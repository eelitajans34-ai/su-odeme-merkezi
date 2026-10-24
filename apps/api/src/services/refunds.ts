import type { Actor, Deps } from '../context.js';
import { withTransaction, type DbClient } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { lockTxn, transition, type SourceType } from './state-machine.js';

/** Su idaresi işlemi reddettiğinde sistemin açtığı iade talebi (onay bekler; para otomatik iade edilmiş sayılmaz). */
export async function openSystemRefund(deps: Deps, c: DbClient, type: SourceType, t: any, reason: string) {
  await c.query(
    `INSERT INTO refunds (payment_transaction_id, source_type, source_id, amount_minor, reason, status, requested_via)
     VALUES ($1,$2,$3,$4,$5,'PENDING_APPROVAL','SYSTEM')
     ON CONFLICT DO NOTHING`,
    [t.payment_transaction_id, type, t.id, t.total_minor, reason],
  );
  await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'REFUND_REQUESTED', severity: 'WARNING', title: 'İade talebiniz alındı', body: `${t.public_ref} numaralı işleminiz su idaresi tarafından gerçekleştirilmedi. İade süreci başlatıldı.`, data: { ref: t.public_ref } }, c);
  await deps.notifications.alertAdmins({ eventType: 'REFUND_PENDING_APPROVAL', severity: 'WARNING', title: 'Onay bekleyen iade', body: `${t.public_ref}: ${reason}`, data: { ref: t.public_ref } }, c);
}

/** Yönetici tarafından incelemedeki işlem için iade talebi açılması. */
export async function requestRefund(deps: Deps, actor: Actor, type: SourceType, sourceId: string, reason: string) {
  return withTransaction(deps.db, async (c) => {
    const t = await lockTxn(c, type, sourceId);
    if (!t) throw notFound();
    if (t.status !== 'REQUIRES_REVIEW') throw conflict('Yalnızca incelemedeki (REQUIRES_REVIEW) işlemler için iade talebi açılabilir.');
    const p = (await c.query('SELECT status FROM payment_transactions WHERE id = $1', [t.payment_transaction_id])).rows[0];
    if (p?.status !== 'SUCCEEDED') throw conflict('Başarılı bir tahsilat olmadan iade yapılamaz.');
    await transition(c, type, sourceId, 'REQUIRES_REVIEW', 'REFUND_PENDING', { actor: `ADMIN:${actor.userId}`, reason });
    const r = await c.query(
      `INSERT INTO refunds (payment_transaction_id, source_type, source_id, amount_minor, reason, status, requested_by, requested_via)
       VALUES ($1,$2,$3,$4,$5,'PENDING_APPROVAL',$6,'ADMIN') RETURNING id`,
      [t.payment_transaction_id, type, sourceId, t.total_minor, reason, actor.userId],
    );
    await audit(c, { actorUserId: actor.userId, actorType: 'ADMIN', action: 'refund.request', targetType: 'refund', targetId: r.rows[0].id, ip: actor.ip, userAgent: actor.userAgent, details: { sourceType: type, sourceId, reason } });
    await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'REFUND_REQUESTED', title: 'İade talebiniz alındı', body: `${t.public_ref} numaralı işleminiz için iade süreci başlatıldı.`, data: { ref: t.public_ref } }, c);
    return r.rows[0].id as string;
  });
}

/**
 * İade onayı. Gerçek iade yalnızca sağlayıcı adaptörü ve sözleşme iadeyi destekliyorsa gönderilir.
 * Desteklenmiyorsa durum MANUAL_ACTION_REQUIRED olur — başarılı sonuç ÜRETİLMEZ.
 */
