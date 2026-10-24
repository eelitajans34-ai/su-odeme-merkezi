import type { Deps } from '../context.js';
import { withTransaction } from '../db.js';
import type { StatusOutcome, SubmitOutcome } from '../integrations/utility/types.js';
import { issueReceipt } from './receipts.js';
import { lockTxn, transition, type SourceType } from './state-machine.js';
import { openSystemRefund } from './refunds.js';

const PENDING: Record<SourceType, 'TOPUP_PENDING' | 'COLLECTION_PENDING'> = { TOPUP: 'TOPUP_PENDING', BILL_PAYMENT: 'COLLECTION_PENDING' };
const MAX_SUBMITS = 3;
const CHECK_DELAY_MS = 60_000;

const text = {
  TOPUP: { done: 'Kart yüklemesi tamamlandı', doneBody: 'su idaresi tarafından teyit edildi. Makbuzunuz hazır.', doneEvent: 'TOPUP_COMPLETED' },
  BILL_PAYMENT: { done: 'Fatura ödemesi tamamlandı', doneBody: 'su idaresi tarafından tahsil edildi olarak teyit edildi. Makbuzunuz hazır.', doneEvent: 'BILL_PAYMENT_COMPLETED' },
};

/**
 * Ödemesi doğrulanmış işlemin su idaresine iletilmesi ve teyidi.
 * Kurallar:
 *  - Emir yalnızca PAYMENT_CONFIRMED → *_PENDING geçişini kazanan süreç tarafından gönderilir (çift gönderim yok).
 *  - Belirsiz sonuçta (zaman aşımı) yeniden gönderim yapılmaz; önce durum sorgulanır.
 *  - Durum sorgusu "kayıt yok" derse aynı tekil istek numarasıyla (utility_request_id) yeniden gönderilir.
 *  - Sonuç netleşmezse REQUIRES_REVIEW ve yönetici uyarısı.
 */
export async function processFulfillment(deps: Deps, type: SourceType, id: string): Promise<void> {
  const claim = await withTransaction(deps.db, async (c) => {
    const t = await lockTxn(c, type, id);
    if (!t) return null;
    if (t.status === 'PAYMENT_CONFIRMED') {
      const row = await transition(c, type, id, 'PAYMENT_CONFIRMED', PENDING[type], {
        actor: 'WORKER',
        reason: 'Su idaresine iletiliyor',
        set: { utility_submit_attempts: t.utility_submit_attempts + 1 },
      });
      return { action: 'SUBMIT' as const, txn: row };
    }
    if ((t.status === PENDING[type] || t.status === 'UNKNOWN') && (!t.next_check_at || new Date(t.next_check_at) <= deps.now())) {
      await c.query(`UPDATE ${type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions'} SET next_check_at = now() + interval '5 minutes' WHERE id = $1`, [id]); // kısa süreli talep kilidi
      return { action: 'CHECK' as const, txn: t };
    }
    return null;
  });
  if (!claim) return;
  if (claim.action === 'SUBMIT') await submit(deps, type, claim.txn);
  else await checkStatus(deps, type, claim.txn);
}

async function utilityFor(deps: Deps, type: SourceType, t: any) {
  const runtime = await deps.integrations.utilityRuntime(deps.db, t.utility_id, t.environment);
  const sub = (await deps.db.query('SELECT subscriber_no FROM subscriptions WHERE id = $1', [t.subscription_id])).rows[0];
  let cardSerial = '';
  let billIds: string[] = [];
  if (type === 'TOPUP') cardSerial = (await deps.db.query('SELECT card_serial FROM water_cards WHERE id = $1', [t.water_card_id])).rows[0]?.card_serial;
  else billIds = (await deps.db.query('SELECT selected_bill_ids FROM bill_inquiries WHERE bill_payment_transaction_id = $1', [t.id])).rows[0]?.selected_bill_ids ?? [];
  return { runtime, subscriberNo: sub.subscriber_no as string, cardSerial, billIds };
}

async function submit(deps: Deps, type: SourceType, t: any) {
  let outcome: SubmitOutcome;
  try {
    const u = await utilityFor(deps, type, t);
    outcome =
      type === 'TOPUP'
        ? await u.runtime.adapter.submitTopup(u.runtime.ctx, { utilityRequestId: t.utility_request_id, subscriberNo: u.subscriberNo, cardSerial: u.cardSerial, amountMinor: Number(t.amount_minor) })
        : await u.runtime.adapter.submitBillPayment(u.runtime.ctx, { utilityRequestId: t.utility_request_id, subscriberNo: u.subscriberNo, billIds: u.billIds, amountMinor: Number(t.amount_minor) });
  } catch (err) {
    // Gönderim sırasında hata: emir kuruma ulaşmış olabilir → sonuç BELİRSİZ
    outcome = { kind: 'AMBIGUOUS', message: (err as Error).message.slice(0, 200) };
  }
  await applyOutcome(deps, type, t.id, outcome);
}

