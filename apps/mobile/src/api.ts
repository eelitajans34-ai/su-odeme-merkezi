import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Mobil API istemcisi.
 * - Oturum belirteci yalnızca cihazın güvenli deposunda (iOS Keychain / Android Keystore) tutulur.
 * - Uygulamada hiçbir API gizli anahtarı, ödeme anahtarı veya yönetici işlemi bulunmaz;
 *   ödeme sağlayıcının güvenli sayfasında yapılır, sonuç sunucu tarafında doğrulanır.
 */
const BASE: string = (Constants.expoConfig?.extra as any)?.apiBaseUrl ?? '';
const TOKEN_KEY = 'su_session_token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}
export async function setToken(t: string | null) {
  if (t) await SecureStore.setItemAsync(TOKEN_KEY, t, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export function idempotencyKey() {
  return `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  if (!BASE.startsWith('https://') && !__DEV__) throw new Error('API adresi https olmalıdır.');
  const token = await getToken();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`${BASE}${path}`, { method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && data?.error?.code === 'UNAUTHORIZED') await setToken(null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'İstek başarısız.', data?.error?.details);
  return data as T;
}

export const tl = (minor?: number | null) => (minor == null ? '—' : `${(minor / 100).toFixed(2).replace('.', ',')} TL`);
