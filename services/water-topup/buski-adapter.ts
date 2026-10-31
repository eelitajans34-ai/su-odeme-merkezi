// BUSKİ su idaresi adaptörü. Sözleşme: abone doğrulama, kredi yükleme (idempotent), sayaç durumu.
// Gerçek bağlantı ancak BUSKİ'nin resmî API adresi, anahtarları ve yazılı izni geldiğinde kurulur;
// o zamana kadar createBuskiAdapter "disabled" döner. Sandbox adaptörü gerçek idareye gitmez.
import { createHmac } from "node:crypto";
import { TopupError, type Mode } from "./types";

export type Identity = { subscriberNo: string; meterNo: string; cardNo: string | null; meterType: "card" | "smart" };
export type CreditRequest = Identity & { orderNo: string; m3: number; amountKurus: number; paidAt: string };

export interface UtilityAdapter {
  readonly code: string;
  readonly mode: Mode;
  verify(id: Identity): Promise<{ valid: boolean; holderMasked?: string; message?: string }>;
  /** orderNo idempotency anahtarıdır: aynı sipariş ikinci kez gelirse idare ilk referansı döndürmelidir. */
  credit(req: CreditRequest): Promise<{ ok: boolean; reference?: string; message?: string }>;
}

export type BuskiConfig = { baseUrl?: string | undefined; apiKey?: string | undefined; signingSecret?: string | undefined; authorizationRef?: string | undefined };

/** Gerçek BUSKİ adaptörü: yapılandırma + yazılı yetki referansı olmadan oluşturulmaz. */
export function createBuskiAdapter(cfg: BuskiConfig, fetchImpl: typeof fetch = fetch): UtilityAdapter | { disabled: true; reason: string } {
  if (!cfg.authorizationRef) return { disabled: true, reason: "BUSKİ yazılı entegrasyon izni (sözleşme no) tanımlı değil." };
  if (!cfg.baseUrl?.startsWith("https://") || !cfg.apiKey || !cfg.signingSecret) return { disabled: true, reason: "BUSKİ API adresi ve anahtarları tanımlı değil." };
  const { baseUrl, apiKey, signingSecret } = cfg;
  const post = async (path: string, body: unknown, idem?: string) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", signingSecret).update(`${ts}.${raw}`).digest("hex");
    const res = await fetchImpl(baseUrl.replace(/\/$/, "") + path, {
      method: "POST", body: raw, signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-kolaysu-timestamp": ts, "x-kolaysu-signature": sig, ...(idem ? { "idempotency-key": idem } : {}) },
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok && res.status !== 409) throw new TopupError("utility_http", `BUSKİ yanıtı ${res.status}`);
    return json ?? {};
  };
  return {
    code: "buski", mode: "live",
    async verify(id) {
      const j = await post("/abone-dogrula", id);
      return { valid: j["valid"] === true, ...(typeof j["message"] === "string" ? { message: j["message"] } : {}) };
    },
    async credit(req) {
      const j = await post("/yukleme", req, req.orderNo);
      const reference = typeof j["reference"] === "string" && j["reference"] ? j["reference"] : undefined;
      return { ok: j["success"] === true && !!reference, ...(reference ? { reference } : {}) };
    },
  };
}

/** Test adaptörü: gerçek idareye gitmez; aynı sipariş için hep aynı referansı döndürür (idempotent). */
export class BuskiSandbox implements UtilityAdapter {
  readonly code = "buski";
  readonly mode = "sandbox" as const;
  private readonly credits = new Map<string, string>();
  failNext = 0;
  async verify(id: Identity) {
    const ok = /^\d{4,}$/.test(id.subscriberNo) && /^\d{4,}$/.test(id.meterNo);
    return ok ? { valid: true, holderMasked: "Te*** Ab***" } : { valid: false, message: "Test: abone/sayaç numarası en az 4 haneli olmalı" };
  }
  async credit(req: CreditRequest) {
    if (this.failNext > 0) { this.failNext--; return { ok: false, message: "Test: idare geçici olarak yanıt vermiyor" }; }
    const ref = this.credits.get(req.orderNo) ?? `SBX-BUSKI-${req.orderNo}`;
    this.credits.set(req.orderNo, ref);
    return { ok: true, reference: ref };
  }
  creditCount() { return this.credits.size; }
}
