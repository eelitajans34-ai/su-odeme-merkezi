// Yükleme siparişleri: durum makinesi, tekil sipariş numarası ve mükerrer işlem koruması.
// Veritabanında aynı kurallar UNIQUE kısıtları ve tetikleyicilerle de zorlanır (database/migrations).
import { randomBytes } from "node:crypto";
import { TopupError, type Kurus, type Mode } from "./types";

export type OrderStatus =
  | "created" | "awaiting_payment" | "payment_failed" | "expired" | "paid"
  | "utility_pending" | "utility_failed" | "completed" | "refund_pending" | "refunded";

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  created: ["awaiting_payment", "expired"],
  awaiting_payment: ["paid", "payment_failed", "expired", "refund_pending"],
  paid: ["utility_pending"],
  utility_pending: ["completed", "utility_failed"],
  utility_failed: ["utility_pending", "completed", "refund_pending"],
  refund_pending: ["refunded"],
  payment_failed: [], expired: [], completed: [], refunded: [],
};

export type TopupOrder = {
  id: string; orderNo: string; userId: string; subscriptionId: string; mode: Mode; m3: number;
  totalKurus: Kurus; status: OrderStatus; paidKurus: Kurus | null; utilityRef: string | null; utilityAttempts: number;
  events: { at: string; from: OrderStatus; to: OrderStatus; note?: string }[];
};

/** "SK" + 20 büyük harf/rakam. Ödeme kuruluşuna merchant_oid, idareye Idempotency-Key olarak gider. */
export function newOrderNo() {
  return "SK" + randomBytes(10).toString("hex").toUpperCase();
}

export function transition(o: TopupOrder, to: OrderStatus, note?: string, now = new Date()): TopupOrder {
  if (!ORDER_TRANSITIONS[o.status].includes(to)) throw new TopupError("bad_transition", `${o.status} → ${to} geçişine izin yok.`);
  return { ...o, status: to, events: [...o.events, { at: now.toISOString(), from: o.status, to, ...(note ? { note } : {}) }] };
}

/** Aynı ödeme bildirimi ikinci kez gelirse (PayTR tekrar gönderir) sipariş ikinci kez işlenmez. */
export function applyPayment(o: TopupOrder, result: "paid" | "failed" | "amount_mismatch", paidKurus: Kurus): { order: TopupOrder; deliver: boolean } {
  if (["paid", "utility_pending", "utility_failed", "completed", "refund_pending", "refunded"].includes(o.status)) return { order: o, deliver: false };
  if (result === "failed") return { order: transition(o, "payment_failed"), deliver: false };
  if (result === "amount_mismatch") return { order: { ...transition(o, "refund_pending", "Tutar uyuşmazlığı"), paidKurus }, deliver: false };
  const paid = { ...transition(o, "paid"), paidKurus };
  return { order: transition(paid, "utility_pending"), deliver: true };
}

/** İdare yanıtı. Başarısızlıkta 2,4,8,16,32 dk arayla 6 deneme; sonra iade sürecine alınır. */
export function applyUtilityResult(o: TopupOrder, r: { ok: boolean; reference?: string; error?: string }, maxAttempts = 6) {
  if (o.status === "completed") return { order: o, retryInMinutes: null as number | null };
  const attempts = o.utilityAttempts + 1;
  if (r.ok) {
    if (!r.reference) throw new TopupError("missing_reference", "İdare referansı olmadan yükleme tamamlanmış sayılmaz.");
    return { order: { ...transition(o, "completed"), utilityRef: r.reference, utilityAttempts: attempts }, retryInMinutes: null };
  }
  const failed = { ...transition(o, "utility_failed", r.error), utilityAttempts: attempts };
  if (attempts >= maxAttempts) return { order: transition(failed, "refund_pending", "İdareye iletilemedi"), retryInMinutes: null };
  return { order: failed, retryInMinutes: 2 ** attempts };
}
