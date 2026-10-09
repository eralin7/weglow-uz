// weglow.uz payments: Multicard / Rahmat (cards, Payme, Click, Uzum, …) and Uzum Nasiya installments.
//
// Public (site):     GET  /catalog · POST /checkout · GET /status?id= · POST /nasiya/{check,calculate,order,confirm}
// Multicard server:  POST /multicard/callback
// Manager page:      POST /manager/invoice · GET /manager/payments · POST /manager/cancel   (header x-admin-key)
import { Multicard, type CallbackBody, type OfdItem } from './lib/multicard.ts';
import { BUYER_CAN_BUY, BUYER_NEEDS_REGISTRATION, Nasiya, type NasiyaProduct } from './lib/nasiya.ts';
import { store, type Payment, type Product } from './lib/store.ts';
import { notify } from './lib/telegram.ts';
import {
  cleanText, corsHeaders, env, formatSum, HttpError, json, loosePhone, normalizeUzPhone, parseQty, safeEqual,
} from './lib/util.ts';

const multicard = new Multicard(
  env('MULTICARD_BASE_URL', 'https://mesh.multicard.uz'),
  env('MULTICARD_APP_ID'),
  env('MULTICARD_SECRET'),
  Number(env('MULTICARD_STORE_ID', '0')),
);
const nasiya = new Nasiya(env('NASIYA_BASE_URL', 'https://merchants-api.uzumnasiya.uz'), env('NASIYA_TOKEN'));

const SITE_URL = env('SITE_URL', 'https://weglow.uz');
const FN_URL = env('PUBLIC_FN_URL'); // e.g. https://<ref>.supabase.co/functions/v1/pay
const MANAGER_INVOICE_TTL = 3 * 24 * 3600;

type Lang = 'ru' | 'uz';
const langOf = (v: unknown): Lang => (v === 'uz' ? 'uz' : 'ru');
/** Order number shown to clients and sent to providers as invoice / ext order id. */
const orderNo = (p: Payment) => `WG-${p.number}`;
const parseOrderNo = (v: unknown) => {
  const m = /^WG-(\d+)$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};
const nameOf = (p: Product, lang: string) => (lang === 'uz' ? p.name_uz : p.name_ru);

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'BAD_JSON');
  }
}

async function sellable(id: unknown): Promise<Product & { price_uzs: number }> {
  const p = await store.product(String(id ?? ''));
  if (!p || !p.price_uzs) throw new HttpError(400, 'PRODUCT_NOT_FOR_SALE');
  return p as Product & { price_uzs: number };
}

function ofd(p: Product & { price_uzs: number }, qty: number): OfdItem[] {
  if (!p.mxik || !p.package_code) throw new HttpError(500, 'PRODUCT_MXIK_MISSING');
  const price = p.price_uzs * 100;
  return [{
    qty, price, total: price * qty, mxik: p.mxik, package_code: p.package_code, name: p.name_ru,
    ...(p.vat_percent != null ? { vat: p.vat_percent } : {}),
  }];
}

function requireMulticard() {
  if (!multicard.configured || !FN_URL) throw new HttpError(503, 'MULTICARD_NOT_CONFIGURED');
}
function requireNasiya() {
  if (!nasiya.configured) throw new HttpError(503, 'NASIYA_NOT_CONFIGURED');
}
function requireAdmin(req: Request) {
  const key = env('ADMIN_KEY');
  const given = req.headers.get('x-admin-key') ?? '';
  if (!key || !safeEqual(key, given)) throw new HttpError(401, 'UNAUTHORIZED');
}

async function issueInvoice(p: Payment, product: Product & { price_uzs: number }, opts: { smsPhone?: string; ttl?: number }) {
  const invoice = await multicard.createInvoice({
    invoiceId: orderNo(p),
    amountTiyin: p.amount_uzs * 100,
    items: ofd(product, p.qty),
    callbackUrl: `${FN_URL}/multicard/callback`,
    returnUrl: `${SITE_URL}/?paid=${p.id}${p.lang === 'uz' ? '&lang=uz' : ''}`,
    lang: langOf(p.lang),
    smsPhone: opts.smsPhone,
    ttlSeconds: opts.ttl,
  });
  return store.update(p.id, {
    status: 'pending',
    mc_uuid: invoice.uuid,
    checkout_url: invoice.checkout_url,
    short_link: invoice.short_link ?? invoice.checkout_url,
  });
}

