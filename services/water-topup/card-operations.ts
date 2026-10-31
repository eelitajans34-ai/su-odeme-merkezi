// Kart işlemleri: tamamlanmış (idare onaylı) yüklemenin karta aktarılması.
// Kart kredi alanları idare/üretici anahtarlarıyla korunur; bu servis o anahtarları TUTMAZ ve karta yazmaz.
// Gerçek yazma yalnızca yetkili SDK ile tanımlanmış bir LiveCardWriter üzerinden olur (şu an yok).
import { createHash, randomBytes } from "node:crypto";
import { TopupError, type CardBinding, type Mode } from "./types";
import type { TopupOrder } from "./topup-orders";

export type CardOpStatus = "requested" | "payment_verified" | "simulated" | "pending_device" | "completed" | "failed";
export type CardOperation = { opNo: string; idempotencyKey: string; orderId: string; bindingId: string; mode: "simulated" | "live"; status: CardOpStatus; resultRef: string | null; steps: string[] };

export interface LiveCardWriter { readonly authorizationRef: string; write(op: CardOperation, order: TopupOrder): Promise<{ ok: boolean; reference?: string }> }

/** Yetkili SDK gelene kadar null. Ortam değişkeni ya da ayar bunu açamaz. */
export const LIVE_CARD_WRITER: LiveCardWriter | null = null;

export const newOpNo = (now = new Date()) => `KK${now.toISOString().slice(2, 10).replace(/-/g, "")}${randomBytes(6).toString("hex").toUpperCase()}`;
export const opKey = (orderNo: string, bindingId: string, mode: string) => createHash("sha256").update(`card-op:v1:${mode}:${orderNo}:${bindingId}`).digest("hex");

/**
 * Kart işlemi başlatır. `existing`: aynı siparişe ait önceki işlemler (veritabanından).
 * Aynı istek tekrar gelirse ilk işlem döner; farklı kartla ikinci yükleme reddedilir.
 */
export function startCardOperation(p: { order: TopupOrder; binding: CardBinding | null; userId: string; existing: CardOperation[]; writer?: LiveCardWriter | null }): CardOperation {
  const { order, binding, userId } = p;
  const writer = p.writer === undefined ? LIVE_CARD_WRITER : p.writer;
  if (order.userId !== userId) throw new TopupError("not_owner", "Bu sipariş size ait değil.");
  if (order.status !== "completed" || !order.utilityRef) throw new TopupError("not_completed", "Su idaresi onaylamadan kart işlemi yapılamaz.");
  if (order.paidKurus !== order.totalKurus) throw new TopupError("amount_mismatch", "Ödenen tutar sipariş tutarıyla eşleşmiyor.");
  if (!binding || binding.status === "revoked" || binding.userId !== userId || binding.subscriptionId !== order.subscriptionId) throw new TopupError("binding_missing", "Bu aboneliğe eşleştirilmiş kart yok.");
  const mode: CardOperation["mode"] = (order.mode as Mode) === "sandbox" ? "simulated" : "live";
  if (mode === "live" && !writer) throw new TopupError("live_disabled", "Gerçek karta yazma kapalı: yetkili BUSKİ/üretici SDK'sı yok.");
  if (mode === "live" && binding.status !== "verified") throw new TopupError("binding_unverified", "Kart idarece doğrulanmadı.");
  const key = opKey(order.orderNo, binding.id, mode);
  const same = p.existing.find((x) => x.idempotencyKey === key && x.status !== "failed");
  if (same) return same;
  if (p.existing.some((x) => x.status !== "failed")) throw new TopupError("duplicate", "Bu sipariş için kart işlemi zaten yapıldı.");
  const opNo = newOpNo();
  if (mode === "simulated") {
    return { opNo, idempotencyKey: key, orderId: order.id, bindingId: binding.id, mode, status: "simulated", resultRef: `SIM-${opNo}`,
      steps: ["Ödeme ve idare referansı doğrulandı.", "Kart eşleştirmesi doğrulandı.", `${order.m3} m³ için kart komutu hazırlandı, GÖNDERİLMEDİ.`, "Simülasyon: karta erişilmedi."] };
  }
  return { opNo, idempotencyKey: key, orderId: order.id, bindingId: binding.id, mode, status: "pending_device", resultRef: null, steps: ["Yetkili SDK ile kart yazma bekleniyor."] };
}