async function applyOutcome(deps: Deps, type: SourceType, id: string, o: SubmitOutcome | StatusOutcome) {
  await withTransaction(deps.db, async (c) => {
    const t = await lockTxn(c, type, id);
    const table = type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions';
    const now = deps.now();
    if (o.kind === 'CONFIRMED') {
      if ('amountMinor' in o && o.amountMinor !== Number(t.amount_minor)) {
        await transition(c, type, id, t.status, 'REQUIRES_REVIEW', { actor: 'WORKER', reason: 'Su idaresi tutarı uyuşmuyor', set: { utility_ref: o.utilityRef } });
        await deps.notifications.alertAdmins({ eventType: 'UTILITY_AMOUNT_MISMATCH', severity: 'CRITICAL', title: 'Su idaresi tutar uyuşmazlığı', body: `İşlem ${t.public_ref} için teyit edilen tutar farklı.`, data: { ref: t.public_ref } }, c);
        return;
      }
      const row = await transition(c, type, id, t.status, 'COMPLETED', { actor: 'WORKER', reason: 'Su idaresi teyidi alındı', set: { utility_ref: o.utilityRef, next_check_at: null } });
      await issueReceipt(c, type, row);
      await deps.notifications.notifyUser({ userId: t.user_id, eventType: text[type].doneEvent, title: text[type].done, body: `${t.public_ref} numaralı işleminiz ${text[type].doneBody}`, data: { ref: t.public_ref } }, c);
      return;
    }
    if (o.kind === 'REJECTED') {
      await transition(c, type, id, t.status, 'REFUND_PENDING', { actor: 'WORKER', reason: `Su idaresi reddetti: ${o.code}`, set: { error_code: o.code, error_message: 'Su idaresi işlemi gerçekleştirmedi. İade süreci başlatıldı.', next_check_at: null } });
      await openSystemRefund(deps, c, type, t, `Su idaresi işlemi reddetti (${o.code})`);
      return;
    }
    if (o.kind === 'ACCEPTED_PENDING' || o.kind === 'PENDING') {
      const checks = t.status_check_count + (o.kind === 'PENDING' ? 1 : 0);
      if (await tooManyChecks(c, checks)) return escalate(deps, c, type, t, 'Su idaresi teyidi uzun süredir bekleniyor');
      const set: Record<string, unknown> = { next_check_at: new Date(now.getTime() + CHECK_DELAY_MS), status_check_count: checks, utility_last_checked_at: now };
      if (o.kind === 'ACCEPTED_PENDING' && o.utilityRef) set.utility_ref = o.utilityRef;
      if (t.status === 'UNKNOWN') {
        await transition(c, type, id, 'UNKNOWN', PENDING[type], { actor: 'WORKER', reason: 'Su idaresi işlemi kayıtlı, teyit bekleniyor', set });
      } else {
        await c.query(`UPDATE ${table} SET next_check_at = $2, status_check_count = $3, utility_last_checked_at = $4, utility_ref = COALESCE($5, utility_ref), updated_at = now() WHERE id = $1`,
          [id, set.next_check_at, checks, now, (set.utility_ref as string) ?? null]);
      }
      if (o.kind === 'ACCEPTED_PENDING') {
        await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'TRANSACTION_PENDING', title: 'İşleminiz beklemede', body: `${t.public_ref} numaralı işleminiz su idaresi teyidi bekliyor. Tekrar ödeme yapmayın.`, data: { ref: t.public_ref } }, c);
      }
      return;
    }
    if (o.kind === 'AMBIGUOUS' || o.kind === 'ERROR') {
      const checks = t.status_check_count + 1;
      if (await tooManyChecks(c, checks)) return escalate(deps, c, type, t, 'Su idaresi sonucu belirsiz');
      const set = { next_check_at: new Date(now.getTime() + CHECK_DELAY_MS), status_check_count: checks, utility_last_checked_at: now, error_message: 'Sonuç su idaresinden teyit bekleniyor.' };
      if (t.status !== 'UNKNOWN') {
        await transition(c, type, id, t.status, 'UNKNOWN', { actor: 'WORKER', reason: `Belirsiz sonuç: ${o.message}`, set });
        await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'TRANSACTION_PENDING', severity: 'WARNING', title: 'İşleminiz beklemeye alındı', body: `${t.public_ref} numaralı işleminizin sonucu henüz netleşmedi. Tekrar ödeme yapmayın; sonuç teyit edildiğinde bilgilendirileceksiniz.`, data: { ref: t.public_ref } }, c);
      } else {
        await c.query(`UPDATE ${table} SET next_check_at = $2, status_check_count = $3, utility_last_checked_at = $4, updated_at = now() WHERE id = $1`, [id, set.next_check_at, checks, now]);
      }
      return;
    }
    if (o.kind === 'NOT_FOUND') {
      // Kurum emri hiç almamış: aynı tekil istek numarasıyla güvenle yeniden gönderilebilir
      if (t.utility_submit_attempts >= MAX_SUBMITS) return escalate(deps, c, type, t, 'Su idaresi emri almadı ve yeniden deneme sınırı aşıldı');
      if (t.status === 'UNKNOWN') {
        await transition(c, type, id, 'UNKNOWN', PENDING[type], { actor: 'WORKER', reason: 'Kurumda kayıt yok; yeniden gönderilecek', set: { next_check_at: null } });
      }
      await c.query(`UPDATE ${table} SET utility_submit_attempts = utility_submit_attempts + 1, next_check_at = NULL WHERE id = $1`, [id]);
      return { resubmit: true };
    }
  }).then(async (res: any) => {
    if (res?.resubmit) {
      const t = (await deps.db.query(`SELECT * FROM ${type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions'} WHERE id = $1`, [id])).rows[0];
      await submit(deps, type, t);
    }
  });
}

