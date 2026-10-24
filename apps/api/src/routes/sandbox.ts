import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.js';
import type { makeGuards } from '../auth/guards.js';
import { handlePaymentWebhook } from '../services/payment-events.js';
import { notFound } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';

type Guards = ReturnType<typeof makeGuards>;

/**
 * YALNIZCA GELİŞTİRME/TEST: ödeme simülatörü sayfası. Üretimde bu rotalar hiç kaydedilmez.
 * Gerçek ödeme alınmaz; kart bilgisi istenmez.
 */
export async function sandboxRoutes(app: FastifyInstance, { deps, guards }: { deps: Deps; guards: Guards }) {
  if (!deps.config.allowSandboxAdapters) return;
  const sim = deps.registry.sandboxPayment;

  async function ctxFor(ref: string) {
    const p = (await deps.db.query('SELECT provider_id, environment FROM payment_transactions WHERE provider_payment_ref = $1', [ref])).rows[0];
    if (!p) throw notFound();
    const rt = await deps.integrations.paymentRuntimeForProvider(deps.db, p.provider_id, p.environment);
    if (!rt?.provider || rt.adapter !== sim) throw notFound();
    return { rt, providerCode: rt.provider!.code as string };
  }

  app.get('/api/sandbox/checkout/:ref', async (req, reply) => {
    const { ref } = parse(z.object({ ref: z.string().max(80) }), req.params);
    const p = sim.payments.get(ref);
    if (!p) throw notFound();
    const amount = (p.amountMinor / 100).toFixed(2);
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test ödeme simülatörü</title></head>
<body style="font-family:system-ui;max-width:480px;margin:40px auto;padding:0 16px">
<p style="background:#fde68a;padding:12px;border-radius:8px"><strong>TEST ÖDEME SİMÜLATÖRÜ</strong> — Gerçek ödeme alınmaz. Kart bilgisi girmeyin.</p>
<h1 style="font-size:20px">Sipariş ${escapeHtml(p.orderRef)}</h1><p>Tutar: <strong>${amount} ${escapeHtml(p.currency)}</strong></p>
<form method="post" action="/api/sandbox/checkout/${encodeURIComponent(ref)}/complete"><input type="hidden" name="outcome" value="SUCCEEDED"><button style="padding:10px 16px">Başarılı ödeme simüle et</button></form>
<form method="post" action="/api/sandbox/checkout/${encodeURIComponent(ref)}/complete" style="margin-top:12px"><input type="hidden" name="outcome" value="FAILED"><button style="padding:10px 16px">Başarısız ödeme simüle et</button></form>
</body></html>`;
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.post('/api/sandbox/checkout/:ref/complete', async (req, reply) => {
    const { ref } = parse(z.object({ ref: z.string().max(80) }), req.params);
    const { outcome } = parse(z.object({ outcome: z.enum(['SUCCEEDED', 'FAILED']) }), req.body);
    const { rt, providerCode } = await ctxFor(ref);
    const ev = sim.simulateOutcome(rt.ctx, ref, outcome);
    await handlePaymentWebhook(deps, providerCode, ev.body, ev.headers);
    const t = (await deps.db.query(
      `SELECT 'yukleme' AS kind, t.id FROM topup_transactions t JOIN payment_transactions p ON p.id = t.payment_transaction_id WHERE p.provider_payment_ref = $1
       UNION ALL SELECT 'fatura', t.id FROM bill_payment_transactions t JOIN payment_transactions p ON p.id = t.payment_transaction_id WHERE p.provider_payment_ref = $1`,
      [ref],
    )).rows[0];
    return reply.redirect(`${deps.config.APP_BASE_URL}/islemler/${t?.kind ?? 'yukleme'}/${t?.id ?? ''}`, 303);
  });

  // Simülatörde iadenin sağlayıcı tarafından tamamlandığını bildiren imzalı webhook'u tetikler (yetkili personel)
  app.post('/api/sandbox/refunds/:providerRefundRef/complete', { preHandler: guards.requirePermission('refunds.approve') }, async (req) => {
    const { providerRefundRef } = parse(z.object({ providerRefundRef: z.string().max(80) }), req.params);
    const r = sim.refunds.get(providerRefundRef);
    if (!r) throw notFound();
    const { rt, providerCode } = await ctxFor(r.providerPaymentRef);
    const ev = sim.simulateRefundCompleted(rt.ctx, providerRefundRef);
    return handlePaymentWebhook(deps, providerCode, ev.body, ev.headers);
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
