import { describe, expect, it } from "vitest";
import { canBindCard, hashCardUid, TopupError, type CardBinding, type Subscription } from "../../services/water-topup";
import { CARDS, bridgeEvent } from "./cards";

const PEPPER = "test-pepper-0123456789abcdef0123456789"; // yalnızca test
const sub: Subscription = { id: "s1", userId: "u1", utilityCode: "buski", subscriberNo: "123456", meterNo: "998877", meterType: "card", status: "verified" };

describe("NFC simülatörü: kart tanıma ve eşleştirme", () => {
  it("köprü olayı yalnızca tanıma verisi taşır (anahtar/sektör yok)", () => {
    for (const c of Object.values(CARDS)) {
      const ev = JSON.parse(bridgeEvent(c));
      expect(Object.keys(ev.card).sort()).toEqual(Object.keys(c).sort());
      expect(JSON.stringify(ev)).not.toMatch(/key|sector|block|balance|kredi/i);
    }
  });

  it("güvenli kartlar (Classic, DESFire) güvenli olarak işaretlenir; ISO 15693 tanınır", () => {
    expect(CARDS.mifareClassic!.secure).toBe(true);
    expect(CARDS.desfire!.secure).toBe(true);
    expect(CARDS.icode!.standard).toContain("15693");
  });

  it("UID biçimi farklı olsa da aynı karma çıkar; açık UID saklanmaz", () => {
    const a = hashCardUid("04:5E:6F:7A:8B:9C:80", PEPPER);
    const b = hashCardUid("045e6f7a8b9c80", PEPPER);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("045E6F");
  });

  it("farklı sunucu anahtarı farklı karma üretir; zayıf anahtar reddedilir", () => {
    expect(hashCardUid(CARDS.mifareClassic!.uid, PEPPER)).not.toBe(hashCardUid(CARDS.mifareClassic!.uid, PEPPER + "x"));
    expect(() => hashCardUid("04A1B2C3", "kisa")).toThrow(TopupError);
    expect(() => hashCardUid("ZZ", PEPPER)).toThrow(/okunamadı/);
  });

  it("kart başka hesaba bağlıysa ikinci hesaba bağlanmaz", () => {
    const taken: CardBinding = { id: "b1", subscriptionId: "s9", userId: "u2", uidHash: "x", status: "verified" };
    expect(() => canBindCard({ sub, userId: "u1", existing: taken })).toThrow(/başka bir hesaba/);
    expect(() => canBindCard({ sub, userId: "u1", existing: { ...taken, status: "revoked" } })).not.toThrow();
  });

  it("akıllı (kartsız) sayaca kart eşleştirilmez", () => {
    expect(() => canBindCard({ sub: { ...sub, meterType: "smart" }, userId: "u1", existing: null })).toThrow(/kartlı sayaç/);
  });
});
