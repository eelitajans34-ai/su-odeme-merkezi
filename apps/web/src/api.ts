export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

function csrfToken(): string | null {
  const m = document.cookie.match(/(?:^|; )su_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function newIdempotencyKey() {
  return `web-${crypto.randomUUID()}`;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const t = csrfToken();
    if (t) headers['x-csrf-token'] = t;
  }
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'İstek başarısız.', e.details);
  }
  return data as T;
}

export const tl = (minor: number | null | undefined) =>
  minor == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(minor / 100);

export const toMinor = (s: string) => {
  const n = Number(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};

export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('tr-TR') : '—');
