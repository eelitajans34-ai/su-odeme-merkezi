import type { Deps } from '../context.js';
import { withTransaction } from '../db.js';
import { publicRef } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { transition, type SourceType, TABLE } from './state-machine.js';
import { activeFeeSchedule, computeFee, type FeeQuote } from './fees.js';

/** Sunucu tarafı ücret teklifi ve limit kontrolü. Tutarlar istemciden yalnızca "istenen yükleme tutarı" olarak alınır. */
export async function quote(deps: Deps, type: 'TOPUP' | 'BILL_PAYMENT', amountMinor: number, userId: string): Promise<FeeQuote> {
  const db = deps.db;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw badRequest('Tutar geçersiz.');
  const runtime = await deps.integrations.paymentRuntime(db);
  const schedule = await activeFeeSchedule(db, type, deps.now());
  const currency = runtime.config?.currency?.trim() ?? 'TRY';
  const minAmount = Math.max(runtime.config?.min_amount_minor ?? 100, schedule?.min_amount_minor ?? 100);
  const maxAmount = Math.min(runtime.config?.max_amount_minor ?? 500_000, schedule?.max_amount_minor ?? 500_000);
  if (amountMinor < minAmount || amountMinor > maxAmount) {
    throw badRequest(`Tutar ${fmt(minAmount)} ile ${fmt(maxAmount)} arasında olmalıdır.`, 'AMOUNT_OUT_OF_RANGE', { minAmountMinor: minAmount, maxAmountMinor: maxAmount });
  }
  const feeMinor = computeFee(amountMinor, schedule);
  const totalMinor = amountMinor + feeMinor;
  const dailyLimit = runtime.config?.daily_user_limit_minor ?? 1_000_000;
  const used = await db.query(
    `SELECT COALESCE(SUM(total_minor),0)::bigint AS s FROM (
       SELECT total_minor FROM topup_transactions WHERE user_id = $1 AND created_at > now() - interval '1 day' AND status NOT IN ('FAILED','CREATED','REFUNDED')
       UNION ALL
       SELECT total_minor FROM bill_payment_transactions WHERE user_id = $1 AND created_at > now() - interval '1 day' AND status NOT IN ('FAILED','CREATED','BILL_QUERY_PENDING','BILL_FOUND','REFUNDED') AND total_minor IS NOT NULL
     ) t`,
    [userId],
  );
  if (Number(used.rows[0].s) + totalMinor > dailyLimit) throw badRequest('Günlük işlem limitiniz aşılıyor.', 'DAILY_LIMIT');
  return {
    amountMinor,
    feeMinor,
    totalMinor,
    currency,
    feeScheduleId: schedule?.id ?? null,
    feeDescription: schedule
      ? schedule.user_facing_description + (schedule.is_sample ? ' (ÖRNEK/TEST TARİFE — sözleşmeye dayalı değildir)' : '')
      : 'Hizmet bedeli tanımlanmadı (TEST). Canlı kullanımda sözleşmeye dayalı tarife zorunludur.',
    isSampleTariff: !schedule || schedule.is_sample,
    minAmountMinor: minAmount,
    maxAmountMinor: maxAmount,
  };
}

const fmt = (m: number) => `${(m / 100).toFixed(2)} TL`;

/**
 * Ödeme sağlayıcısında ödeme oturumu başlatır. Kaynak işlem CREATED (yükleme) veya BILL_FOUND (fatura) durumunda olmalıdır.
 * Sağlayıcıya yapılan dış çağrı, veritabanı transaction'ı dışında yapılır.
 */
export async function startPayment(deps: Deps, type: SourceType, sourceId: string, fromStatus: 'CREATED' | 'BILL_FOUND') {
  const db = deps.db;
  const runtime = await deps.integrations.paymentRuntime(db);
  if (!runtime.provider) throw badRequest('Ödeme sağlayıcısı yok.');
  const src = (await db.query(`SELECT * FROM ${TABLE[type]} WHERE id = $1`, [sourceId])).rows[0];
  const payment = (
    await db.query(
      `INSERT INTO payment_transactions (public_ref, user_id, provider_id, environment, purpose, amount_minor, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'INITIATED') RETURNING *`,
      [publicRef('ODM'), src.user_id, runtime.provider.id, src.environment, type, src.total_minor, src.currency],
    )
  ).rows[0];
  await db.query(`UPDATE ${TABLE[type]} SET payment_transaction_id = $2 WHERE id = $1`, [sourceId, payment.id]);
  try {
    const result = await runtime.adapter.createPayment(runtime.ctx, {
      orderRef: payment.public_ref,
      amountMinor: payment.amount_minor,
      currency: payment.currency,
      description: type === 'TOPUP' ? 'Su kartı yükleme' : 'Su faturası ödeme',
      returnUrl: `${deps.config.APP_BASE_URL}/islemler/${type === 'TOPUP' ? 'yukleme' : 'fatura'}/${sourceId}`,
    });
    return await withTransaction(db, async (c) => {
      await c.query(
        `UPDATE payment_transactions SET status = 'PENDING', provider_payment_ref = $2, checkout_url = $3, updated_at = now() WHERE id = $1`,
        [payment.id, result.providerPaymentRef, result.checkoutUrl],
      );
      await transition(c, type, sourceId, fromStatus, 'AWAITING_PAYMENT', { actor: 'SYSTEM', reason: 'Ödeme oturumu oluşturuldu' });
      return { checkoutUrl: result.checkoutUrl, paymentRef: payment.public_ref };
    });
  } catch (err) {
    await withTransaction(db, async (c) => {
      await c.query(`UPDATE payment_transactions SET status = 'FAILED', failure_message = $2, updated_at = now() WHERE id = $1`, [payment.id, 'Ödeme oturumu oluşturulamadı']);
      await transition(c, type, sourceId, fromStatus, 'FAILED', {
        actor: 'SYSTEM',
        reason: 'Ödeme oturumu oluşturulamadı',
        set: { error_code: 'PAYMENT_INIT_FAILED', error_message: 'Ödeme başlatılamadı; hesabınızdan tahsilat yapılmadı.' },
      });
    });
    throw badRequest('Ödeme başlatılamadı; hesabınızdan tahsilat yapılmadı. Lütfen daha sonra tekrar deneyin.', 'PAYMENT_INIT_FAILED');
  }
}
