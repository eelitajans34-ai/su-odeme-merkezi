/**
 * Su idaresi adaptör arayüzü.
 *
 * Uç noktalar ve istek/yanıt biçimleri yalnızca kurumun resmî teknik dokümanından alınır.
 * Kurum dokümanı ve yazılı izin olmadan gerçek adaptör yazılmaz; izin alınmamış web sayfalarını
 * kazımak (scraping) veya yetkisiz erişim yöntemleri kesinlikle kullanılmaz.
 */
export interface UtilityContext {
  environment: 'TEST' | 'LIVE';
  apiBaseUrl: string | null;
  integrationCode: string | null;
  credential: string | null;     // yalnızca bellekte
  certificate: string | null;    // yalnızca bellekte
}

export interface AccountInfo {
  found: boolean;
  holderNameMasked?: string | null;
  cards?: { cardSerial: string; topupMethod: 'REMOTE_CREDIT' | 'CARD_WRITE_AT_TERMINAL' | 'NOT_SUPPORTED' }[];
}

export interface Bill {
  billId: string;
  period: string;
  amountMinor: number;
  dueDate: string;   // YYYY-MM-DD
}

/** Su idaresine gönderilen emrin sonucu. AMBIGUOUS: zaman aşımı/bağlantı kesintisi — sonuç BİLİNMİYOR. */
export type SubmitOutcome =
  | { kind: 'CONFIRMED'; utilityRef: string }
  | { kind: 'ACCEPTED_PENDING'; utilityRef: string | null }
  | { kind: 'REJECTED'; code: string; message: string }
  | { kind: 'AMBIGUOUS'; message: string };

export type StatusOutcome =
  | { kind: 'CONFIRMED'; utilityRef: string; amountMinor: number }
  | { kind: 'PENDING' }
  | { kind: 'REJECTED'; code: string; message: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ERROR'; message: string };

export interface UtilityTxnRecord {
  utilityRequestId: string;
  utilityRef: string | null;
  type: 'TOPUP' | 'BILL_PAYMENT';
  amountMinor: number;
  status: 'CONFIRMED' | 'PENDING' | 'REJECTED';
}

export interface WaterUtilityAdapter {
  readonly code: string;
  readonly isSimulator: boolean;
  testConnection(ctx: UtilityContext): Promise<{ ok: boolean; code: string; message: string }>;
  queryAccount(ctx: UtilityContext, subscriberNo: string): Promise<AccountInfo>;
  parseQr?(payload: string): { utilityCode: string; subscriberNo: string } | null;
  submitTopup(ctx: UtilityContext, input: { utilityRequestId: string; subscriberNo: string; cardSerial: string; amountMinor: number }): Promise<SubmitOutcome>;
  getTopupStatus(ctx: UtilityContext, utilityRequestId: string): Promise<StatusOutcome>;
  queryBills(ctx: UtilityContext, subscriberNo: string): Promise<{ bills: Bill[] }>;
  submitBillPayment(ctx: UtilityContext, input: { utilityRequestId: string; subscriberNo: string; billIds: string[]; amountMinor: number }): Promise<SubmitOutcome>;
  getCollectionStatus(ctx: UtilityContext, utilityRequestId: string): Promise<StatusOutcome>;
  listTransactions?(ctx: UtilityContext, from: Date, to: Date): Promise<UtilityTxnRecord[]>;
}

export class UtilityNotConfiguredError extends Error {
  readonly code = 'UTILITY_NOT_CONFIGURED';
  constructor(message = 'Su idaresi entegrasyonu yapılandırılmadı (Yapılandırma bekleniyor).') {
    super(message);
  }
}
