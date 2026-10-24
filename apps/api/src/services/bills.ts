import type { Actor, Deps } from '../context.js';
import { withTransaction } from '../db.js';
import { publicRef, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { maskTail } from '../lib/mask.js';
import { quote, startPayment } from './payments.js';
import { lockTxn, transition, USER_STATUS_TEXT } from './state-machine.js';
import { getOwnedSubscription } from './subscriptions.js';
import type { Bill } from '../integrations/utility/types.js';

const INQUIRY_TTL_MS = 15 * 60_000;

/** 1-3. adım: borç sorgulama. Borç bilgisi yalnızca resmî entegrasyondan gelir. */
export async function inquireBills(deps: Deps, actor: Actor, input: { subscriptionId: string; idempotencyKey: string }) {
  const db = deps.db;
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(input.idempotencyKey)) throw badRequest('Idempotency-Key başlığı gerekli (16-80 karakter).', 'IDEMPOTENCY_KEY_REQUIRED');
  const prior = (await db.query('SELECT id FROM bill_payment_transactions WHERE user_id = $1 AND idempotency_key = $2', [actor.userId, input.idempotencyKey])).rows[0];
  if (prior) return getBillPayment(deps, actor.userId, prior.id);

  const sub = await getOwnedSubscription(deps, actor.userId, input.subscriptionId);
  if (sub.verification_status !== 'VERIFIED') throw badRequest('Abonelik su idaresi tarafından doğrulanmadan borç sorgulanamaz.', 'SUBSCRIPTION_NOT_VERIFIED');
  const readiness = await deps.integrations.assertReady(db, 'BILL_QUERY', sub.utility_id);

  const txn = await withTransaction(db, async (c) => {
    const t = (
      await c.query(
        `INSERT INTO bill_payment_transactions (public_ref, user_id, subscription_id, utility_id, environment, idempotency_key, status, utility_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,'CREATED',$7) RETURNING *`,
        [publicRef('FTR'), actor.userId, sub.id, sub.utility_id, readiness.mode, input.idempotencyKey, `UR-${randomToken(12)}`],
      )
    ).rows[0];
    await c.query('INSERT INTO transaction_status_history (source_type, source_id, to_status, actor) VALUES ($1,$2,$3,$4)', ['BILL_PAYMENT', t.id, 'CREATED', `USER:${actor.userId}`]);
    await transition(c, 'BILL_PAYMENT', t.id, 'CREATED', 'BILL_QUERY_PENDING', { actor: `USER:${actor.userId}` });
    await c.query(`INSERT INTO bill_inquiries (bill_payment_transaction_id, user_id, subscription_id, status) VALUES ($1,$2,$3,'PENDING')`, [t.id, actor.userId, sub.id]);
    return t;
  });

  const rt = await deps.integrations.utilityRuntime(db, sub.utility_id, readiness.mode);
  let bills: Bill[] | null = null;
  let error: string | null = null;
  try {
    bills = (await rt.adapter.queryBills(rt.ctx, sub.subscriber_no)).bills;
  } catch (err) {
    error = 'Borç sorgulaması su idaresinden yanıt alınamadığı için tamamlanamadı.';
  }
  await withTransaction(db, async (c) => {
    if (bills && bills.length > 0) {
      const total = bills.reduce((a, b) => a + b.amountMinor, 0);
      await c.query(`UPDATE bill_inquiries SET status = 'FOUND', bills = $2, total_debt_minor = $3, queried_at = now(), expires_at = $4 WHERE bill_payment_transaction_id = $1`,
        [txn.id, JSON.stringify(bills), total, new Date(deps.now().getTime() + INQUIRY_TTL_MS)]);
      await transition(c, 'BILL_PAYMENT', txn.id, 'BILL_QUERY_PENDING', 'BILL_FOUND', { actor: 'SYSTEM' });
    } else if (bills) {
      await c.query(`UPDATE bill_inquiries SET status = 'NO_DEBT', queried_at = now() WHERE bill_payment_transaction_id = $1`, [txn.id]);
      await transition(c, 'BILL_PAYMENT', txn.id, 'BILL_QUERY_PENDING', 'FAILED', { actor: 'SYSTEM', reason: 'Borç yok', set: { error_code: 'NO_DEBT', error_message: 'Ödenecek borç bulunamadı.' } });
    } else {
      await c.query(`UPDATE bill_inquiries SET status = 'FAILED', error_message = $2 WHERE bill_payment_transaction_id = $1`, [txn.id, error]);
      await transition(c, 'BILL_PAYMENT', txn.id, 'BILL_QUERY_PENDING', 'FAILED', { actor: 'SYSTEM', reason: 'Sorgu başarısız', set: { error_code: 'QUERY_FAILED', error_message: error } });
    }
  });
  return getBillPayment(deps, actor.userId, txn.id);
}

