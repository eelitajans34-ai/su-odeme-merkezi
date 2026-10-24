import { randomUUID } from 'node:crypto';
import { hmacSha256Hex, safeEqualHex } from '../../lib/crypto.js';
import type { PaymentProviderAdapter, ProviderContext, ProviderPaymentStatus, ProviderTxnRecord, WebhookVerification } from './types.js';

/**
 * UYGULAMA İÇİ ÖDEME SİMÜLATÖRÜ — GERÇEK PARA HAREKETİ OLUŞTURMAZ.
 * Yalnızca geliştirme/test ortamında, TEST modunda kullanılabilir (üretimde kayıt defteri reddeder).
 * Webhook imzası: header `x-sandbox-signature: t=<unix>,v1=<hex(HMAC_SHA256(secret, t + "." + body))>`
 * Bu imza şeması simülatöre özgüdür; gerçek sağlayıcının şeması onun dokümanından alınmalıdır.
 */
interface SimPayment extends ProviderTxnRecord {}

export class SandboxPaymentAdapter implements PaymentProviderAdapter {
  readonly code = 'SANDBOX';
  readonly isSimulator = true;
  readonly supportsRefund = true;
  readonly supportsStatusQuery = true;
  readonly supportsTransactionList = true;
  /** Simülatör durumu bellek içidir; süreç yeniden başlarsa durum sorgusu UNKNOWN döner. */
  readonly payments = new Map<string, SimPayment>();
  readonly refunds = new Map<string, { providerPaymentRef: string; amountMinor: number; status: 'SUBMITTED' | 'COMPLETED' }>();

  async testConnection(ctx: ProviderContext) {
    if (!ctx.webhookSecret) return { ok: false, code: 'WEBHOOK_SECRET_MISSING', message: 'Webhook imza sırrı tanımlı değil.' };
    if (!ctx.apiKey) return { ok: false, code: 'API_KEY_MISSING', message: 'API anahtarı referansı tanımlı değil.' };
    return { ok: true, code: 'SIMULATOR_OK', message: 'Simülatör erişilebilir (TEST — gerçek sağlayıcı değildir).' };
  }

  async createPayment(ctx: ProviderContext, input: { orderRef: string; amountMinor: number; currency: string }) {
    const providerPaymentRef = `SIM-${randomUUID()}`;
    this.payments.set(providerPaymentRef, {
      providerPaymentRef,
      orderRef: input.orderRef,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'PENDING',
    });
    return { providerPaymentRef, checkoutUrl: `${ctx.callbackBaseUrl}/api/sandbox/checkout/${encodeURIComponent(providerPaymentRef)}` };
  }

  /** Simülatör ödeme sayfasındaki karar; imzalı webhook gövdesini döndürür. */
  simulateOutcome(ctx: ProviderContext, providerPaymentRef: string, outcome: 'SUCCEEDED' | 'FAILED', nowMs = Date.now()) {
    const p = this.payments.get(providerPaymentRef);
    if (!p) throw new Error('Simülatör ödemesi bulunamadı');
    if (p.status === 'PENDING') p.status = outcome;
    return this.signedEvent(ctx, {
      id: `evt_${randomUUID()}`,
      type: outcome === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed',
      created: Math.floor(nowMs / 1000),
      data: { providerPaymentRef, orderRef: p.orderRef, amountMinor: p.amountMinor, currency: p.currency, failureCode: outcome === 'FAILED' ? 'SIM_DECLINED' : null },
    }, nowMs);
  }

