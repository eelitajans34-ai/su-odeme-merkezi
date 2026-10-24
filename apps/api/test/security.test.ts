import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSuperAdmin } from '../src/cli/bootstrap.js';
import { computeFee } from '../src/services/fees.js';
import { canTransition } from '../src/services/state-machine.js';
import { itemsToCsv, runReconciliation } from '../src/services/reconciliation.js';
import { base32Encode, currentStep, totpAt, verifyTotp } from '../src/lib/totp.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { maskTail } from '../src/lib/mask.js';
import { createUser, idemKey, login, payViaSimulator, PASSWORD, resetData, seedSandbox, setupApp, superAdmin, SUPER_ADMIN_EMAIL, teardown, userWithCard, type TestCtx } from './helpers.js';

describe('birim testleri', () => {
  it('TOTP RFC 6238 test vektörü', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // T = 59 sn → adım 1 → 8 haneli referans 94287082; 6 hane: 287082
    expect(totpAt(secret, 1)).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    const step = currentStep();
    expect(verifyTotp(secret, totpAt(secret, step))).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step), Date.now(), step)).toBeNull(); // tekrar kullanım
  });

  it('ücret hesaplama tamsayı kuruşla yapılır ve sınırlara uyar', () => {
    const base = { id: 'x', fixed_fee_minor: 150, percent_bps: 125, min_fee_minor: 200, max_fee_minor: 1000, min_amount_minor: 100, max_amount_minor: 1e6, user_facing_description: '', is_sample: true };
    expect(computeFee(10_000, { ...base, fee_type: 'FIXED' })).toBe(200);
    expect(computeFee(10_000, { ...base, fee_type: 'PERCENT' })).toBe(200);
    expect(computeFee(40_000, { ...base, fee_type: 'FIXED_PLUS_PERCENT' })).toBe(650);
    expect(computeFee(400_000, { ...base, fee_type: 'PERCENT' })).toBe(1000);
    expect(computeFee(10_000, null)).toBe(0);
  });

  it('durum makinesi: ödeme onayı doğrudan COMPLETED yapmaz; tahsilat sonrası FAILED olmaz', () => {
    expect(canTransition('TOPUP', 'PAYMENT_CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransition('TOPUP', 'TOPUP_PENDING', 'FAILED')).toBe(false);
    expect(canTransition('BILL_PAYMENT', 'PAYMENT_CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransition('BILL_PAYMENT', 'COLLECTION_PENDING', 'COMPLETED')).toBe(true);
    expect(canTransition('TOPUP', 'COMPLETED', 'REFUNDED')).toBe(false);
  });

  it('AES-GCM şifreleme ek veriyle bağlıdır', () => {
    const key = Buffer.alloc(32, 7);
    const c = encrypt('gizli', key, 'ref-a');
    expect(decrypt(c, key, 'ref-a')).toBe('gizli');
    expect(() => decrypt(c, key, 'ref-b')).toThrow();
  });

  it('maskeleme ve CSV formül enjeksiyonu önlemi', () => {
    expect(maskTail('1234567890')).toBe('••••••7890');
    expect(itemsToCsv([{ issue_type: '=HYPERLINK("x")' }])).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('entegrasyon: güvenlik ve süreçler', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await setupApp();
  });
  afterAll(async () => teardown(t));
  beforeEach(async () => {
    await resetData(t);
    await seedSandbox(t);
  });

  it('bootstrap-super-admin idempotenttir, parola üretmez ve MFA kurulmadan yönetim erişimi vermez', async () => {
    const r1 = await bootstrapSuperAdmin(t.deps, { email: SUPER_ADMIN_EMAIL });
    expect(r1.status).toBe('INVITE_CREATED');
    const r2 = await bootstrapSuperAdmin(t.deps, { email: SUPER_ADMIN_EMAIL });
    expect(r2.status).toBe('ALREADY_EXISTS');
    const r3 = await bootstrapSuperAdmin(t.deps, { email: 'baska@test.invalid' });
    expect(r3.status).toBe('ALREADY_EXISTS');
    const admins = await t.deps.db.query(`SELECT u.email, u.password_hash, u.status FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE r.code = 'SUPER_ADMIN'`);
    expect(admins.rows).toHaveLength(1);
    expect(admins.rows[0].password_hash).toBeNull();
    expect(admins.rows[0].status).toBe('INVITED');
    // Davet kabulü
    if (r1.status !== 'INVITE_CREATED') throw new Error();
    const token = new URL(r1.inviteUrl).searchParams.get('token')!;
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: 'zayif' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD } })).statusCode).toBe(200);
    // Davet ikinci kez kullanılamaz
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/invite/accept', payload: { token, password: PASSWORD } })).statusCode).toBe(400);
    const s = await login(t, SUPER_ADMIN_EMAIL, r1.userId);
    const me = (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers })).json();
    expect(me.mfa.enrollmentRequired).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: s.headers })).statusCode).toBe(403);
    // TOTP kurulumu sonrası erişim
    const start = (await t.app.inject({ method: 'POST', url: '/api/auth/mfa/totp/start', headers: s.headers })).json();
    const code = totpAt(start.secret, currentStep());
    const confirm = await t.app.inject({ method: 'POST', url: '/api/auth/mfa/totp/confirm', headers: s.headers, payload: { code } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: s.headers })).statusCode).toBe(200);
    // Personel MFA'yı kapatamaz
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/mfa/disable', headers: s.headers, payload: { password: PASSWORD } })).statusCode).toBe(403);
  });

  it('mevcut hesaba süper yönetici yetkisi açık onay olmadan verilmez', async () => {
    await createUser(t, SUPER_ADMIN_EMAIL);
    const r = await bootstrapSuperAdmin(t.deps, { email: SUPER_ADMIN_EMAIL });
    expect(r.status).toBe('REFUSED');
    const ok = await bootstrapSuperAdmin(t.deps, { email: SUPER_ADMIN_EMAIL, confirmExistingAccount: true });
    expect(ok.status).toBe('INVITE_CREATED');
    const u = (await t.deps.db.query('SELECT status, password_hash FROM users WHERE email_normalized = $1', [SUPER_ADMIN_EMAIL])).rows[0];
    expect(u.status).toBe('INVITED');
    expect(u.password_hash).toBeNull();
  });

  it('üretimde e-posta kanalı yoksa davet bağlantısı konsola yazılmaz', async () => {
    const prodLike = { ...t.deps, config: { ...t.deps.config, isProduction: true, APP_ENV: 'production' as const } };
    await expect(bootstrapSuperAdmin(prodLike, { email: 'prod-admin@test.invalid' })).rejects.toThrow(/e-posta/);
  });

  it('art arda hatalı girişler hesabı geçici kilitler ve kullanıcı bilgilendirilir', async () => {
    const id = await createUser(t, 'lock@test.invalid');
    for (let i = 0; i < 5; i++) {
      await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@test.invalid', password: 'Yanlis-Parola-1' } });
    }
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lock@test.invalid', password: PASSWORD } });
    expect(r.statusCode).toBe(423);
    const n = await t.deps.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND event_type = 'SUSPICIOUS_LOGIN'`, [id]);
    expect(n.rowCount).toBe(1);
  });

  it('giriş uç noktası hız sınırlıdır', async () => {
    const t2 = await setupApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await t2.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@test.invalid', password: 'x' } })).statusCode);
    expect(codes.slice(-1)[0]).toBe(429);
    await teardown(t2);
  });

  it('kayıt e-posta doğrulaması olmadan giriş yapılamaz; hesap varlığı ifşa edilmez', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'new@test.invalid', password: PASSWORD } });
    const dup = await t.app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'new@test.invalid', password: PASSWORD } });
    expect(r.json()).toEqual(dup.json());
    const l = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@test.invalid', password: PASSWORD } });
    expect(l.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    const mail = t.deps.notifications.devOutbox.find((m) => m.to === 'new@test.invalid' && /doğrulayın/.test(m.subject))!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@test.invalid', password: PASSWORD } })).statusCode).toBe(200);
  });

  it('parola sıfırlama tüm oturumları sonlandırır', async () => {
    const id = await createUser(t, 'reset@test.invalid');
    const s = await login(t, 'reset@test.invalid', id);
    await t.app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { email: 'reset@test.invalid' } });
    const mail = t.deps.notifications.devOutbox.filter((m) => m.to === 'reset@test.invalid').pop()!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { token, password: 'Yeni-Guclu-Parola-9' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers })).statusCode).toBe(401);
  });

  it('SMS/push sağlayıcısı yokken bildirim gönderilmiş gibi gösterilmez', async () => {
    const id = await createUser(t, 'notify@test.invalid');
    const nid = await t.deps.notifications.notifyUser({ userId: id, eventType: 'X', title: 'x', body: 'y', channels: ['SMS', 'PUSH'] });
    const d = await t.deps.db.query('SELECT channel, status FROM notification_deliveries WHERE notification_id = $1 ORDER BY channel', [nid]);
    expect(d.rows).toEqual([
      { channel: 'IN_APP', status: 'DELIVERED_IN_APP' },
      { channel: 'PUSH', status: 'NOT_SENT_PROVIDER_NOT_CONFIGURED' },
      { channel: 'SMS', status: 'NOT_SENT_PROVIDER_NOT_CONFIGURED' },
    ]);
  });

  it('mutabakat eşleşmeyen tutarı ve eksik makbuzu tespit eder', async () => {
    const u = await userWithCard(t, 'recon@test.invalid');
    const r = await t.app.inject({ method: 'POST', url: '/api/topups', headers: { ...u.session.headers, 'idempotency-key': idemKey() }, payload: { waterCardId: u.cardId, amountMinor: 5000 } });
    await payViaSimulator(t, r.json().checkoutUrl, 'SUCCEEDED');
    // Sağlayıcı tarafında tutarı değiştir ve makbuzu sil → iki uyuşmazlık beklenir
    for (const p of t.deps.registry.sandboxPayment.payments.values()) p.amountMinor += 1;
    await t.deps.db.query('DELETE FROM receipts');
    const admin = await superAdmin(t);
    const run = await t.app.inject({ method: 'POST', url: '/api/admin/payment-service/reconciliation/runs', headers: admin.headers, payload: { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() } });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('COMPLETED_WITH_ISSUES');
    const items = (await t.app.inject({ method: 'GET', url: `/api/admin/payment-service/reconciliation/runs/${run.json().id}/items`, headers: admin.headers })).json();
    expect(items.map((i: any) => i.issue_type).sort()).toEqual(['AMOUNT_MISMATCH', 'MISSING_RECEIPT']);
    const csv = await t.app.inject({ method: 'GET', url: `/api/admin/payment-service/reconciliation/runs/${run.json().id}/export.csv`, headers: admin.headers });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
  });

  it('mutabakat kaynak yapılandırılmamışsa bunu açıkça kaydeder', async () => {
    await t.deps.db.query(`UPDATE payment_providers SET adapter_code = 'NONE'`);
    await t.deps.db.query(`UPDATE utility_integrations SET supports_reconciliation = false`);
    const admin = await createUser(t, 'r@test.invalid');
    const run = await runReconciliation(t.deps, { userId: admin }, new Date(Date.now() - 1000), new Date());
    expect(run.status).toBe('SKIPPED_NOT_CONFIGURED');
  });

  it('yayın kontrol listesi kanıtsız doğrulanamaz; otomatik maddeler gerçek durumu kontrol eder', async () => {
    const admin = await superAdmin(t);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/golive/UTILITY_WRITTEN_APPROVAL/verify', headers: admin.headers, payload: { status: 'VERIFIED' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/golive/KEYS_SEPARATED/verify', headers: admin.headers, payload: { status: 'VERIFIED', evidenceRef: 'belge-1' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/golive/BACKUP_RESTORE_VERIFIED/verify', headers: admin.headers, payload: { status: 'VERIFIED', evidenceRef: 'belge-2' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/golive/SUPER_ADMIN_MFA/verify', headers: admin.headers, payload: { status: 'VERIFIED', evidenceRef: 'belge-3' } })).statusCode).toBe(200);
  });

  it('yönetici rol değişikliği denetim kaydına yazılır ve hedefin oturumlarını kapatır', async () => {
    const admin = await superAdmin(t);
    const id = await createUser(t, 'staff@test.invalid');
    const s = await login(t, 'staff@test.invalid', id);
    const r = await t.app.inject({ method: 'POST', url: `/api/admin/users/${id}/roles`, headers: admin.headers, payload: { role: 'FINANCE', action: 'GRANT' } });
    expect(r.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: s.headers })).statusCode).toBe(401);
    const a = await t.deps.db.query(`SELECT 1 FROM audit_logs WHERE action = 'role.grant' AND target_id = $1`, [id]);
    expect(a.rowCount).toBe(1);
    await expect(t.deps.db.query('DELETE FROM audit_logs')).rejects.toThrow(/yalnızca ekleme/);
  });
  it('e-posta kanalı: SMTP bilgisi geri gösterilmez, deneme gönderimi gerçek sonucu bildirir', async () => {
    const admin = await superAdmin(t);
    const put = await t.app.inject({ method: 'PUT', url: '/api/admin/notification-channels/EMAIL', headers: admin.headers, payload: { providerName: 'Deneme SMTP', status: 'TEST', smtpUrl: 'smtp://kullanici:cok-gizli-parola@127.0.0.1:1' } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('cok-gizli-parola');
    const list = await t.app.inject({ method: 'GET', url: '/api/admin/notification-channels', headers: admin.headers });
    expect(list.body).not.toContain('cok-gizli-parola');
    expect(list.json().find((c: any) => c.channel === 'EMAIL')).toMatchObject({ status: 'TEST', has_secret: true });
    const test = await t.app.inject({ method: 'POST', url: '/api/admin/notification-channels/EMAIL/test', headers: admin.headers });
    expect(test.json().status).toBe('FAILED');
    expect(test.body).not.toContain('cok-gizli-parola');
    const user = await login(t, 'u-mail@test.invalid', await createUser(t, 'u-mail@test.invalid'));
    expect((await t.app.inject({ method: 'PUT', url: '/api/admin/notification-channels/EMAIL', headers: user.headers, payload: { providerName: 'x', status: 'DISABLED' } })).statusCode).toBe(403);
  });
});
