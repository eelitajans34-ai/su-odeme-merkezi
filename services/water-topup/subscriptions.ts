// Abonelik (sayaç) ve NFC kart eşleştirme kuralları.
import { createHmac } from "node:crypto";
import { TopupError, type CardBinding, type Subscription } from "./types";

const DIGITS = /^\d{4,20}$/;

export function validateSubscriptionInput(i: { subscriberNo: string; meterNo: string; utilityCode: string }) {
  if (!DIGITS.test(i.subscriberNo.trim())) throw new TopupError("invalid_subscriber", "Abone numarası 4–20 haneli rakam olmalı.");
  if (!DIGITS.test(i.meterNo.trim())) throw new TopupError("invalid_meter", "Sayaç numarası 4–20 haneli rakam olmalı.");
  if (!/^[a-z0-9-]{2,40}$/.test(i.utilityCode)) throw new TopupError("invalid_utility", "Geçersiz su idaresi.");
}

/** Kart UID'i yalnızca sunucu anahtarıyla HMAC'lenmiş halde saklanır. */
export function hashCardUid(uid: string, pepper: string) {
  const n = uid.replace(/[\s:-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{8,20}$/.test(n) || n.length % 2) throw new TopupError("invalid_uid", "Kart seri numarası okunamadı.");
  if (pepper.length < 32) throw new TopupError("weak_pepper", "Kart anahtarı yapılandırılmadı.");
  return createHmac("sha256", pepper).update(`nfc-uid:v1:${n}`).digest("hex");
}

/** Kartı aboneliğe bağlamadan önceki kontroller. */
export function canBindCard(p: { sub: Subscription | null; userId: string; existing: CardBinding | null }) {
  const { sub, userId, existing } = p;
  if (!sub || sub.userId !== userId || sub.status === "archived") throw new TopupError("subscription_missing", "Abonelik bulunamadı.");
  if (sub.meterType !== "card") throw new TopupError("not_card_meter", "Yalnızca kartlı sayaçlara kart eşleştirilir.");
  if (existing && existing.status !== "revoked") {
    if (existing.userId !== userId) throw new TopupError("card_taken", "Bu kart başka bir hesaba bağlı.");
    if (existing.subscriptionId === sub.id) throw new TopupError("already_bound", "Bu kart zaten bu aboneliğe bağlı.");
  }
}

/** Yükleme yapılabilir mi: abonelik idarece doğrulanmış olmalı. */
export function assertTopupAllowed(sub: Subscription | null, userId: string) {
  if (!sub || sub.userId !== userId) throw new TopupError("subscription_missing", "Abonelik bulunamadı.");
  if (sub.status !== "verified") throw new TopupError("subscription_unverified", "Abonelik su idaresince doğrulanmadan yükleme yapılamaz.");
}
