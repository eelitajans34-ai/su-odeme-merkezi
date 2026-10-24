/**
 * Bölüm 13 — Kabul kriterleri. Her senaryo, belgedeki numarasıyla etiketlenmiştir.
 * Tüm testler TEST ortamında, açıkça etiketlenmiş simülatör verisiyle çalışır.
 */
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdapterRegistry } from '../src/integrations/registry.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrator.js';
import { runWorkerTick } from '../src/services/fulfillment.js';
import { TEST_DB_URL } from './global-setup.js';
import {
  createUser, idemKey, login, payViaSimulator, resetData, seedSandbox, setupApp, superAdmin, SUPER_ADMIN_EMAIL, teardown, testConfig, userWithCard, verifyMfa, type TestCtx,
} from './helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await setupApp();
});
afterAll(async () => teardown(t));
beforeEach(async () => {
  await resetData(t);
  await seedSandbox(t);
});

const inject = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as any, url, headers, payload: payload as any });

async function startTopup(s: { headers: Record<string, string> }, cardId: string, amountMinor = 5000, key = idemKey()) {
  return inject('POST', '/api/topups', { ...s.headers, 'idempotency-key': key }, { waterCardId: cardId, amountMinor });
}

describe('13.1 Yetkisiz kullanıcı süper yönetici paneline erişemez', () => {
  it('oturumsuz istek 401, normal kullanıcı 403 alır', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/admin/payment-service/overview' });
    expect(anon.statusCode).toBe(401);
    const id = await createUser(t, 'user1@test.invalid');
    const s = await login(t, 'user1@test.invalid', id);
    for (const url of ['/api/admin/payment-service/overview', '/api/admin/users', '/api/admin/utilities', '/api/admin/audit-logs', '/api/admin/golive']) {
      expect((await inject('GET', url, s.headers)).statusCode).toBe(403);
    }
  });
});

