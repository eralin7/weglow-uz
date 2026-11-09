// weglow.uz payment server: Uzum Checkout (Uzcard, Humo, Visa, Mastercard) and Uzum Nasiya installments.
//
// Site:          GET /catalog · POST /checkout · GET /status?id= · POST /nasiya/{check,calculate,order,confirm}
// Client link:   GET /p/<number>-<token>    (manager invoice → fresh Uzum Checkout session)
// Uzum server:   POST /uzum/callback
// Manager page:  POST /manager/invoice · GET /manager/payments · POST /manager/cancel
//                GET /manager/products · POST /manager/products                     (header x-admin-key)
import { BUYER_CAN_BUY, BUYER_NEEDS_REGISTRATION, Nasiya, type NasiyaProduct } from './lib/nasiya.ts';
import { type Payment, type Product, type ProductPatch, Store } from './lib/store.ts';
import { notify } from './lib/telegram.ts';
import { type CartItem, type UzumCallback, UzumCheckout } from './lib/uzum.ts';
import {
  cleanText, corsHeaders, env, formatSum, HttpError, json, loosePhone, normalizeUzPhone, parseQty, redirect, safeEqual,
} from './lib/util.ts';

const store = new Store();
const uzum = new UzumCheckout(env('UZUM_CHECKOUT_URL'), env('UZUM_TERMINAL_ID'), env('UZUM_API_KEY'));
const nasiya = new Nasiya(env('NASIYA_BASE_URL', 'https://merchants-api.uzumnasiya.uz'), env('NASIYA_TOKEN'));

const SITE_URL = env('SITE_URL', 'https://weglow.uz');
const PUBLIC_URL = env('PUBLIC_URL', 'https://pay.weglow.uz'); // this server
const SESSION_REUSE_MS = 25 * 60 * 1000; // Uzum Checkout sessions live 30 minutes

type Lang = 'ru' | 'uz';
const langOf = (v: unknown): Lang => (v === 'uz' ? 'uz' : 'ru');
const nameOf = (p: Product, lang: string) => (lang === 'uz' ? p.name_uz : p.name_ru);
const orderNo = (p: Payment) => `WG-${p.number}`;
const linkOf = (p: Payment) => `${PUBLIC_URL}/p/${p.number}-${p.token}`;
const resultUrl = (p: Payment, key = 'paid') => `${SITE_URL}/?${key}=${p.id}${p.lang === 'uz' ? '&lang=uz' : ''}`;

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

function sellable(id: unknown): Product & { price_uzs: number } {
  const p = store.product(String(id ?? ''));
  if (!p || !p.price_uzs) throw new HttpError(400, 'PRODUCT_NOT_FOR_SALE');
  return p as Product & { price_uzs: number };
}

function requireUzum() {
  if (!uzum.configured) throw new HttpError(503, 'UZUM_NOT_CONFIGURED');
}
function requireNasiya() {
  if (!nasiya.configured) throw new HttpError(503, 'NASIYA_NOT_CONFIGURED');
}
function requireAdmin(req: Request) {
  const key = env('ADMIN_KEY');
  if (!key || !safeEqual(key, req.headers.get('x-admin-key') ?? '')) throw new HttpError(401, 'UNAUTHORIZED');
}

function cart(p: Payment): CartItem[] {
  const product = store.product(p.product_id);
  if (!product?.mxik || !product.package_code) throw new HttpError(500, 'PRODUCT_MXIK_MISSING');
  const unit = Math.round(p.amount_uzs / p.qty) * 100;
  return [{
    title: product.name_ru.slice(0, 63), productId: product.id, quantity: p.qty, unitPrice: unit, total: unit * p.qty,
    receiptParams: { spic: product.mxik, packageCode: product.package_code, vatPercent: product.vat_percent ?? 0 },
  }];
}

