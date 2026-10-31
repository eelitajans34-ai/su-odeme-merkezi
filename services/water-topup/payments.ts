// Ödeme doğrulama. Para yalnızca ödeme kuruluşunun İMZALI bildirimiyle "ödendi" sayılır.
// Sandbox sağlayıcısı test içindir ve canlı modda kullanılamaz. Gizli anahtarlar koda yazılmaz (ortam/kasa).
import { createHmac, timingSafeEqual } from "node:crypto";
import { TopupError, type Kurus, type Mode } from "./types";

export type PaymentNotice = { provider: string; orderNo: string; status: "success" | "failed"; paidKurus: Kurus; providerRef: string; signature: string };

export interface PaymentProvider {
  readonly name: string;
  readonly mode: Mode;
  /** Bildirimin bu sağlayıcıdan geldiğini doğrular (imza). */
  verify(n: PaymentNotice): boolean;
}

const sign = (secret: string, n: Omit<PaymentNotice, "signature">) =>
  createHmac("sha256", secret).update(`${n.provider}|${n.orderNo}|${n.status}|${n.paidKurus}|${n.providerRef}`).digest("hex");

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Test ödeme sağlayıcısı: gerçek para hareketi yoktur. */
export class SandboxProvider implements PaymentProvider {
  readonly name = "sandbox";
  readonly mode = "sandbox" as const;
  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new TopupError("weak_secret", "Sandbox anahtarı en az 16 karakter olmalı.");
  }
  notice(orderNo: string, paidKurus: Kurus, status: "success" | "failed" = "success"): PaymentNotice {
    const n = { provider: this.name, orderNo, status, paidKurus, providerRef: `SBX-${orderNo}` };
    return { ...n, signature: sign(this.secret, n) };
  }
  verify(n: PaymentNotice) {
    return n.provider === this.name && safeEqual(n.signature, sign(this.secret, n));
  }
}

/** Canlı sağlayıcı (PayTR vb.) yetkili sözleşme ve anahtarlar gelene kadar yoktur. */
export function liveProvider(): PaymentProvider | null {
  return null;
}

export type PaymentCheck = { orderNo: string; expectedKurus: Kurus; orderMode: Mode };

/** İmza, mod ve tutar eşleşmesi. Tutar uyuşmazsa ödeme kabul edilmez (iade sürecine alınır). */
export function verifyPayment(provider: PaymentProvider, n: PaymentNotice, c: PaymentCheck): "paid" | "failed" | "amount_mismatch" {
  if (!provider.verify(n)) throw new TopupError("bad_signature", "Ödeme bildirimi doğrulanamadı.");
  if (n.orderNo !== c.orderNo) throw new TopupError("order_mismatch", "Bildirim başka bir siparişe ait.");
  if (provider.mode !== c.orderMode) throw new TopupError("mode_mismatch", "Test ödemesi canlı siparişi kapatamaz.");
  if (n.status !== "success") return "failed";
  return n.paidKurus === c.expectedKurus ? "paid" : "amount_mismatch";
}
