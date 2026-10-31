import { describe, expect, it, vi } from "vitest";
import {
  applyPayment, applyUtilityResult, assertTopupAllowed, BuskiSandbox, createBuskiAdapter, LIVE_CARD_WRITER, newOrderNo, opKey,
  quote, SandboxProvider, startCardOperation, transition, verifyPayment, type CardBinding, type CardOperation, type Subscription, type TopupOrder,
} from "../../services/water-topup";

const sub: Subscription = { id: "s1", userId: "u1", utilityCode: "buski", subscriberNo: "123456", meterNo: "998877", meterType: "card", status: "verified" };
const binding: CardBinding = { id: "b1", subscriptionId: "s1", userId: "u1", uidHash: "h", status: "verified" };
const sbx = new SandboxProvider("sandbox-secret-only-for-tests");

function newOrder(mode: "sandbox" | "live" = "sandbox"): TopupOrder {
  const q = quote({ utilityCode: "buski", unitPriceKurus: 2350, minM3: 1, maxM3: 100 }, 10, 0.02);
  const o: TopupOrder = { id: "o1", orderNo: newOrderNo(), userId: "u1", subscriptionId: "s1", mode, m3: 10, totalKurus: q.totalKurus, status: "created", paidKurus: null, utilityRef: null, utilityAttempts: 0, events: [] };
  return transition(o, "awaiting_payment");
}

async function runToCompleted() {
  const buski = new BuskiSandbox();
  let o = newOrder();
  const result = verifyPayment(sbx, sbx.notice(o.orderNo, o.totalKurus), { orderNo: o.orderNo, expectedKurus: o.totalKurus, orderMode: o.mode });
  const r = applyPayment(o, result, o.totalKurus);
  o = r.order;
  const res = await buski.credit({ ...sub, cardNo: null, orderNo: o.orderNo, m3: o.m3, amountKurus: o.totalKurus, paidAt: new Date().toISOString() });
  o = applyUtilityResult(o, res).order;
  return { o, buski, deliver: r.deliver };
}

