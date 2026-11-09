// Uzum Checkout (Uzum Bank card acquiring) — https://developer.uzumbank.uz/checkout
// Amounts are in tiyin (1 sum = 100 tiyin). Auth: X-Terminal-Id + X-API-Key headers.
import { HttpError } from './util.ts';

export interface CartItem {
  title: string; // ≤ 63 chars
  productId: string;
  quantity: number;
  unitPrice: number; // tiyin
  total: number; // tiyin
  receiptParams: { spic: string; packageCode: string; vatPercent: number };
}

export interface RegisterInput {
  orderNumber: string; // ≤ 36 chars, unique per registration
  amountTiyin: number;
  clientId: string;
  items: CartItem[];
  successUrl: string;
  failureUrl: string;
  lang: 'ru' | 'uz';
  phone?: string; // 998XXXXXXXXX
  details: string;
}

export type UzumPaymentStatus =
  | 'REGISTERED' | 'AUTHORIZED' | 'COMPLETED' | 'TOP_UP_COMPLETED' | 'REFUNDED' | 'REVERSED' | 'DECLINED';

export interface OrderStatus {
  orderId: string;
  status: UzumPaymentStatus;
  merchantOrderId: string;
  amount: number;
  completedAmount: number;
  refundedAmount: number;
}

/** Body Uzum POSTs to our callback URL (configured on their terminal). It carries no signature. */
export interface UzumCallback {
  orderId: string;
  orderNumber: string;
  operationState: 'SUCCESS' | 'FAIL';
  operationType: 'AUTHORIZE' | 'COMPLETE' | 'REFUND' | 'REVERSE' | 'TOP_UP_COMPLETED';
}

export class UzumCheckout {
  constructor(private base: string, private terminalId: string, private apiKey: string) {}

  get configured(): boolean {
    return Boolean(this.base && this.terminalId && this.apiKey);
  }

  private async call<T>(path: string, body: unknown, lang: 'ru' | 'uz' = 'ru'): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Terminal-Id': this.terminalId,
        'X-API-Key': this.apiKey,
        'Content-Language': lang === 'uz' ? 'uz-UZ' : 'ru-RU',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.errorCode ?? 0) !== 0 || !data.result) {
      throw new HttpError(502, `UZUM_${data.errorCode ?? res.status}`, String(data.message ?? '').slice(0, 300));
    }
    return data.result as T;
  }

  register(input: RegisterInput): Promise<{ orderId: string; paymentRedirectUrl: string }> {
    return this.call('/api/v1/payment/register', {
      amount: input.amountTiyin,
      currency: 860,
      clientId: input.clientId,
      orderNumber: input.orderNumber,
      paymentDetails: input.details,
      viewType: 'REDIRECT',
      sessionTimeoutSecs: 1800,
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
      paymentParams: { payType: 'ONE_STEP', ...(input.phone ? { phoneNumber: input.phone } : {}) },
      merchantParams: {
        cart: { cartId: input.orderNumber, receiptType: 'PURCHASE', total: input.amountTiyin, items: input.items },
      },
    }, input.lang);
  }

  status(orderId: string): Promise<OrderStatus> {
    return this.call('/api/v1/payment/getOrderStatus', { orderId });
  }
}