/** Opens (or reuses) an Uzum Checkout session for the payment and returns its URL. */
async function checkoutUrl(p: Payment): Promise<string> {
  if (p.uzum_order_id && p.checkout_url && Date.now() - Date.parse(p.updated_at) < SESSION_REUSE_MS) return p.checkout_url;
  const attempt = p.attempts + 1;
  const phone = normalizeUzPhone(p.customer_phone);
  const reg = await uzum.register({
    orderNumber: attempt === 1 ? orderNo(p) : `${orderNo(p)}-${attempt}`,
    amountTiyin: p.amount_uzs * 100,
    clientId: phone ?? `wg-${p.number}`,
    items: cart(p),
    successUrl: resultUrl(p),
    failureUrl: resultUrl(p),
    lang: langOf(p.lang),
    phone: phone ?? undefined,
    details: `WEGLOW ${orderNo(p)}`,
  });
  store.update(p.id, { status: 'pending', attempts: attempt, uzum_order_id: reg.orderId, checkout_url: reg.paymentRedirectUrl });
  return reg.paymentRedirectUrl;
}

/** Re-reads the payment from Uzum and marks it paid / refunded. Never trusts the callback body alone. */
async function syncUzum(p: Payment, orderId: string): Promise<Payment> {
  const s = await uzum.status(orderId);
  const ourNumber = /^WG-(\d+)/.exec(s.merchantOrderId ?? '')?.[1];
  if (Number(ourNumber) !== p.number) return p;
  const expected = p.amount_uzs * 100;
  if (s.status === 'COMPLETED' && s.amount === expected && s.completedAmount === expected) {
    const paid = store.transition(p.id, ['new', 'pending', 'failed', 'cancelled'], {
      status: 'paid', uzum_order_id: orderId, paid_at: new Date().toISOString(), error: null,
    });
    if (paid) await notify(paidMessage(paid));
    return paid ?? store.get(p.id)!;
  }
  if (s.status === 'REFUNDED' || s.status === 'REVERSED') {
    return store.transition(p.id, ['paid'], { status: 'refunded' }) ?? p;
  }
  return p;
}

function paidMessage(p: Payment): string {
  const product = store.product(p.product_id);
  const how = p.provider === 'nasiya'
    ? `Uzum Nasiya, ${p.nasiya_period ?? ''} (клиент заплатит ${formatSum(p.nasiya_total ?? 0)})`
    : 'карта (Uzum Checkout)';
  return [
    `✅ Оплата weglow.uz — ${orderNo(p)}${p.source === 'manager' ? ` (счёт менеджера ${p.created_by ?? ''})`.replace(' )', ')') : ''}`,
    `Товар: ${product?.name_ru ?? p.product_id} × ${p.qty}`,
    `Сумма: ${formatSum(p.amount_uzs)}`,
    `Способ: ${how}`,
    `Клиент: ${p.customer_name ?? '—'}, ${p.customer_phone ? '+' + p.customer_phone : '—'}`,
  ].join('\n');
}

function nasiyaProduct(p: Product & { price_uzs: number }, qty: number, lang: Lang): NasiyaProduct {
  if (!p.nasiya_category || !p.nasiya_product_id) throw new HttpError(500, 'PRODUCT_NASIYA_MISSING');
  return {
    product_id: p.nasiya_product_id, name: nameOf(p, lang), price: p.price_uzs, amount: qty,
    category: p.nasiya_category, unit_id: p.nasiya_unit_id ?? 1,
  };
}

function shareText(p: Payment): string {
  const product = store.product(p.product_id)!;
  return p.lang === 'uz'
    ? `Assalomu alaykum! WEGLOW to‘lov havolasi (${orderNo(p)}):\n${nameOf(product, 'uz')} × ${p.qty} — ${formatSum(p.amount_uzs).replace('сум', 'so‘m')}\n${linkOf(p)}\nUzcard, Humo, Visa yoki Mastercard kartasi bilan to‘lash mumkin.`
    : `Здравствуйте! Ссылка на оплату WEGLOW (${orderNo(p)}):\n${nameOf(product, 'ru')} × ${p.qty} — ${formatSum(p.amount_uzs)}\n${linkOf(p)}\nОплатить можно картой Uzcard, Humo, Visa или Mastercard.`;
}

