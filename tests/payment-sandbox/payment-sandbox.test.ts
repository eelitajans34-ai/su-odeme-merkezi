import { describe, expect, it } from "vitest";
import { liveProvider, quote, SandboxProvider, verifyPayment, type PaymentProvider } from "../../services/water-topup";

const sbx = new SandboxProvider("sandbox-secret-only-for-tests");
const tariff = { utilityCode: "buski", unitPriceKurus: 2350, minM3: 1, maxM3: 100 };

describe("ödeme sandbox", () => {
  it("fiyat sunucuda kuruş olarak hesaplanır", () => {
    expect(quote(tariff, 10, 0.02)).toEqual({ m3: 10, waterKurus: 23500, feeKurus: 470, totalKurus: 23970, feeRate: 0.02 });
    expect(quote(tariff, 2.55, 0).waterKurus).toBe(5993);
    expect(() => quote(tariff, 0.5, 0)).toThrow(/arasında/);
    expect(() => quote(tariff, 1.234, 0)).toThrow(/ondalık/);
  });

  it("imzalı ve tutarı doğru bildirim ödendi sayılır", () => {
    expect(verifyPayment(sbx, sbx.notice("SK1", 23970), { orderNo: "SK1", expectedKurus: 23970, orderMode: "sandbox" })).toBe("paid");
  });

  it("imzası bozuk ya da değiştirilmiş bildirim reddedilir", () => {
    const n = sbx.notice("SK1", 100);
    expect(() => verifyPayment(sbx, { ...n, paidKurus: 23970 }, { orderNo: "SK1", expectedKurus: 23970, orderMode: "sandbox" })).toThrow(/doğrulanamadı/);
    const other = new SandboxProvider("baska-bir-anahtar-123456");
    expect(() => verifyPayment(sbx, other.notice("SK1", 23970), { orderNo: "SK1", expectedKurus: 23970, orderMode: "sandbox" })).toThrow(/doğrulanamadı/);
  });

  it("eksik tutar, başka sipariş ve başarısız ödeme ayrı ele alınır", () => {
    const c = { orderNo: "SK1", expectedKurus: 23970, orderMode: "sandbox" as const };
    expect(verifyPayment(sbx, sbx.notice("SK1", 100), c)).toBe("amount_mismatch");
    expect(verifyPayment(sbx, sbx.notice("SK1", 23970, "failed"), c)).toBe("failed");
    expect(() => verifyPayment(sbx, sbx.notice("SK2", 23970), c)).toThrow(/başka bir siparişe/);
  });

  it("test ödemesi canlı siparişi kapatamaz; canlı sağlayıcı tanımlı değil", () => {
    expect(() => verifyPayment(sbx, sbx.notice("SK1", 1), { orderNo: "SK1", expectedKurus: 1, orderMode: "live" })).toThrow(/canlı/);
    expect(liveProvider()).toBeNull();
  });

  it("sahte sağlayıcı imzasız bildirimi kabul ettiremez", () => {
    const fake: PaymentProvider = { name: "sandbox", mode: "sandbox", verify: () => false };
    expect(() => verifyPayment(fake, sbx.notice("SK1", 1), { orderNo: "SK1", expectedKurus: 1, orderMode: "sandbox" })).toThrow();
  });

  it("zayıf sandbox anahtarı reddedilir", () => {
    expect(() => new SandboxProvider("kisa")).toThrow();
  });
});
