// Test kartları: Android köprüsünün (apps/android/NfcCardReader.kt) ürettiği olay biçiminde.
// Gerçek kart, anahtar ya da sektör verisi içermez.
export type BridgeCard = { uid: string; techList: string[]; atqa?: string; sak?: number; dsfid?: number; standard: string; family: string; secure: boolean };
const t = (...x: string[]) => x.map((s) => `android.nfc.tech.${s}`);

export const CARDS: Record<string, BridgeCard> = {
  mifareClassic: { uid: "04A1B2C3", techList: t("NfcA", "MifareClassic", "NdefFormatable"), atqa: "0400", sak: 0x08, standard: "ISO/IEC 14443-A", family: "MIFARE Classic", secure: true },
  desfire: { uid: "04112233445566", techList: t("NfcA", "IsoDep"), atqa: "4403", sak: 0x20, standard: "ISO/IEC 14443-A", family: "MIFARE DESFire / ISO-DEP", secure: true },
  icode: { uid: "E004015012345678", techList: t("NfcV"), dsfid: 0, standard: "ISO/IEC 15693 (NFC-V)", family: "ICODE / ISO 15693 etiket", secure: false },
  ntag: { uid: "04:5E:6F:7A:8B:9C:80", techList: t("NfcA", "MifareUltralight", "Ndef"), atqa: "4400", sak: 0x00, standard: "ISO/IEC 14443-A", family: "MIFARE Ultralight / NTAG", secure: false },
};

/** Köprünün sayfaya gönderdiği olay. */
export const bridgeEvent = (card: BridgeCard) => JSON.stringify({ type: "card", card });