export async function approveRefund(deps: Deps, actor: Actor, refundId: string) {
  const claim = await withTransaction(deps.db, async (c) => {
    const r = (await c.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
    if (!r) throw notFound('İade bulunamadı.');
    if (r.status !== 'PENDING_APPROVAL') throw conflict('İade onay beklemiyor.');
    const p = (await c.query('SELECT * FROM payment_transactions WHERE id = $1', [r.payment_transaction_id])).rows[0];
    if (p.status !== 'SUCCEEDED') throw conflict('İade edilecek başarılı tahsilat yok.');
    await c.query(`UPDATE refunds SET status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [refundId, actor.userId]);
    await audit(c, { actorUserId: actor.userId, actorType: 'ADMIN', action: 'refund.approve', targetType: 'refund', targetId: refundId, ip: actor.ip, userAgent: actor.userAgent, details: { amountMinor: r.amount_minor } });
    return { r, p };
  });
  const runtime = await deps.integrations.paymentRuntimeForProvider(deps.db, claim.p.provider_id, claim.p.environment);
  if (!runtime || !runtime.adapter.supportsRefund || !runtime.config?.supports_refund) {
    await deps.db.query(
      `UPDATE refunds SET status = 'MANUAL_ACTION_REQUIRED', failure_message = $2, updated_at = now() WHERE id = $1`,
      [refundId, 'Ödeme sağlayıcısı iade API\'si yapılandırılmadı/desteklenmiyor. İade sağlayıcı panelinden yapılmalı ve kanıt referansıyla kapatılmalıdır.'],
    );
    return { status: 'MANUAL_ACTION_REQUIRED' as const };
  }
  try {
    const res = await runtime.adapter.refund(runtime.ctx, { providerPaymentRef: claim.p.provider_payment_ref, amountMinor: Number(claim.r.amount_minor), refundRef: refundId });
    if (res.status === 'FAILED') {
      await deps.db.query(`UPDATE refunds SET status = 'FAILED', failure_message = $2, updated_at = now() WHERE id = $1`, [refundId, res.message ?? 'Sağlayıcı iadeyi reddetti']);
      await deps.notifications.alertAdmins({ eventType: 'REFUND_FAILED', severity: 'CRITICAL', title: 'Başarısız iade', body: `İade ${refundId} sağlayıcı tarafından reddedildi.` });
      return { status: 'FAILED' as const };
    }
    await deps.db.query(`UPDATE refunds SET status = 'SUBMITTED', provider_refund_ref = $2, updated_at = now() WHERE id = $1`, [refundId, res.providerRefundRef]);
    if (res.status === 'COMPLETED') await applyRefundResult(deps, res.providerRefundRef, 'COMPLETED', 'PROVIDER_STATUS_QUERY');
    return { status: res.status };
  } catch (err) {
    await deps.db.query(`UPDATE refunds SET status = 'FAILED', failure_message = $2, updated_at = now() WHERE id = $1`, [refundId, 'İade isteği gönderilemedi']);
    await deps.notifications.alertAdmins({ eventType: 'REFUND_FAILED', severity: 'CRITICAL', title: 'Başarısız iade', body: `İade ${refundId} gönderilemedi.` });
    return { status: 'FAILED' as const };
  }
}

/** İade sonucu: yalnızca sağlayıcıdan doğrulanmış bilgiyle (webhook/durum sorgusu) veya kanıtlı manuel kapanışla tamamlanır. */
export async function applyRefundResult(deps: Deps, providerRefundRef: string, result: 'COMPLETED' | 'FAILED', method: 'PROVIDER_WEBHOOK' | 'PROVIDER_STATUS_QUERY') {
  await withTransaction(deps.db, async (c) => {
    const r = (await c.query('SELECT * FROM refunds WHERE provider_refund_ref = $1 FOR UPDATE', [providerRefundRef])).rows[0];
    if (!r || r.status === 'COMPLETED') return;
    if (result === 'FAILED') {
      await c.query(`UPDATE refunds SET status = 'FAILED', failure_message = 'Sağlayıcı iadenin başarısız olduğunu bildirdi', updated_at = now() WHERE id = $1`, [r.id]);
      const t = await lockTxn(c, r.source_type, r.source_id);
      if (t?.status === 'REFUND_PENDING') await transition(c, r.source_type, t.id, 'REFUND_PENDING', 'REQUIRES_REVIEW', { actor: 'WEBHOOK', reason: 'İade başarısız' });
      await deps.notifications.alertAdmins({ eventType: 'REFUND_FAILED', severity: 'CRITICAL', title: 'Başarısız iade', body: `İade ${r.id} başarısız oldu.` }, c);
      return;
    }
    await completeRefund(deps, c, r, method, null);
  });
}

async function completeRefund(deps: Deps, c: DbClient, r: any, method: string, evidenceRef: string | null) {
  await c.query(`UPDATE refunds SET status = 'COMPLETED', verified_at = now(), verification_method = $2, evidence_ref = $3, updated_at = now() WHERE id = $1`, [r.id, method, evidenceRef]);
  await c.query(`UPDATE payment_transactions SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [r.payment_transaction_id]);
  const t = await lockTxn(c, r.source_type, r.source_id);
  if (t?.status === 'REFUND_PENDING') {
    await transition(c, r.source_type, t.id, 'REFUND_PENDING', 'REFUNDED', { actor: method === 'MANUAL_EVIDENCE' ? 'ADMIN' : 'WEBHOOK', reason: 'İade doğrulandı' });
    await deps.notifications.notifyUser({ userId: t.user_id, eventType: 'REFUND_COMPLETED', title: 'İadeniz tamamlandı', body: `${t.public_ref} numaralı işleminizin iadesi tamamlandı.`, data: { ref: t.public_ref } }, c);
  }
}

/** Sağlayıcı panelinden manuel yapılan iadenin kanıt referansıyla kapatılması (yalnızca MANUAL_ACTION_REQUIRED). */
export async function completeManualRefund(deps: Deps, actor: Actor, refundId: string, evidenceRef: string) {
  if (!evidenceRef || evidenceRef.trim().length < 4) throw badRequest('Sağlayıcı iade referansı/kanıtı gerekli.');
  await withTransaction(deps.db, async (c) => {
    const r = (await c.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
    if (!r) throw notFound();
    if (r.status !== 'MANUAL_ACTION_REQUIRED') throw conflict('Yalnızca manuel işlem gerektiren iadeler bu yolla kapatılabilir.');
    await completeRefund(deps, c, r, 'MANUAL_EVIDENCE', evidenceRef.trim());
    await audit(c, { actorUserId: actor.userId, actorType: 'ADMIN', action: 'refund.manual_complete', targetType: 'refund', targetId: refundId, ip: actor.ip, userAgent: actor.userAgent, details: { evidenceRef } });
  });
}

export async function rejectRefund(deps: Deps, actor: Actor, refundId: string, note: string) {
  await withTransaction(deps.db, async (c) => {
    const r = (await c.query('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [refundId])).rows[0];
    if (!r) throw notFound();
    if (r.status !== 'PENDING_APPROVAL') throw conflict('İade onay beklemiyor.');
    await c.query(`UPDATE refunds SET status = 'REJECTED', failure_message = $2, approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1`, [refundId, note, actor.userId]);
    const t = await lockTxn(c, r.source_type, r.source_id);
    if (t?.status === 'REFUND_PENDING') await transition(c, r.source_type, t.id, 'REFUND_PENDING', 'REQUIRES_REVIEW', { actor: `ADMIN:${actor.userId}`, reason: 'İade talebi reddedildi' });
    await audit(c, { actorUserId: actor.userId, actorType: 'ADMIN', action: 'refund.reject', targetType: 'refund', targetId: refundId, ip: actor.ip, userAgent: actor.userAgent, details: { note } });
  });
}
