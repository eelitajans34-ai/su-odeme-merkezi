// Denetim kayıtlarına ve günlüklere yazılmadan önce hassas alanların ayıklanması.
const SENSITIVE_KEY = /pass(word)?|parola|otp|totp|secret|token|api[_-]?key|authorization|cookie|cvv|cvc|pan|card_?number|kart_?no|private|signature|recovery/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[derin]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[GİZLENDİ]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && /\b\d{13,19}\b/.test(value)) {
    // Olası kart numarası
    return value.replace(/\b\d{13,19}\b/g, '[GİZLENDİ]');
  }
  return value;
}

/** pino redaction yolları */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.code',
  '*.token',
  '*.secret',
  '*.value',
  '*.apiKey',
];
