import type { Actor, Deps } from '../context.js';
import { publicRef, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { maskTail } from '../lib/mask.js';
import { quote, startPayment } from './payments.js';
import { USER_STATUS_TEXT } from './state-machine.js';
import { applyPaymentResult } from './payment-events.js';

export async function topupQuote(deps: Deps, actor: Actor, waterCardId: string, amountMinor: number) {
  const card = await ownedCard(deps, actor.userId, waterCardId);
  const readiness = await deps.integrations.readiness(deps.db, 'TOPUP', card.utility_id);
  const q = await quote(deps, 'TOPUP', amountMinor, actor.userId);
  return { ...q, readiness };
}

async function ownedCard(deps: Deps, userId: string, waterCardId: string) {
  // Nesne bazlı yetki: kart yalnızca sahibine görünür. Başkasının kartı için 404 döner (varlık ifşa edilmez).
  const { rows } = await deps.db.query(
    `SELECT c.*, s.utility_id, s.subscriber_no, s.verification_status
       FROM water_cards c JOIN subscriptions s ON s.id = c.subscription_id
      WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL AND s.deleted_at IS NULL`,
    [waterCardId, userId],
  );
  if (!rows[0]) throw notFound('Su kartı bulunamadı.');
  return rows[0];
}

export async function createTopup(deps: Deps, actor: Actor, input: { waterCardId: string; amountMinor: number; idempotencyKey: string }) {
  const db = deps.db;
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(input.idempotencyKey)) throw badRequest('Idempotency-Key başlığı gerekli (16-80 karakter).', 'IDEMPOTENCY_KEY_REQUIRED');

  const existing = await db.query('SELECT * FROM topup_transactions WHERE user_id = $1 AND idempotency_key = $2', [actor.userId, input.idempotencyKey]);
  if (existing.rows[0]) return replay(deps, existing.rows[0], input);

  const card = await ownedCard(deps, actor.userId, input.waterCardId);
  if (card.verification_status !== 'VERIFIED') throw badRequest('Abonelik su idaresi tarafından doğrulanmadan yükleme yapılamaz.', 'SUBSCRIPTION_NOT_VERIFIED');
  if (card.topup_method === 'NOT_SUPPORTED') throw badRequest('Bu kart/sayaç için uzaktan yükleme desteklenmiyor.', 'TOPUP_NOT_SUPPORTED');

  const readiness = await deps.integrations.assertReady(db, 'TOPUP', card.utility_id);
  const q = await quote(deps, 'TOPUP', input.amountMinor, actor.userId);

  let txn;
  try {
    txn = (
      await db.query(
        `INSERT INTO topup_transactions (public_ref, user_id, water_card_id, subscription_id, utility_id, environment, idempotency_key,
           status, amount_minor, fee_minor, total_minor, currency, fee_schedule_id, utility_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'CREATED',$8,$9,$10,$11,$12,$13) RETURNING *`,
        [publicRef('YKL'), actor.userId, card.id, card.subscription_id, card.utility_id, readiness.mode, input.idempotencyKey,
          q.amountMinor, q.feeMinor, q.totalMinor, q.currency, q.feeScheduleId, `UR-${randomToken(12)}`],
      )
    ).rows[0];
  } catch (err: any) {
    if (err.code === '23505') {
      // Aynı anahtarla eşzamanlı ikinci istek: ilk kaydı döndür
      const again = await db.query('SELECT * FROM topup_transactions WHERE user_id = $1 AND idempotency_key = $2', [actor.userId, input.idempotencyKey]);
      if (again.rows[0]) return replay(deps, again.rows[0], input);
    }
    throw err;
  }
  await db.query('INSERT INTO transaction_status_history (source_type, source_id, to_status, actor) VALUES ($1,$2,$3,$4)', ['TOPUP', txn.id, 'CREATED', `USER:${actor.userId}`]);
  const pay = await startPayment(deps, 'TOPUP', txn.id, 'CREATED');
  return { transaction: await getTopup(deps, actor.userId, txn.id), checkoutUrl: pay.checkoutUrl, replayed: false };
}

async function replay(deps: Deps, row: any, input: { waterCardId: string; amountMinor: number }) {
  if (row.water_card_id !== input.waterCardId || Number(row.amount_minor) !== input.amountMinor) {
    throw conflict('Bu Idempotency-Key farklı bir istekle daha önce kullanıldı.', 'IDEMPOTENCY_KEY_REUSED');
  }
  const p = row.payment_transaction_id ? (await deps.db.query('SELECT checkout_url FROM payment_transactions WHERE id = $1', [row.payment_transaction_id])).rows[0] : null;
  return { transaction: await getTopup(deps, row.user_id, row.id), checkoutUrl: row.status === 'AWAITING_PAYMENT' ? p?.checkout_url ?? null : null, replayed: true };
}

export function presentTopup(r: any) {
  return {
    id: r.id,
    type: 'TOPUP' as const,
    ref: r.public_ref,
    status: r.status,
    statusText: USER_STATUS_TEXT[r.status] ?? r.status,
    environment: r.environment,
    isTest: r.environment === 'TEST',
    amountMinor: r.amount_minor,
    feeMinor: r.fee_minor,
    totalMinor: r.total_minor,
    currency: r.currency?.trim(),
    cardMasked: maskTail(r.card_serial),
    subscriberMasked: maskTail(r.subscriber_no),
    utilityName: r.utility_name,
    utilityRef: r.status === 'COMPLETED' ? r.utility_ref : null,
    errorMessage: r.error_message,
    receiptId: r.receipt_id ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const TOPUP_SELECT = `SELECT t.*, c.card_serial, s.subscriber_no, u.full_name AS utility_name, r.id AS receipt_id
  FROM topup_transactions t
  JOIN water_cards c ON c.id = t.water_card_id
  JOIN subscriptions s ON s.id = t.subscription_id
  JOIN water_utilities u ON u.id = t.utility_id
  LEFT JOIN receipts r ON r.source_type = 'TOPUP' AND r.source_id = t.id`;

export async function getTopup(deps: Deps, userId: string, id: string) {
  const { rows } = await deps.db.query(`${TOPUP_SELECT} WHERE t.id = $1 AND t.user_id = $2`, [id, userId]);
  if (!rows[0]) throw notFound('İşlem bulunamadı.');
  return presentTopup(rows[0]);
}

export async function listTopups(deps: Deps, userId: string) {
  const { rows } = await deps.db.query(`${TOPUP_SELECT} WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 100`, [userId]);
  return rows.map(presentTopup);
}

/** Kullanıcı ödeme sayfasından döndüğünde: istemcinin "ödendi" beyanına değil, sağlayıcı durum sorgusuna güvenilir. */
export async function refreshPaymentStatus(deps: Deps, type: 'TOPUP' | 'BILL_PAYMENT', userId: string, id: string) {
  const table = type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions';
  const row = (await deps.db.query(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
  if (!row) throw notFound('İşlem bulunamadı.');
  if (!['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(row.status) || !row.payment_transaction_id) return;
  const p = (await deps.db.query('SELECT * FROM payment_transactions WHERE id = $1', [row.payment_transaction_id])).rows[0];
  const runtime = await deps.integrations.paymentRuntimeForProvider(deps.db, p.provider_id, p.environment);
  if (!runtime?.adapter.supportsStatusQuery || !p.provider_payment_ref) return;
  const st = await runtime.adapter.getPaymentStatus(runtime.ctx, p.provider_payment_ref);
  await applyPaymentResult(deps, p.id, {
    status: st.status,
    amountMinor: st.amountMinor,
    currency: st.currency,
    source: 'STATUS_QUERY',
  });
}
