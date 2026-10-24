import type { Deps } from '../context.js';
import { withTransaction } from '../db.js';
import type { ProviderPaymentStatus } from '../integrations/payment/types.js';
import { lockTxn, transition, type SourceType } from './state-machine.js';
import { processFulfillment } from './fulfillment.js';
import { applyRefundResult } from './refunds.js';

interface PaymentResult {
  status: ProviderPaymentStatus;
  amountMinor: number | null;
  currency: string | null;
  source: 'WEBHOOK' | 'STATUS_QUERY';
  failureCode?: string | null;
}

/**
 * Ödeme sonucunu işler. Hem imzalı webhook hem de sunucu tarafı durum sorgusu buraya gelir.
 * - Tutar/para birimi uyuşmazlığı → REQUIRES_REVIEW + kritik uyarı.
 * - Başarısız ödeme hiçbir zaman başarılı gösterilmez.
 * - Ödeme onayı yalnızca PAYMENT_CONFIRMED'e taşır; yükleme/tahsilat ayrı adımdır.
 */
export async function applyPaymentResult(deps: Deps, paymentId: string, r: PaymentResult): Promise<void> {
  const confirmed = await withTransaction(deps.db, async (c) => {
    const p = (await c.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
    if (!p) return null;
    const type = p.purpose as SourceType;
    const src = (await c.query(`SELECT id FROM ${type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions'} WHERE payment_transaction_id = $1`, [p.id])).rows[0];
    if (!src) return null;
    const txn = await lockTxn(c, type, src.id);
    const actor = r.source === 'WEBHOOK' ? 'WEBHOOK' : 'SYSTEM';

    if (r.status === 'SUCCEEDED') {
      const mismatch =
        (r.amountMinor != null && r.amountMinor !== Number(p.amount_minor)) ||
        (r.currency != null && r.currency.trim() !== p.currency.trim());
      if (p.status !== 'SUCCEEDED') {
        await c.query(`UPDATE payment_transactions SET status = 'SUCCEEDED', confirmed_at = now(), updated_at = now() WHERE id = $1`, [p.id]);
      }
      if (mismatch) {
        if (['AWAITING_PAYMENT', 'PAYMENT_PENDING', 'FAILED'].includes(txn.status)) {
          await transition(c, type, txn.id, txn.status, 'REQUIRES_REVIEW', { actor, reason: 'Ödeme tutarı/para birimi uyuşmuyor' });
        }
        await deps.notifications.alertAdmins({ eventType: 'PAYMENT_AMOUNT_MISMATCH', severity: 'CRITICAL', title: 'Ödeme tutarı uyuşmazlığı', body: `İşlem ${txn.public_ref}: sağlayıcı tutarı beklenenle eşleşmiyor.`, data: { ref: txn.public_ref } }, c);
        return null;
      }
      if (txn.status === 'AWAITING_PAYMENT' || txn.status === 'PAYMENT_PENDING') {
        await transition(c, type, txn.id, txn.status, 'PAYMENT_CONFIRMED', { actor, reason: `Ödeme doğrulandı (${r.source})` });
        await deps.notifications.notifyUser({ userId: txn.user_id, eventType: 'PAYMENT_RECEIVED', title: 'Ödemeniz alındı', body: `${txn.public_ref} numaralı işleminizin ödemesi alındı. Su idaresi teyidi bekleniyor; işlem henüz tamamlanmadı.`, data: { ref: txn.public_ref } }, c);
        return { type, id: txn.id };
      }
      if (txn.status === 'FAILED') {
        // Başarısız sayılan işlem için geç gelen başarılı ödeme: para alınmış olabilir → inceleme
        await transition(c, type, txn.id, 'FAILED', 'REQUIRES_REVIEW', { actor, reason: 'Başarısız işlem için geç ödeme onayı' });
        await deps.notifications.alertAdmins({ eventType: 'LATE_PAYMENT', severity: 'WARNING', title: 'Geç ödeme onayı', body: `İşlem ${txn.public_ref} başarısız sayılmıştı ancak ödeme başarılı bildirildi.`, data: { ref: txn.public_ref } }, c);
      }
      return null; // zaten işlenmiş — idempotent
    }

    if (r.status === 'FAILED' || r.status === 'CANCELLED') {
      if (p.status === 'SUCCEEDED') {
        await deps.notifications.alertAdmins({ eventType: 'PAYMENT_STATUS_CONFLICT', severity: 'CRITICAL', title: 'Çelişkili ödeme durumu', body: `Ödeme ${p.public_ref} başarılı iken başarısız bildirimi alındı.`, data: { ref: p.public_ref } }, c);
        return null;
      }
      await c.query(`UPDATE payment_transactions SET status = $2, failure_code = $3, updated_at = now() WHERE id = $1`, [p.id, r.status, r.failureCode ?? null]);
      if (txn.status === 'AWAITING_PAYMENT' || txn.status === 'PAYMENT_PENDING') {
        await transition(c, type, txn.id, txn.status, 'FAILED', { actor, reason: 'Ödeme başarısız', set: { error_code: 'PAYMENT_FAILED', error_message: 'Ödeme başarısız oldu; hesabınızdan tahsilat yapılmadı.' } });
        await deps.notifications.notifyUser({ userId: txn.user_id, eventType: 'TRANSACTION_FAILED', severity: 'WARNING', title: 'İşlem başarısız', body: `${txn.public_ref} numaralı işleminizin ödemesi başarısız oldu. Tahsilat yapılmadı.`, data: { ref: txn.public_ref } }, c);
      }
      return null;
    }

    if (r.status === 'PENDING' && txn.status === 'AWAITING_PAYMENT') {
      await c.query(`UPDATE payment_transactions SET status = 'PENDING', updated_at = now() WHERE id = $1`, [p.id]);
      await transition(c, type, txn.id, 'AWAITING_PAYMENT', 'PAYMENT_PENDING', { actor, reason: 'Ödeme sağlayıcısı beklemede' });
    }
    return null;
  });
  if (confirmed) await processFulfillment(deps, confirmed.type, confirmed.id);
}

/**
 * Ödeme sağlayıcısı webhook'u. İmza doğrulanmadan hiçbir işlem yapılmaz; olay kimliğiyle tekrar saldırısı engellenir.
 */
export async function handlePaymentWebhook(
  deps: Deps,
  providerCode: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = deps.db;
  const provider = (await db.query('SELECT id FROM payment_providers WHERE code = $1', [providerCode])).rows[0];
  if (!provider) return { status: 404, body: { error: 'unknown_provider' } };
  const state = await deps.integrations.mode(db);
  const runtime = await deps.integrations.paymentRuntimeForProvider(db, provider.id, state.mode);
  if (!runtime) return { status: 404, body: { error: 'unknown_provider' } };

  const v = runtime.adapter.verifyWebhook(runtime.ctx, rawBody, headers, deps.now());
  if (!v.ok) {
    await db.query(
      `INSERT INTO webhook_events (source, provider_id, signature_valid, rejection_reason) VALUES ('PAYMENT_PROVIDER',$1,false,$2)`,
      [provider.id, v.reason],
    );
    return { status: v.reason === 'NOT_CONFIGURED' ? 503 : 401, body: { error: 'webhook_rejected', reason: v.reason } };
  }
  const e = v.event;
  const ins = await db.query(
    `INSERT INTO webhook_events (source, provider_id, event_id, event_type, signature_valid, event_timestamp, payload)
     VALUES ('PAYMENT_PROVIDER',$1,$2,$3,true,$4,$5)
     ON CONFLICT (source, provider_id, event_id) WHERE event_id IS NOT NULL AND signature_valid DO NOTHING RETURNING id`,
    [provider.id, e.eventId, e.type, e.occurredAt, JSON.stringify(e.sanitizedPayload)],
  );
  if (!ins.rows[0]) return { status: 200, body: { received: true, duplicate: true } };
  const webhookId = ins.rows[0].id;

  try {
    if (e.type === 'payment.succeeded' || e.type === 'payment.failed') {
      const p = (await db.query('SELECT * FROM payment_transactions WHERE provider_id = $1 AND provider_payment_ref = $2', [provider.id, e.providerPaymentRef])).rows[0];
      if (!p || (e.orderRef && e.orderRef !== p.public_ref)) throw new Error('Eşleşen ödeme kaydı bulunamadı');
      let status: ProviderPaymentStatus = e.type === 'payment.succeeded' ? 'SUCCEEDED' : 'FAILED';
      let amountMinor = e.amountMinor;
      let currency = e.currency;
      if (status === 'SUCCEEDED' && runtime.adapter.supportsStatusQuery) {
        // Derinlemesine savunma: imzalı bildirime ek olarak sağlayıcıdan durum sorgulanır
        const q = await runtime.adapter.getPaymentStatus(runtime.ctx, p.provider_payment_ref);
        status = q.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING';
        amountMinor = q.amountMinor ?? amountMinor;
        currency = q.currency ?? currency;
      }
      await applyPaymentResult(deps, p.id, { status, amountMinor, currency, source: 'WEBHOOK', failureCode: e.failureCode });
    } else if (e.type === 'refund.succeeded' || e.type === 'refund.failed') {
      await applyRefundResult(deps, e.providerRefundRef ?? '', e.type === 'refund.succeeded' ? 'COMPLETED' : 'FAILED', 'PROVIDER_WEBHOOK');
    }
    await db.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [webhookId]);
    return { status: 200, body: { received: true } };
  } catch (err) {
    // Olay işlenemedi: tekil kimlik serbest bırakılır, sağlayıcının yeniden göndermesi için 500 döndürülür.
    await db.query(
      `UPDATE webhook_events SET processing_error = $2, event_id = NULL, rejection_reason = 'PROCESSING_FAILED_WILL_RETRY' WHERE id = $1`,
      [webhookId, (err as Error).message.slice(0, 300)],
    );
    return { status: 500, body: { received: false } };
  }
}
