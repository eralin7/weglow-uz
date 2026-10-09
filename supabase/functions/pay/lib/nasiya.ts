// Uzum Nasiya Partner API (installments) — https://developer.uzumbank.uz/nasiya
// Prices are in sum. The Bearer token is issued by the Uzum Nasiya manager; there is no sandbox.
import { HttpError } from './util.ts';

/** Buyer statuses from the spec. 4 = verified, can sign a contract. */
export const BUYER_CAN_BUY = 4;
export const BUYER_NEEDS_REGISTRATION = [0, 1, 2, 5, 10, 11, 12];

export interface NasiyaProduct {
  product_id: number;
  name: string;
  price: number; // sum per unit, without Nasiya markup
  amount: number; // qty
  category: number;
  unit_id: number;
}

export interface BuyerStatus {
  phone: string;
  status: number;
  buyer_id: number;
  has_limit: boolean;
  webview: string;
  balance?: string;
  is_in_black_list: boolean;
  available_periods: { period: string; title_ru: string; title_uz: string }[];
}

export interface Tariff {
  tariff: string;
  period_months: number;
  title_ru?: string;
  title_uz?: string;
  total: number;
  origin: number;
  month: number;
  deposit: number;
  is_available: boolean;
  first_payment_date: string;
  error_message?: string;
}

export interface CreatedContract {
  paymart_client: { order: number; contract_id: number; price_month: string; total: string };
  webview_path: string;
  client_act_pdf: string;
}

export class Nasiya {
  constructor(private base: string, private token: string) {}

  get configured(): boolean {
    return Boolean(this.base && this.token);
  }

  private async call<T>(path: string, body: unknown): Promise<{ data: T; response_code?: number }> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'error') {
      const msg = Array.isArray(data.error) && data.error[0]?.text ? data.error[0].text : JSON.stringify(data).slice(0, 300);
      throw new HttpError(502, `NASIYA_${data.response_code ?? res.status}`, msg);
    }
    return data;
  }

  async buyerStatus(phone: string): Promise<BuyerStatus> {
    return (await this.call<BuyerStatus>('/api/v1/buyers/check-status', { phone: Number(phone) })).data;
  }

  async calculate(buyerId: number, products: NasiyaProduct[]): Promise<Tariff[]> {
    const items = products.map(({ product_id, price, amount }) => ({ product_id, price, amount }));
    return (await this.call<Tariff[]>('/api/v1/orders/calculate', { user_id: buyerId, products: items })).data;
  }

  async createOrder(input: {
    buyerId: number;
    period: string;
    products: NasiyaProduct[];
    callback: string;
    extOrderId: string;
  }): Promise<CreatedContract> {
    return (
      await this.call<CreatedContract>('/api/v1/orders', {
        user_id: input.buyerId,
        period: input.period,
        callback: input.callback,
        ext_order_id: input.extOrderId,
        products: input.products,
      })
    ).data;
  }

  async contractStatus(contractId: number): Promise<{ contract_status: number; is_signed?: boolean }> {
    return (await this.call<{ contract_status: number; is_signed?: boolean }>('/api/v1/contracts/check-status', { contract_id: contractId })).data;
  }

  /** `orderId` is paymart_client.order from createOrder. */
  async confirm(orderId: number): Promise<{ client_act_pdf: string }> {
    return (await this.call<{ client_act_pdf: string }>('/api/v1/contracts/confirm', { contract_id: orderId })).data;
  }

  async cancel(orderId: number): Promise<void> {
    await this.call('/api/v1/contracts/cancel', { contract_id: orderId });
  }
}