async function checkStatus(deps: Deps, type: SourceType, t: any) {
  let o: StatusOutcome;
  try {
    const runtime = await deps.integrations.utilityRuntime(deps.db, t.utility_id, t.environment);
    if (!runtime.integration?.supports_status_query) {
      await withTransaction(deps.db, async (c) => escalate(deps, c, type, (await lockTxn(c, type, t.id)), 'Su idaresi durum sorgusu desteklenmiyor'));
      return;
    }
    o = type === 'TOPUP'
      ? await runtime.adapter.getTopupStatus(runtime.ctx, t.utility_request_id)
      : await runtime.adapter.getCollectionStatus(runtime.ctx, t.utility_request_id);
  } catch (err) {
    o = { kind: 'ERROR', message: (err as Error).message.slice(0, 200) };
  }
  await applyOutcome(deps, type, t.id, o);
}

async function tooManyChecks(c: any, checks: number) {
  const max = (await c.query(`SELECT value FROM system_settings WHERE key = 'utility_status_max_checks'`)).rows[0]?.value ?? 12;
  return checks >= Number(max);
}

async function escalate(deps: Deps, c: any, type: SourceType, t: any, reason: string) {
  if (t.status === 'REQUIRES_REVIEW') return;
  await transition(c, type, t.id, t.status, 'REQUIRES_REVIEW', { actor: 'WORKER', reason, set: { next_check_at: null } });
  await deps.notifications.alertAdmins({ eventType: 'TRANSACTION_REQUIRES_REVIEW', severity: 'WARNING', title: 'İşlem incelemesi gerekiyor', body: `${t.public_ref}: ${reason}`, data: { ref: t.public_ref, type } }, c);
  await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'TRANSACTION_PENDING', severity: 'WARNING', title: 'İşleminiz inceleniyor', body: `${t.public_ref} numaralı işleminiz destek ekibimiz tarafından inceleniyor. Tekrar ödeme yapmayın.`, data: { ref: t.public_ref } }, c);
}

/** Zamanlanmış görev: bekleyen işlemleri ilerletir ve uzun süredir bekleyenler için uyarı üretir. */
export async function runWorkerTick(deps: Deps): Promise<{ processed: number }> {
  let processed = 0;
  for (const type of ['TOPUP', 'BILL_PAYMENT'] as SourceType[]) {
    const table = type === 'TOPUP' ? 'topup_transactions' : 'bill_payment_transactions';
    const { rows } = await deps.db.query(
      `SELECT id FROM ${table} WHERE status = 'PAYMENT_CONFIRMED'
          OR (status IN ($1,'UNKNOWN') AND (next_check_at IS NULL OR next_check_at <= $2))
        ORDER BY updated_at LIMIT 50`,
      [PENDING[type], deps.now()],
    );
    for (const r of rows) {
      await processFulfillment(deps, type, r.id);
      processed++;
    }
  }
  return { processed };
}