/** 4-5. adım: seçilen faturalar için ödeme. Tutar istemciden alınmaz; sorgu anlık görüntüsünden hesaplanır. */
export async function payBills(deps: Deps, actor: Actor, txnId: string, billIds: string[]) {
  const db = deps.db;
  if (!Array.isArray(billIds) || billIds.length === 0) throw badRequest('En az bir fatura seçin.');
  const prepared = await withTransaction(db, async (c) => {
    const t = await lockTxn(c, 'BILL_PAYMENT', txnId);
    if (!t || t.user_id !== actor.userId) throw notFound('İşlem bulunamadı.');
    if (t.status !== 'BILL_FOUND') throw conflict('Bu işlem için ödeme başlatılamaz (durum: ' + t.status + ').');
    const inq = (await c.query('SELECT * FROM bill_inquiries WHERE bill_payment_transaction_id = $1', [txnId])).rows[0];
    if (!inq?.expires_at || new Date(inq.expires_at) < deps.now()) {
      await transition(c, 'BILL_PAYMENT', txnId, 'BILL_FOUND', 'FAILED', { actor: 'SYSTEM', reason: 'Sorgu süresi doldu', set: { error_code: 'INQUIRY_EXPIRED', error_message: 'Borç sorgusunun süresi doldu; yeniden sorgulayın.' } });
      return { expired: true } as const;
    }
    const bills = inq.bills as Bill[];
    const unique = [...new Set(billIds)];
    const selected = bills.filter((b) => unique.includes(b.billId));
    if (selected.length !== unique.length) throw badRequest('Seçilen fatura sorgu sonucunda yok.');
    const amount = selected.reduce((a, b) => a + b.amountMinor, 0);
    return { expired: false, amount, unique, t } as const;
  });
  if (prepared.expired) throw conflict('Borç sorgusunun süresi doldu; lütfen yeniden sorgulayın.', 'INQUIRY_EXPIRED');
  await deps.integrations.assertReady(db, 'BILL_PAYMENT', prepared.t.utility_id);
  const q = await quote(deps, 'BILL_PAYMENT', prepared.amount, actor.userId);
  await withTransaction(db, async (c) => {
    await c.query('UPDATE bill_inquiries SET selected_bill_ids = $2 WHERE bill_payment_transaction_id = $1', [txnId, prepared.unique]);
    await c.query(
      `UPDATE bill_payment_transactions SET amount_minor = $2, fee_minor = $3, total_minor = $4, currency = $5, fee_schedule_id = $6, updated_at = now() WHERE id = $1 AND status = 'BILL_FOUND'`,
      [txnId, q.amountMinor, q.feeMinor, q.totalMinor, q.currency, q.feeScheduleId],
    );
  });
  const pay = await startPayment(deps, 'BILL_PAYMENT', txnId, 'BILL_FOUND');
  return { transaction: await getBillPayment(deps, actor.userId, txnId), checkoutUrl: pay.checkoutUrl };
}

const BILL_SELECT = `SELECT t.*, s.subscriber_no, u.full_name AS utility_name, i.status AS inquiry_status, i.bills, i.total_debt_minor, i.selected_bill_ids, i.expires_at AS inquiry_expires_at, r.id AS receipt_id
  FROM bill_payment_transactions t
  JOIN subscriptions s ON s.id = t.subscription_id
  JOIN water_utilities u ON u.id = t.utility_id
  LEFT JOIN bill_inquiries i ON i.bill_payment_transaction_id = t.id
  LEFT JOIN receipts r ON r.source_type = 'BILL_PAYMENT' AND r.source_id = t.id`;

export function presentBill(r: any) {
  return {
    id: r.id,
    type: 'BILL_PAYMENT' as const,
    ref: r.public_ref,
    status: r.status,
    // "Fatura ödendi" ifadesi yalnızca COMPLETED (su idaresi teyidi) durumunda kullanılır
    statusText: r.status === 'COMPLETED' ? 'Fatura ödendi (su idaresi tarafından teyit edildi)' : USER_STATUS_TEXT[r.status] ?? r.status,
    isPaidConfirmed: r.status === 'COMPLETED',
    environment: r.environment,
    isTest: r.environment === 'TEST',
    subscriberMasked: maskTail(r.subscriber_no),
    utilityName: r.utility_name,
    bills: r.bills ?? [],
    totalDebtMinor: r.total_debt_minor,
    selectedBillIds: r.selected_bill_ids ?? [],
    inquiryExpiresAt: r.inquiry_expires_at,
    amountMinor: r.amount_minor,
    feeMinor: r.fee_minor,
    totalMinor: r.total_minor,
    currency: r.currency?.trim(),
    utilityRef: r.status === 'COMPLETED' ? r.utility_ref : null,
    errorMessage: r.error_message,
    receiptId: r.receipt_id ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export async function getBillPayment(deps: Deps, userId: string, id: string) {
  const { rows } = await deps.db.query(`${BILL_SELECT} WHERE t.id = $1 AND t.user_id = $2`, [id, userId]);
  if (!rows[0]) throw notFound('İşlem bulunamadı.');
  return presentBill(rows[0]);
}

export async function listBillPayments(deps: Deps, userId: string) {
  const { rows } = await deps.db.query(`${BILL_SELECT} WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 100`, [userId]);
  return rows.map(presentBill);
}
