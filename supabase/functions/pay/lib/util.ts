import { crypto } from 'jsr:@std/crypto@1';
import { encodeHex } from 'jsr:@std/encoding@1/hex';

export const env = (key: string, fallback = ''): string => Deno.env.get(key) ?? fallback;

const allowedOrigins = env('CORS_ORIGINS', 'https://weglow.uz,https://www.weglow.uz')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('Origin') ?? '';
  const allow = allowedOrigins.includes('*') ? '*' : allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

/** Uzbek mobile number → 998XXXXXXXXX, or null. */
export function normalizeUzPhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  const full = digits.length === 9 ? '998' + digits : digits;
  return /^998\d{9}$/.test(full) ? full : null;
}

/** Any phone the client typed (kept for the manager), 9–15 digits. */
export function loosePhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15 ? digits : null;
}

export function cleanText(raw: unknown, max = 120): string {
  return String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

export function parseQty(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 99) throw new HttpError(400, 'BAD_QTY');
  return n;
}

export async function md5(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
  return encodeHex(buf);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function formatSum(uzs: number | string): string {
  return Math.round(Number(uzs)).toLocaleString('ru-RU').replace(/ /g, ' ') + ' сум';
}
