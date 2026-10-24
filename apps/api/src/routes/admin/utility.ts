import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../context.js';
import type { makeGuards } from '../../auth/guards.js';
import { withTransaction } from '../../db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, z } from '../../lib/validate.js';
import { audit } from '../../services/audit.js';
import { SecretStore } from '../../services/secrets.js';

type Guards = ReturnType<typeof makeGuards>;
const env = z.enum(['TEST', 'LIVE']);
const P = '/api/admin/utilities';

/** Su İdaresi Entegrasyonu yönetim paneli API'si (bölüm 8) */
export async function utilityRoutes(app: FastifyInstance, { deps, guards }: { deps: Deps; guards: Guards }) {
  const db = deps.db;
  const read = { preHandler: guards.requirePermission('utility_integration.read') };
  const manage = { preHandler: guards.requirePermission('utility_integration.manage', { fresh: true }) };

  async function integrationView(utilityId: string, environment: 'TEST' | 'LIVE') {
    const i = (await db.query('SELECT * FROM utility_integrations WHERE utility_id = $1 AND environment = $2', [utilityId, environment])).rows[0];
    if (!i) return null;
    return {
      environment,
      adapterCode: i.adapter_code,
      status: i.adapter_code === 'NONE' ? 'Yapılandırma bekleniyor' : deps.registry.getUtility(i.adapter_code).isSimulator ? 'Test modu (simülatör)' : i.authorization_status === 'PRODUCTION_ACCESS' ? 'Üretim erişimi' : 'Yetkilendirme bekleniyor',
      integrationCode: i.integration_code,
      technicalContact: i.technical_contact,
      agreementStatus: i.agreement_status,
      authorizationStatus: i.authorization_status,
      apiBaseUrl: i.api_base_url,
      authMethod: i.auth_method,
      credential: await deps.secrets.meta(db, i.credential_secret_ref),
      certificate: await deps.secrets.meta(db, i.certificate_secret_ref),
      capabilities: {
        accountQuery: i.supports_account_query,
        cardTopup: i.supports_card_topup,
        billQuery: i.supports_bill_query,
        billPayment: i.supports_bill_payment,
        statusQuery: i.supports_status_query,
        reconciliation: i.supports_reconciliation,
      },
      lastConnectionTestAt: i.last_connection_test_at,
      lastConnectionTestOk: i.last_connection_test_ok,
      lastSuccessAt: i.last_success_at,
      lastErrorAt: i.last_error_at,
      lastError: i.last_error,
      documentationRef: i.documentation_ref,
      agreementDocumentRef: i.agreement_document_ref,
      updatedAt: i.updated_at,
    };
  }

  app.get(P, read, async () => {
    const { rows } = await db.query('SELECT * FROM water_utilities ORDER BY full_name');
    const out = [];
    for (const u of rows) out.push({ id: u.id, code: u.code, fullName: u.full_name, city: u.city, isActive: u.is_active, test: await integrationView(u.id, 'TEST'), live: await integrationView(u.id, 'LIVE') });
    return { utilities: out, availableAdapters: deps.registry.availableUtilityAdapters() };
  });

  app.post(P, manage, async (req) => {
    const b = parse(z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,20}$/), fullName: z.string().trim().min(3).max(200), city: z.string().trim().max(60).optional() }).strict(), req.body);
    try {
      const { rows } = await db.query('INSERT INTO water_utilities (code, full_name, city) VALUES ($1,$2,$3) RETURNING id', [b.code, b.fullName, b.city ?? null]);
      await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'utility.create', targetType: 'water_utility', targetId: rows[0].id, ip: req.ip, details: b });
      return { id: rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') throw conflict('Bu kurum kodu zaten var.');
      throw e;
    }
  });

  app.post(`${P}/:id/active`, manage, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { isActive } = parse(z.object({ isActive: z.boolean() }).strict(), req.body);
    const r = await db.query('UPDATE water_utilities SET is_active = $2, updated_at = now() WHERE id = $1', [id, isActive]);
    if (!r.rowCount) throw notFound();
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'utility.set_active', targetType: 'water_utility', targetId: id, ip: req.ip, details: { isActive } });
    return { ok: true };
  });

  app.put(`${P}/:id/integration/:env`, manage, async (req) => {
    const { id, env: environment } = parse(z.object({ id: z.uuid(), env }), req.params);
    const b = parse(
      z.object({
        adapterCode: z.string().max(40),
        integrationCode: z.string().max(60).nullable(),
        technicalContact: z.object({ name: z.string().max(100).optional(), email: z.email().optional(), phone: z.string().max(30).optional() }).strict(),
        agreementStatus: z.enum(['NOT_STARTED', 'IN_NEGOTIATION', 'SIGNED', 'REVOKED']),
        authorizationStatus: z.enum(['AWAITING', 'TEST_ACCESS', 'PRODUCTION_ACCESS', 'REVOKED']),
        apiBaseUrl: z.url().refine((u) => u.startsWith('https://'), 'API adresi https olmalı').nullable(),
        authMethod: z.enum(['API_KEY', 'OAUTH2_CLIENT_CREDENTIALS', 'MUTUAL_TLS', 'OTHER']).nullable(),
        capabilities: z.object({ accountQuery: z.boolean(), cardTopup: z.boolean(), billQuery: z.boolean(), billPayment: z.boolean(), statusQuery: z.boolean(), reconciliation: z.boolean() }).strict(),
        documentationRef: z.string().max(300).nullable(),
        agreementDocumentRef: z.string().max(300).nullable(),
      }).strict(),
      req.body,
    );
    const adapter = deps.registry.availableUtilityAdapters().find((a) => a.code === b.adapterCode);
    if (!adapter) throw badRequest('Bu adaptör kayıtlı değil. Gerçek adaptör, kurumun resmî teknik dokümanıyla geliştirilmelidir.', 'UNKNOWN_ADAPTER');
    if (environment === 'LIVE' && adapter.isSimulator) throw badRequest('Simülatör canlı ortama atanamaz.');
    if (b.authorizationStatus === 'PRODUCTION_ACCESS' && (b.agreementStatus !== 'SIGNED' || !b.agreementDocumentRef)) {
      throw badRequest('Üretim erişimi için imzalı sözleşme ve sözleşme belge referansı gereklidir.');
    }
    const u = (await db.query('SELECT 1 FROM water_utilities WHERE id = $1', [id])).rows[0];
    if (!u) throw notFound();
    const c = b.capabilities;
    await db.query(
      `INSERT INTO utility_integrations (utility_id, environment, adapter_code, integration_code, technical_contact, agreement_status, authorization_status, api_base_url, auth_method,
         supports_account_query, supports_card_topup, supports_bill_query, supports_bill_payment, supports_status_query, supports_reconciliation, documentation_ref, agreement_document_ref, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (utility_id, environment) DO UPDATE SET adapter_code=EXCLUDED.adapter_code, integration_code=EXCLUDED.integration_code, technical_contact=EXCLUDED.technical_contact,
         agreement_status=EXCLUDED.agreement_status, authorization_status=EXCLUDED.authorization_status, api_base_url=EXCLUDED.api_base_url, auth_method=EXCLUDED.auth_method,
         supports_account_query=EXCLUDED.supports_account_query, supports_card_topup=EXCLUDED.supports_card_topup, supports_bill_query=EXCLUDED.supports_bill_query,
         supports_bill_payment=EXCLUDED.supports_bill_payment, supports_status_query=EXCLUDED.supports_status_query, supports_reconciliation=EXCLUDED.supports_reconciliation,
         documentation_ref=EXCLUDED.documentation_ref, agreement_document_ref=EXCLUDED.agreement_document_ref, updated_by=EXCLUDED.updated_by, updated_at=now(), last_connection_test_ok=NULL`,
      [id, environment, b.adapterCode, b.integrationCode, JSON.stringify(b.technicalContact), b.agreementStatus, b.authorizationStatus, b.apiBaseUrl, b.authMethod,
        c.accountQuery, c.cardTopup, c.billQuery, c.billPayment, c.statusQuery, c.reconciliation, b.documentationRef, b.agreementDocumentRef, req.auth!.userId],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'utility_integration.update', targetType: 'water_utility', targetId: id, ip: req.ip, userAgent: req.headers['user-agent'], details: { environment, ...b } });
    return integrationView(id, environment);
  });

  app.put(`${P}/:id/integration/:env/secrets`, { preHandler: guards.requirePermission('secrets.write', { fresh: true }) }, async (req) => {
    const { id, env: environment } = parse(z.object({ id: z.uuid(), env }), req.params);
    const b = parse(z.object({ kind: z.enum(['CREDENTIAL', 'CERTIFICATE']), value: z.string().min(8).max(16384).optional(), externalRef: z.string().min(3).max(300).optional(), expiresAt: z.iso.datetime().nullable().optional() }).strict(), req.body);
    const u = (await db.query('SELECT code FROM water_utilities WHERE id = $1', [id])).rows[0];
    if (!u) throw notFound();
    const ref = `utility/${environment.toLowerCase()}/${u.code.toLowerCase().replace(/_/g, '-')}-${b.kind === 'CREDENTIAL' ? 'credential' : 'certificate'}`;
    SecretStore.validateRef(ref, environment);
    return withTransaction(db, async (c) => {
      const exists = await c.query('SELECT 1 FROM utility_integrations WHERE utility_id = $1 AND environment = $2', [id, environment]);
      if (!exists.rows[0]) throw badRequest('Önce entegrasyon ayarlarını kaydedin.');
      const meta = await deps.secrets.put(c, { ref, environment, value: b.value, externalRef: b.externalRef, expiresAt: b.expiresAt ?? null, actorId: req.auth!.userId });
      await c.query(`UPDATE utility_integrations SET ${b.kind === 'CREDENTIAL' ? 'credential_secret_ref' : 'certificate_secret_ref'} = $3, last_connection_test_ok = NULL, updated_at = now() WHERE utility_id = $1 AND environment = $2`, [id, environment, ref]);
      await audit(c, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'secret.rotate', targetType: 'secret', targetId: ref, ip: req.ip, details: { kind: b.kind, environment, fingerprint: meta.fingerprint } });
      return meta;
    });
  });

  app.post(`${P}/:id/integration/:env/test`, manage, async (req) => {
    const { id, env: environment } = parse(z.object({ id: z.uuid(), env }), req.params);
    const rt = await deps.integrations.utilityRuntime(db, id, environment);
    const started = Date.now();
    let result: { ok: boolean; code: string; message: string };
    if (!rt.integration) result = { ok: false, code: 'NO_CONFIG', message: 'Entegrasyon ayarı yok.' };
    else {
      try {
        result = await rt.adapter.testConnection(rt.ctx);
      } catch {
        result = { ok: false, code: 'ERROR', message: 'Bağlantı testi sırasında hata oluştu.' };
      }
    }
    await db.query(`INSERT INTO connection_tests (target, target_id, environment, ok, result_code, message, latency_ms, performed_by) VALUES ('WATER_UTILITY',$1,$2,$3,$4,$5,$6,$7)`, [id, environment, result.ok, result.code, result.message, Date.now() - started, req.auth!.userId]);
    await db.query(
      `UPDATE utility_integrations SET last_connection_test_at = now(), last_connection_test_ok = $3,
         last_success_at = CASE WHEN $3 THEN now() ELSE last_success_at END,
         last_error_at = CASE WHEN $3 THEN last_error_at ELSE now() END, last_error = CASE WHEN $3 THEN last_error ELSE $4 END
       WHERE utility_id = $1 AND environment = $2`,
      [id, environment, result.ok, result.message],
    );
    if (!result.ok) await deps.notifications.alertAdmins({ eventType: 'INTEGRATION_CONNECTION_ERROR', severity: environment === 'LIVE' ? 'CRITICAL' : 'WARNING', title: 'Su idaresi bağlantı hatası', body: `${rt.utility.full_name} (${environment}): ${result.message}` });
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'utility_integration.connection_test', targetType: 'water_utility', targetId: id, ip: req.ip, details: { environment, ok: result.ok, code: result.code } });
    return result;
  });
}
