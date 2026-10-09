// Persistence for products and payments. Supabase in production; an in-memory store for local runs
// (PAY_DEV_MEMORY=1) so the whole flow can be exercised against the Multicard sandbox without a project.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { env } from './util.ts';

export interface Product {
  id: string;
  name_ru: string;
  name_uz: string;
  price_uzs: number | null;
  mxik: string | null;
  package_code: string | null;
  vat_percent: number | null;
  nasiya_product_id: number | null;
  nasiya_category: number | null;
  nasiya_unit_id: number | null;
  active: boolean;
  sort: number;
}

export type PaymentStatus = 'new' | 'pending' | 'paid' | 'cancelled' | 'failed';

export interface Payment {
  id: string;
  number: number;
  created_at: string;
  source: 'site' | 'manager';
  provider: 'multicard' | 'nasiya';
  status: PaymentStatus;
  product_id: string;
  qty: number;
  amount_uzs: number;
  customer_name: string | null;
  customer_phone: string | null;
  city: string | null;
  lang: string;
  created_by: string | null;
  mc_uuid: string | null;
  checkout_url: string | null;
  short_link: string | null;
  receipt_url: string | null;
  ps: string | null;
  card_pan: string | null;
  nasiya_buyer_id: number | null;
  nasiya_order_id: number | null;
  nasiya_contract_id: number | null;
  nasiya_period: string | null;
  nasiya_total: number | null;
  paid_at: string | null;
  error: string | null;
}

export type NewPayment = Pick<Payment, 'source' | 'provider' | 'product_id' | 'qty' | 'amount_uzs' | 'lang'> &
  Partial<Pick<Payment, 'customer_name' | 'customer_phone' | 'city' | 'created_by'>>;

export interface Store {
  products(): Promise<Product[]>;
  product(id: string): Promise<Product | null>;
  create(row: NewPayment): Promise<Payment>;
  update(id: string, patch: Partial<Payment>): Promise<Payment>;
  /** Sets fields only if the current status is one of `from`; returns null when nothing changed. */
  transition(id: string, from: PaymentStatus[], patch: Partial<Payment>): Promise<Payment | null>;
  get(id: string): Promise<Payment | null>;
  byNumber(number: number): Promise<Payment | null>;
  list(limit: number): Promise<Payment[]>;
}

class SupabaseStore implements Store {
  private db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  private check<T>(res: { data: T; error: { message: string } | null }): T {
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  async products() {
    return this.check(await this.db.from('uz_products').select('*').eq('active', true).order('sort')) as Product[];
  }
  async product(id: string) {
    return this.check(await this.db.from('uz_products').select('*').eq('id', id).eq('active', true).maybeSingle()) as Product | null;
  }
  async create(row: NewPayment) {
    return this.check(await this.db.from('uz_payments').insert(row).select().single()) as Payment;
  }
  async update(id: string, patch: Partial<Payment>) {
    const res = await this.db.from('uz_payments').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    return this.check(res) as Payment;
  }
  async transition(id: string, from: PaymentStatus[], patch: Partial<Payment>) {
    const res = await this.db
      .from('uz_payments')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', from)
      .select()
      .maybeSingle();
    return this.check(res) as Payment | null;
  }
  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.check(await this.db.from('uz_payments').select('*').eq('id', id).maybeSingle()) as Payment | null;
  }
  async byNumber(number: number) {
    return this.check(await this.db.from('uz_payments').select('*').eq('number', number).maybeSingle()) as Payment | null;
  }
  async list(limit: number) {
    return this.check(await this.db.from('uz_payments').select('*').order('created_at', { ascending: false }).limit(limit)) as Payment[];
  }
}

class MemoryStore implements Store {
  private items = new Map<string, Payment>();
  private seq = 1000;
  private catalog: Product[] = [
    { id: 'marine', name_ru: 'WEGLOW Marine Collagen (30 саше)', name_uz: 'WEGLOW Marine Collagen (30 ta sashe)', price_uzs: 100000, mxik: '06401004002000000', package_code: '1506113', vat_percent: null, nasiya_product_id: 1, nasiya_category: 1, nasiya_unit_id: 1, active: true, sort: 1 },
    { id: 'vitc', name_ru: 'WEGLOW Marine Collagen + Vitamin C (30 саше)', name_uz: 'WEGLOW Marine Collagen + Vitamin C (30 ta sashe)', price_uzs: 120000, mxik: '06401004002000000', package_code: '1506113', vat_percent: null, nasiya_product_id: 2, nasiya_category: 1, nasiya_unit_id: 1, active: true, sort: 2 },
  ];

  async products() { return this.catalog; }
  async product(id: string) { return this.catalog.find((p) => p.id === id) ?? null; }
  async create(row: NewPayment) {
    const p = {
      id: crypto.randomUUID(), number: ++this.seq, created_at: new Date().toISOString(), status: 'new', customer_name: null, customer_phone: null,
      city: null, created_by: null, mc_uuid: null, checkout_url: null, short_link: null, receipt_url: null, ps: null,
      card_pan: null, nasiya_buyer_id: null, nasiya_order_id: null, nasiya_contract_id: null, nasiya_period: null,
      nasiya_total: null, paid_at: null, error: null, ...row,
    } as Payment;
    this.items.set(p.id, p);
    return p;
  }
  async update(id: string, patch: Partial<Payment>) {
    const p = { ...this.items.get(id)!, ...patch };
    this.items.set(id, p);
    return p;
  }
  async transition(id: string, from: PaymentStatus[], patch: Partial<Payment>) {
    const p = this.items.get(id);
    if (!p || !from.includes(p.status)) return null;
    return this.update(id, patch);
  }
  async get(id: string) { return this.items.get(id) ?? null; }
  async byNumber(number: number) { return [...this.items.values()].find((p) => p.number === number) ?? null; }
  async list(limit: number) { return [...this.items.values()].reverse().slice(0, limit); }
}

export const store: Store = env('PAY_DEV_MEMORY') === '1' ? new MemoryStore() : new SupabaseStore();
