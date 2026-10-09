// Multicard (Rahmat) payment gateway — https://docs.multicard.uz
// Amounts are in tiyin (1 sum = 100 tiyin).
import { HttpError, md5, safeEqual } from './util.ts';

export interface OfdItem {
  qty: number;
  price: number; // tiyin per unit
  total: number; // tiyin, price × qty
  mxik: string;
  package_code: string;
  name: string;
  vat?: number;
}

export interface CreateInvoiceInput {
  invoiceId: string;
  amountTiyin: number;
  items: OfdItem[];
  callbackUrl: string;
  returnUrl: string;
  lang: 'ru' | 'uz';
  smsPhone?: string; // 998XXXXXXXXX — Multicard sends the payment link by SMS
  ttlSeconds?: number;
}

export interface Invoice {
  uuid: string;
  checkout_url: string;
  short_link?: string;
  payment?: { status?: string };
}

export interface CallbackBody {
  store_id: number | string;
  amount: number | string;
  invoice_id: string;
  uuid: string;
  sign: string;
  ps?: string;
  card_pan?: string;
  phone?: string;
  receipt_url?: string;
  payment_time?: string;
}

export class Multicard {
  private token = '';
  private tokenExpires = 0;

  constructor(
    private base: string,
    private appId: string,
    private secret: string,
    readonly storeId: number,
  ) {}

  get configured(): boolean {
    return Boolean(this.base && this.appId && this.secret && this.storeId);
  }

  private async auth(): Promise<string> {
    // Tokens live 24h; refresh a little early.
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    const res = await fetch(`${this.base}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_id: this.appId, secret: this.secret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new HttpError(502, 'MULTICARD_AUTH', JSON.stringify(data).slice(0, 300));
    this.token = data.token;
    this.tokenExpires = Date.now() + 23 * 3600 * 1000;
    return this.token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.auth()}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) this.token = '';
    if (!res.ok || data.success === false) {
      throw new HttpError(502, data?.error?.code ?? 'MULTICARD_ERROR', JSON.stringify(data?.error ?? data).slice(0, 300));
    }
    return data.data ?? data;
  }

  createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    return this.call('POST', '/payment/invoice', {
      store_id: this.storeId,
      amount: input.amountTiyin,
      invoice_id: input.invoiceId,
      lang: input.lang,
      return_url: input.returnUrl,
      callback_url: input.callbackUrl,
      ttl: input.ttlSeconds ?? 86400,
      ...(input.smsPhone ? { sms: input.smsPhone } : {}),
      ofd: input.items,
    });
  }

  getInvoice(uuid: string): Promise<Invoice> {
    return this.call('GET', `/payment/invoice/${encodeURIComponent(uuid)}`);
  }

  cancelInvoice(uuid: string): Promise<unknown> {
    return this.call('DELETE', `/payment/invoice/${encodeURIComponent(uuid)}`);
  }

  /** sign = md5(store_id + invoice_id + amount + secret) */
  async verifyCallback(body: CallbackBody): Promise<boolean> {
    if (!body?.sign) return false;
    if (String(body.store_id) !== String(this.storeId)) return false;
    const expected = await md5(`${body.store_id}${body.invoice_id}${body.amount}${this.secret}`);
    return safeEqual(expected, String(body.sign).toLowerCase());
  }
}
