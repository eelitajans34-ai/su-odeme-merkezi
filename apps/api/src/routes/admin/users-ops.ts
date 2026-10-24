import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../context.js';
import type { makeGuards } from '../../auth/guards.js';
import { withTransaction } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { maskEmail, maskTail } from '../../lib/mask.js';
import { parse, z } from '../../lib/validate.js';
import { audit } from '../../services/audit.js';

type Guards = ReturnType<typeof makeGuards>;

export async function adminUserOpsRoutes(app: FastifyInstance, { deps, guards }: { deps: Deps; guards: Guards }) {
  const db = deps.db;

  // ---- Kullanıcılar ve roller ----
  app.get('/api/admin/users', { preHandler: guards.requirePermission('users.read') }, async (req) => {
    const q = parse(z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, u.email_verified_at, u.last_login_at, u.is_test_account, u.created_at,
              array_remove(array_agg(r.code), NULL) AS roles,
              EXISTS (SELECT 1 FROM mfa_methods m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL AND m.disabled_at IS NULL) AS mfa_enabled
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
        WHERE ($1::text IS NULL OR u.email_normalized LIKE '%' || lower($1) || '%' OR u.full_name ILIKE '%' || $1 || '%')
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [q.search ?? null, q.limit, q.offset],
    );
    return rows;
  });

  app.get('/api/admin/users/:id', { preHandler: guards.requirePermission('users.read') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const u = (await db.query('SELECT id, email, full_name, phone, status, email_verified_at, last_login_at, created_at FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw notFound();
    const subs = (await db.query('SELECT id, subscriber_no, verification_status, created_at FROM subscriptions WHERE user_id = $1 AND deleted_at IS NULL', [id])).rows;
    const roles = (await db.query('SELECT r.code, ur.granted_via, ur.created_at FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1', [id])).rows;
    const logins = (await db.query('SELECT success, reason, ip_address::text AS ip, suspicious, created_at FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [id])).rows;
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'user.view', targetType: 'user', targetId: id, ip: req.ip });
    return { ...u, phone: u.phone ? maskTail(u.phone) : null, roles, subscriptions: subs.map((s) => ({ ...s, subscriber_no: maskTail(s.subscriber_no) })), recentLogins: logins };
  });

  /** Rol değişikliği: yalnızca roles.assign yetkisi + taze MFA ile, sunucu tarafında, denetim kaydıyla. */
  app.post('/api/admin/users/:id/roles', { preHandler: guards.requirePermission('roles.assign', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ role: z.enum(['USER', 'SUPPORT', 'FINANCE', 'SUPER_ADMIN']), action: z.enum(['GRANT', 'REVOKE']) }).strict(), req.body);
    await withTransaction(db, async (c) => {
      const target = (await c.query('SELECT id, status, email_verified_at FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) throw notFound();
      const role = (await c.query('SELECT id, is_staff FROM roles WHERE code = $1', [b.role])).rows[0];
      if (b.action === 'GRANT') {
        if (role.is_staff && (!target.email_verified_at || target.status !== 'ACTIVE')) throw badRequest('Personel rolü yalnızca e-postası doğrulanmış etkin hesaplara verilebilir.');
        await c.query(`INSERT INTO user_roles (user_id, role_id, granted_by, granted_via) VALUES ($1,$2,$3,'ADMIN_ACTION') ON CONFLICT DO NOTHING`, [id, role.id, req.auth!.userId]);
        if (role.is_staff) {
          // Personel rolü alan hesap MFA kurmadan yönetim işlemi yapamaz; mevcut oturumları kapatılır
          await c.query('UPDATE users SET must_enroll_mfa = true WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM mfa_methods WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL)', [id]);
          await c.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'ROLE_CHANGED' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
        }
      } else {
        if (b.role === 'SUPER_ADMIN') {
          const n = (await c.query(`SELECT count(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'SUPER_ADMIN'`)).rows[0].n;
          if (Number(n) <= 1) throw conflict('Son süper yönetici rolü kaldırılamaz.');
        }
        await c.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [id, role.id]);
        await c.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'ROLE_CHANGED' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      }
      await audit(c, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: `role.${b.action.toLowerCase()}`, targetType: 'user', targetId: id, ip: req.ip, userAgent: req.headers['user-agent'], details: { role: b.role } });
    });
    await deps.notifications.notifyUser({ userId: id, eventType: 'SECURITY_SETTING_CHANGED', severity: 'WARNING', title: 'Hesap yetkileriniz değişti', body: `Hesabınızın rolleri güncellendi (${b.role}).` });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/status', { preHandler: guards.requirePermission('users.manage', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ status: z.enum(['ACTIVE', 'DISABLED']), reason: z.string().trim().min(3).max(300) }).strict(), req.body);
    if (id === req.auth!.userId) throw forbidden('Kendi hesabınızın durumunu değiştiremezsiniz.');
    await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, b.status]);
    if (b.status === 'DISABLED') await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'ADMIN_DISABLED' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'user.status', targetType: 'user', targetId: id, ip: req.ip, details: b });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', { preHandler: guards.requirePermission('users.manage', { fresh: true }) }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'ADMIN_REVOKED' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'user.revoke_sessions', targetType: 'user', targetId: id, ip: req.ip });
    return { ok: true };
  });

  // ---- Denetim kayıtları ----
  app.get('/api/admin/audit-logs', { preHandler: guards.requirePermission('audit.read') }, async (req) => {
    const q = parse(z.object({ action: z.string().max(60).optional(), actorId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const { rows } = await db.query(
      `SELECT a.id, a.actor_type, a.action, a.target_type, a.target_id, a.ip_address::text AS ip, a.details, a.created_at, u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::uuid IS NULL OR a.actor_user_id = $2)
        ORDER BY a.id DESC LIMIT $3`,
      [q.action ?? null, q.actorId ?? null, q.limit],
    );
    return rows.map((r) => ({ ...r, actor_email: r.actor_email ? maskEmail(r.actor_email) : null }));
  });

  // ---- Sistem uyarıları ----
  app.get('/api/admin/alerts', { preHandler: guards.requirePermission('alerts.manage') }, async () =>
    (await db.query(`SELECT id, event_type, severity, title, body, data, acknowledged_at, created_at FROM notifications WHERE audience = 'ADMIN' ORDER BY (acknowledged_at IS NULL) DESC, created_at DESC LIMIT 200`)).rows,
  );
  app.post('/api/admin/alerts/:id/ack', { preHandler: guards.requirePermission('alerts.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await db.query(`UPDATE notifications SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND audience = 'ADMIN'`, [id, req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'alert.ack', targetType: 'notification', targetId: id, ip: req.ip });
    return { ok: true };
  });
  app.get('/api/admin/notification-channels', { preHandler: guards.requirePermission('alerts.manage') }, async () => (await db.query('SELECT channel, provider_name, secret_ref IS NOT NULL AS has_secret, status, updated_at FROM notification_channels ORDER BY channel')).rows);

  // E-posta kanalı: standart SMTP. SMS/PUSH sağlayıcısı adaptörü olmadığından burada yapılandırılamaz.
  app.put('/api/admin/notification-channels/EMAIL', { preHandler: guards.requirePermission('secrets.write', { fresh: true }) }, async (req) => {
    const b = parse(z.object({
      providerName: z.string().min(2).max(80),
      status: z.enum(['TEST', 'ACTIVE', 'DISABLED']),
      smtpUrl: z.string().regex(/^smtps?:\/\//, 'SMTP adresi smtp:// veya smtps:// ile başlamalıdır.').max(500).optional(),
      externalRef: z.string().max(200).optional(),
    }).strict(), req.body);
    const ref = deps.config.EMAIL_PROVIDER_SECRET_REF;
    if (!ref) throw badRequest('EMAIL_PROVIDER_SECRET_REF ortam değişkeni tanımlı değil.');
    if (b.status !== 'DISABLED' && !deps.config.EMAIL_FROM) throw badRequest('EMAIL_FROM ortam değişkeni tanımlı değil.');
    const environment = ref.split('/')[1] === 'live' ? 'LIVE' : 'TEST';
    return withTransaction(db, async (c) => {
      const meta = b.smtpUrl || b.externalRef
        ? await deps.secrets.put(c, { ref, environment, value: b.smtpUrl, externalRef: b.externalRef, actorId: req.auth!.userId })
        : null;
      const hasSecret = !!meta || !!(await deps.secrets.meta(c, ref))?.isSet;
      if (b.status !== 'DISABLED' && !hasSecret) throw badRequest('SMTP bağlantı bilgisi girilmedi.');
      await c.query(`UPDATE notification_channels SET provider_name = $1, status = $2, secret_ref = $3, updated_at = now() WHERE channel = 'EMAIL'`, [b.providerName, b.status, hasSecret ? ref : null]);
      await audit(c, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'notification_channel.update', targetType: 'notification_channel', targetId: 'EMAIL', ip: req.ip, details: { status: b.status, providerName: b.providerName, secretFingerprint: meta?.fingerprint ?? null } });
      return { ok: true, secret: meta };
    });
  });
  // Deneme e-postası yöneticinin kendi adresine gider; sonuç gerçek gönderim sonucudur (SENT / FAILED / NOT_SENT_...)
  app.post('/api/admin/notification-channels/EMAIL/test', { preHandler: guards.requirePermission('secrets.write', { fresh: true }) }, async (req) => {
    const r = await deps.notifications.sendTransactionalEmail({ to: req.auth!.email, subject: 'Su Ödeme Merkezi — deneme e-postası', text: 'Bu ileti e-posta kanalı yapılandırmasını denemek için gönderildi.' });
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'notification_channel.test', targetType: 'notification_channel', targetId: 'EMAIL', ip: req.ip, details: { result: r.status } });
    return r;
  });

  // ---- Destek ----
  app.get('/api/admin/support-tickets', { preHandler: guards.requirePermission('support.manage') }, async (req) => {
    const q = parse(z.object({ status: z.string().max(20).optional() }), req.query);
    return (await db.query(`SELECT t.id, t.ticket_no, t.category, t.subject, t.status, t.related_type, t.related_id, t.created_at, t.updated_at, u.email FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT 200`, [q.status ?? null])).rows
      .map((r) => ({ ...r, email: maskEmail(r.email) }));
  });
  app.get('/api/admin/support-tickets/:id/messages', { preHandler: guards.requirePermission('support.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return (await db.query('SELECT author_role, body, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [id])).rows;
  });
  app.post('/api/admin/support-tickets/:id/reply', { preHandler: guards.requirePermission('support.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const b = parse(z.object({ message: z.string().trim().min(1).max(4000), status: z.enum(['IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED']) }).strict(), req.body);
    const t = (await db.query('SELECT user_id, ticket_no FROM support_tickets WHERE id = $1', [id])).rows[0];
    if (!t) throw notFound();
    await db.query(`INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body) VALUES ($1,$2,'STAFF',$3)`, [id, req.auth!.userId, b.message]);
    await db.query('UPDATE support_tickets SET status = $2, assigned_to = COALESCE(assigned_to, $3), updated_at = now() WHERE id = $1', [id, b.status, req.auth!.userId]);
    await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'SUPPORT_REPLY', title: 'Destek talebiniz yanıtlandı', body: `${t.ticket_no} numaralı talebinize yanıt verildi.` });
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'support.reply', targetType: 'support_ticket', targetId: id, ip: req.ip, details: { status: b.status } });
    return { ok: true };
  });

  // ---- Sistem sağlığı, yedekleme, bakım ----
  app.get('/api/admin/system/health', { preHandler: guards.requirePermission('system.read') }, async () => {
    const migrations = (await db.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')).rows;
    const backups = (await db.query('SELECT kind, status, storage_ref, details, recorded_by, created_at FROM backup_runs ORDER BY created_at DESC LIMIT 20')).rows;
    const stale = (await db.query(`SELECT value FROM system_settings WHERE key = 'pending_alert_minutes'`)).rows[0]?.value ?? 30;
    const pending = (
      await db.query(
        `SELECT (SELECT count(*) FROM topup_transactions WHERE status IN ('PAYMENT_CONFIRMED','TOPUP_PENDING','UNKNOWN') AND updated_at < now() - make_interval(mins => $1)) +
                (SELECT count(*) FROM bill_payment_transactions WHERE status IN ('PAYMENT_CONFIRMED','COLLECTION_PENDING','UNKNOWN') AND updated_at < now() - make_interval(mins => $1)) AS stale_pending`,
        [Number(stale)],
      )
    ).rows[0];
    const expiring = (await db.query(`SELECT ref, environment, expires_at FROM secret_values WHERE expires_at IS NOT NULL AND expires_at < now() + interval '30 days' ORDER BY expires_at`)).rows;
    return {
      database: 'OK',
      appEnv: deps.config.APP_ENV,
      secretManager: deps.config.SECRET_MANAGER_REFERENCE,
      migrations,
      backups,
      lastSuccessfulBackup: backups.find((b) => b.kind === 'BACKUP' && b.status === 'SUCCEEDED')?.created_at ?? null,
      lastRestoreTest: backups.find((b) => b.kind === 'RESTORE_TEST')?.created_at ?? null,
      stalePendingTransactions: Number(pending.stale_pending),
      expiringSecrets: expiring,
      settings: (await db.query('SELECT key, value, description, updated_at FROM system_settings ORDER BY key')).rows,
    };
  });

  app.put('/api/admin/system/settings/:key', { preHandler: guards.requirePermission('users.manage', { fresh: true }) }, async (req) => {
    const { key } = parse(z.object({ key: z.enum(['maintenance_mode', 'pending_alert_minutes', 'utility_status_max_checks', 'admin_mfa_max_age_minutes']) }), req.params);
    const { value } = parse(z.object({ value: z.union([z.boolean(), z.number().int().min(1).max(1440)]) }).strict(), req.body);
    if (key === 'maintenance_mode' && typeof value !== 'boolean') throw badRequest('Bakım modu true/false olmalı.');
    if (key !== 'maintenance_mode' && typeof value !== 'number') throw badRequest('Sayısal değer bekleniyor.');
    await db.query('UPDATE system_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1', [key, JSON.stringify(value), req.auth!.userId]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'system_setting.update', targetType: 'system_setting', targetId: key, ip: req.ip, details: { value } });
    return { ok: true };
  });

  // ---- Yayın öncesi kontrol listesi (bölüm 15) ----
  app.get('/api/admin/golive', { preHandler: guards.requirePermission('golive.manage') }, async () => ({
    items: (await db.query('SELECT g.*, u.email AS verified_by_email FROM golive_checklist_items g LEFT JOIN users u ON u.id = g.verified_by ORDER BY sort_order')).rows,
    blockers: await deps.integrations.liveBlockers(db),
    notice: 'Bir maddenin işaretlenmesi gerçek iznin veya entegrasyonun kanıtı değildir; her madde için kanıt belgesi referansı zorunludur.',
  }));
  app.post('/api/admin/golive/:code/verify', { preHandler: guards.requirePermission('golive.manage', { fresh: true }) }, async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Z_]{3,40}$/) }), req.params);
    const b = parse(z.object({ status: z.enum(['VERIFIED', 'REJECTED', 'OPEN']), evidenceRef: z.string().trim().min(4).max(300).optional(), note: z.string().max(500).optional() }).strict(), req.body);
    if (b.status === 'VERIFIED' && !b.evidenceRef) throw badRequest('Doğrulama için kanıt belgesi referansı zorunludur.');
    if (b.status === 'VERIFIED') {
      if (code === 'SUPER_ADMIN_MFA') {
        const ok = (await db.query(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
            WHERE r.code = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM mfa_methods m WHERE m.user_id = u.id AND m.confirmed_at IS NOT NULL AND m.disabled_at IS NULL)`)).rows[0];
        if (!ok) throw badRequest('MFA etkin, aktif bir süper yönetici bulunmuyor.');
      }
      if (code === 'KEYS_SEPARATED') {
        const live = (await db.query(`SELECT count(*) AS n FROM secret_values WHERE environment = 'LIVE'`)).rows[0].n;
        const shared = (await db.query(`SELECT count(*) AS n FROM secret_values a JOIN secret_values b ON a.fingerprint = b.fingerprint AND a.environment = 'TEST' AND b.environment = 'LIVE'`)).rows[0].n;
        if (Number(live) === 0) throw badRequest('Canlı ortam anahtarları tanımlı değil.');
        if (Number(shared) > 0) throw badRequest('Test ve canlı ortamlarda aynı anahtar kullanılıyor.');
      }
      if (code === 'BACKUP_RESTORE_VERIFIED') {
        const r = (await db.query(`SELECT 1 FROM backup_runs WHERE kind = 'RESTORE_TEST' AND status = 'SUCCEEDED' AND created_at > now() - interval '30 days'`)).rows[0];
        if (!r) throw badRequest('Son 30 günde başarılı bir geri yükleme testi kaydı yok.');
      }
    }
    const r = await db.query(
      `UPDATE golive_checklist_items SET status = $2, evidence_ref = $3, note = $4, verified_by = CASE WHEN $2 = 'OPEN' THEN NULL ELSE $5::uuid END, verified_at = CASE WHEN $2 = 'OPEN' THEN NULL ELSE now() END WHERE code = $1`,
      [code, b.status, b.evidenceRef ?? null, b.note ?? null, req.auth!.userId],
    );
    if (!r.rowCount) throw notFound();
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'golive.update', targetType: 'golive_item', targetId: code, ip: req.ip, details: b });
    return { ok: true };
  });

  // ---- Hukuki metinler ve veri işleyen envanteri ----
  app.get('/api/admin/legal-documents', { preHandler: guards.requirePermission('legal.manage') }, async () => (await db.query('SELECT id, doc_type, version, title, is_draft, legal_reviewed_by, published_at, created_at FROM legal_documents ORDER BY doc_type, created_at DESC')).rows);
  app.post('/api/admin/legal-documents', { preHandler: guards.requirePermission('legal.manage', { fresh: true }) }, async (req) => {
    const b = parse(z.object({ docType: z.enum(['KVKK_NOTICE', 'PRIVACY_POLICY', 'TERMS_OF_USE', 'COOKIE_POLICY', 'RETENTION_POLICY', 'EXPLICIT_CONSENT']), version: z.string().max(20), title: z.string().max(200), bodyMarkdown: z.string().min(10).max(200_000), publish: z.boolean(), legalReviewedBy: z.string().max(200).optional() }).strict(), req.body);
    if (b.publish && !b.legalReviewedBy) throw badRequest('Yayımlamak için hukuki inceleme yapan kişi/kurum bilgisi gerekli.');
    const { rows } = await db.query(
      `INSERT INTO legal_documents (doc_type, version, title, body_markdown, is_draft, legal_reviewed_by, published_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.docType, b.version, b.title, b.bodyMarkdown, !b.publish, b.legalReviewedBy ?? null, b.publish ? new Date() : null, req.auth!.userId],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'legal.create', targetType: 'legal_document', targetId: rows[0].id, ip: req.ip, details: { docType: b.docType, version: b.version, publish: b.publish } });
    return { id: rows[0].id };
  });
  app.get('/api/admin/data-processors', { preHandler: guards.requirePermission('legal.manage') }, async () => (await db.query('SELECT * FROM data_processors ORDER BY name')).rows);
  app.post('/api/admin/data-processors', { preHandler: guards.requirePermission('legal.manage', { fresh: true }) }, async (req) => {
    const b = parse(z.object({ name: z.string().max(200), role: z.string().max(200), dataCategories: z.array(z.string().max(60)).max(20), transferAbroad: z.boolean().nullable(), contractRef: z.string().max(300).nullable(), status: z.enum(['PLANNED', 'UNDER_REVIEW', 'CONTRACTED', 'TERMINATED']) }).strict(), req.body);
    const { rows } = await db.query('INSERT INTO data_processors (name, role, data_categories, transfer_abroad, contract_ref, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [b.name, b.role, b.dataCategories, b.transferAbroad, b.contractRef, b.status]);
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'ADMIN', action: 'data_processor.create', targetType: 'data_processor', targetId: rows[0].id, ip: req.ip });
    return { id: rows[0].id };
  });
}
