import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.js';
import { handlePaymentWebhook } from '../services/payment-events.js';
import { parse, z } from '../lib/validate.js';

/** Ödeme sağlayıcısı webhook'ları. İmza ham gövde üzerinden doğrulanır; bu yüzden gövde metin olarak alınır. */
export async function webhookRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/api/webhooks/payment/:providerCode', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { providerCode } = parse(z.object({ providerCode: z.string().regex(/^[a-z0-9-]{2,30}$/) }), req.params);
    const allowed = await allowedIps(deps, providerCode);
    if (allowed.length && !allowed.includes(req.ip)) {
      return reply.status(403).send({ error: 'ip_not_allowed' });
    }
    const raw = typeof req.body === 'string' ? req.body : '';
    const r = await handlePaymentWebhook(deps, providerCode, raw, req.headers as Record<string, string>);
    return reply.status(r.status).send(r.body);
  });
}

async function allowedIps(deps: Deps, providerCode: string): Promise<string[]> {
  const { mode } = await deps.integrations.mode(deps.db);
  const r = await deps.db.query(
    `SELECT c.allowed_ips FROM payment_provider_configs c JOIN payment_providers p ON p.id = c.provider_id WHERE p.code = $1 AND c.environment = $2`,
    [providerCode, mode],
  );
  // Basit tam eşleşme; CIDR desteği için ters vekil sunucu (reverse proxy) katmanında filtreleme önerilir
  return (r.rows[0]?.allowed_ips ?? []).filter((ip: string) => !ip.includes('/'));
}
