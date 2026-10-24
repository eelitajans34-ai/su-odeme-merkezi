import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.js';
import { actorOf, type makeGuards } from '../auth/guards.js';
import { publicRef } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse, z } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getBillPayment, inquireBills, listBillPayments, payBills } from '../services/bills.js';
import { addCard, addSubscription, addSubscriptionFromQr, getOwnedSubscription, listCards, listSubscriptions, presentSubscription, removeSubscription } from '../services/subscriptions.js';
import { createTopup, getTopup, listTopups, refreshPaymentStatus, topupQuote } from '../services/topups.js';
import { quote } from '../services/payments.js';

type Guards = ReturnType<typeof makeGuards>;

const idem = (req: any) => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string') throw badRequest('Idempotency-Key başlığı gerekli.', 'IDEMPOTENCY_KEY_REQUIRED');
  return k;
};

export async function userRoutes(app: FastifyInstance, { deps, guards }: { deps: Deps; guards: Guards }) {
  const authed = { preHandler: guards.requireAuth() };
  const db = deps.db;

  // Su idareleri ve entegrasyon durumu (gerçeğe uygun etiketlerle)
  app.get('/api/utilities', authed, async () => {
    const { mode } = await deps.integrations.mode(db);
    const { rows } = await db.query('SELECT id, code, full_name, city FROM water_utilities WHERE is_active ORDER BY full_name');
    const out = [];
    for (const u of rows) {
      const topup = await deps.integrations.readiness(db, 'TOPUP', u.id);
      const bill = await deps.integrations.readiness(db, 'BILL_PAYMENT', u.id);
      out.push({ id: u.id, code: u.code, name: u.full_name, city: u.city, mode, topupAvailable: topup.ok, billPaymentAvailable: bill.ok, isSimulator: topup.isSimulator || bill.isSimulator, statusLabel: label(topup.ok || bill.ok, mode, topup.isSimulator) });
    }
    return out;
  });

  app.get('/api/platform/status', async () => {
    const { mode } = await deps.integrations.mode(db);
    const p = await deps.integrations.paymentRuntime(db);
    return {
      mode,
      paymentProvider: p.provider ? (p.adapter.code === 'NONE' ? 'Kurulum bekleniyor' : p.adapter.isSimulator ? 'Test modu (simülatör)' : mode === 'LIVE' ? 'Canlı' : 'Test modu') : 'Kurulum bekleniyor',
      environmentNotice: mode === 'TEST' ? 'TEST MODU — Gerçek ödeme alınmaz, gerçek kart yüklemesi veya fatura tahsilatı yapılmaz.' : null,
    };
  });

  // Abonelikler
  app.get('/api/subscriptions', authed, async (req) => listSubscriptions(deps, req.auth!.userId));
  app.get('/api/subscriptions/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return presentSubscription(await getOwnedSubscription(deps, req.auth!.userId, id));
  });
  app.post('/api/subscriptions', authed, async (req) => {
    const body = parse(z.object({ utilityId: z.uuid(), subscriberNo: z.string().max(24), nickname: z.string().max(60).optional() }).strict(), req.body);
    return addSubscription(deps, actorOf(req), { ...body, source: 'MANUAL' });
  });
  app.post('/api/subscriptions/qr', authed, async (req) => {
    const { payload } = parse(z.object({ payload: z.string().min(4).max(500) }).strict(), req.body);
    return addSubscriptionFromQr(deps, actorOf(req), payload);
  });
  app.delete('/api/subscriptions/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await removeSubscription(deps, actorOf(req), id);
    return { ok: true };
  });

  // Su kartları
  app.get('/api/cards', authed, async (req) => listCards(deps, req.auth!.userId));
  app.post('/api/subscriptions/:id/cards', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ cardSerial: z.string().max(32), nickname: z.string().max(60).optional() }).strict(), req.body);
    return addCard(deps, actorOf(req), id, body);
  });

  // Kart yükleme
  app.post('/api/topups/quote', authed, async (req) => {
    const body = parse(z.object({ waterCardId: z.uuid(), amountMinor: z.number().int().positive() }).strict(), req.body);
    return topupQuote(deps, actorOf(req), body.waterCardId, body.amountMinor);
  });
  app.post('/api/topups', authed, async (req) => {
    // Tutar ve kart dışındaki hiçbir alan (durum, ücret, "ödendi" vb.) istemciden kabul edilmez
    const body = parse(z.object({ waterCardId: z.uuid(), amountMinor: z.number().int().positive() }).strict(), req.body);
    return createTopup(deps, actorOf(req), { ...body, idempotencyKey: idem(req) });
  });
  app.get('/api/topups', authed, async (req) => listTopups(deps, req.auth!.userId));
  app.get('/api/topups/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return getTopup(deps, req.auth!.userId, id);
  });
  app.post('/api/topups/:id/refresh', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await refreshPaymentStatus(deps, 'TOPUP', req.auth!.userId, id);
    return getTopup(deps, req.auth!.userId, id);
  });

  // Fatura sorgulama ve ödeme
  app.post('/api/bill-payments/inquiries', authed, async (req) => {
    const body = parse(z.object({ subscriptionId: z.uuid() }).strict(), req.body);
    return inquireBills(deps, actorOf(req), { subscriptionId: body.subscriptionId, idempotencyKey: idem(req) });
  });
  app.post('/api/bill-payments/:id/quote', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { billIds } = parse(z.object({ billIds: z.array(z.string().max(64)).min(1).max(24) }).strict(), req.body);
    const t = await getBillPayment(deps, req.auth!.userId, id);
    const amount = (t.bills as any[]).filter((b) => billIds.includes(b.billId)).reduce((a, b) => a + b.amountMinor, 0);
    if (!amount) throw badRequest('Seçilen fatura bulunamadı.');
    return quote(deps, 'BILL_PAYMENT', amount, req.auth!.userId);
  });
  app.post('/api/bill-payments/:id/pay', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { billIds } = parse(z.object({ billIds: z.array(z.string().max(64)).min(1).max(24) }).strict(), req.body);
    return payBills(deps, actorOf(req), id, billIds);
  });
  app.get('/api/bill-payments', authed, async (req) => listBillPayments(deps, req.auth!.userId));
  app.get('/api/bill-payments/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    return getBillPayment(deps, req.auth!.userId, id);
  });
  app.post('/api/bill-payments/:id/refresh', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await refreshPaymentStatus(deps, 'BILL_PAYMENT', req.auth!.userId, id);
    return getBillPayment(deps, req.auth!.userId, id);
  });

  // Birleşik işlem geçmişi
  app.get('/api/transactions', authed, async (req) => {
    const [t, b] = await Promise.all([listTopups(deps, req.auth!.userId), listBillPayments(deps, req.auth!.userId)]);
    return [...t, ...b].sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime());
  });

  // Makbuzlar
  app.get('/api/receipts', authed, async (req) => {
    const { rows } = await db.query('SELECT id, receipt_no, source_type, environment, content, issued_at FROM receipts WHERE user_id = $1 ORDER BY issued_at DESC', [req.auth!.userId]);
    return rows;
  });
  app.get('/api/receipts/:id', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { rows } = await db.query('SELECT id, receipt_no, source_type, environment, content, issued_at FROM receipts WHERE id = $1 AND user_id = $2', [id, req.auth!.userId]);
    if (!rows[0]) throw notFound('Makbuz bulunamadı.');
    return rows[0];
  });

  // Bildirimler
  app.get('/api/notifications', authed, async (req) => {
    const { rows } = await db.query(`SELECT id, event_type, severity, title, body, read_at, created_at FROM notifications WHERE user_id = $1 AND audience = 'USER' ORDER BY created_at DESC LIMIT 100`, [req.auth!.userId]);
    return rows;
  });
  app.post('/api/notifications/:id/read', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2', [id, req.auth!.userId]);
    return { ok: true };
  });
  app.post('/api/push-devices', authed, async (req) => {
    const body = parse(z.object({ platform: z.enum(['ANDROID', 'IOS']), pushToken: z.string().min(10).max(400) }).strict(), req.body);
    await db.query(`INSERT INTO push_devices (user_id, platform, push_token) VALUES ($1,$2,$3) ON CONFLICT (push_token) DO UPDATE SET user_id = EXCLUDED.user_id, revoked_at = NULL`, [req.auth!.userId, body.platform, body.pushToken]);
    return { ok: true };
  });

  // Destek ve iade talepleri
  app.get('/api/support-tickets', authed, async (req) => {
    const { rows } = await db.query('SELECT id, ticket_no, category, subject, status, related_type, related_id, created_at, updated_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [req.auth!.userId]);
    return rows;
  });
  app.post('/api/support-tickets', authed, async (req) => {
    const body = parse(
      z.object({
        category: z.enum(['REFUND', 'TRANSACTION', 'ACCOUNT', 'KVKK_REQUEST', 'OTHER']),
        subject: z.string().trim().min(3).max(150),
        message: z.string().trim().min(5).max(4000),
        relatedType: z.enum(['TOPUP', 'BILL_PAYMENT']).optional(),
        relatedId: z.uuid().optional(),
      }).strict(),
      req.body,
    );
    if (body.relatedId) {
      const table = body.relatedType === 'BILL_PAYMENT' ? 'bill_payment_transactions' : 'topup_transactions';
      const own = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [body.relatedId, req.auth!.userId]);
      if (!own.rows[0]) throw notFound('İlgili işlem bulunamadı.');
    }
    const { rows } = await db.query(
      `INSERT INTO support_tickets (ticket_no, user_id, category, subject, related_type, related_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ticket_no`,
      [publicRef('DST'), req.auth!.userId, body.category, body.subject, body.relatedType ?? null, body.relatedId ?? null],
    );
    await db.query(`INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body) VALUES ($1,$2,'USER',$3)`, [rows[0].id, req.auth!.userId, body.message]);
    if (body.category === 'REFUND') {
      await deps.notifications.notifyUser({ userId: req.auth!.userId, eventType: 'REFUND_REQUESTED', title: 'İade talebiniz alındı', body: `${rows[0].ticket_no} numaralı talebiniz incelenecek.`, channels: ['EMAIL'] });
    }
    return rows[0];
  });
  app.get('/api/support-tickets/:id/messages', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const own = await db.query('SELECT 1 FROM support_tickets WHERE id = $1 AND user_id = $2', [id, req.auth!.userId]);
    if (!own.rows[0]) throw notFound();
    return (await db.query('SELECT author_role, body, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [id])).rows;
  });
  app.post('/api/support-tickets/:id/messages', authed, async (req) => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { message } = parse(z.object({ message: z.string().trim().min(1).max(4000) }).strict(), req.body);
    const own = await db.query('SELECT 1 FROM support_tickets WHERE id = $1 AND user_id = $2', [id, req.auth!.userId]);
    if (!own.rows[0]) throw notFound();
    await db.query(`INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body) VALUES ($1,$2,'USER',$3)`, [id, req.auth!.userId, message]);
    await db.query(`UPDATE support_tickets SET status = 'OPEN', updated_at = now() WHERE id = $1 AND status = 'WAITING_USER'`, [id]);
    return { ok: true };
  });

  // Profil
  app.patch('/api/profile', authed, async (req) => {
    const body = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().regex(/^\+?[0-9 ]{10,16}$/).nullable().optional() }).strict(), req.body);
    await db.query(
      `UPDATE users SET full_name = COALESCE($2, full_name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         phone_verified_at = CASE WHEN $3::boolean THEN NULL ELSE phone_verified_at END, updated_at = now() WHERE id = $1`,
      [req.auth!.userId, body.fullName ?? null, body.phone !== undefined, body.phone ?? null],
    );
    await audit(db, { actorUserId: req.auth!.userId, actorType: 'USER', action: 'profile.update', targetType: 'user', targetId: req.auth!.userId });
    return { ok: true };
  });

  // Hukuki metinler (taslaklar açıkça işaretlenir)
  app.get('/api/legal/:docType', async (req) => {
    const { docType } = parse(z.object({ docType: z.enum(['KVKK_NOTICE', 'PRIVACY_POLICY', 'TERMS_OF_USE', 'COOKIE_POLICY', 'RETENTION_POLICY', 'EXPLICIT_CONSENT']) }), req.params);
    const { rows } = await db.query(
      `SELECT id, doc_type, version, title, body_markdown, is_draft, published_at FROM legal_documents WHERE doc_type = $1
        ORDER BY (published_at IS NOT NULL) DESC, created_at DESC LIMIT 1`,
      [docType],
    );
    if (!rows[0]) return { docType, missing: true, notice: 'Bu metin henüz hukuk danışmanı tarafından hazırlanmadı.' };
    return { ...rows[0], notice: rows[0].is_draft ? 'TASLAK — hukuki inceleme tamamlanmadı.' : null };
  });
  app.post('/api/consents', authed, async (req) => {
    const body = parse(z.object({ documentId: z.uuid(), action: z.enum(['ACKNOWLEDGED', 'GRANTED', 'WITHDRAWN']) }).strict(), req.body);
    await db.query('INSERT INTO consent_records (user_id, document_id, action, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5)', [req.auth!.userId, body.documentId, body.action, req.ip, req.headers['user-agent'] ?? null]);
    return { ok: true };
  });
}

function label(available: boolean, mode: string, sim: boolean) {
  if (!available) return 'Kurulum bekleniyor';
  if (sim) return 'Test modu (simülatör)';
  return mode === 'LIVE' ? 'Canlı' : 'Test modu';
}
