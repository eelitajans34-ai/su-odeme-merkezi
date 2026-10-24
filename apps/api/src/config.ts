import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_BASE_URL: z.url().default('http://localhost:5173'),
  API_PUBLIC_URL: z.url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET en az 32 karakter olmalı'),
  // Yerel şifreli kasa için 32 baytlık anahtar (base64). Üretimde bulut KMS/secret manager tercih edilir.
  SECRETS_ENCRYPTION_KEY: z.string().min(1),
  SUPER_ADMIN_EMAIL: z.email().optional(),
  MFA_REQUIRED_FOR_SUPER_ADMIN: bool.default(true),
  SECRET_MANAGER_REFERENCE: z.string().default('local-encrypted-db'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: bool.default(false),
  PAYMENT_PROVIDER_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
  WATER_UTILITY_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
  // E-posta: standart SMTP. Sağlayıcıya özel API uydurulmaz.
  EMAIL_FROM: z.string().optional(),
  EMAIL_PROVIDER_SECRET_REF: z.string().optional(),
  SMS_PROVIDER_SECRET_REF: z.string().optional(),
  BACKUP_STORAGE_REFERENCE: z.string().optional(),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof schema> & {
  isProduction: boolean;
  allowSandboxAdapters: boolean;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Ortam değişkenleri geçersiz: ${issues}`);
  }
  const c = parsed.data;
  const isProduction = c.APP_ENV === 'production';
  if (isProduction) {
    if (!c.APP_BASE_URL.startsWith('https://') || !c.API_PUBLIC_URL.startsWith('https://')) {
      throw new Error('Üretimde APP_BASE_URL ve API_PUBLIC_URL https olmalıdır (TLS zorunlu).');
    }
    if (/change-me|example|test|dev/i.test(c.AUTH_SECRET)) {
      throw new Error('Üretimde varsayılan/örnek AUTH_SECRET kullanılamaz.');
    }
    if (!c.MFA_REQUIRED_FOR_SUPER_ADMIN) {
      throw new Error('Üretimde süper yönetici için MFA kapatılamaz.');
    }
  }
  const key = Buffer.from(c.SECRETS_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('SECRETS_ENCRYPTION_KEY base64 kodlu 32 bayt olmalıdır.');
  }
  return {
    ...c,
    isProduction,
    // Uygulama içi simülatör adaptörleri (SANDBOX) üretim dağıtımında asla kullanılamaz.
    allowSandboxAdapters: !isProduction,
    corsOrigins: c.CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
