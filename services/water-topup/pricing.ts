// Fiyat ve hizmet bedeli hesabı. Yalnızca sunucuda çalışır; istemciden gelen tutara güvenilmez.
import { TopupError, type Kurus } from "./types";

export type Tariff = { utilityCode: string; unitPriceKurus: Kurus; minM3: number; maxM3: number };
export type Quote = { m3: number; waterKurus: Kurus; feeKurus: Kurus; totalKurus: Kurus; feeRate: number };

/** m3 en fazla 2 ondalık; hizmet bedeli yarım kuruştan yukarı yuvarlanır. */
export function quote(t: Tariff, m3: number, feeRate: number): Quote {
  if (!Number.isFinite(m3) || Math.abs(m3 * 100 - Math.round(m3 * 100)) > 1e-6) throw new TopupError("invalid_m3", "Miktar en fazla 2 ondalık olabilir.");
  if (m3 < t.minM3 || m3 > t.maxM3) throw new TopupError("m3_out_of_range", `Miktar ${t.minM3}–${t.maxM3} m³ arasında olmalı.`);
  if (!(feeRate >= 0 && feeRate <= 0.2)) throw new TopupError("invalid_fee", "Hizmet bedeli oranı geçersiz.");
  if (!Number.isInteger(t.unitPriceKurus) || t.unitPriceKurus <= 0) throw new TopupError("invalid_tariff", "Tarife geçersiz.");
  const centiM3 = Math.round(m3 * 100);
  const waterKurus = Math.round((centiM3 * t.unitPriceKurus) / 100);
  const feeKurus = Math.round(waterKurus * feeRate);
  return { m3, waterKurus, feeKurus, totalKurus: waterKurus + feeKurus, feeRate };
}

export const formatTl = (k: Kurus) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(k / 100);