  signedEvent(ctx: ProviderContext, event: Record<string, unknown>, nowMs = Date.now()) {
    if (!ctx.webhookSecret) throw new Error('Webhook sırrı tanımlı değil');
    const body = JSON.stringify(event);
    const t = Math.floor(nowMs / 1000);
    const sig = hmacSha256Hex(ctx.webhookSecret, `${t}.${body}`);
    return { body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': `t=${t},v1=${sig}` } };
  }

  verifyWebhook(ctx: ProviderContext, rawBody: string, headers: Record<string, string | string[] | undefined>, now: Date): WebhookVerification {
    if (!ctx.webhookSecret) return { ok: false, reason: 'NOT_CONFIGURED' };
    const header = headers['x-sandbox-signature'];
    if (typeof header !== 'string' || !header) return { ok: false, reason: 'MISSING_SIGNATURE' };
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) return { ok: false, reason: 'MALFORMED' };
    const expected = hmacSha256Hex(ctx.webhookSecret, `${t}.${rawBody}`);
    if (!safeEqualHex(expected, parts.v1)) return { ok: false, reason: 'INVALID_SIGNATURE' };
    if (Math.abs(now.getTime() / 1000 - t) > ctx.webhookToleranceSeconds) return { ok: false, reason: 'STALE_TIMESTAMP' };
    let json: any;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: 'MALFORMED' };
    }
    if (typeof json?.id !== 'string' || typeof json?.type !== 'string') return { ok: false, reason: 'MALFORMED' };
    const d = json.data ?? {};
    const known = ['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed'];
    return {
      ok: true,
      event: {
        eventId: json.id,
        type: known.includes(json.type) ? json.type : 'other',
        occurredAt: new Date((json.created ?? t) * 1000),
        orderRef: d.orderRef ?? null,
        providerPaymentRef: d.providerPaymentRef ?? null,
        providerRefundRef: d.providerRefundRef ?? null,
        amountMinor: typeof d.amountMinor === 'number' ? d.amountMinor : null,
        currency: d.currency ?? null,
        failureCode: d.failureCode ?? null,
        sanitizedPayload: { id: json.id, type: json.type, providerPaymentRef: d.providerPaymentRef, orderRef: d.orderRef, amountMinor: d.amountMinor, currency: d.currency },
      },
    };
  }

  async getPaymentStatus(_ctx: ProviderContext, providerPaymentRef: string): Promise<{ status: ProviderPaymentStatus; amountMinor: number | null; currency: string | null }> {
    const p = this.payments.get(providerPaymentRef);
    if (!p) return { status: 'UNKNOWN', amountMinor: null, currency: null };
    return { status: p.status, amountMinor: p.amountMinor, currency: p.currency };
  }

  async refund(_ctx: ProviderContext, input: { providerPaymentRef: string; amountMinor: number; refundRef: string }) {
    const p = this.payments.get(input.providerPaymentRef);
    if (!p || p.status !== 'SUCCEEDED') return { providerRefundRef: '', status: 'FAILED' as const, message: 'İade edilebilir ödeme bulunamadı' };
    const providerRefundRef = `SIMR-${randomUUID()}`;
    this.refunds.set(providerRefundRef, { providerPaymentRef: input.providerPaymentRef, amountMinor: input.amountMinor, status: 'SUBMITTED' });
    return { providerRefundRef, status: 'SUBMITTED' as const };
  }

  /** Simülatörde iadenin tamamlandığını bildiren imzalı webhook üretir. */
  simulateRefundCompleted(ctx: ProviderContext, providerRefundRef: string, nowMs = Date.now()) {
    const r = this.refunds.get(providerRefundRef);
    if (!r) throw new Error('Simülatör iadesi bulunamadı');
    r.status = 'COMPLETED';
    const p = this.payments.get(r.providerPaymentRef)!;
    p.status = 'REFUNDED';
    return this.signedEvent(ctx, {
      id: `evt_${randomUUID()}`,
      type: 'refund.succeeded',
      created: Math.floor(nowMs / 1000),
      data: { providerPaymentRef: r.providerPaymentRef, providerRefundRef, orderRef: p.orderRef, amountMinor: r.amountMinor, currency: p.currency },
    }, nowMs);
  }

  async listTransactions(): Promise<ProviderTxnRecord[]> {
    return [...this.payments.values()].map((p) => ({ ...p }));
  }
}