describe('13.2 Süper yönetici MFA olmadan hassas işlemleri tamamlayamaz', () => {
  it('MFA kurulmamış süper yönetici reddedilir', async () => {
    const id = await createUser(t, 'nomfa@test.invalid', { roles: ['SUPER_ADMIN'] });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nomfa@test.invalid', password: 'Guclu-Parola-2026' } });
    expect(res.json().mfaEnrollmentRequired).toBe(true);
    const s = await login(t, 'nomfa@test.invalid', id);
    const r = await inject('GET', '/api/admin/payment-service/overview', s.headers);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('MFA doğrulanmamış oturum ve süresi geçmiş MFA ile hassas işlem reddedilir', async () => {
    const admin = await superAdmin(t);
    // MFA doğrulaması geçerli → okuma serbest
    expect((await inject('GET', '/api/admin/payment-service/overview', admin.headers)).statusCode).toBe(200);
    // MFA doğrulaması 20 dk önce → hassas işlem (rol atama) step-up ister
    await t.deps.db.query(`UPDATE user_sessions SET mfa_verified_at = now() - interval '20 minutes' WHERE user_id = $1`, [admin.userId]);
    const target = await createUser(t, 'target@test.invalid');
    const r = await inject('POST', `/api/admin/users/${target}/roles`, admin.headers, { role: 'SUPPORT', action: 'GRANT' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('MFA_STEP_UP_REQUIRED');
    // MFA doğrulanmamış yeni oturum: hiçbir uç noktaya erişemez
    const raw = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.invalid', password: 'Guclu-Parola-2026' } });
    expect(raw.json().mfaRequired).toBe(true);
    const cookie = raw.cookies.find((c) => c.name === 'su_session')!.value;
    const r2 = await inject('GET', '/api/admin/users', { cookie: `su_session=${cookie}` });
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.code).toBe('MFA_REQUIRED');
    // Yeniden doğrulama sonrası işlem başarılı
    await verifyMfa(t, admin);
    expect((await inject('POST', `/api/admin/users/${target}/roles`, admin.headers, { role: 'SUPPORT', action: 'GRANT' })).statusCode).toBe(200);
  });
});

describe('13.3 Kullanıcı başka bir kişinin aboneliğini görüntüleyemez', () => {
  it('başka kullanıcının aboneliği, kartı ve işlemi 404 döner', async () => {
    const a = await userWithCard(t, 'a@test.invalid');
    const b = await userWithCard(t, 'b@test.invalid', 'TEST-20001');
    expect((await inject('GET', `/api/subscriptions/${a.subscriptionId}`, b.session.headers)).statusCode).toBe(404);
    expect((await startTopup(b.session, a.cardId)).statusCode).toBe(404);
    const topup = await startTopup(a.session, a.cardId);
    expect((await inject('GET', `/api/topups/${topup.json().transaction.id}`, b.session.headers)).statusCode).toBe(404);
    const list = (await inject('GET', '/api/subscriptions', b.session.headers)).json();
    expect(list.map((x: any) => x.id)).not.toContain(a.subscriptionId);
  });
});

describe('13.4 Başarısız ödeme başarılı olarak gösterilmez', () => {
  it('başarısız ödeme FAILED olur, makbuz oluşmaz, yükleme emri gönderilmez', async () => {
    const u = await userWithCard(t, 'fail@test.invalid');
    const r = await startTopup(u.session, u.cardId);
    expect(r.statusCode).toBe(200);
    await payViaSimulator(t, r.json().checkoutUrl, 'FAILED');
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('FAILED');
    expect(tx.statusText).toMatch(/Başarısız/);
    expect(tx.receiptId).toBeNull();
    expect(t.deps.registry.sandboxUtility.submissions.size).toBe(0);
  });
});

describe('13.5 Aynı istek iki kez geldiğinde mükerrer yükleme gerçekleşmez', () => {
  it('aynı Idempotency-Key tek işlem üretir (eşzamanlı istekler dahil)', async () => {
    const u = await userWithCard(t, 'dup@test.invalid');
    const key = idemKey();
    const [r1, r2] = await Promise.all([startTopup(u.session, u.cardId, 5000, key), startTopup(u.session, u.cardId, 5000, key)]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.json().transaction.id).toBe(r2.json().transaction.id);
    const r3 = await startTopup(u.session, u.cardId, 5000, key);
    expect(r3.json().replayed).toBe(true);
    const count = await t.deps.db.query('SELECT count(*)::int AS n FROM topup_transactions WHERE user_id = $1', [u.session.userId]);
    expect(count.rows[0].n).toBe(1);
    // Farklı tutarla aynı anahtar reddedilir
    expect((await startTopup(u.session, u.cardId, 7000, key)).statusCode).toBe(409);
  });

  it('aynı webhook iki kez gelse ve işçi tekrar çalışsa bile su idaresine tek emir gider', async () => {
    const u = await userWithCard(t, 'dup2@test.invalid');
    const r = await startTopup(u.session, u.cardId);
    const ref = decodeURIComponent(r.json().checkoutUrl.split('/').pop());
    const rt = await t.deps.integrations.paymentRuntime(t.deps.db);
    const ev = t.deps.registry.sandboxPayment.simulateOutcome(rt.ctx, ref, 'SUCCEEDED');
    const send = () => t.app.inject({ method: 'POST', url: '/api/webhooks/payment/sandbox', headers: ev.headers, payload: ev.body });
    expect((await send()).statusCode).toBe(200);
    const again = await send();
    expect(again.json().duplicate).toBe(true);
    await runWorkerTick(t.deps);
    await runWorkerTick(t.deps);
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('COMPLETED');
    const subs = [...t.deps.registry.sandboxUtility.submissions.values()];
    expect(subs).toHaveLength(1);
    expect(subs[0]!.count).toBe(1);
  });
});

describe('13.6 Ödeme başarılı fakat su idaresi cevabı belirsizse işlem UNKNOWN/PENDING kalır', () => {
  it('zaman aşımı → UNKNOWN; durum sorgusu bekliyor → TOPUP_PENDING; asla COMPLETED olmaz, emir tekrarlanmaz', async () => {
    const u = await userWithCard(t, 'amb@test.invalid', 'TEST-10007');
    const r = await startTopup(u.session, u.cardId);
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    const id = r.json().transaction.id;
    let tx = (await inject('GET', `/api/topups/${id}`, u.session.headers)).json();
    expect(tx.status).toBe('UNKNOWN');
    expect(tx.statusText).toMatch(/tekrar ödeme yapmayın/);
    expect(tx.receiptId).toBeNull();
    // Durum sorgusu PENDING → bekler
    await t.deps.db.query('UPDATE topup_transactions SET next_check_at = now() - interval \'1 second\' WHERE id = $1', [id]);
    await runWorkerTick(t.deps);
    tx = (await inject('GET', `/api/topups/${id}`, u.session.headers)).json();
    expect(['UNKNOWN', 'TOPUP_PENDING']).toContain(tx.status);
    const sub = [...t.deps.registry.sandboxUtility.submissions.values()][0]!;
    expect(sub.count).toBe(1); // yeniden gönderim yok
    // Sınır aşılınca inceleme kuyruğuna alınır
    await t.deps.db.query(`UPDATE topup_transactions SET status_check_count = 50, next_check_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await runWorkerTick(t.deps);
    tx = (await inject('GET', `/api/topups/${id}`, u.session.headers)).json();
    expect(tx.status).toBe('REQUIRES_REVIEW');
    const alerts = await t.deps.db.query(`SELECT 1 FROM notifications WHERE audience = 'ADMIN' AND event_type = 'TRANSACTION_REQUIRES_REVIEW'`);
    expect(alerts.rowCount).toBeGreaterThan(0);
  });

  it('su idaresi reddederse iade süreci başlar (otomatik başarılı iade sayılmaz)', async () => {
    const u = await userWithCard(t, 'rej@test.invalid', 'TEST-10008');
    const r = await startTopup(u.session, u.cardId);
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('REFUND_PENDING');
    const refund = (await t.deps.db.query('SELECT status FROM refunds WHERE source_id = $1', [tx.id])).rows[0];
    expect(refund.status).toBe('PENDING_APPROVAL');
  });
});

describe('13.7 Resmî teyit olmadan fatura ödenmiş olarak gösterilmez', () => {
  it('ödeme alındı ama tahsilat teyidi yok → "Fatura ödendi" yazmaz; teyit sonrası yazar', async () => {
    const u = await userWithCard(t, 'bill@test.invalid', 'TEST-10006');
    const inq = await inject('POST', '/api/bill-payments/inquiries', { ...u.session.headers, 'idempotency-key': idemKey() }, { subscriptionId: u.subscriptionId });
    expect(inq.statusCode).toBe(200);
    expect(inq.json().status).toBe('BILL_FOUND');
    const billIds = inq.json().bills.map((b: any) => b.billId);
    // Tutar istemciden alınmaz: ek alan reddedilir
    expect((await inject('POST', `/api/bill-payments/${inq.json().id}/pay`, u.session.headers, { billIds, amountMinor: 1 })).statusCode).toBe(400);
    const pay = await inject('POST', `/api/bill-payments/${inq.json().id}/pay`, u.session.headers, { billIds });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().transaction.amountMinor).toBe(18_450 + 21_075);
    await payViaSimulator(t, pay.json().checkoutUrl, 'SUCCEEDED');
    let tx = (await inject('GET', `/api/bill-payments/${inq.json().id}`, u.session.headers)).json();
    expect(tx.status).toBe('COLLECTION_PENDING');
    expect(tx.isPaidConfirmed).toBe(false);
    expect(tx.statusText).not.toMatch(/Fatura ödendi/);
    expect(tx.receiptId).toBeNull();
    // İki durum sorgusu sonrası kurum teyit eder
    for (let i = 0; i < 2; i++) {
      await t.deps.db.query(`UPDATE bill_payment_transactions SET next_check_at = now() - interval '1 second' WHERE id = $1`, [tx.id]);
      await runWorkerTick(t.deps);
    }
    tx = (await inject('GET', `/api/bill-payments/${tx.id}`, u.session.headers)).json();
    expect(tx.status).toBe('COMPLETED');
    expect(tx.statusText).toMatch(/Fatura ödendi/);
    expect(tx.receiptId).not.toBeNull();
  });
});

describe('13.8 Webhook imzası geçersizse olay reddedilir', () => {
  it('geçersiz imza, eksik imza ve eski zaman damgası reddedilir; işlem değişmez', async () => {
    const u = await userWithCard(t, 'wh@test.invalid');
    const r = await startTopup(u.session, u.cardId);
    const ref = decodeURIComponent(r.json().checkoutUrl.split('/').pop());
    const rt = await t.deps.integrations.paymentRuntime(t.deps.db);
    const good = t.deps.registry.sandboxPayment.simulateOutcome(rt.ctx, ref, 'SUCCEEDED');
    const tampered = good.body.replace('"amountMinor":5150', '"amountMinor":1');
    const bad1 = await t.app.inject({ method: 'POST', url: '/api/webhooks/payment/sandbox', headers: good.headers, payload: tampered });
    expect(bad1.statusCode).toBe(401);
    const bad2 = await t.app.inject({ method: 'POST', url: '/api/webhooks/payment/sandbox', headers: { 'content-type': 'application/json' }, payload: good.body });
    expect(bad2.statusCode).toBe(401);
    const stale = t.deps.registry.sandboxPayment.signedEvent(rt.ctx, JSON.parse(good.body), Date.now() - 3600_000);
    const bad3 = await t.app.inject({ method: 'POST', url: '/api/webhooks/payment/sandbox', headers: stale.headers, payload: stale.body });
    expect(bad3.statusCode).toBe(401);
    expect(bad3.json().reason).toBe('STALE_TIMESTAMP');
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('AWAITING_PAYMENT');
    const rejected = await t.deps.db.query('SELECT count(*)::int AS n FROM webhook_events WHERE NOT signature_valid');
    expect(rejected.rows[0].n).toBe(3);
  });
});

describe('13.9 Gizli anahtarlar istemciye ve günlük kayıtlarına sızmaz', () => {
  it('girilen anahtar hiçbir yanıtta, denetim kaydında veya veritabanında düz metin olarak bulunmaz', async () => {
    const admin = await superAdmin(t);
    const providerId = (await t.deps.db.query(`SELECT id FROM payment_providers WHERE code = 'sandbox'`)).rows[0].id;
    const SECRET = 'sk_test_SUPERSECRET_9f8e7d6c5b4a';
    const put = await inject('PUT', `/api/admin/payment-service/providers/${providerId}/secrets`, admin.headers, { kind: 'API_KEY', environment: 'TEST', value: SECRET });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(SECRET);
    expect(put.json().hint).toBe('••••5b4a');
    const responses = await Promise.all([
      inject('GET', '/api/admin/payment-service/providers', admin.headers),
      inject('GET', '/api/admin/payment-service/connection', admin.headers),
      inject('GET', '/api/admin/payment-service/overview', admin.headers),
      inject('GET', '/api/admin/audit-logs', admin.headers),
    ]);
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain(SECRET);
    }
    const dump = await t.deps.db.query(`SELECT (SELECT string_agg(details::text, '') FROM audit_logs) AS a, (SELECT string_agg(coalesce(ciphertext,''), '') FROM secret_values) AS s`);
    expect(dump.rows[0].a ?? '').not.toContain(SECRET);
    expect(dump.rows[0].s).not.toContain(SECRET);
    // Sunucu tarafı adaptör değeri çözebilir
    expect(await t.deps.secrets.reveal(t.deps.db, 'payment/test/sandbox-api-key')).toBe(SECRET);
    // Test anahtarı canlı referansa yazılamaz
    const mixed = await inject('PUT', `/api/admin/payment-service/providers/${providerId}/secrets`, admin.headers, { kind: 'API_KEY', environment: 'LIVE', value: SECRET, extra: 1 });
    expect(mixed.statusCode).toBe(400);
  });

  it('günlük yazıcısı gizli alanları maskeler', async () => {
    const { redact } = await import('../src/lib/redact.js');
    const out = JSON.stringify(redact({ password: 'x', apiKey: 'y', nested: { webhook_secret: 'z', cardNumber: '4111111111111111', note: 'kart 4111111111111111' } }));
    expect(out).not.toMatch(/4111111111111111|"x"|"y"|"z"/);
  });
});

describe('13.10 İade işlemi yetki kontrolünden geçmeden gerçekleştirilemez', () => {
  it('kullanıcı ve destek personeli iade onaylayamaz; yetkili yönetici onaylar, sonuç sağlayıcıdan doğrulanınca REFUNDED olur', async () => {
    const u = await userWithCard(t, 'ref@test.invalid', 'TEST-10008');
    const r = await startTopup(u.session, u.cardId);
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    const refundId = (await t.deps.db.query('SELECT id FROM refunds WHERE source_id = $1', [r.json().transaction.id])).rows[0].id;

    expect((await inject('POST', `/api/admin/payment-service/refunds/${refundId}/approve`, u.session.headers)).statusCode).toBe(403);
    const { generateTotpSecret } = await import('../src/lib/totp.js');
    const secret = generateTotpSecret();
    const supportId = await createUser(t, 'support@test.invalid', { roles: ['SUPPORT'], mfaSecret: secret });
    const support = await login(t, 'support@test.invalid', supportId, secret);
    expect((await inject('POST', `/api/admin/payment-service/refunds/${refundId}/approve`, support.headers)).statusCode).toBe(403);

    const admin = await superAdmin(t);
    const ok = await inject('POST', `/api/admin/payment-service/refunds/${refundId}/approve`, admin.headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('SUBMITTED'); // gönderildi ≠ tamamlandı
    let tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('REFUND_PENDING');
    const providerRefundRef = (await t.deps.db.query('SELECT provider_refund_ref FROM refunds WHERE id = $1', [refundId])).rows[0].provider_refund_ref;
    const done = await inject('POST', `/api/sandbox/refunds/${providerRefundRef}/complete`, admin.headers);
    expect(done.statusCode).toBe(200);
    tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('REFUNDED');
    const audit = await t.deps.db.query(`SELECT 1 FROM audit_logs WHERE action = 'refund.approve' AND target_id = $1`, [refundId]);
    expect(audit.rowCount).toBe(1);
  });

  it('iade API\'si yoksa düğme başarılı sonuç üretmez (MANUAL_ACTION_REQUIRED)', async () => {
    const u = await userWithCard(t, 'ref2@test.invalid', 'TEST-10008');
    const r = await startTopup(u.session, u.cardId);
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    await t.deps.db.query('UPDATE payment_provider_configs SET supports_refund = false');
    const refundId = (await t.deps.db.query('SELECT id FROM refunds WHERE source_id = $1', [r.json().transaction.id])).rows[0].id;
    const admin = await superAdmin(t);
    const res = await inject('POST', `/api/admin/payment-service/refunds/${refundId}/approve`, admin.headers);
    expect(res.json().status).toBe('MANUAL_ACTION_REQUIRED');
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('REFUND_PENDING');
  });
});

describe('13.11 Yönetici rolü istemci tarafında değiştirilemez', () => {
  it('kayıtta rol alanı reddedilir; süper yönetici e-postasıyla kayıt yönetici yetkisi vermez', async () => {
    const r1 = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'x@test.invalid', password: 'Guclu-Parola-2026', role: 'SUPER_ADMIN' } });
    expect(r1.statusCode).toBe(400);
    const r2 = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: SUPER_ADMIN_EMAIL, password: 'Guclu-Parola-2026' } });
    expect(r2.statusCode).toBe(200);
    const roles = await t.deps.db.query(`SELECT r.code FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.email_normalized = $1`, [SUPER_ADMIN_EMAIL]);
    expect(roles.rows.map((x) => x.code)).toEqual(['USER']);
  });

  it('kullanıcı profil veya rol uçlarıyla kendine yetki veremez', async () => {
    const id = await createUser(t, 'self@test.invalid');
    const s = await login(t, 'self@test.invalid', id);
    expect((await inject('PATCH', '/api/profile', s.headers, { roles: ['SUPER_ADMIN'] })).statusCode).toBe(400);
    expect((await inject('POST', `/api/admin/users/${id}/roles`, s.headers, { role: 'SUPER_ADMIN', action: 'GRANT' })).statusCode).toBe(403);
    const me = (await inject('GET', '/api/auth/me', { ...s.headers, 'x-role': 'SUPER_ADMIN' })).json();
    expect(me.roles).toEqual(['USER']);
    expect(me.isStaff).toBe(false);
  });

  it('CSRF belirteci olmadan çerezli istek reddedilir', async () => {
    const id = await createUser(t, 'csrf@test.invalid');
    const s = await login(t, 'csrf@test.invalid', id);
    const r = await inject('PATCH', '/api/profile', { cookie: s.headers.cookie! }, { fullName: 'Deneme Ad' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_FAILED');
  });
});

describe('13.12 Veritabanı migrationları mevcut verileri korur', () => {
  it('ara sürümde eklenen veri sonraki migrationlardan sonra korunur; değiştirilmiş migration reddedilir', async () => {
    const url = new URL(TEST_DB_URL);
    url.pathname = '/su_migr_test';
    const admin = new pg.Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS su_migr_test');
    await admin.query('CREATE DATABASE su_migr_test');
    await admin.end();
    const db = createPool(url.toString());
    try {
      await migrate(db, { upTo: '0002' });
      const u = (await db.query(`INSERT INTO users (email, email_normalized, status) VALUES ('keep@test.invalid','keep@test.invalid','ACTIVE') RETURNING id`)).rows[0];
      const w = (await db.query(`INSERT INTO water_utilities (code, full_name) VALUES ('KEEP','Koru İdaresi') RETURNING id`)).rows[0];
      await db.query(`INSERT INTO subscriptions (user_id, utility_id, subscriber_no) VALUES ($1,$2,'TEST-9999')`, [u.id, w.id]);
      const applied = await migrate(db);
      expect(applied.length).toBeGreaterThan(0);
      expect((await migrate(db)).length).toBe(0); // tekrar çalıştırmak güvenli
      const s = await db.query('SELECT s.subscriber_no, u.email FROM subscriptions s JOIN users u ON u.id = s.user_id');
      expect(s.rows).toEqual([{ subscriber_no: 'TEST-9999', email: 'keep@test.invalid' }]);
      await db.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'`);
      await expect(migrate(db)).rejects.toThrow(/checksum/);
    } finally {
      await db.end();
    }
  });
});

describe('13.13 Yedekten geri yükleme yapılabilir', () => {
  const hasPgDump = (() => {
    try {
      execFileSync('pg_dump', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasPgDump)('pg_dump ile alınan yedek yeni veritabanına geri yüklenir ve veriler eşleşir', async () => {
    await userWithCard(t, 'backup@test.invalid');
    const src = TEST_DB_URL;
    const dst = new URL(TEST_DB_URL);
    dst.pathname = '/su_restore_test';
    const admin = new pg.Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS su_restore_test');
    await admin.query('CREATE DATABASE su_restore_test');
    await admin.end();
    const dump = execFileSync('pg_dump', ['--format=custom', '--no-owner', src], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync('pg_restore', ['--no-owner', '--dbname', dst.toString()], { input: dump });
    const a = createPool(src);
    const b = createPool(dst.toString());
    try {
      for (const table of ['users', 'subscriptions', 'water_cards', 'schema_migrations', 'roles', 'role_permissions']) {
        const [x, y] = await Promise.all([a.query(`SELECT count(*)::int AS n FROM ${table}`), b.query(`SELECT count(*)::int AS n FROM ${table}`)]);
        expect(y.rows[0].n).toBe(x.rows[0].n);
      }
      const email = await b.query(`SELECT 1 FROM users WHERE email_normalized = 'backup@test.invalid'`);
      expect(email.rowCount).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('13.14 Test modundaki işlemler gerçek ödeme veya gerçek yükleme oluşturmaz', () => {
  it('işlem ve makbuz TEST olarak etiketlenir; simülatör üretim yapılandırmasında yoktur', async () => {
    const u = await userWithCard(t, 'testmode@test.invalid');
    const r = await startTopup(u.session, u.cardId);
    expect(r.json().transaction.isTest).toBe(true);
    expect(r.json().checkoutUrl).toContain('/api/sandbox/checkout/');
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    const tx = (await inject('GET', `/api/topups/${r.json().transaction.id}`, u.session.headers)).json();
    expect(tx.status).toBe('COMPLETED');
    const receipt = (await inject('GET', `/api/receipts/${tx.receiptId}`, u.session.headers)).json();
    expect(receipt.environment).toBe('TEST');
    expect(receipt.content.ortamUyarisi).toMatch(/TEST İŞLEMİDİR/);
    expect(receipt.content.kartNo).toMatch(/^•+/);

    const prod = new AdapterRegistry(false);
    expect(prod.getPayment('SANDBOX').code).toBe('NONE');
    expect(prod.getUtility('SANDBOX').code).toBe('NONE');
    expect(() => prod.registerPayment(t.deps.registry.sandboxPayment)).toThrow();
    const cfg = testConfig({ APP_ENV: 'production', APP_BASE_URL: 'https://su.example.org', API_PUBLIC_URL: 'https://api.su.example.org', AUTH_SECRET: 'Zq8'.repeat(16) });
    expect(cfg.allowSandboxAdapters).toBe(false);
  });

  it('üretim yapılandırması güvensiz değerleri reddeder', () => {
    expect(() => testConfig({ APP_ENV: 'production', APP_BASE_URL: 'http://su.example.org', API_PUBLIC_URL: 'https://api.su.example.org' })).toThrow(/https/);
    expect(() => testConfig({ APP_ENV: 'production', APP_BASE_URL: 'https://a.org', API_PUBLIC_URL: 'https://b.org', MFA_REQUIRED_FOR_SUPER_ADMIN: 'false', AUTH_SECRET: 'Zq8'.repeat(16) })).toThrow(/MFA/);
  });
});

describe('13.15 Gerçek entegrasyon ayarları eksikken sistem canlı işlem başlatmaz', () => {
  it('canlı modda gerçek adaptör/sözleşme/kontrol listesi yokken işlem başlatılamaz ve eksikler raporlanır', async () => {
    const u = await userWithCard(t, 'live@test.invalid');
    await t.deps.db.query(`UPDATE payment_service_state SET mode = 'LIVE'`);
    const r = await startTopup(u.session, u.cardId);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('NOT_READY');
    const reasons: string[] = r.json().error.details.reasons;
    expect(reasons.join(' ')).toMatch(/Yayın öncesi kontrol eksik/);
    expect(reasons.join(' ')).toMatch(/üretim \(production\) dağıtımında/);
    expect(await t.deps.db.query('SELECT 1 FROM payment_transactions').then((x) => x.rowCount)).toBe(0);
  });

  it('yapılandırılmamış entegrasyonla TEST modunda da işlem başlatılmaz ("Kurulum bekleniyor")', async () => {
    const u = await userWithCard(t, 'none@test.invalid');
    await t.deps.db.query(`UPDATE payment_providers SET adapter_code = 'NONE'`);
    const r = await startTopup(u.session, u.cardId);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.details.reasons.join(' ')).toMatch(/sözleşme ve teknik doküman bekleniyor/);
    const status = (await t.app.inject({ method: 'GET', url: '/api/platform/status' })).json();
    expect(status.paymentProvider).toBe('Kurulum bekleniyor');
  });

  it('yönetici canlı moda geçmeye çalışırsa engellenir', async () => {
    const admin = await superAdmin(t);
    const r = await inject('POST', '/api/admin/payment-service/mode', admin.headers, { mode: 'LIVE' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('LIVE_BLOCKED');
    expect(r.json().error.details.reasons.length).toBeGreaterThan(0);
  });
});
