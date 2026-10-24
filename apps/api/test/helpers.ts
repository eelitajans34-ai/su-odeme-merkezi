import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, createDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Deps } from '../src/context.js';
import { hashPassword, sha256Hex } from '../src/lib/crypto.js';
import { encrypt } from '../src/lib/crypto.js';
import { currentStep, generateTotpSecret, totpAt } from '../src/lib/totp.js';
import { TEST_DB_URL } from './global-setup.js';

export const SUPER_ADMIN_EMAIL = 'super-admin@test.invalid'; // gerçek adres testlerde kullanılmaz
export const PASSWORD = 'Guclu-Parola-2026';

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    AUTH_SECRET: randomBytes(32).toString('hex'),
    SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SUPER_ADMIN_EMAIL,
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    API_PUBLIC_URL: 'http://localhost:3000',
    APP_BASE_URL: 'http://localhost:5173',
    EMAIL_FROM: 'noreply@test.invalid',
    EMAIL_PROVIDER_SECRET_REF: 'notification/test/smtp-url',
    ...overrides,
  });
}

export interface TestCtx {
  deps: Deps;
  app: FastifyInstance;
  clock: { offsetMs: number };
}

export async function setupApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  const deps = createDeps(testConfig(overrides));
  const clock = { offsetMs: 0 };
  deps.now = () => new Date(Date.now() + clock.offsetMs);
  const app = await buildApp(deps);
  await app.ready();
  return { deps, app, clock };
}

export async function teardown(t: TestCtx) {
  await t.app.close();
  await t.deps.db.end();
}

/** Kullanıcı verilerini temizler; rol/yetki tanımları ve sistem ayarları korunur. */
let seedSnapshot: { golive: any[]; settings: any[] } | null = null;

export async function resetData(t: TestCtx) {
  // users tablosuna bağlı tekil ayar tabloları da CASCADE ile boşalır; migration tohum verisi saklanıp geri yazılır
  if (!seedSnapshot) {
    seedSnapshot = {
      golive: (await t.deps.db.query('SELECT code, title, is_automated, sort_order FROM golive_checklist_items')).rows,
      settings: (await t.deps.db.query('SELECT key, value, description FROM system_settings')).rows,
    };
  }
  await t.deps.db.query(`TRUNCATE users, water_utilities, payment_providers, secret_values, fee_schedules, reconciliation_runs, notifications,
    audit_logs, webhook_events, connection_tests, backup_runs, transaction_status_history, legal_documents, data_processors, payment_transactions CASCADE`);
  // TRUNCATE ... CASCADE yabancı anahtarla bağlı tekil tabloları da boşaltır; varsayılanlar yeniden yazılır
  await t.deps.db.query(`INSERT INTO payment_service_state (id, mode) VALUES (true, 'TEST') ON CONFLICT (id) DO UPDATE SET mode = 'TEST', active_provider_id = NULL, live_enabled_at = NULL`);
  await t.deps.db.query(`INSERT INTO notification_channels (channel, status) VALUES ('EMAIL','NOT_CONFIGURED'),('SMS','NOT_CONFIGURED'),('PUSH','NOT_CONFIGURED'),('IN_APP','ACTIVE') ON CONFLICT DO NOTHING`);
  await t.deps.db.query('TRUNCATE golive_checklist_items, system_settings');
  for (const g of seedSnapshot.golive) {
    await t.deps.db.query('INSERT INTO golive_checklist_items (code, title, is_automated, sort_order) VALUES ($1,$2,$3,$4)', [g.code, g.title, g.is_automated, g.sort_order]);
  }
  for (const st of seedSnapshot.settings) {
    await t.deps.db.query('INSERT INTO system_settings (key, value, description) VALUES ($1,$2,$3)', [st.key, JSON.stringify(st.value), st.description]);
  }
  t.deps.registry.sandboxPayment.payments.clear();
  t.deps.registry.sandboxPayment.refunds.clear();
  t.deps.registry.sandboxUtility.submissions.clear();
}

