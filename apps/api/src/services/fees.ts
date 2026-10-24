import type { DbClient } from '../db.js';

export interface FeeQuote {
  amountMinor: number;
  feeMinor: number;
  totalMinor: number;
  currency: string;
  feeScheduleId: string | null;
  feeDescription: string;
  isSampleTariff: boolean;
  minAmountMinor: number;
  maxAmountMinor: number;
}

export interface FeeScheduleRow {
  id: string;
  fee_type: 'NONE' | 'FIXED' | 'PERCENT' | 'FIXED_PLUS_PERCENT';
  fixed_fee_minor: number;
  percent_bps: number;
  min_fee_minor: number;
  max_fee_minor: number | null;
  min_amount_minor: number;
  max_amount_minor: number;
  user_facing_description: string;
  is_sample: boolean;
}

export async function activeFeeSchedule(db: DbClient, type: 'TOPUP' | 'BILL_PAYMENT', at = new Date()): Promise<FeeScheduleRow | null> {
  const { rows } = await db.query(
    'SELECT * FROM fee_schedules WHERE transaction_type = $1 AND effective_from <= $2 ORDER BY effective_from DESC, created_at DESC LIMIT 1',
    [type, at],
  );
  return rows[0] ?? null;
}

/** Ücret hesaplaması tamamen sunucu tarafındadır; tamsayı kuruş, oransal kısımda yarım kuruş yukarı yuvarlanır. */
export function computeFee(amountMinor: number, s: FeeScheduleRow | null): number {
  if (!s || s.fee_type === 'NONE') return 0;
  let fee = 0;
  if (s.fee_type === 'FIXED' || s.fee_type === 'FIXED_PLUS_PERCENT') fee += s.fixed_fee_minor;
  if (s.fee_type === 'PERCENT' || s.fee_type === 'FIXED_PLUS_PERCENT') fee += Math.floor((amountMinor * s.percent_bps + 5000) / 10000);
  fee = Math.max(fee, s.min_fee_minor);
  if (s.max_fee_minor != null) fee = Math.min(fee, s.max_fee_minor);
  return fee;
}