function publicProduct(p: Product) {
  return { id: p.id, name_ru: p.name_ru, name_uz: p.name_uz, price_uzs: p.price_uzs };
}

function managerRow(p: Payment) {
  const { token: _t, ...rest } = p;
  return { ...rest, link: p.source === 'manager' ? linkOf(p) : null };
}

function productPatch(b: Record<string, unknown>): ProductPatch {
  const patch: ProductPatch = {};
  const int = (v: unknown, min: number, max: number, code: string) => {
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, code);
    return n;
  };
  if ('price_uzs' in b) patch.price_uzs = int(b.price_uzs, 1000, 1_000_000_000, 'BAD_PRICE');
  if ('mxik' in b) {
    const v = String(b.mxik ?? '').replace(/\D/g, '');
    if (v && v.length !== 17) throw new HttpError(400, 'BAD_MXIK');
    patch.mxik = v || null;
  }
  if ('package_code' in b) {
    const v = String(b.package_code ?? '').replace(/\D/g, '');
    if (v.length > 20) throw new HttpError(400, 'BAD_PACKAGE_CODE');
    patch.package_code = v || null;
  }
  if ('vat_percent' in b) patch.vat_percent = int(b.vat_percent, 0, 99, 'BAD_VAT') ?? 0;
  if ('nasiya_category' in b) patch.nasiya_category = int(b.nasiya_category, 1, 1_000_000, 'BAD_NASIYA_CATEGORY');
  if ('nasiya_unit_id' in b) patch.nasiya_unit_id = int(b.nasiya_unit_id, 1, 1000, 'BAD_NASIYA_UNIT');
  if ('active' in b) patch.active = b.active ? 1 : 0;
  return patch;
}

// ---------------------------------------------------------------- routes

