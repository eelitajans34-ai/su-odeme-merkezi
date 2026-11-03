/**
 * Fatura ödemede QR ve temassız (NFC) ödeme yöntemleri.
 * Kural: yöntem ancak sağlayıcı adaptörü destekliyor VE yönetici açtıysa sunulur; aksi hâlde gerçek durumu ("Kurulum bekleniyor") gösterilir.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWorkerTick } from '../src/services/fulfillment.js';
import { createUser, idemKey, PASSWORD, resetData, seedSandbox, setupApp, superAdmin, teardown, userWithCard, type TestCtx } from './helpers.js';

let t: TestCtx;
let providerId: string;
beforeAll(async () => { t = await setupApp(); });
afterAll(async () => teardown(t));
beforeEach(async () => {
  await resetData(t);
  ({ providerId } = await seedSandbox(t));
});

const inject = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as any, url, headers, payload: payload as any });

async function billInquiry(u: Awaited<ReturnType<typeof userWithCard>>, headers = u.session.headers) {
  const inq = await inject('POST', '/api/bill-payments/inquiries', { ...headers, 'idempotency-key': idemKey() }, { subscriptionId: u.subscriptionId });
  expect(inq.statusCode).toBe(200);
  return inq.json();
}
const methods = async (headers: Record<string, string>, subscriptionId: string) =>
  Object.fromEntries((await inject('GET', `/api/payment-methods?kind=BILL_PAYMENT&subscriptionId=${subscriptionId}`, headers)).json().map((m: any) => [m.method, m]));
const enable = (list: string[]) => t.deps.db.query(`UPDATE payment_provider_configs SET enabled_payment_methods = $1`, [list]);

async function mobileHeaders(email: string) {
  const r = await inject('POST', '/api/auth/login', {}, { email, password: PASSWORD, clientType: 'MOBILE' });
  return { authorization: `Bearer ${r.json().token}` };
}

describe('Ödeme yöntemleri', () => {
  it('yönetici açmadıysa QR/NFC sunulmaz ve ödeme başlatılmaz', async () => {
    const u = await userWithCard(t, 'm1@test.invalid', 'TEST-10006');
    const m = await methods(u.session.headers, u.subscriptionId);
    expect(m.HOSTED_CARD.status).toBe('AVAILABLE');
    expect(m.QR.status).toBe('DISABLED');
    const inq = await billInquiry(u);
    const r = await inject('POST', `/api/bill-payments/${inq.id}/pay`, u.session.headers, { billIds: inq.bills.map((b: any) => b.billId), paymentMethod: 'QR' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect((await inject('GET', `/api/bill-payments/${inq.id}`, u.session.headers)).json().status).toBe('BILL_FOUND');
    expect((await t.deps.db.query('SELECT 1 FROM payment_transactions')).rowCount).toBe(0);
  });

  it('sağlayıcı entegrasyonu yoksa her yöntem "Kurulum bekleniyor" görünür ve açılamaz', async () => {
    await t.deps.db.query(`UPDATE payment_providers SET adapter_code = 'NONE'`);
    const u = await userWithCard(t, 'm2@test.invalid');
    const m = await methods(u.session.headers, u.subscriptionId);
    for (const k of ['HOSTED_CARD', 'QR', 'NFC']) {
      expect(m[k].status).toBe('SETUP_PENDING');
      expect(m[k].statusLabel).toMatch(/Kurulum bekleniyor/);
    }
    const admin = await superAdmin(t);
    const r = await inject('PUT', `/api/admin/payment-service/providers/${providerId}/config/TEST/payment-methods`, admin.headers, { methods: ['HOSTED_CARD', 'QR'] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('METHOD_NOT_SUPPORTED');
  });

  it('QR: karekod üretilir, "ödendi" yazmaz; ödeme ve su idaresi teyidinden sonra tamamlanır', async () => {
    const admin = await superAdmin(t);
    const en = await inject('PUT', `/api/admin/payment-service/providers/${providerId}/config/TEST/payment-methods`, admin.headers, { methods: ['HOSTED_CARD', 'QR', 'NFC'] });
    expect(en.statusCode).toBe(200);
    expect(en.json().enabledPaymentMethods).toEqual(['HOSTED_CARD', 'QR', 'NFC']);
    expect((await t.deps.db.query(`SELECT 1 FROM audit_logs WHERE action = 'payment_config.methods'`)).rowCount).toBe(1);

    const u = await userWithCard(t, 'm3@test.invalid', 'TEST-10006');
    const m = await methods(u.session.headers, u.subscriptionId);
    expect(m.QR.status).toBe('AVAILABLE');
    expect(m.QR.isSimulator).toBe(true);
    expect(m.NFC.status).toBe('MOBILE_ONLY');

    const inq = await billInquiry(u);
    const pay = await inject('POST', `/api/bill-payments/${inq.id}/pay`, u.session.headers, { billIds: inq.bills.map((b: any) => b.billId), paymentMethod: 'QR' });
    expect(pay.statusCode).toBe(200);
    const body = pay.json();
    expect(body.method).toBe('QR');
    expect(body.checkoutUrl).toBeNull();
    expect(body.qr.payload).toMatch(/sandbox\/checkout/);
    let tx = (await inject('GET', `/api/bill-payments/${inq.id}`, u.session.headers)).json();
    expect(tx.status).toBe('AWAITING_PAYMENT');
    expect(tx.paymentMethod).toBe('QR');
    expect(tx.qr.payload).toBe(body.qr.payload);
    expect(tx.isPaidConfirmed).toBe(false);

    // Karekod okutulup ödeme simülatörde onaylanır
    const ref = decodeURIComponent(new URL(body.qr.payload).pathname.split('/').pop()!);
    await t.app.inject({ method: 'POST', url: `/api/sandbox/checkout/${encodeURIComponent(ref)}/complete`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'outcome=SUCCEEDED' });
    tx = (await inject('GET', `/api/bill-payments/${inq.id}`, u.session.headers)).json();
    expect(tx.status).toBe('COLLECTION_PENDING');
    expect(tx.statusText).not.toMatch(/Fatura ödendi/);
    expect(tx.qr).toBeNull();
    for (let i = 0; i < 2; i++) {
      await t.deps.db.query(`UPDATE bill_payment_transactions SET next_check_at = now() - interval '1 second' WHERE id = $1`, [tx.id]);
      await runWorkerTick(t.deps);
    }
    tx = (await inject('GET', `/api/bill-payments/${inq.id}`, u.session.headers)).json();
    expect(tx.status).toBe('COMPLETED');
    expect(tx.statusText).toMatch(/Fatura ödendi/);
  });

  it('NFC: tarayıcıdan reddedilir; mobil uygulamada oturum açılır, başkası simülasyonu tetikleyemez', async () => {
    await enable(['HOSTED_CARD', 'QR', 'NFC']);
    const u = await userWithCard(t, 'm4@test.invalid', 'TEST-10006');
    const inq = await billInquiry(u);
    const billIds = inq.bills.map((b: any) => b.billId);
    const web = await inject('POST', `/api/bill-payments/${inq.id}/pay`, u.session.headers, { billIds, paymentMethod: 'NFC' });
    expect(web.statusCode).toBe(409);

    const mob = await mobileHeaders('m4@test.invalid');
    expect((await methods(mob, u.subscriptionId)).NFC.status).toBe('AVAILABLE');
    const pay = await inject('POST', `/api/bill-payments/${inq.id}/pay`, mob, { billIds, paymentMethod: 'NFC' });
    expect(pay.statusCode).toBe(200);
    const token = pay.json().nfc.sessionToken;
    expect(token).toMatch(/^SIMNFC-/);

    await createUser(t, 'other@test.invalid');
    const other = await mobileHeaders('other@test.invalid');
    expect((await inject('POST', `/api/sandbox/nfc/${encodeURIComponent(token)}/tap`, other, { outcome: 'SUCCEEDED' })).statusCode).toBe(404);

    expect((await inject('POST', `/api/sandbox/nfc/${encodeURIComponent(token)}/tap`, mob, { outcome: 'SUCCEEDED' })).statusCode).toBe(200);
    const tx = (await inject('GET', `/api/bill-payments/${inq.id}`, mob)).json();
    expect(tx.status).toBe('COLLECTION_PENDING');
    expect(tx.isPaidConfirmed).toBe(false);
  });
});
