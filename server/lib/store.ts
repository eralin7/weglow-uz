// Products and payments in SQLite. The database file lives on the server in Uzbekistan
// (personal data of Uzbek customers must be stored in the country).
import { DatabaseSync } from 'node:sqlite';
import { env, token } from './util.ts';

export interface Product {
  id: string;
  name_ru: string;
  name_uz: string;
  price_uzs: number | null;
  mxik: string | null; // ИКПУ, 17 digits (tasnif.soliq.uz)
  package_code: string | null;
  vat_percent: number; // 0 if the company is not a VAT payer
  nasiya_product_id: number | null;
  nasiya_category: number | null;
  nasiya_unit_id: number | null;
  active: number;
  sort: number;
}

export type PaymentStatus = 'new' | 'pending' | 'paid' | 'cancelled' | 'failed' | 'refunded';

export interface Payment {
  id: string;
  number: number; // shown as WG-1001
  token: string; // for the manager payment link /p/<number>-<token>
  created_at: string;
  updated_at: string;
  source: 'site' | 'manager';
  provider: 'uzum' | 'nasiya';
  status: PaymentStatus;
  product_id: string;
  qty: number;
  amount_uzs: number;
  customer_name: string | null;
  customer_phone: string | null;
  lang: string;
  created_by: string | null;
  uzum_order_id: string | null; // orderId of the latest Uzum Checkout registration
  attempts: number; // registrations made; orderNumber is WG-1001, WG-1001-2, ...
  checkout_url: string | null;
  nasiya_buyer_id: number | null;
  nasiya_order_id: number | null;
  nasiya_contract_id: number | null;
  nasiya_period: string | null;
  nasiya_total: number | null;
  paid_at: string | null;
  error: string | null;
}

export type NewPayment = Pick<Payment, 'source' | 'provider' | 'product_id' | 'qty' | 'amount_uzs' | 'lang'> &
  Partial<Pick<Payment, 'customer_name' | 'customer_phone' | 'created_by'>>;

const PRODUCT_FIELDS = ['price_uzs', 'mxik', 'package_code', 'vat_percent', 'nasiya_product_id', 'nasiya_category', 'nasiya_unit_id', 'active'] as const;
export type ProductPatch = Partial<Pick<Product, typeof PRODUCT_FIELDS[number]>>;

export class Store {
  private db: DatabaseSync;

  constructor(path = env('DB_PATH', './data/weglow.db')) {
    if (path !== ':memory:') Deno.mkdirSync(path.replace(/\/[^/]+$/, '') || '.', { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma foreign_keys = on;
      create table if not exists products (
        id text primary key, name_ru text not null, name_uz text not null, price_uzs integer,
        mxik text, package_code text, vat_percent integer not null default 0,
        nasiya_product_id integer, nasiya_category integer, nasiya_unit_id integer default 1,
        active integer not null default 1, sort integer not null default 0
      );
      insert or ignore into products (id, name_ru, name_uz, nasiya_product_id, sort) values
        ('marine', 'WEGLOW Marine Collagen (30 саше)', 'WEGLOW Marine Collagen (30 ta sashe)', 1, 1),
        ('vitc', 'WEGLOW Marine Collagen + Vitamin C (30 саше)', 'WEGLOW Marine Collagen + Vitamin C (30 ta sashe)', 2, 2);
      create table if not exists payments (
        id text primary key, number integer not null unique, token text not null,
        created_at text not null, updated_at text not null,
        source text not null check (source in ('site', 'manager')),
        provider text not null check (provider in ('uzum', 'nasiya')),
        status text not null default 'new' check (status in ('new', 'pending', 'paid', 'cancelled', 'failed', 'refunded')),
        product_id text not null references products (id), qty integer not null, amount_uzs integer not null,
        customer_name text, customer_phone text, lang text not null default 'ru', created_by text,
        uzum_order_id text, attempts integer not null default 0, checkout_url text,
        nasiya_buyer_id integer, nasiya_order_id integer unique, nasiya_contract_id integer,
        nasiya_period text, nasiya_total real, paid_at text, error text
      );
      create index if not exists payments_created on payments (created_at desc);
      create index if not exists payments_uzum on payments (uzum_order_id);
    `);
  }

  products(all = false): Product[] {
    const sql = `select * from products ${all ? '' : 'where active = 1'} order by sort`;
    return this.db.prepare(sql).all() as unknown as Product[];
  }

  product(id: string): Product | null {
    return (this.db.prepare('select * from products where id = ? and active = 1').get(id) as unknown as Product) ?? null;
  }

  updateProduct(id: string, patch: ProductPatch): Product | null {
    const keys = PRODUCT_FIELDS.filter((k) => k in patch);
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      this.db.prepare(`update products set ${sets} where id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
    }
    return (this.db.prepare('select * from products where id = ?').get(id) as unknown as Product) ?? null;
  }

  create(row: NewPayment): Payment {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const next = this.db.prepare('select coalesce(max(number), 1000) + 1 as n from payments').get() as { n: number };
    this.db.prepare(`
      insert into payments (id, number, token, created_at, updated_at, source, provider, product_id, qty, amount_uzs,
                            customer_name, customer_phone, lang, created_by)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, next.n, token(), now, now, row.source, row.provider, row.product_id, row.qty, row.amount_uzs,
      row.customer_name ?? null, row.customer_phone ?? null, row.lang, row.created_by ?? null);
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Payment>): Payment {
    this.set(id, patch);
    return this.get(id)!;
  }

  /** Applies `patch` only if the current status is one of `from`; returns null when nothing changed. */
  transition(id: string, from: PaymentStatus[], patch: Partial<Payment>): Payment | null {
    const changed = this.set(id, patch, from);
    return changed ? this.get(id) : null;
  }

  private set(id: string, patch: Partial<Payment>, from?: PaymentStatus[]): boolean {
    const keys = Object.keys(patch).filter((k) => k !== 'id') as (keyof Payment)[];
    const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
    const where = from ? ` and status in (${from.map(() => '?').join(', ')})` : '';
    const res = this.db.prepare(`update payments set ${sets} where id = ?${where}`)
      .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), new Date().toISOString(), id, ...(from ?? []));
    return Number(res.changes) > 0;
  }

  get(id: string): Payment | null {
    return (this.db.prepare('select * from payments where id = ?').get(id) as unknown as Payment) ?? null;
  }

  byNumber(number: number): Payment | null {
    return (this.db.prepare('select * from payments where number = ?').get(number) as unknown as Payment) ?? null;
  }

  byUzumOrder(orderId: string): Payment | null {
    return (this.db.prepare('select * from payments where uzum_order_id = ?').get(orderId) as unknown as Payment) ?? null;
  }

  list(limit: number): Payment[] {
    return this.db.prepare('select * from payments order by created_at desc limit ?').all(limit) as unknown as Payment[];
  }
}
