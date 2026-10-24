import { notConfiguredPaymentAdapter } from './payment/not-configured.js';
import { SandboxPaymentAdapter } from './payment/sandbox.js';
import type { PaymentProviderAdapter } from './payment/types.js';
import { notConfiguredUtilityAdapter } from './utility/not-configured.js';
import { SandboxUtilityAdapter } from './utility/sandbox.js';
import type { WaterUtilityAdapter } from './utility/types.js';

/**
 * Adaptör kayıt defteri.
 * Gerçek sağlayıcı/kurum adaptörleri, resmî doküman ve sözleşme geldikten sonra buraya eklenir.
 * Bu sürümde gerçek adaptör YOKTUR; bu nedenle LIVE işlemler sistem tarafından başlatılamaz.
 */
export class AdapterRegistry {
  readonly sandboxPayment = new SandboxPaymentAdapter();
  readonly sandboxUtility = new SandboxUtilityAdapter();
  private readonly payment = new Map<string, PaymentProviderAdapter>();
  private readonly utility = new Map<string, WaterUtilityAdapter>();

  constructor(private readonly allowSimulators: boolean) {
    this.payment.set('NONE', notConfiguredPaymentAdapter);
    this.utility.set('NONE', notConfiguredUtilityAdapter);
    if (allowSimulators) {
      this.payment.set('SANDBOX', this.sandboxPayment);
      this.utility.set('SANDBOX', this.sandboxUtility);
    }
  }

  registerPayment(adapter: PaymentProviderAdapter) {
    if (adapter.isSimulator && !this.allowSimulators) throw new Error('Simülatör adaptörleri üretimde kaydedilemez');
    this.payment.set(adapter.code, adapter);
  }

  registerUtility(adapter: WaterUtilityAdapter) {
    if (adapter.isSimulator && !this.allowSimulators) throw new Error('Simülatör adaptörleri üretimde kaydedilemez');
    this.utility.set(adapter.code, adapter);
  }

  getPayment(code: string | null | undefined): PaymentProviderAdapter {
    return this.payment.get(code ?? 'NONE') ?? notConfiguredPaymentAdapter;
  }

  getUtility(code: string | null | undefined): WaterUtilityAdapter {
    return this.utility.get(code ?? 'NONE') ?? notConfiguredUtilityAdapter;
  }

  availablePaymentAdapters() {
    return [...this.payment.values()].map((a) => ({ code: a.code, isSimulator: a.isSimulator }));
  }

  availableUtilityAdapters() {
    return [...this.utility.values()].map((a) => ({ code: a.code, isSimulator: a.isSimulator }));
  }
}