type Handler = (req: Request, url: URL, params: string[]) => Promise<Response> | Response;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/health$/, (req) => json(req, { ok: true, uzum: uzum.configured, nasiya: nasiya.configured })],

  ['GET', /^\/catalog$/, (req) =>
    json(req, { products: store.products().map(publicProduct), online: uzum.configured, nasiya: nasiya.configured })],

  ['POST', /^\/checkout$/, async (req) => {
    requireUzum();
    const b = await body(req);
    const product = sellable(b.product_id);
    const qty = parseQty(b.qty);
    const phone = loosePhone(b.phone);
    const name = cleanText(b.name, 80);
    if (!phone || name.length < 2) throw new HttpError(400, 'BAD_CONTACT');
    const p = store.create({
      source: 'site', provider: 'uzum', product_id: product.id, qty, amount_uzs: product.price_uzs * qty,
      lang: langOf(b.lang), customer_name: name, customer_phone: phone,
    });
    try {
      return json(req, { id: p.id, checkout_url: await checkoutUrl(p) });
    } catch (e) {
      store.update(p.id, { status: 'failed', error: String((e as Error).message).slice(0, 500) });
      throw e;
    }
  }],

  ['GET', /^\/p\/(\d+)-([a-z0-9]{8})$/, async (_req, _url, [num, tok]) => {
    const p = store.byNumber(Number(num));
    if (!p || p.provider !== 'uzum' || !safeEqual(p.token, tok)) return new Response('Ссылка недействительна', { status: 404 });
    let current = p;
    if (p.uzum_order_id && p.status === 'pending') current = await syncUzum(p, p.uzum_order_id); // paid in another tab?
    if (current.status === 'paid' || current.status === 'cancelled' || current.status === 'refunded') return redirect(resultUrl(current));
    requireUzum();
    return redirect(await checkoutUrl(current));
  }],

  ['POST', /^\/uzum\/callback$/, async (req) => {
    // Uzum retries up to 5 times until it gets 200. The body is unsigned, so the status is re-read via the API.
    const b = (await body(req)) as unknown as UzumCallback;
    if (!b?.orderId) return json(req, { ok: false });
    const number = Number(/^WG-(\d+)/.exec(String(b.orderNumber ?? ''))?.[1]);
    const p = store.byUzumOrder(b.orderId) ?? (number ? store.byNumber(number) : null);
    if (!p || p.provider !== 'uzum') return json(req, { ok: false, reason: 'unknown order' });
    try {
      await syncUzum(p, b.orderId);
    } catch (e) {
      // Uzum does not know this orderId → not a real callback. Other errors → 500 so Uzum retries.
      if (e instanceof HttpError && e.code === 'UZUM_3005') return json(req, { ok: false, reason: 'unknown order' });
      throw e;
    }
    return json(req, { ok: true });
  }],

  ['GET', /^\/status$/, async (req, url) => {
    let p = store.get(url.searchParams.get('id') ?? '');
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    // The client may come back before the callback arrives — ask Uzum directly.
    if (p.provider === 'uzum' && p.status === 'pending' && p.uzum_order_id && uzum.configured) {
      p = await syncUzum(p, p.uzum_order_id).catch(() => p!);
    }
    return json(req, { number: orderNo(p), status: p.status, provider: p.provider, product_id: p.product_id, qty: p.qty, amount_uzs: p.amount_uzs });
  }],

  // ---------------- Uzum Nasiya

  ['POST', /^\/nasiya\/check$/, async (req) => {
    requireNasiya();
    const phone = normalizeUzPhone((await body(req)).phone);
    if (!phone) throw new HttpError(400, 'BAD_PHONE');
    const s = await nasiya.buyerStatus(phone);
    const state = s.status === BUYER_CAN_BUY ? 'ok' : BUYER_NEEDS_REGISTRATION.includes(s.status) ? 'register' : 'denied';
    return json(req, { state, status: s.status, webview: state === 'register' ? s.webview : null });
  }],

  ['POST', /^\/nasiya\/calculate$/, async (req) => {
    requireNasiya();
    const b = await body(req);
    const phone = normalizeUzPhone(b.phone);
    if (!phone) throw new HttpError(400, 'BAD_PHONE');
    const product = sellable(b.product_id);
    const qty = parseQty(b.qty);
    const buyer = await nasiya.buyerStatus(phone);
    if (buyer.status !== BUYER_CAN_BUY) throw new HttpError(409, 'NASIYA_BUYER_NOT_READY');
    const tariffs = await nasiya.calculate(buyer.buyer_id, [nasiyaProduct(product, qty, 'ru')]);
    return json(req, {
      tariffs: tariffs.map((t) => ({
        tariff: t.tariff, months: t.period_months, title_ru: t.title_ru, title_uz: t.title_uz, month: t.month,
        total: t.total, deposit: t.deposit, available: t.is_available, first_payment_date: t.first_payment_date,
        error: t.error_message ?? null,
      })),
    });
  }],

  ['POST', /^\/nasiya\/order$/, async (req) => {
    requireNasiya();
    const b = await body(req);
    const phone = normalizeUzPhone(b.phone);
    const name = cleanText(b.name, 80);
    const period = cleanText(b.tariff, 40);
    if (!phone || !period) throw new HttpError(400, 'BAD_INPUT');
    const product = sellable(b.product_id);
    const qty = parseQty(b.qty);
    const lang = langOf(b.lang);
    const buyer = await nasiya.buyerStatus(phone);
    if (buyer.status !== BUYER_CAN_BUY) throw new HttpError(409, 'NASIYA_BUYER_NOT_READY');
    const row = store.create({
      source: 'site', provider: 'nasiya', product_id: product.id, qty, amount_uzs: product.price_uzs * qty, lang,
      customer_name: name || null, customer_phone: phone,
    });
    try {
      const c = await nasiya.createOrder({
        buyerId: buyer.buyer_id, period, products: [nasiyaProduct(product, qty, 'ru')],
        callback: resultUrl(row, 'nasiya'), extOrderId: orderNo(row),
      });
      store.update(row.id, {
        status: 'pending', nasiya_buyer_id: buyer.buyer_id, nasiya_order_id: c.paymart_client.order,
        nasiya_contract_id: c.paymart_client.contract_id, nasiya_period: period, nasiya_total: Number(c.paymart_client.total),
      });
      return json(req, { id: row.id, webview: c.webview_path });
    } catch (e) {
      store.update(row.id, { status: 'failed', error: String((e as Error).message).slice(0, 500) });
      throw e;
    }
  }],

  ['POST', /^\/nasiya\/confirm$/, async (req) => {
    requireNasiya();
    const p = store.get(String((await body(req)).id ?? ''));
    if (!p || p.provider !== 'nasiya' || !p.nasiya_order_id) throw new HttpError(404, 'NOT_FOUND');
    if (p.status === 'paid') return json(req, { status: 'paid' });
    const contract = await nasiya.contractStatus(p.nasiya_contract_id ?? p.nasiya_order_id);
    if (contract.contract_status === 5) {
      store.transition(p.id, ['new', 'pending'], { status: 'cancelled' });
      return json(req, { status: 'cancelled' });
    }
    if (!contract.is_signed) return json(req, { status: 'pending' }); // client has not finished signing yet
    await nasiya.confirm(p.nasiya_order_id);
    const paid = store.transition(p.id, ['new', 'pending'], { status: 'paid', paid_at: new Date().toISOString() });
    if (paid) await notify(paidMessage(paid));
    return json(req, { status: 'paid' });
  }],

  // ---------------- Manager

  ['POST', /^\/manager\/invoice$/, async (req) => {
    requireAdmin(req);
    const b = await body(req);
    const product = sellable(b.product_id);
    const qty = parseQty(b.qty);
    const p = store.create({
      source: 'manager', provider: 'uzum', product_id: product.id, qty, amount_uzs: product.price_uzs * qty,
      lang: langOf(b.lang), customer_name: cleanText(b.name, 80) || null,
      customer_phone: normalizeUzPhone(b.phone) ?? loosePhone(b.phone), created_by: cleanText(b.manager, 40) || null,
    });
    return json(req, { payment: managerRow(p), text: shareText(p) });
  }],

  ['GET', /^\/manager\/payments$/, (req) => {
    requireAdmin(req);
    return json(req, { payments: store.list(100).map(managerRow) });
  }],

  ['POST', /^\/manager\/cancel$/, async (req) => {
    requireAdmin(req);
    const p = store.get(String((await body(req)).id ?? ''));
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    if (p.provider === 'nasiya' && p.nasiya_order_id && p.status === 'pending') await nasiya.cancel(p.nasiya_order_id);
    const updated = store.transition(p.id, ['new', 'pending', 'failed'], { status: 'cancelled' });
    return json(req, { payment: managerRow(updated ?? p) });
  }],

  ['GET', /^\/manager\/products$/, (req) => {
    requireAdmin(req);
    return json(req, { products: store.products(true) });
  }],

  ['POST', /^\/manager\/products$/, async (req) => {
    requireAdmin(req);
    const b = await body(req);
    const updated = store.updateProduct(String(b.id ?? ''), productPatch(b));
    if (!updated) throw new HttpError(404, 'NOT_FOUND');
    return json(req, { product: updated });
  }],
];

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  const url = new URL(req.url);
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(url.pathname);
    if (m && method === req.method) {
      try {
        return await handler(req, url, m.slice(1));
      } catch (e) {
        if (e instanceof HttpError) {
          if (e.status >= 500) console.error(e.code, e.message);
          return json(req, { error: e.code, message: e.status < 500 ? e.message : undefined }, e.status);
        }
        console.error(e);
        return json(req, { error: 'INTERNAL' }, 500);
      }
    }
  }
  return json(req, { error: 'NOT_FOUND' }, 404);
}