/** Simülatör su idaresi + simülatör ödeme sağlayıcısı + örnek tarife (TEST). */
export async function seedSandbox(t: TestCtx) {
  const db = t.deps.db;
  const u = (await db.query(`INSERT INTO water_utilities (code, full_name, is_active) VALUES ('TEST_SIM','TEST Simülatör İdaresi', true) RETURNING id`)).rows[0];
  await db.query(
    `INSERT INTO utility_integrations (utility_id, environment, adapter_code, supports_account_query, supports_card_topup, supports_bill_query, supports_bill_payment, supports_status_query, supports_reconciliation, last_connection_test_ok)
     VALUES ($1,'TEST','SANDBOX',true,true,true,true,true,true,true)`,
    [u.id],
  );
  const p = (await db.query(`INSERT INTO payment_providers (code, display_name, adapter_code) VALUES ('sandbox','TEST Simülatör','SANDBOX') RETURNING id`)).rows[0];
  await t.deps.secrets.put(db, { ref: 'payment/test/sandbox-api-key', environment: 'TEST', value: 'sim_api_key_value_123', actorId: null });
  await t.deps.secrets.put(db, { ref: 'payment/test/sandbox-webhook-secret', environment: 'TEST', value: 'whsec_test_value_456', actorId: null });
  await db.query(
    `INSERT INTO payment_provider_configs (provider_id, environment, api_key_secret_ref, webhook_secret_ref, supports_refund, last_connection_test_ok)
     VALUES ($1,'TEST','payment/test/sandbox-api-key','payment/test/sandbox-webhook-secret',true,true)`,
    [p.id],
  );
  await db.query('UPDATE payment_service_state SET active_provider_id = $1', [p.id]);
  for (const type of ['TOPUP', 'BILL_PAYMENT']) {
    await db.query(`INSERT INTO fee_schedules (transaction_type, fee_type, fixed_fee_minor, user_facing_description, is_sample, effective_from) VALUES ($1,'FIXED',150,'Örnek bedel',true, now() - interval '1 day')`, [type]);
  }
  return { utilityId: u.id as string, providerId: p.id as string };
}

export async function createUser(t: TestCtx, email: string, opts: { roles?: string[]; mfaSecret?: string } = {}) {
  const db = t.deps.db;
  const u = (
    await db.query(`INSERT INTO users (email, email_normalized, password_hash, status, email_verified_at) VALUES ($1,$2,$3,'ACTIVE',now()) RETURNING id`, [email, email.toLowerCase(), await hashPassword(PASSWORD)])
  ).rows[0];
  for (const r of ['USER', ...(opts.roles ?? [])]) {
    await db.query(`INSERT INTO user_roles (user_id, role_id, granted_via) SELECT $1, id, 'ADMIN_ACTION' FROM roles WHERE code = $2`, [u.id, r]);
  }
  if (opts.mfaSecret) {
    const key = Buffer.from(t.deps.config.SECRETS_ENCRYPTION_KEY, 'base64');
    await db.query(`INSERT INTO mfa_methods (user_id, type, secret_ciphertext, confirmed_at) VALUES ($1,'TOTP',$2,now())`, [u.id, encrypt(opts.mfaSecret, key, `mfa:${u.id}`)]);
  }
  return u.id as string;
}

export interface Session {
  userId: string;
  headers: Record<string, string>;
  mfaSecret?: string;
}

export async function login(t: TestCtx, email: string, userId: string, mfaSecret?: string): Promise<Session> {
  const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD, clientType: 'WEB' } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'su_session')!.value;
  const csrf = res.json().csrfToken;
  const s: Session = { userId, headers: { cookie: `su_session=${cookie}`, 'x-csrf-token': csrf }, mfaSecret };
  if (mfaSecret) await verifyMfa(t, s);
  return s;
}

/** Her MFA doğrulaması yeni bir TOTP zaman adımı gerektirir (tekrar kullanım engeli); saat 30 sn ileri alınır. */
export async function verifyMfa(t: TestCtx, s: Session) {
  t.clock.offsetMs += 31_000;
  const code = totpAt(s.mfaSecret!, currentStep(Date.now() + t.clock.offsetMs));
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/mfa/verify', headers: s.headers, payload: { code } });
  if (r.statusCode !== 200) throw new Error(`mfa verify failed ${r.body}`);
}

export async function superAdmin(t: TestCtx, email = 'admin@test.invalid') {
  const secret = generateTotpSecret();
  const id = await createUser(t, email, { roles: ['SUPER_ADMIN'], mfaSecret: secret });
  return login(t, email, id, secret);
}

export async function userWithCard(t: TestCtx, email: string, subscriberNo = 'TEST-10001') {
  const id = await createUser(t, email);
  const s = await login(t, email, id);
  const utilityId = (await t.deps.db.query(`SELECT id FROM water_utilities WHERE code = 'TEST_SIM'`)).rows[0].id;
  const sub = await t.app.inject({ method: 'POST', url: '/api/subscriptions', headers: s.headers, payload: { utilityId, subscriberNo } });
  if (sub.statusCode !== 200) throw new Error(`subscription failed ${sub.body}`);
  const cards = (await t.app.inject({ method: 'GET', url: '/api/cards', headers: s.headers })).json();
  return { session: s, subscriptionId: sub.json().id as string, cardId: cards[0]?.id as string };
}

export function idemKey() {
  return `idem-${randomBytes(12).toString('hex')}`;
}

export async function payViaSimulator(t: TestCtx, checkoutUrl: string, outcome: 'SUCCEEDED' | 'FAILED') {
  const ref = decodeURIComponent(checkoutUrl.split('/').pop()!);
  return t.app.inject({ method: 'POST', url: `/api/sandbox/checkout/${encodeURIComponent(ref)}/complete`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `outcome=${outcome}` });
}

export { sha256Hex };
