/**
 * Ödeme sağlayıcısı adaptör arayüzü.
 *
 * Gerçek bir ödeme kuruluşunun API dokümanı ve sözleşmesi olmadan sağlayıcıya özel kod YAZILMAZ.
 * Yeni sağlayıcı eklemek için bu arayüzü uygulayan bir sınıf, kurumun resmî dokümanına göre yazılır
 * ve `registry.ts` içine kaydedilir (bkz. docs/ENTEGRASYON_REHBERI.md).
 */
export type ProviderPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED' | 'UNKNOWN';

export interface ProviderContext {
  environment: 'TEST' | 'LIVE';
  apiBaseUrl: string | null;
  merchantId: string | null;
  apiKey: string | null;          // yalnızca bellekte; asla günlüğe yazılmaz
  webhookSecret: string | null;   // yalnızca bellekte
  webhookToleranceSeconds: number;
  callbackBaseUrl: string;
}

/**
 * Ödeme yöntemleri:
 *  - HOSTED_CARD: sağlayıcının güvenli ödeme sayfası (kart bilgisi platforma gelmez)
 *  - QR: sağlayıcının ürettiği karekod; kullanıcı banka/cüzdan uygulamasıyla okutur
 *  - NFC: temassız kart okuma; yalnızca mobil uygulamada ve sağlayıcının SDK'sı ile
 * Sonuç her yöntemde aynı yoldan (imzalı webhook + durum sorgusu) doğrulanır.
 */
export type PaymentMethod = 'HOSTED_CARD' | 'QR' | 'NFC';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['HOSTED_CARD', 'QR', 'NFC'];

export interface CreatePaymentInput {
  orderRef: string;               // payment_transactions.public_ref
  amountMinor: number;
  currency: string;
  description: string;
  returnUrl: string;
  method: PaymentMethod;
}

export interface CreatePaymentResult {
  providerPaymentRef: string;
  /** HOSTED_CARD: yönlendirilecek ödeme sayfası */
  checkoutUrl: string | null;
  /** QR: karekod içeriği ve geçerlilik süresi */
  qr?: { payload: string; expiresAt: Date } | null;
  /** NFC: mobil SDK'nın kullanacağı oturum belirteci (gizli anahtar değildir) */
  nfc?: { sessionToken: string; sdk: string } | null;
}

export interface VerifiedWebhookEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed' | 'other';
  occurredAt: Date;
  orderRef: string | null;
  providerPaymentRef: string | null;
  providerRefundRef?: string | null;
  amountMinor: number | null;
  currency: string | null;
  failureCode?: string | null;
  sanitizedPayload: Record<string, unknown>;
}

export type WebhookVerification =
  | { ok: true; event: VerifiedWebhookEvent }
  | { ok: false; reason: 'MISSING_SIGNATURE' | 'INVALID_SIGNATURE' | 'STALE_TIMESTAMP' | 'MALFORMED' | 'NOT_CONFIGURED' };

export interface ProviderTxnRecord {
  providerPaymentRef: string;
  orderRef: string;
  amountMinor: number;
  currency: string;
  status: ProviderPaymentStatus;
}

export interface PaymentProviderAdapter {
  readonly code: string;
  /** Uygulama içi simülatör mü? Simülatörler üretimde kullanılamaz ve gerçek para hareketi oluşturmaz. */
  readonly isSimulator: boolean;
  readonly supportsRefund: boolean;
  readonly supportsStatusQuery: boolean;
  readonly supportsTransactionList: boolean;
  /** Adaptörün resmî dokümana göre uyguladığı ödeme yöntemleri */
  readonly supportedMethods: readonly PaymentMethod[];

  testConnection(ctx: ProviderContext): Promise<{ ok: boolean; code: string; message: string }>;
  createPayment(ctx: ProviderContext, input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyWebhook(ctx: ProviderContext, rawBody: string, headers: Record<string, string | string[] | undefined>, now: Date): WebhookVerification;
  getPaymentStatus(ctx: ProviderContext, providerPaymentRef: string): Promise<{ status: ProviderPaymentStatus; amountMinor: number | null; currency: string | null }>;
  refund(ctx: ProviderContext, input: { providerPaymentRef: string; amountMinor: number; refundRef: string }): Promise<{ providerRefundRef: string; status: 'SUBMITTED' | 'COMPLETED' | 'FAILED'; message?: string }>;
  listTransactions(ctx: ProviderContext, from: Date, to: Date): Promise<ProviderTxnRecord[]>;
}

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PAYMENT_PROVIDER_NOT_CONFIGURED';
  constructor(message = 'Ödeme sağlayıcısı yapılandırılmadı (Kurulum bekleniyor).') {
    super(message);
  }
}
