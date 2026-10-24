import type { AppConfig } from '../config.js';
import type { DbClient } from '../db.js';
import type { AdapterRegistry } from '../integrations/registry.js';
import type { PaymentProviderAdapter, ProviderContext } from '../integrations/payment/types.js';
import type { UtilityContext, WaterUtilityAdapter } from '../integrations/utility/types.js';
import { unavailable } from '../lib/errors.js';
import type { SecretStore } from './secrets.js';

export type Mode = 'TEST' | 'LIVE';

export interface PaymentRuntime {
  mode: Mode;
  provider: { id: string; code: string; display_name: string; adapter_code: string } | null;
  config: any | null;
  adapter: PaymentProviderAdapter;
  ctx: ProviderContext;
}

export interface UtilityRuntime {
  utility: { id: string; code: string; full_name: string; is_active: boolean };
  integration: any | null;
  adapter: WaterUtilityAdapter;
  ctx: UtilityContext;
}

export interface Readiness {
  ok: boolean;
  mode: Mode;
  reasons: string[];
  isSimulator: boolean;
}

export class IntegrationService {
  constructor(
    private readonly config: AppConfig,
    private readonly registry: AdapterRegistry,
    private readonly secrets: SecretStore,
  ) {}

  async mode(db: DbClient): Promise<{ mode: Mode; activeProviderId: string | null; liveEnabledAt: Date | null }> {
    const { rows } = await db.query('SELECT mode, active_provider_id, live_enabled_at FROM payment_service_state WHERE id');
    return { mode: rows[0].mode, activeProviderId: rows[0].active_provider_id, liveEnabledAt: rows[0].live_enabled_at };
  }

  async paymentRuntime(db: DbClient, forMode?: Mode): Promise<PaymentRuntime> {
    const state = await this.mode(db);
    const mode = forMode ?? state.mode;
    let provider = null;
    let config = null;
    if (state.activeProviderId) {
      provider = (await db.query('SELECT id, code, display_name, adapter_code FROM payment_providers WHERE id = $1', [state.activeProviderId])).rows[0] ?? null;
      config = (await db.query('SELECT * FROM payment_provider_configs WHERE provider_id = $1 AND environment = $2', [state.activeProviderId, mode])).rows[0] ?? null;
    }
    const adapter = this.registry.getPayment(provider?.adapter_code);
    const ctx: ProviderContext = {
      environment: mode,
      apiBaseUrl: config?.api_base_url ?? null,
      merchantId: config?.merchant_id ?? null,
      apiKey: await this.secrets.reveal(db, config?.api_key_secret_ref),
      webhookSecret: await this.secrets.reveal(db, config?.webhook_secret_ref),
      webhookToleranceSeconds: config?.webhook_tolerance_seconds ?? 300,
      callbackBaseUrl: this.config.API_PUBLIC_URL,
    };
    return { mode, provider, config, adapter, ctx };
  }

  /** Belirli bir sağlayıcı için çalışma zamanı (webhook doğrulaması aktif olmayan sağlayıcı için de çalışmalı). */
  async paymentRuntimeForProvider(db: DbClient, providerId: string, mode: Mode): Promise<PaymentRuntime | null> {
    const provider = (await db.query('SELECT id, code, display_name, adapter_code FROM payment_providers WHERE id = $1', [providerId])).rows[0];
    if (!provider) return null;
    const config = (await db.query('SELECT * FROM payment_provider_configs WHERE provider_id = $1 AND environment = $2', [providerId, mode])).rows[0] ?? null;
    return {
      mode,
      provider,
      config,
      adapter: this.registry.getPayment(provider.adapter_code),
      ctx: {
        environment: mode,
        apiBaseUrl: config?.api_base_url ?? null,
        merchantId: config?.merchant_id ?? null,
        apiKey: await this.secrets.reveal(db, config?.api_key_secret_ref),
        webhookSecret: await this.secrets.reveal(db, config?.webhook_secret_ref),
        webhookToleranceSeconds: config?.webhook_tolerance_seconds ?? 300,
        callbackBaseUrl: this.config.API_PUBLIC_URL,
      },
    };
  }

  async utilityRuntime(db: DbClient, utilityId: string, mode: Mode): Promise<UtilityRuntime> {
    const utility = (await db.query('SELECT id, code, full_name, is_active FROM water_utilities WHERE id = $1', [utilityId])).rows[0];
    if (!utility) throw unavailable('Su idaresi bulunamadı.', 'UTILITY_NOT_FOUND');
    const integration = (await db.query('SELECT * FROM utility_integrations WHERE utility_id = $1 AND environment = $2', [utilityId, mode])).rows[0] ?? null;
    const adapter = this.registry.getUtility(integration?.adapter_code);
    return {
      utility,
      integration,
      adapter,
      ctx: {
        environment: mode,
        apiBaseUrl: integration?.api_base_url ?? null,
        integrationCode: integration?.integration_code ?? null,
        credential: await this.secrets.reveal(db, integration?.credential_secret_ref),
        certificate: await this.secrets.reveal(db, integration?.certificate_secret_ref),
      },
    };
  }

