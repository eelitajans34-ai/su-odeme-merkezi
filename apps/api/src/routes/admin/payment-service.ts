import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../context.js';
import { actorOf, type makeGuards } from '../../auth/guards.js';
import { withTransaction } from '../../db.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { maskTail } from '../../lib/mask.js';
import { parse, z } from '../../lib/validate.js';
import { audit } from '../../services/audit.js';
import { itemsToCsv, runReconciliation } from '../../services/reconciliation.js';
import { approveRefund, completeManualRefund, rejectRefund, requestRefund } from '../../services/refunds.js';
import { SecretStore } from '../../services/secrets.js';
import { USER_STATUS_TEXT } from '../../services/state-machine.js';

type Guards = ReturnType<typeof makeGuards>;
const env = z.enum(['TEST', 'LIVE']);
const P = '/api/admin/payment-service';

/** Güvenli Ödeme Hizmeti yönetim paneli API'si (bölüm 7, A–H) */
export async function paymentServiceRoutes(app: FastifyInstance, { deps, guards }: { deps: Deps; guards: Guards }) {
  const db = deps.db;
  const read = { preHandler: guards.requirePermission('payment_service.read') };
  const manage = { preHandler: guards.requirePermission('payment_service.manage', { fresh: true }) };

  async function configView(providerId: string, environment: 'TEST' | 'LIVE') {
    const c = (await db.query('SELECT * FROM payment_provider_configs WHERE provider_id = $1 AND environment = $2', [providerId, environment])).rows[0];
    if (!c) return null;
    const editor = c.updated_by ? (await db.query('SELECT email FROM users WHERE id = $1', [c.updated_by])).rows[0]?.email : null;
    return {
      environment: c.environment,
      apiBaseUrl: c.api_base_url,
      merchantId: c.merchant_id,
      apiKey: await deps.secrets.meta(db, c.api_key_secret_ref),          // yalnızca meta: tanımlı mı, parmak izi, maskeli ipucu
      webhookSecret: await deps.secrets.meta(db, c.webhook_secret_ref),
      webhookUrl: c.webhook_url,
      webhookSignatureRequired: c.webhook_signature_required,
      webhookToleranceSeconds: c.webhook_tolerance_seconds,
      currency: c.currency?.trim(),
      minAmountMinor: c.min_amount_minor,
      maxAmountMinor: c.max_amount_minor,
      dailyUserLimitMinor: c.daily_user_limit_minor,
      allowedIps: c.allowed_ips,
      supportsRefund: c.supports_refund,
      lastConnectionTestAt: c.last_connection_test_at,
      lastConnectionTestOk: c.last_connection_test_ok,
      lastConnectionError: c.last_connection_error,
      certificateExpiresAt: c.certificate_expires_at,
      updatedAt: c.updated_at,
      updatedBy: editor,
    };
  }

  // A. Genel bakış
  app.get(`${P}/overview`, read, async () => {
    const state = await deps.integrations.mode(db);
    const rt = await deps.integrations.paymentRuntime(db);
    const counts = (
      await db.query(`SELECT
        (SELECT count(*) FROM payment_transactions WHERE status = 'PENDING') AS pending_payments,
        (SELECT count(*) FROM topup_transactions WHERE status IN ('PAYMENT_CONFIRMED','TOPUP_PENDING','UNKNOWN')) +
        (SELECT count(*) FROM bill_payment_transactions WHERE status IN ('PAYMENT_CONFIRMED','COLLECTION_PENDING','UNKNOWN')) AS pending_fulfillment,
        (SELECT count(*) FROM refunds WHERE status IN ('PENDING_APPROVAL','APPROVED','SUBMITTED','MANUAL_ACTION_REQUIRED')) AS pending_refunds,
        (SELECT count(*) FROM topup_transactions WHERE status = 'REQUIRES_REVIEW') + (SELECT count(*) FROM bill_payment_transactions WHERE status = 'REQUIRES_REVIEW') AS requires_review,
        (SELECT max(finished_at) FROM reconciliation_runs WHERE status IN ('COMPLETED','COMPLETED_WITH_ISSUES')) AS last_reconciliation,
        (SELECT max(received_at) FROM webhook_events WHERE source='PAYMENT_PROVIDER' AND signature_valid) AS last_valid_webhook,
        (SELECT count(*) FROM webhook_events WHERE source='PAYMENT_PROVIDER' AND NOT signature_valid AND received_at > now() - interval '24 hours') AS rejected_webhooks_24h`)
    ).rows[0];
    const recent = (await db.query(`SELECT public_ref, purpose, amount_minor, status, environment, created_at FROM payment_transactions ORDER BY created_at DESC LIMIT 10`)).rows;
    const readiness = await deps.integrations.readiness(db, 'TOPUP', null);
    return {
      mode: state.mode,
      modeBanner: state.mode === 'LIVE' ? 'CANLI MOD — gerçek ödemeler' : 'TEST MODU — gerçek ödeme alınmaz',
      provider: rt.provider ? { id: rt.provider.id, name: rt.provider.display_name, adapter: rt.adapter.code, isSimulator: rt.adapter.isSimulator } : null,
      configurationStatus: !rt.provider ? 'Kurulum bekleniyor' : rt.adapter.code === 'NONE' ? 'Yetkilendirme bekleniyor (adaptör/sözleşme yok)' : readiness.ok ? 'Hazır' : 'Eksik yapılandırma',
      readiness,
      counts,
      recentPayments: recent,
      alerts: (await db.query(`SELECT id, event_type, severity, title, body, created_at FROM notifications WHERE audience='ADMIN' AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 20`)).rows,
    };
  });

  // B. Sağlayıcı yapılandırması
  app.get(`${P}/providers`, read, async () => {
    const { rows } = await db.query('SELECT p.*, (s.active_provider_id = p.id) AS is_active_provider FROM payment_providers p CROSS JOIN payment_service_state s ORDER BY p.created_at');
    const out = [];
    for (const p of rows) {
      out.push({ id: p.id, code: p.code, displayName: p.display_name, adapterCode: p.adapter_code, isActive: p.is_active_provider, test: await configView(p.id, 'TEST'), live: await configView(p.id, 'LIVE') });
    }
    return { providers: out, availableAdapters: deps.registry.availablePaymentAdapters() };
  });

  app.post(`${P}/providers`, manage, async (req) => {
    const body = parse(z.object({ code: z.string().regex(/^[a-z0-9-]{2,30}$/), displayName: z.string().trim().min(2).max(100), adapterCode: z.string().max(40) }).strict(), req.body);
    if (!deps.registry.availablePaymentAdapters().some((a) => a.code === body.adapterCode)) {
      throw badRequest('Bu adaptör kayıtlı değil. Gerçek sağlayıcı adaptörü, sağlayıcının resmî dokümanıyla geliştirilmelidir.', 'UNKNOWN_ADAPTER');
    }
    try {
      const { rows } = await db.query('INSERT INTO payment_providers (code, display_name, adapter_code) VALUES ($1,$2,$3) RETURNING id', [body.code, body.displayName, body.adapterCode]);
      await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_provider.create', targetType: 'payment_provider', targetId: rows[0].id, ip: req.ip, details: body });
      return { id: rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Bu kod zaten kullanılıyor.');
      throw e;
    }
  });

  app.put(`${P}/providers/:id/config/:env`, manage, async (req) => {
    const { id, env: environment } = parse(z.object({ id: z.uuid(), env }), req.params);
    const body = parse(
      z.object({
        apiBaseUrl: z.url().refine((u) => u.startsWith('https://'), 'API adresi https olmalı').nullable(),
        merchantId: z.string().trim().max(64).nullable(),
        webhookToleranceSeconds: z.number().int().min(30).max(900),
        currency: z.string().regex(/^[A-Z]{3}$/),
        minAmountMinor: z.number().int().positive(),
        maxAmountMinor: z.number().int().positive(),
        dailyUserLimitMinor: z.number().int().positive(),
        allowedIps: z.array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])).max(50),
        supportsRefund: z.boolean(),
        certificateExpiresAt: z.iso.datetime().nullable().optional(),
      }).strict(),
      req.body,
    );
    if (body.maxAmountMinor < body.minAmountMinor) throw badRequest('Azami tutar asgari tutardan küçük olamaz.');
    const provider = (await db.query('SELECT code FROM payment_providers WHERE id = $1', [id])).rows[0];
    if (!provider) throw notFound();
    const webhookUrl = `${deps.config.API_PUBLIC_URL}/api/webhooks/payment/${provider.code}`;
    await db.query(
      `INSERT INTO payment_provider_configs (provider_id, environment, api_base_url, merchant_id, webhook_url, webhook_tolerance_seconds, currency,
         min_amount_minor, max_amount_minor, daily_user_limit_minor, allowed_ips, supports_refund, certificate_expires_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (provider_id, environment) DO UPDATE SET api_base_url = EXCLUDED.api_base_url, merchant_id = EXCLUDED.merchant_id, webhook_url = EXCLUDED.webhook_url,
         webhook_tolerance_seconds = EXCLUDED.webhook_tolerance_seconds, currency = EXCLUDED.currency, min_amount_minor = EXCLUDED.min_amount_minor,
         max_amount_minor = EXCLUDED.max_amount_minor, daily_user_limit_minor = EXCLUDED.daily_user_limit_minor, allowed_ips = EXCLUDED.allowed_ips,
         supports_refund = EXCLUDED.supports_refund, certificate_expires_at = EXCLUDED.certificate_expires_at, updated_by = EXCLUDED.updated_by, updated_at = now(),
         last_connection_test_ok = NULL`,
      [id, environment, body.apiBaseUrl, body.merchantId, webhookUrl, body.webhookToleranceSeconds, body.currency, body.minAmountMinor, body.maxAmountMinor, body.dailyUserLimitMinor, body.allowedIps, body.supportsRefund, body.certificateExpiresAt ?? null, req.auth!.userId],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_config.update', targetType: 'payment_provider', targetId: id, ip: req.ip, userAgent: req.headers['user-agent'], details: { environment, ...body } });
    return configView(id, environment);
  });

  // Gizli anahtar girişi: yalnızca yazma. Değer yanıtta, günlükte veya denetim kaydında yer almaz.
  app.put(`${P}/providers/:id/secrets`, { preHandler: guards.requirePermission('secrets.write', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(
      z.object({ kind: z.enum(['API_KEY', 'WEBHOOK_SECRET']), environment: env, value: z.string().min(8).max(4096).optional(), externalRef: z.string().min(3).max(300).optional(), expiresAt: z.iso.datetime().nullable().optional() }).strict(),
      req.body,
    );
    const provider = (await db.query('SELECT code FROM payment_providers WHERE id = $1', [id])).rows[0];
    if (!provider) throw notFound();
    const ref = `payment/${body.environment.toLowerCase()}/${provider.code}-${body.kind === 'API_KEY' ? 'api-key' : 'webhook-secret'}`;
    SecretStore.validateRef(ref, body.environment);
    const meta = await withTransaction(db, async (c) => {
      await c.query(`INSERT INTO payment_provider_configs (provider_id, environment, updated_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, body.environment, req.auth!.userId]);
      const m = await deps.secrets.put(c, { ref, environment: body.environment, value: body.value, externalRef: body.externalRef, expiresAt: body.expiresAt ?? null, actorId: req.auth!.userId });
      const col = body.kind === 'API_KEY' ? 'api_key_secret_ref' : 'webhook_secret_ref';
      await c.query(`UPDATE payment_provider_configs SET ${col} = $3, last_connection_test_ok = NULL, updated_by = $4, updated_at = now() WHERE provider_id = $1 AND environment = $2`, [id, body.environment, ref, req.auth!.userId]);
      await audit(c, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'secret.rotate', targetType: 'secret', targetId: ref, ip: req.ip, details: { kind: body.kind, environment: body.environment, fingerprint: m.fingerprint } });
      return m;
    });
    return meta;
  });

  app.post(`${P}/providers/:id/activate`, manage, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const p = (await db.query('SELECT id FROM payment_providers WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound();
    await db.query('UPDATE payment_service_state SET active_provider_id = $1, updated_at = now() WHERE id', [id]);
    await db.query('UPDATE payment_providers SET is_active = (id = $1)', [id]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_provider.activate', targetType: 'payment_provider', targetId: id, ip: req.ip });
    return { ok: true };
  });

  // H. Bağlantı testi
  app.post(`${P}/providers/:id/test/:env`, manage, async (req) => {
    const { id, env: environment } = parse(z.object({ id: z.uuid(), env }), req.params);
    const rt = await deps.integrations.paymentRuntimeForProvider(db, id, environment);
    if (!rt) throw notFound();
    const started = Date.now();
    let result: { ok: boolean; code: string; message: string };
    if (!rt.config) result = { ok: false, code: 'NO_CONFIG', message: `${environment} yapılandırması yok.` };
    else if (environment === 'LIVE' && rt.adapter.isSimulator) result = { ok: false, code: 'SIMULATOR_NOT_ALLOWED', message: 'Simülatör canlı ortamda test edilemez.' };
    else {
      try {
        result = await rt.adapter.testConnection(rt.ctx);
      } catch {
        result = { ok: false, code: 'ERROR', message: 'Bağlantı testi sırasında hata oluştu.' };
      }
    }
    await db.query(
      `INSERT INTO connection_tests (target, target_id, environment, ok, result_code, message, latency_ms, performed_by) VALUES ('PAYMENT_PROVIDER',$1,$2,$3,$4,$5,$6,$7)`,
      [id, environment, result.ok, result.code, result.message, Date.now() - started, req.auth!.userId],
    );
    await db.query(
      `UPDATE payment_provider_configs SET last_connection_test_at = now(), last_connection_test_ok = $3, last_connection_error = $4, last_success_at = CASE WHEN $3 THEN now() ELSE last_success_at END WHERE provider_id = $1 AND environment = $2`,
      [id, environment, result.ok, result.ok ? null : result.message],
    );
    if (!result.ok) await deps.notifications.alertAdmins({ eventType: 'INTEGRATION_CONNECTION_ERROR', severity: environment === 'LIVE' ? 'CRITICAL' : 'WARNING', title: 'Ödeme sağlayıcısı bağlantı hatası', body: `${environment}: ${result.message}` });
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_provider.connection_test', targetType: 'payment_provider', targetId: id, ip: req.ip, details: { environment, ok: result.ok, code: result.code } });
    return result;
  });

  app.get(`${P}/connection`, read, async () => ({
    tests: (await db.query(`SELECT target, environment, ok, result_code, message, latency_ms, created_at FROM connection_tests WHERE target = 'PAYMENT_PROVIDER' ORDER BY created_at DESC LIMIT 50`)).rows,
    webhooks: (await db.query(`SELECT event_type, signature_valid, rejection_reason, received_at, processed_at, processing_error FROM webhook_events WHERE source = 'PAYMENT_PROVIDER' ORDER BY received_at DESC LIMIT 50`)).rows,
    secrets: (await db.query(`SELECT ref, environment, fingerprint, last4_hint, expires_at, rotated_at FROM secret_values WHERE ref LIKE 'payment/%' ORDER BY ref`)).rows,
    goLiveChecklist: (await db.query('SELECT code, title, is_automated, status, evidence_ref, verified_at, note FROM golive_checklist_items ORDER BY sort_order')).rows,
    liveBlockers: await deps.integrations.liveBlockers(db),
  }));

  // C. Sözleşme bilgileri
  app.get(`${P}/providers/:id/contract`, read, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return (await db.query('SELECT * FROM payment_provider_contracts WHERE provider_id = $1', [id])).rows[0] ?? { provider_id: id, empty: true };
  });
  app.put(`${P}/providers/:id/contract`, manage, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(
      z.object({
        legalName: z.string().max(200).nullable(),
        contractNumber: z.string().max(100).nullable(),
        contractDate: z.iso.date().nullable(),
        serviceStartDate: z.iso.date().nullable(),
        authorizedContact: z.object({ name: z.string().max(100).optional(), email: z.email().optional(), phone: z.string().max(30).optional() }).strict(),
        supportChannel: z.string().max(200).nullable(),
        contractDocumentRef: z.string().max(300).nullable(),
        testAccessStatus: z.enum(['NONE', 'REQUESTED', 'GRANTED']),
        productionAccessStatus: z.enum(['NONE', 'REQUESTED', 'GRANTED']),
        liveApprovalStatus: z.enum(['NOT_APPROVED', 'PENDING', 'APPROVED']),
      }).strict(),
      req.body,
    );
    if (b.liveApprovalStatus === 'APPROVED' && (!b.contractNumber || !b.contractDocumentRef || b.productionAccessStatus !== 'GRANTED')) {
      throw badRequest('Canlı kullanım onayı için sözleşme numarası, sözleşme belge referansı ve üretim erişimi gereklidir.');
    }
    await db.query(
      `INSERT INTO payment_provider_contracts (provider_id, legal_name, contract_number, contract_date, service_start_date, authorized_contact, support_channel, contract_document_ref, test_access_status, production_access_status, live_approval_status, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (provider_id) DO UPDATE SET legal_name=EXCLUDED.legal_name, contract_number=EXCLUDED.contract_number, contract_date=EXCLUDED.contract_date,
         service_start_date=EXCLUDED.service_start_date, authorized_contact=EXCLUDED.authorized_contact, support_channel=EXCLUDED.support_channel,
         contract_document_ref=EXCLUDED.contract_document_ref, test_access_status=EXCLUDED.test_access_status, production_access_status=EXCLUDED.production_access_status,
         live_approval_status=EXCLUDED.live_approval_status, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [id, b.legalName, b.contractNumber, b.contractDate, b.serviceStartDate, JSON.stringify(b.authorizedContact), b.supportChannel, b.contractDocumentRef, b.testAccessStatus, b.productionAccessStatus, b.liveApprovalStatus, req.auth!.userId],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_contract.update', targetType: 'payment_provider', targetId: id, ip: req.ip, details: b });
    return { ok: true };
  });

  // D. Komisyon ve ücretler (sürümlü; geçmiş korunur)
  app.get(`${P}/fees`, read, async () => (await db.query(`SELECT f.*, u.email AS created_by_email FROM fee_schedules f LEFT JOIN users u ON u.id = f.created_by ORDER BY transaction_type, effective_from DESC`)).rows);
  app.post(`${P}/fees`, { preHandler: guards.requirePermission('fees.manage', { fresh: true }) }, async (req) => {
    const b = parse(
      z.object({
        transactionType: z.enum(['TOPUP', 'BILL_PAYMENT']),
        feeType: z.enum(['NONE', 'FIXED', 'PERCENT', 'FIXED_PLUS_PERCENT']),
        fixedFeeMinor: z.number().int().min(0).max(100_000),
        percentBps: z.number().int().min(0).max(2000),
        minFeeMinor: z.number().int().min(0),
        maxFeeMinor: z.number().int().min(0).nullable(),
        minAmountMinor: z.number().int().positive(),
        maxAmountMinor: z.number().int().positive(),
        userFacingDescription: z.string().trim().min(5).max(300),
        isSample: z.boolean(),
        effectiveFrom: z.iso.datetime(),
      }).strict(),
      req.body,
    );
    if (!b.isSample) {
      const state = await deps.integrations.mode(db);
      const c = state.activeProviderId ? (await db.query('SELECT contract_number FROM payment_provider_contracts WHERE provider_id = $1', [state.activeProviderId])).rows[0] : null;
      if (!c?.contract_number) throw badRequest('Sözleşme bilgisi girilmeden tarife "gerçek" olarak işaretlenemez; örnek/test tarifesi olarak kaydedin.');
    }
    const { rows } = await db.query(
      `INSERT INTO fee_schedules (transaction_type, fee_type, fixed_fee_minor, percent_bps, min_fee_minor, max_fee_minor, min_amount_minor, max_amount_minor, user_facing_description, is_sample, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.transactionType, b.feeType, b.fixedFeeMinor, b.percentBps, b.minFeeMinor, b.maxFeeMinor, b.minAmountMinor, b.maxAmountMinor, b.userFacingDescription, b.isSample, b.effectiveFrom, req.auth!.userId],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'fees.create', targetType: 'fee_schedule', targetId: rows[0].id, ip: req.ip, details: b });
    return { id: rows[0].id };
  });

  // E. İşlem takibi
  app.get(`${P}/transactions`, { preHandler: guards.requirePermission('transactions.read') }, async (req) => {
    const q = parse(z.object({ type: z.enum(['TOPUP', 'BILL_PAYMENT']).optional(), status: z.string().max(30).optional(), ref: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const parts: string[] = [];
    for (const type of q.type ? [q.type] : ['TOPUP', 'BILL_PAYMENT']) {
      const t = type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions';
      parts.push(`SELECT '${type}' AS type, t.id, t.public_ref, t.status, t.environment, t.amount_minor, t.fee_minor, t.total_minor, t.currency, t.utility_ref, t.error_code, t.error_message, t.created_at, t.completed_at,
        u.email, s.subscriber_no, p.provider_payment_ref, p.public_ref AS payment_ref, p.status AS payment_status,
        (SELECT status FROM refunds r WHERE r.source_id = t.id ORDER BY created_at DESC LIMIT 1) AS refund_status
        FROM ${t} t JOIN users u ON u.id = t.user_id JOIN subscriptions s ON s.id = t.subscription_id LEFT JOIN payment_transactions p ON p.id = t.payment_transaction_id
        WHERE ($1::text IS NULL OR t.status = $1) AND ($2::text IS NULL OR t.public_ref = $2)`);
    }
    const { rows } = await db.query(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT $3`, [q.status ?? null, q.ref ?? null, q.limit]);
    return rows.map((r) => ({ ...r, subscriber_no: undefined, subscriberMasked: maskTail(r.subscriber_no), userEmail: r.email, statusText: USER_STATUS_TEXT[r.status] }));
  });

  app.get(`${P}/transactions/:type/:id/history`, { preHandler: guards.requirePermission('transactions.read') }, async (req) => {
    const p = parse(z.object({ type: z.enum(['TOPUP', 'BILL_PAYMENT']), id: z.uuid() }), req.params);
    return (await db.query('SELECT from_status, to_status, reason, actor, created_at FROM transaction_status_history WHERE source_type = $1 AND source_id = $2 ORDER BY id', [p.type, p.id])).rows;
  });

  // F. İade ve inceleme
  app.get(`${P}/refunds`, { preHandler: guards.requirePermission('transactions.read') }, async () =>
    (await db.query(`SELECT r.*, p.public_ref AS payment_ref, p.provider_payment_ref, ua.email AS approved_by_email FROM refunds r JOIN payment_transactions p ON p.id = r.payment_transaction_id LEFT JOIN users ua ON ua.id = r.approved_by ORDER BY r.created_at DESC LIMIT 200`)).rows,
  );
  app.post(`${P}/refunds`, { preHandler: guards.requirePermission('refunds.request', { fresh: true }) }, async (req) => {
    const b = parse(z.object({ sourceType: z.enum(['TOPUP', 'BILL_PAYMENT']), sourceId: z.uuid(), reason: z.string().trim().min(5).max(500) }).strict(), req.body);
    return { id: await requestRefund(deps, actorOf(req), b.sourceType, b.sourceId, b.reason) };
  });
  app.post(`${P}/refunds/:id/approve`, { preHandler: guards.requirePermission('refunds.approve', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return approveRefund(deps, actorOf(req), id);
  });
  app.post(`${P}/refunds/:id/reject`, { preHandler: guards.requirePermission('refunds.approve', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(3).max(500) }).strict(), req.body);
    await rejectRefund(deps, actorOf(req), id, note);
    return { ok: true };
  });
  app.post(`${P}/refunds/:id/manual-complete`, { preHandler: guards.requirePermission('refunds.approve', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { evidenceRef } = parse(z.object({ evidenceRef: z.string().trim().min(4).max(200) }).strict(), req.body);
    await completeManualRefund(deps, actorOf(req), id, evidenceRef);
    return { ok: true };
  });

  // G. Mutabakat
  app.post(`${P}/reconciliation/runs`, { preHandler: guards.requirePermission('reconciliation.run', { fresh: true }) }, async (req) => {
    const b = parse(z.object({ from: z.iso.datetime(), to: z.iso.datetime() }).strict(), req.body);
    return runReconciliation(deps, actorOf(req), new Date(b.from), new Date(b.to));
  });
  app.get(`${P}/reconciliation/runs`, { preHandler: guards.requirePermission('reconciliation.run') }, async () => (await db.query('SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 50')).rows);
  app.get(`${P}/reconciliation/runs/:id/items`, { preHandler: guards.requirePermission('reconciliation.run') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return (await db.query('SELECT * FROM reconciliation_items WHERE run_id = $1 ORDER BY created_at', [id])).rows;
  });
  app.get(`${P}/reconciliation/review-queue`, { preHandler: guards.requirePermission('reconciliation.run') }, async () => (await db.query(`SELECT * FROM reconciliation_items WHERE review_status = 'OPEN' ORDER BY created_at LIMIT 200`)).rows);
  app.get(`${P}/reconciliation/runs/:id/export.csv`, { preHandler: guards.requirePermission('reconciliation.run') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const rows = (await db.query('SELECT * FROM reconciliation_items WHERE run_id = $1 ORDER BY created_at', [id])).rows;
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'reconciliation.export', targetType: 'reconciliation_run', targetId: id, ip: req.ip });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="mutabakat-${id}.csv"`);
    return itemsToCsv(rows);
  });
  app.post(`${P}/reconciliation/items/:id/review`, { preHandler: guards.requirePermission('reconciliation.run', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ reviewStatus: z.enum(['RESOLVED', 'NOT_AN_ISSUE']), note: z.string().trim().min(3).max(500) }).strict(), req.body);
    await db.query('UPDATE reconciliation_items SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1', [id, b.reviewStatus, b.note, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'reconciliation.review', targetType: 'reconciliation_item', targetId: id, ip: req.ip, details: b });
    return { ok: true };
  });

  // Mod değişimi (TEST ↔ LIVE). Canlıya geçiş tüm engeller kalkmadan yapılamaz.
  app.post(`${P}/mode`, { preHandler: guards.requirePermission('golive.manage', { fresh: true }) }, async (req) => {
    const { mode } = parse(z.object({ mode: env }).strict(), req.body);
    if (mode === 'LIVE') {
      const blockers = (await deps.integrations.liveBlockers(db)).filter((r) => !r.startsWith('Canlı mod yetkili yönetici'));
      const rt = await deps.integrations.paymentRuntime(db, 'LIVE');
      if (!rt.provider || rt.adapter.code === 'NONE' || rt.adapter.isSimulator) blockers.push('Canlı ödeme sağlayıcısı adaptörü yok.');
      if (rt.config?.last_connection_test_ok !== true) blockers.push('Canlı ödeme bağlantı testi başarılı değil.');
      if (blockers.length) throw new AppError(409, 'LIVE_BLOCKED', 'Canlı moda geçilemez. Eksik maddeler raporlandı.', { reasons: blockers });
      await db.query('UPDATE payment_service_state SET mode = $1, live_enabled_at = now(), live_enabled_by = $2, updated_at = now() WHERE id', ['LIVE', req.auth!.userId]);
    } else {
      await db.query(`UPDATE payment_service_state SET mode = 'TEST', live_enabled_at = NULL, live_enabled_by = NULL, updated_at = now() WHERE id`);
    }
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'payment_service.mode_change', targetType: 'payment_service', targetId: 'state', ip: req.ip, details: { mode } });
    return { mode };
  });
}
