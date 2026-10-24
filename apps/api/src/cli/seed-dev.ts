import { createDeps } from '../app.js';
import { loadConfig } from '../config.js';

/**
 * YALNIZCA GELİŞTİRME/TEST: simülatör su idaresi, simülatör ödeme sağlayıcısı ve ÖRNEK ücret tarifesi oluşturur.
 * Tüm kayıtlar "TEST"/"SİMÜLATÖR" olarak etiketlenir. Üretimde çalışmayı reddeder.
 */
const config = loadConfig();
if (config.isProduction) {
  console.error('seed-dev üretim ortamında çalıştırılamaz.');
  process.exit(1);
}
const deps = createDeps(config);
const db = deps.db;
const u = (
  await db.query(
    `INSERT INTO water_utilities (code, full_name, city, is_active) VALUES ('TEST_SIM', 'TEST — Su İdaresi Simülatörü (gerçek kurum değildir)', 'Test', true)
     ON CONFLICT (code) DO UPDATE SET is_active = true RETURNING id`,
  )
).rows[0];
await db.query(
  `INSERT INTO utility_integrations (utility_id, environment, adapter_code, integration_code, authorization_status, supports_account_query, supports_card_topup, supports_bill_query, supports_bill_payment, supports_status_query, supports_reconciliation, last_connection_test_ok, last_connection_test_at)
   VALUES ($1,'TEST','SANDBOX','SIM','TEST_ACCESS',true,true,true,true,true,true,true,now()) ON CONFLICT (utility_id, environment) DO NOTHING`,
  [u.id],
);
const p = (
  await db.query(`INSERT INTO payment_providers (code, display_name, adapter_code) VALUES ('sandbox', 'TEST — Ödeme Simülatörü (gerçek sağlayıcı değildir)', 'SANDBOX') ON CONFLICT (code) DO UPDATE SET adapter_code = 'SANDBOX' RETURNING id`)
).rows[0];
await db.query(`INSERT INTO payment_provider_configs (provider_id, environment, webhook_url, supports_refund) VALUES ($1,'TEST',$2,true) ON CONFLICT DO NOTHING`, [p.id, `${config.API_PUBLIC_URL}/api/webhooks/payment/sandbox`]);
const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
await deps.secrets.put(db, { ref: 'payment/test/sandbox-api-key', environment: 'TEST', value: `sim_${rand()}`, actorId: null });
await deps.secrets.put(db, { ref: 'payment/test/sandbox-webhook-secret', environment: 'TEST', value: `whsec_sim_${rand()}`, actorId: null });
await db.query(`UPDATE payment_provider_configs SET api_key_secret_ref = 'payment/test/sandbox-api-key', webhook_secret_ref = 'payment/test/sandbox-webhook-secret', last_connection_test_ok = true, last_connection_test_at = now() WHERE provider_id = $1 AND environment = 'TEST'`, [p.id]);
await db.query(`UPDATE payment_service_state SET active_provider_id = $1, mode = 'TEST' WHERE id`, [p.id]);
const hasFee = (await db.query('SELECT 1 FROM fee_schedules LIMIT 1')).rows[0];
if (!hasFee) {
  for (const t of ['TOPUP', 'BILL_PAYMENT']) {
    await db.query(
      `INSERT INTO fee_schedules (transaction_type, fee_type, fixed_fee_minor, user_facing_description, is_sample, effective_from)
       VALUES ($1,'FIXED',150,'Örnek hizmet bedeli: işlem başına 1,50 TL',true, now() - interval '1 minute')`,
      [t],
    );
  }
}
console.log('Geliştirme simülatör verisi hazır. Abone numarası örnekleri: TEST-10001 (başarılı), TEST-10007 (belirsiz), TEST-10008 (red), TEST-10009 (bulunamadı), TEST-10000 (borç yok).');
await db.end();
