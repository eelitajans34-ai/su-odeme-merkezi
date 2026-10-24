import type { DbClient } from '../db.js';
import { conflict } from '../lib/errors.js';

export type TopupStatus =
  | 'CREATED' | 'AWAITING_PAYMENT' | 'PAYMENT_PENDING' | 'PAYMENT_CONFIRMED' | 'TOPUP_PENDING'
  | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'REFUND_PENDING' | 'REFUNDED' | 'REQUIRES_REVIEW';

export type BillStatus =
  | 'CREATED' | 'BILL_QUERY_PENDING' | 'BILL_FOUND' | 'AWAITING_PAYMENT' | 'PAYMENT_PENDING' | 'PAYMENT_CONFIRMED'
  | 'COLLECTION_PENDING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'REFUND_PENDING' | 'REFUNDED' | 'REQUIRES_REVIEW';

export type SourceType = 'TOPUP' | 'BILL_PAYMENT';

/**
 * İzin verilen durum geçişleri.
 * Temel kurallar:
 *  - FAILED yalnızca kullanıcıdan para ALINMADIYSA kullanılır. Para alındıktan sonraki başarısızlık REFUND_PENDING'e gider.
 *  - Ödeme onayı, yükleme/tahsilatın başarılı olduğu anlamına gelmez; COMPLETED yalnızca su idaresi teyidiyle.
 *  - Belirsiz sonuç (zaman aşımı) UNKNOWN'a gider; yeniden gönderim önce durum sorgusu gerektirir.
 */
export const TOPUP_TRANSITIONS: Record<TopupStatus, TopupStatus[]> = {
  CREATED: ['AWAITING_PAYMENT', 'FAILED'],
  AWAITING_PAYMENT: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'FAILED', 'REQUIRES_REVIEW'],
  PAYMENT_PENDING: ['PAYMENT_CONFIRMED', 'FAILED', 'REQUIRES_REVIEW'],
  PAYMENT_CONFIRMED: ['TOPUP_PENDING', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  TOPUP_PENDING: ['COMPLETED', 'UNKNOWN', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  UNKNOWN: ['COMPLETED', 'TOPUP_PENDING', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  REQUIRES_REVIEW: ['COMPLETED', 'REFUND_PENDING', 'FAILED'],
  REFUND_PENDING: ['REFUNDED', 'REQUIRES_REVIEW'],
  FAILED: ['REQUIRES_REVIEW'], // yalnızca geç gelen "ödeme başarılı" bildirimi için
  COMPLETED: [],
  REFUNDED: [],
};

export const BILL_TRANSITIONS: Record<BillStatus, BillStatus[]> = {
  CREATED: ['BILL_QUERY_PENDING', 'FAILED'],
  BILL_QUERY_PENDING: ['BILL_FOUND', 'FAILED'],
  BILL_FOUND: ['AWAITING_PAYMENT', 'FAILED'],
  AWAITING_PAYMENT: ['PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'FAILED', 'REQUIRES_REVIEW'],
  PAYMENT_PENDING: ['PAYMENT_CONFIRMED', 'FAILED', 'REQUIRES_REVIEW'],
  PAYMENT_CONFIRMED: ['COLLECTION_PENDING', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  COLLECTION_PENDING: ['COMPLETED', 'UNKNOWN', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  UNKNOWN: ['COMPLETED', 'COLLECTION_PENDING', 'REFUND_PENDING', 'REQUIRES_REVIEW'],
  REQUIRES_REVIEW: ['COMPLETED', 'REFUND_PENDING', 'FAILED'],
  REFUND_PENDING: ['REFUNDED', 'REQUIRES_REVIEW'],
  FAILED: ['REQUIRES_REVIEW'],
  COMPLETED: [],
  REFUNDED: [],
};

export const TABLE: Record<SourceType, string> = {
  TOPUP: 'topup_transactions',
  BILL_PAYMENT: 'bill_payment_transactions',
};

export function canTransition(type: SourceType, from: string, to: string): boolean {
  const map = (type === 'TOPUP' ? TOPUP_TRANSITIONS : BILL_TRANSITIONS) as Record<string, string[]>;
  return map[from]?.includes(to) ?? false;
}

/** Satırı kilitler (SELECT ... FOR UPDATE). Çağıran bir transaction içinde olmalıdır. */
export async function lockTxn(db: DbClient, type: SourceType, id: string) {
  const { rows } = await db.query(`SELECT * FROM ${TABLE[type]} WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ?? null;
}

/**
 * Durum geçişi: geçerlilik kontrolü + koşullu güncelleme (iyimser kilit: mevcut durum eşleşmeli) + geçmiş kaydı.
 */
export async function transition(
  db: DbClient,
  type: SourceType,
  id: string,
  from: string,
  to: string,
  opts: { reason?: string; actor: string; set?: Record<string, unknown> },
) {
  if (!canTransition(type, from, to)) {
    throw conflict(`Geçersiz durum geçişi: ${from} → ${to}`, 'INVALID_TRANSITION');
  }
  const set = { ...(opts.set ?? {}) };
  if (to === 'COMPLETED') set.completed_at = new Date();
  const cols = Object.keys(set);
  const assignments = cols.map((c, i) => `${c} = $${i + 4}`).join(', ');
  const sql = `UPDATE ${TABLE[type]} SET status = $3, updated_at = now()${assignments ? ', ' + assignments : ''} WHERE id = $1 AND status = $2 RETURNING *`;
  const { rows } = await db.query(sql, [id, from, to, ...cols.map((c) => set[c])]);
  if (!rows[0]) throw conflict('İşlem durumu eşzamanlı olarak değişti; tekrar deneyin.', 'CONCURRENT_UPDATE');
  await db.query(
    'INSERT INTO transaction_status_history (source_type, source_id, from_status, to_status, reason, actor) VALUES ($1,$2,$3,$4,$5,$6)',
    [type, id, from, to, opts.reason ?? null, opts.actor],
  );
  return rows[0];
}

/** Kullanıcıya gösterilecek, gerçeğe uygun durum açıklamaları. */
export const USER_STATUS_TEXT: Record<string, string> = {
  CREATED: 'İşlem oluşturuldu',
  BILL_QUERY_PENDING: 'Borç sorgulanıyor',
  BILL_FOUND: 'Borç bulundu, ödeme bekleniyor',
  AWAITING_PAYMENT: 'Ödeme bekleniyor',
  PAYMENT_PENDING: 'Ödeme sonucu bekleniyor',
  PAYMENT_CONFIRMED: 'Ödeme alındı — su idaresine iletilecek (henüz tamamlanmadı)',
  TOPUP_PENDING: 'Ödeme alındı — su idaresi yükleme teyidi bekleniyor',
  COLLECTION_PENDING: 'Ödeme alındı — su idaresi tahsilat teyidi bekleniyor',
  COMPLETED: 'Tamamlandı (su idaresi tarafından teyit edildi)',
  FAILED: 'Başarısız — hesabınızdan tahsilat yapılmadı',
  UNKNOWN: 'Sonuç henüz netleşmedi — su idaresinden teyit bekleniyor, tekrar ödeme yapmayın',
  REFUND_PENDING: 'İşlem tamamlanamadı — iade süreci başlatıldı',
  REFUNDED: 'İade edildi',
  REQUIRES_REVIEW: 'İnceleniyor — destek ekibimiz işlemi kontrol ediyor, tekrar ödeme yapmayın',
};