describe("uçtan uca yükleme akışı (sandbox)", () => {
  it("sipariş no tekil ve biçimli", () => {
    const set = new Set(Array.from({ length: 500 }, newOrderNo));
    expect(set.size).toBe(500);
    for (const n of set) expect(n).toMatch(/^SK[0-9A-F]{20}$/);
  });

  it("doğrulanmamış abonelikle yükleme başlatılamaz", () => {
    expect(() => assertTopupAllowed({ ...sub, status: "pending" }, "u1")).toThrow(/doğrulanmadan/);
    expect(() => assertTopupAllowed(sub, "u2")).toThrow();
  });

  it("ödeme → idare → kart simülasyonu; geçmiş kaydedilir", async () => {
    const { o, deliver } = await runToCompleted();
    expect(deliver).toBe(true);
    expect(o.status).toBe("completed");
    expect(o.utilityRef).toBe(`SBX-BUSKI-${o.orderNo}`);
    expect(o.events.map((e) => e.to)).toEqual(["awaiting_payment", "paid", "utility_pending", "completed"]);
    const op = startCardOperation({ order: o, binding, userId: "u1", existing: [] });
    expect(op.mode).toBe("simulated");
    expect(op.resultRef).toMatch(/^SIM-KK\d{6}[0-9A-F]{12}$/);
    expect(op.steps.join(" ")).toContain("GÖNDERİLMEDİ");
  });

  it("aynı ödeme bildirimi iki kez gelirse idareye ikinci kez gidilmez", async () => {
    const { o } = await runToCompleted();
    const again = applyPayment(o, "paid", o.totalKurus);
    expect(again.deliver).toBe(false);
    expect(again.order).toBe(o);
  });

  it("idare aynı sipariş için aynı referansı döndürür (idempotent)", async () => {
    const buski = new BuskiSandbox();
    const req = { ...sub, cardNo: null, orderNo: "SKAAAAAAAAAAAAAAAAAAAA", m3: 1, amountKurus: 100, paidAt: "x" };
    const a = await buski.credit(req), b = await buski.credit(req);
    expect(a.reference).toBe(b.reference);
    expect(buski.creditCount()).toBe(1);
  });

  it("idare hatasında artan aralıklarla yeniden dener, 6. denemede iadeye alınır", () => {
    let o = applyPayment(newOrder(), "paid", newOrder().totalKurus).order;
    const waits: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const r = applyUtilityResult(o, { ok: false, error: "zaman aşımı" });
      waits.push(r.retryInMinutes);
      o = r.order.status === "utility_failed" ? transition(r.order, "utility_pending") : r.order;
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, null]);
    expect(o.status).toBe("refund_pending");
  });

  it("referanssız 'başarılı' idare yanıtı kabul edilmez", () => {
    const o = applyPayment(newOrder(), "paid", newOrder().totalKurus).order;
    expect(() => applyUtilityResult(o, { ok: true })).toThrow(/referansı/);
  });

  it("tutar uyuşmazlığı iade sürecine alınır, idareye gitmez", () => {
    const o = newOrder();
    const r = applyPayment(o, "amount_mismatch", 1);
    expect(r.deliver).toBe(false);
    expect(r.order.status).toBe("refund_pending");
  });

  it("geçersiz durum geçişi reddedilir", () => {
    expect(() => transition(newOrder(), "completed")).toThrow(/izin yok/);
  });

  it("kart işlemi: tekrar isteği aynı işlemi döndürür, ikinci kart işlemi reddedilir", async () => {
    const { o } = await runToCompleted();
    const first = startCardOperation({ order: o, binding, userId: "u1", existing: [] });
    expect(startCardOperation({ order: o, binding, userId: "u1", existing: [first] })).toBe(first);
    const other: CardOperation = { ...first, idempotencyKey: opKey(o.orderNo, "b2", "simulated") };
    expect(() => startCardOperation({ order: o, binding, userId: "u1", existing: [other] })).toThrow(/zaten/);
  });

  it("kart işlemi: başkasının siparişi, tamamlanmamış sipariş ve bağsız kart reddedilir", async () => {
    const { o } = await runToCompleted();
    expect(() => startCardOperation({ order: o, binding, userId: "u2", existing: [] })).toThrow(/size ait değil/);
    expect(() => startCardOperation({ order: newOrder(), binding, userId: "u1", existing: [] })).toThrow(/onaylamadan/);
    expect(() => startCardOperation({ order: o, binding: { ...binding, status: "revoked" }, userId: "u1", existing: [] })).toThrow(/eşleştirilmiş kart yok/);
  });

  it("canlı modda gerçek kart yazma kapalı (yetkili SDK yok)", async () => {
    const { o } = await runToCompleted();
    expect(LIVE_CARD_WRITER).toBeNull();
    expect(() => startCardOperation({ order: { ...o, mode: "live" }, binding, userId: "u1", existing: [] })).toThrow(/kapalı/);
  });

  it("gerçek BUSKİ adaptörü izin ve anahtar olmadan oluşmaz, ağa çıkmaz", () => {
    const f = vi.fn();
    expect(createBuskiAdapter({}, f as unknown as typeof fetch)).toMatchObject({ disabled: true });
    expect(createBuskiAdapter({ authorizationRef: "X", baseUrl: "http://buski", apiKey: "k", signingSecret: "s" }, f as unknown as typeof fetch)).toMatchObject({ disabled: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("izinli yapılandırmada istek imzalı ve idempotency anahtarlı gider (sahte ağ)", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ success: true, reference: "BUSKI-1" }), { status: 200 }));
    const a = createBuskiAdapter({ authorizationRef: "SOZ-1", baseUrl: "https://ornek.invalid", apiKey: "k", signingSecret: "s" }, f as unknown as typeof fetch);
    if ("disabled" in a) throw new Error("beklenmedik");
    const r = await a.credit({ ...sub, cardNo: null, orderNo: "SK123", m3: 1, amountKurus: 100, paidAt: "x" });
    expect(r).toEqual({ ok: true, reference: "BUSKI-1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ornek.invalid/yukleme");
    const h = init.headers as Record<string, string>;
    expect(h["idempotency-key"]).toBe("SK123");
    expect(h["x-kolaysu-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});