  /**
   * İşlem başlatılabilir mi? Eksik her madde açıkça raporlanır. Bir madde bile eksikse işlem başlatılmaz.
   */
  async readiness(db: DbClient, kind: 'TOPUP' | 'BILL_PAYMENT' | 'BILL_QUERY', utilityId: string | null): Promise<Readiness> {
    const reasons: string[] = [];
    const state = await this.mode(db);
    const mode = state.mode;
    const maintenance = (await db.query(`SELECT value FROM system_settings WHERE key = 'maintenance_mode'`)).rows[0]?.value === true;
    if (maintenance) reasons.push('Sistem bakım modunda.');

    let isSimulator = false;
    if (kind !== 'BILL_QUERY') {
      const p = await this.paymentRuntime(db);
      if (!p.provider) reasons.push('Etkin ödeme sağlayıcısı seçilmedi (Kurulum bekleniyor).');
      else {
        if (p.adapter.code === 'NONE') reasons.push('Ödeme sağlayıcısı adaptörü yok — sözleşme ve teknik doküman bekleniyor.');
        if (!p.config) reasons.push(`Ödeme sağlayıcısının ${mode} ortamı yapılandırması yok.`);
        else {
          if (!p.config.api_key_secret_ref || !p.ctx.apiKey) reasons.push('Ödeme sağlayıcısı API anahtarı tanımlı değil.');
          if (!p.config.webhook_secret_ref || !p.ctx.webhookSecret) reasons.push('Webhook imza sırrı tanımlı değil.');
          if (p.config.last_connection_test_ok !== true) reasons.push('Ödeme sağlayıcısı bağlantı testi başarılı değil veya yapılmadı.');
          if (mode === 'LIVE' && !isRecent(p.config.last_connection_test_at, 24)) reasons.push('Canlı ödeme bağlantı testi son 24 saatte yapılmadı.');
        }
        if (p.adapter.isSimulator) {
          isSimulator = true;
          if (mode === 'LIVE') reasons.push('Simülatör adaptörü canlı modda kullanılamaz.');
        }
      }
    }

    if (utilityId) {
      const u = await this.utilityRuntime(db, utilityId, mode);
      if (!u.utility.is_active) reasons.push('Su idaresi platformda etkin değil.');
      if (!u.integration) reasons.push(`Su idaresi entegrasyonunun ${mode} ortamı yapılandırılmadı (Yapılandırma bekleniyor).`);
      else {
        if (u.adapter.code === 'NONE') reasons.push('Su idaresi adaptörü yok — kurum dokümanı ve yetki bekleniyor.');
        if (u.adapter.isSimulator) {
          isSimulator = true;
          if (mode === 'LIVE') reasons.push('Su idaresi simülatörü canlı modda kullanılamaz.');
        }
        const i = u.integration;
        if (kind === 'TOPUP' && !i.supports_card_topup) reasons.push('Su idaresi entegrasyonu kart yüklemeyi desteklemiyor.');
        if (kind !== 'TOPUP' && !i.supports_bill_query) reasons.push('Su idaresi entegrasyonu fatura sorgulamayı desteklemiyor.');
        if (kind === 'BILL_PAYMENT' && !i.supports_bill_payment) reasons.push('Su idaresi entegrasyonu fatura ödemeyi desteklemiyor.');
        if (kind !== 'BILL_QUERY' && !i.supports_status_query) reasons.push('Su idaresi işlem durum sorgulaması desteklenmiyor; belirsiz sonuçlar çözülemez.');
        if (i.last_connection_test_ok !== true) reasons.push('Su idaresi bağlantı testi başarılı değil veya yapılmadı.');
        if (mode === 'LIVE') {
          if (i.agreement_status !== 'SIGNED') reasons.push('Su idaresi ile sözleşme imzalanmamış.');
          if (i.authorization_status !== 'PRODUCTION_ACCESS') reasons.push('Su idaresi üretim erişim yetkisi yok.');
        }
      }
    }

    if (mode === 'LIVE') {
      reasons.push(...(await this.liveBlockers(db)));
    }
    return { ok: reasons.length === 0, mode, reasons: [...new Set(reasons)], isSimulator };
  }

  /** Canlı moda özgü engeller (bölüm 15). */
  async liveBlockers(db: DbClient): Promise<string[]> {
    const reasons: string[] = [];
    if (!this.config.isProduction) reasons.push('Canlı işlemler yalnızca üretim (production) dağıtımında başlatılabilir.');
    const state = await this.mode(db);
    if (!state.liveEnabledAt) reasons.push('Canlı mod yetkili yönetici tarafından etkinleştirilmedi.');
    const open = await db.query(`SELECT title FROM golive_checklist_items WHERE status <> 'VERIFIED' ORDER BY sort_order`);
    for (const r of open.rows) reasons.push(`Yayın öncesi kontrol eksik: ${r.title}`);
    if (state.activeProviderId) {
      const c = await db.query('SELECT live_approval_status FROM payment_provider_contracts WHERE provider_id = $1', [state.activeProviderId]);
      if (c.rows[0]?.live_approval_status !== 'APPROVED') reasons.push('Ödeme kuruluşu canlı kullanım onayı yok.');
    }
    const fee = await db.query(`SELECT bool_or(is_sample) AS sample, count(*) AS n FROM (
        SELECT DISTINCT ON (transaction_type) is_sample FROM fee_schedules WHERE effective_from <= now() ORDER BY transaction_type, effective_from DESC) t`);
    if (Number(fee.rows[0].n) < 2 || fee.rows[0].sample) reasons.push('Ücret tarifeleri sözleşmeye dayalı olarak tanımlanmadı (örnek tarife canlıda kullanılamaz).');
    return reasons;
  }

  async assertReady(db: DbClient, kind: 'TOPUP' | 'BILL_PAYMENT' | 'BILL_QUERY', utilityId: string | null): Promise<Readiness> {
    const r = await this.readiness(db, kind, utilityId);
    if (!r.ok) throw unavailable('İşlem şu anda başlatılamaz. Eksik kurulum maddeleri listelenmiştir.', 'NOT_READY', { mode: r.mode, reasons: r.reasons });
    return r;
  }
}

function isRecent(at: Date | null | undefined, hours: number) {
  return !!at && Date.now() - new Date(at).getTime() < hours * 3600_000;
}