function paidMessage(p: Payment, product: Product | null): string {
  const how = p.provider === 'nasiya'
    ? `Uzum Nasiya, ${p.nasiya_period ?? ''} (клиент заплатит ${formatSum(p.nasiya_total ?? 0)})`
    : [p.ps, p.card_pan].filter(Boolean).join(' ');
  return [
    `✅ Оплата weglow.uz — ${orderNo(p)}${p.source === 'manager' ? ' (счёт менеджера)' : ''}`,
    `Товар: ${product?.name_ru ?? p.product_id} × ${p.qty}`,
    `Сумма: ${formatSum(p.amount_uzs)}`,
    `Способ: ${how || '—'}`,
    `Клиент: ${p.customer_name ?? '—'}, +${p.customer_phone ?? '—'}`,
    p.receipt_url ? `Чек: ${p.receipt_url}` : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- routes

const routes: Record<string, (req: Request, url: URL) => Promise<Response>> = {
  'GET /health': async (req) =>
    json(req, { ok: true, multicard: multicard.configured && Boolean(FN_URL), nasiya: nasiya.configured }),

  'GET /catalog': async (req) => {
    const items = (await store.products()).map((p) => ({
      id: p.id, name_ru: p.name_ru, name_uz: p.name_uz, price_uzs: p.price_uzs,
    }));
    return json(req, {
      products: items,
      online: multicard.configured && Boolean(FN_URL),
      nasiya: nasiya.configured,
    });
  },

  'POST /checkout': async (req) => {
    requireMulticard();
    const b = await body(req);
    const product = await sellable(b.product_id);
    const qty = parseQty(b.qty);
    const phone = loosePhone(b.phone);
    const name = cleanText(b.name, 80);
    if (!phone || name.length < 2) throw new HttpError(400, 'BAD_CONTACT');
    const row = await store.create({
      source: 'site', provider: 'multicard', product_id: product.id, qty,
      amount_uzs: product.price_uzs * qty, lang: langOf(b.lang), customer_name: name, customer_phone: phone,
    });
    const p = await issueInvoice(row, product, {});
    return json(req, { id: p.id, checkout_url: p.checkout_url });
  },

  'POST /multicard/callback': async (req) => {
    // Multicard reverses the payment unless we answer 200 + {success:true}; on 5xx it freezes and retries.
    const b = (await body(req)) as unknown as CallbackBody;
    if (!(await multicard.verifyCallback(b))) return json(req, { success: false, message: 'Bad signature' });
    const no = parseOrderNo(b.invoice_id);
    const p = no ? await store.byNumber(no) : null;
    if (!p || p.provider !== 'multicard') return json(req, { success: false, message: 'Invoice not found' });
    if (p.status === 'paid') return json(req, { success: p.mc_uuid === b.uuid }); // retry of the same payment
    if (Number(b.amount) !== p.amount_uzs * 100) return json(req, { success: false, message: 'Amount mismatch' });
    if (p.status === 'cancelled') return json(req, { success: false, message: 'Invoice cancelled' });
    const paid = await store.transition(p.id, ['new', 'pending', 'failed'], {
      status: 'paid', mc_uuid: b.uuid, ps: b.ps ?? null, card_pan: b.card_pan ?? null,
      receipt_url: b.receipt_url ?? null, paid_at: new Date().toISOString(), error: null,
    });
    if (paid) await notify(paidMessage(paid, await store.product(paid.product_id)));
    return json(req, { success: true });
  },

  'GET /status': async (req, url) => {
    const p = await store.get(url.searchParams.get('id') ?? '');
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    return json(req, { number: orderNo(p), status: p.status, provider: p.provider, product_id: p.product_id, qty: p.qty, amount_uzs: p.amount_uzs, receipt_url: p.receipt_url });
  },

  // ---------------- Uzum Nasiya

  'POST /nasiya/check': async (req) => {
    requireNasiya();
    const phone = normalizeUzPhone((await body(req)).phone);
    if (!phone) throw new HttpError(400, 'BAD_PHONE');
    const s = await nasiya.buyerStatus(phone);
    const state = s.status === BUYER_CAN_BUY ? 'ok' : BUYER_NEEDS_REGISTRATION.includes(s.status) ? 'register' : 'denied';
    return json(req, { state, status: s.status, webview: state === 'register' ? s.webview : null });
  },

  'POST /nasiya/calculate': async (req) => {
    requireNasiya();
    const b = await body(req);
    const phone = normalizeUzPhone(b.phone);
    if (!phone) throw new HttpError(400, 'BAD_PHONE');
    const product = await sellable(b.product_id);
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
  },

  'POST /nasiya/order': async (req) => {
    requireNasiya();
    const b = await body(req);
    const phone = normalizeUzPhone(b.phone);
    const name = cleanText(b.name, 80);
    const period = cleanText(b.tariff, 40);
    if (!phone || !period) throw new HttpError(400, 'BAD_INPUT');
    const product = await sellable(b.product_id);
    const qty = parseQty(b.qty);
    const lang = langOf(b.lang);
    const buyer = await nasiya.buyerStatus(phone);
    if (buyer.status !== BUYER_CAN_BUY) throw new HttpError(409, 'NASIYA_BUYER_NOT_READY');
    const row = await store.create({
      source: 'site', provider: 'nasiya', product_id: product.id, qty, amount_uzs: product.price_uzs * qty, lang,
      customer_name: name || null, customer_phone: phone,
    });
    try {
      const c = await nasiya.createOrder({
        buyerId: buyer.buyer_id, period, products: [nasiyaProduct(product, qty, 'ru')],
        callback: `${SITE_URL}/?nasiya=${row.id}${lang === 'uz' ? '&lang=uz' : ''}`, extOrderId: orderNo(row),
      });
      await store.update(row.id, {
        status: 'pending', nasiya_buyer_id: buyer.buyer_id, nasiya_order_id: c.paymart_client.order,
        nasiya_contract_id: c.paymart_client.contract_id, nasiya_period: period, nasiya_total: Number(c.paymart_client.total),
      });
      return json(req, { id: row.id, webview: c.webview_path });
    } catch (e) {
      await store.update(row.id, { status: 'failed', error: String((e as Error).message).slice(0, 500) });
      throw e;
    }
  },

  'POST /nasiya/confirm': async (req) => {
    requireNasiya();
    const p = await store.get(String((await body(req)).id ?? ''));
    if (!p || p.provider !== 'nasiya' || !p.nasiya_order_id) throw new HttpError(404, 'NOT_FOUND');
    if (p.status === 'paid') return json(req, { status: 'paid' });
    const contract = await nasiya.contractStatus(p.nasiya_contract_id ?? p.nasiya_order_id);
    if (contract.contract_status === 5) {
      await store.transition(p.id, ['new', 'pending'], { status: 'cancelled' });
      return json(req, { status: 'cancelled' });
    }
    if (!contract.is_signed) return json(req, { status: 'pending' }); // client has not finished signing yet
    await nasiya.confirm(p.nasiya_order_id);
    const paid = await store.transition(p.id, ['new', 'pending'], { status: 'paid', paid_at: new Date().toISOString() });
    if (paid) await notify(paidMessage(paid, await store.product(paid.product_id)));
    return json(req, { status: 'paid' });
  },

  // ---------------- Manager

  'POST /manager/invoice': async (req) => {
    requireAdmin(req);
    requireMulticard();
    const b = await body(req);
    const product = await sellable(b.product_id);
    const qty = parseQty(b.qty);
    const phone = normalizeUzPhone(b.phone);
    const lang = langOf(b.lang);
    if (b.send_sms && !phone) throw new HttpError(400, 'BAD_PHONE');
    const row = await store.create({
      source: 'manager', provider: 'multicard', product_id: product.id, qty, amount_uzs: product.price_uzs * qty, lang,
      customer_name: cleanText(b.name, 80) || null, customer_phone: phone ?? loosePhone(b.phone),
      created_by: cleanText(b.manager, 40) || null,
    });
    const p = await issueInvoice(row, product, { smsPhone: b.send_sms ? phone! : undefined, ttl: MANAGER_INVOICE_TTL });
    return json(req, { payment: p, text: shareText(p, product) });
  },

  'GET /manager/payments': async (req) => {
    requireAdmin(req);
    return json(req, { payments: await store.list(100) });
  },

  'POST /manager/cancel': async (req) => {
    requireAdmin(req);
    const p = await store.get(String((await body(req)).id ?? ''));
    if (!p) throw new HttpError(404, 'NOT_FOUND');
    if (p.provider === 'multicard' && p.mc_uuid && p.status === 'pending') await multicard.cancelInvoice(p.mc_uuid);
    if (p.provider === 'nasiya' && p.nasiya_order_id && p.status === 'pending') await nasiya.cancel(p.nasiya_order_id);
    const updated = await store.transition(p.id, ['new', 'pending', 'failed'], { status: 'cancelled' });
    return json(req, { payment: updated ?? p });
  },
};

function nasiyaProduct(p: Product & { price_uzs: number }, qty: number, lang: Lang): NasiyaProduct {
  if (!p.nasiya_category || !p.nasiya_product_id) throw new HttpError(500, 'PRODUCT_NASIYA_MISSING');
  return {
    product_id: p.nasiya_product_id, name: nameOf(p, lang), price: p.price_uzs, amount: qty,
    category: p.nasiya_category, unit_id: p.nasiya_unit_id ?? 1,
  };
}

function shareText(p: Payment, product: Product): string {
  const link = p.short_link ?? p.checkout_url;
  return p.lang === 'uz'
    ? `Assalomu alaykum! WEGLOW to‘lov havolasi (${orderNo(p)}):\n${nameOf(product, 'uz')} × ${p.qty} — ${formatSum(p.amount_uzs).replace('сум', 'so‘m')}\n${link}\nKarta, Payme, Click, Uzum va boshqalar orqali to‘lash mumkin.`
    : `Здравствуйте! Ссылка на оплату WEGLOW (${orderNo(p)}):\n${nameOf(product, 'ru')} × ${p.qty} — ${formatSum(p.amount_uzs)}\n${link}\nОплатить можно картой, Payme, Click, Uzum и другими способами.`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(functions\/v1\/)?pay/, '') || '/';
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return json(req, { error: 'NOT_FOUND' }, 404);
  try {
    return await handler(req, url);
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status >= 500) console.error(e.code, e.message);
      return json(req, { error: e.code, message: e.status < 500 ? e.message : undefined }, e.status);
    }
    console.error(e);
    return json(req, { error: 'INTERNAL' }, 500);
  }
});
