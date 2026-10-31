// water-topup servislerinin ortak tipleri. Tutarlar kuruş (tam sayı) olarak taşınır; kayan nokta hatası olmaz.

export type Kurus = number;
export type Mode = "sandbox" | "live";

export type Subscription = {
  id: string;
  userId: string;
  utilityCode: string; // ör. "buski"
  subscriberNo: string;
  meterNo: string;
  meterType: "card" | "smart";
  status: "pending" | "verified" | "rejected" | "archived";
};

export type CardBinding = {
  id: string;
  subscriptionId: string;
  userId: string;
  uidHash: string; // HMAC-SHA256, açık UID asla saklanmaz
  status: "pending" | "verified" | "revoked";
};

export class TopupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TopupError";
  }
}
