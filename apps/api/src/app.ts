import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import type { Deps } from './context.js';
import { createPool, type Db } from './db.js';
import { AdapterRegistry } from './integrations/registry.js';
import { AuthService } from './auth/service.js';
import { makeGuards } from './auth/guards.js';
import { AppError } from './lib/errors.js';
import { LOG_REDACT_PATHS } from './lib/redact.js';
import { IntegrationService } from './services/integrations.js';
import { NotificationService } from './services/notifications.js';
import { SecretStore } from './services/secrets.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/user.js';
import { webhookRoutes } from './routes/webhooks.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { paymentServiceRoutes } from './routes/admin/payment-service.js';
import { utilityRoutes } from './routes/admin/utility.js';
import { adminUserOpsRoutes } from './routes/admin/users-ops.js';

export function createDeps(config: AppConfig, db: Db = createPool(config.DATABASE_URL)): Deps {
  const secrets = new SecretStore(Buffer.from(config.SECRETS_ENCRYPTION_KEY, 'base64'));
  const registry = new AdapterRegistry(config.allowSandboxAdapters);
  return {
    config,
    db,
    secrets,
    registry,
    integrations: new IntegrationService(config, registry, secrets),
    notifications: new NotificationService(db, secrets, { appEnv: config.APP_ENV, emailFrom: config.EMAIL_FROM, emailSecretRef: config.EMAIL_PROVIDER_SECRET_REF }),
    now: () => new Date(),
  };
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL, redact: { paths: LOG_REDACT_PATHS, censor: '[GİZLENDİ]' } },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  app.decorateRequest('auth', null);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], formAction: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key', 'authorization'],
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // TLS zorunluluğu: üretimde yalnızca HTTPS (TLS sonlandırması vekil sunucuda yapılır)
  if (config.isProduction) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.protocol !== 'https') return reply.status(400).send({ error: { code: 'TLS_REQUIRED', message: 'HTTPS zorunludur.' } });
    });
  }

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Çok fazla istek. Lütfen biraz sonra tekrar deneyin.' } });
    if (err.validation || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || (err.statusCode && err.statusCode < 500)) {
      return reply.status(err.statusCode ?? 400).send({ error: { code: 'BAD_REQUEST', message: 'İstek geçersiz.' } });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'Beklenmeyen hata');
    // İç hata ayrıntıları (ve olası gizli bilgiler) istemciye gönderilmez
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu.' } });
  });

  const auth = new AuthService(deps);
  const guards = makeGuards(auth, async () => {
    const r = await deps.db.query(`SELECT value FROM system_settings WHERE key = 'admin_mfa_max_age_minutes'`);
    return Number(r.rows[0]?.value ?? 15);
  });

  app.get('/api/health', async () => {
    await deps.db.query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(async (s) => authRoutes(s, { deps, auth, guards }));
  await app.register(async (s) => userRoutes(s, { deps, guards }));
  await app.register(async (s) => webhookRoutes(s, { deps }));
  await app.register(async (s) => sandboxRoutes(s, { deps, guards }));
  await app.register(async (s) => paymentServiceRoutes(s, { deps, guards }));
  await app.register(async (s) => utilityRoutes(s, { deps, guards }));
  await app.register(async (s) => adminUserOpsRoutes(s, { deps, guards }));
  return app;
}
