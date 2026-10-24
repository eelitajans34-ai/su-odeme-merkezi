import { type PaymentProviderAdapter, ProviderNotConfiguredError } from './types.js';

/** Sözleşme ve teknik doküman gelene kadar kullanılan adaptör: hiçbir işlem başlatmaz. */
export const notConfiguredPaymentAdapter: PaymentProviderAdapter = {
  code: 'NONE',
  isSimulator: false,
  supportsRefund: false,
  supportsStatusQuery: false,
  supportsTransactionList: false,
  async testConnection() {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Ödeme sağlayıcısı adaptörü tanımlı değil. Kurulum bekleniyor.' };
  },
  async createPayment() {
    throw new ProviderNotConfiguredError();
  },
  verifyWebhook() {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  },
  async getPaymentStatus() {
    throw new ProviderNotConfiguredError();
  },
  async refund() {
    throw new ProviderNotConfiguredError();
  },
  async listTransactions() {
    throw new ProviderNotConfiguredError();
  },
};
