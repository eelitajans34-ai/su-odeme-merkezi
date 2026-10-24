import type { DbClient } from '../db.js';
import { publicRef } from '../lib/crypto.js';
import { maskTail } from '../lib/mask.js';

export async function issueReceipt(db: DbClient, type: 'TOPUP' | 'BILL_PAYMENT', txn: any): Promise<string> {
  const existing = await db.query('SELECT id FROM receipts WHERE source_type = $1 AND source_id = $2', [type, txn.id]);
  if (existing.rows[0]) return existing.rows[0].id;
  const info = (
    await db.query(
      `SELECT s.subscriber_no, u.full_name AS utility_name, p.provider_payment_ref, p.public_ref AS payment_ref
         FROM subscriptions s JOIN water_utilities u ON u.id = s.utility_id
         LEFT JOIN payment_transactions p ON p.id = $2
        WHERE s.id = $1`,
      [txn.subscription_id, txn.payment_transaction_id],
    )
  ).rows[0];
  let cardMasked: string | null = null;
  if (type === 'TOPUP') {
    const c = await db.query('SELECT card_serial FROM water_cards WHERE id = $1', [txn.water_card_id]);
    cardMasked = maskTail(c.rows[0]?.card_serial);
  }
  const content = {
    baslik: type === 'TOPUP' ? 'Su Kartı Yükleme Makbuzu' : 'Su Faturası Ödeme Makbuzu',
    ortamUyarisi: txn.environment === 'TEST' ? 'TEST İŞLEMİDİR — GERÇEK ÖDEME VEYA YÜKLEME DEĞİLDİR' : null,
    islemNo: txn.public_ref,
    suIdaresi: info?.utility_name ?? null,
    aboneNo: maskTail(info?.subscriber_no),
    kartNo: cardMasked,
    tutarKurus: txn.amount_minor,
    hizmetBedeliKurus: txn.fee_minor,
    toplamKurus: txn.total_minor,
    paraBirimi: txn.currency,
    odemeReferansi: info?.payment_ref ?? null,
    suIdaresiReferansi: txn.utility_ref,
    tamamlanmaZamani: (txn.completed_at ?? new Date()).toISOString?.() ?? String(txn.completed_at),
    teyit: 'Bu makbuz, işlemin su idaresi tarafından teyit edilmesinin ardından düzenlenmiştir.',
  };
  const { rows } = await db.query(
    `INSERT INTO receipts (receipt_no, user_id, source_type, source_id, environment, content) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [publicRef('MKB'), txn.user_id, type, txn.id, txn.environment, JSON.stringify(content)],
  );
  return rows[0].id;
}
