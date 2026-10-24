import type { Deps } from '../context.js';

/** Periyodik kontroller: uzun bekleyen işlemler, süresi dolmak üzere olan anahtarlar, yedekleme durumu. Tekrarlayan uyarılar günde bire sınırlanır. */
export async function runMaintenanceChecks(deps: Deps) {
  const db = deps.db;
  const once = async (eventType: string, key: string, fn: () => Promise<void>) => {
    const r = await db.query(`SELECT 1 FROM notifications WHERE audience = 'ADMIN' AND event_type = $1 AND data->>'key' = $2 AND created_at > now() - interval '1 day'`, [eventType, key]);
    if (!r.rows[0]) await fn();
  };
  const minutes = Number((await db.query(`SELECT value FROM system_settings WHERE key = 'pending_alert_minutes'`)).rows[0]?.value ?? 30);
  const stale = await db.query(
    `SELECT public_ref, status FROM topup_transactions WHERE status IN ('PAYMENT_CONFIRMED','TOPUP_PENDING','UNKNOWN','REFUND_PENDING') AND updated_at < now() - make_interval(mins => $1)
     UNION ALL SELECT public_ref, status FROM bill_payment_transactions WHERE status IN ('PAYMENT_CONFIRMED','COLLECTION_PENDING','UNKNOWN','REFUND_PENDING') AND updated_at < now() - make_interval(mins => $1)`,
    [minutes],
  );
  for (const t of stale.rows) {
    await once('LONG_PENDING_TRANSACTION', t.public_ref, () =>
      deps.notifications.alertAdmins({ eventType: 'LONG_PENDING_TRANSACTION', title: 'Uzun süredir bekleyen işlem', body: `${t.public_ref} ${minutes} dakikadan uzun süredir ${t.status} durumunda.`, data: { key: t.public_ref } }),
    );
  }
  const expiring = await db.query(`SELECT ref, environment, expires_at FROM secret_values WHERE expires_at IS NOT NULL AND expires_at < now() + interval '14 days'`);
  for (const s of expiring.rows) {
    await once('SECRET_EXPIRING', s.ref, () =>
      deps.notifications.alertAdmins({ eventType: 'SECRET_EXPIRING', severity: s.environment === 'LIVE' ? 'CRITICAL' : 'WARNING', title: 'Anahtarın süresi dolmak üzere', body: `${s.ref} anahtarının süresi ${new Date(s.expires_at).toISOString().slice(0, 10)} tarihinde doluyor.`, data: { key: s.ref } }),
    );
  }
  const lastBackup = await db.query(`SELECT status, created_at FROM backup_runs WHERE kind = 'BACKUP' ORDER BY created_at DESC LIMIT 1`);
  const b = lastBackup.rows[0];
  if (deps.config.isProduction && (!b || b.status === 'FAILED' || Date.now() - new Date(b.created_at).getTime() > 26 * 3600_000)) {
    await once('BACKUP_FAILURE', 'daily', () =>
      deps.notifications.alertAdmins({ eventType: 'BACKUP_FAILURE', severity: 'CRITICAL', title: 'Yedekleme hatası', body: 'Son 26 saatte başarılı bir veritabanı yedeği kaydı yok.', data: { key: 'daily' } }),
    );
  }
}
