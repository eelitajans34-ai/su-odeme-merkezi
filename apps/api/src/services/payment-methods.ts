import type { Deps } from '../context.js';
import type { DbClient } from '../db.js';
import { AppError } from '../lib/errors.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../integrations/payment/types.js';

export type ClientType = 'WEB' | 'MOBILE';
export type MethodStatus = 'AVAILABLE' | 'SETUP_PENDING' | 'DISABLED' | 'MOBILE_ONLY' | 'SERVICE_UNAVAILABLE';

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  HOSTED_CARD: 'Kart ile öde',
  QR: 'QR ile öde',
  NFC: 'Temassız (NFC) ile öde',
};

const METHOD_HELP: Record<PaymentMethod, string> = {
  HOSTED_CARD: 'Ödeme kuruluşunun güvenli sayfasında kart bilgilerinizi girersiniz; kart bilgileri bu platforma gelmez.',
  QR: 'Ekranda gösterilen karekodu banka veya cüzdan uygulamanızla okutup ödemeyi orada onaylarsınız.',
  NFC: 'Temassız kartınızı telefonunuzun arkasına yaklaştırırsınız. Kart okuma ödeme kuruluşunun uygulama içi bileşeniyle yapılır.',
};

export interface MethodOption {
  method: PaymentMethod;
  label: string;
  help: string;
  status: MethodStatus;
  statusLabel: string;
  isSimulator: boolean;
}

/**
 * Kullanıcıya sunulacak ödeme yöntemleri ve gerçek durumları.
 * Bir yöntem yalnızca adaptör destekliyorsa VE yönetici etkinleştirdiyse kullanılabilir. NFC tarayıcıda kullanılamaz.
 */
export async function paymentMethodOptions(deps: Deps, db: DbClient, kind: 'TOPUP' | 'BILL_PAYMENT', utilityId: string | null, clientType: ClientType): Promise<MethodOption[]> {
  const readiness = await deps.integrations.readiness(db, kind, utilityId);
  const rt = await deps.integrations.paymentRuntime(db);
  const enabled: string[] = rt.config?.enabled_payment_methods ?? [];
  return PAYMENT_METHODS.map((method) => {
    let status: MethodStatus = 'AVAILABLE';
    let statusLabel = rt.adapter.isSimulator ? 'Test modu (simülatör)' : rt.mode === 'LIVE' ? 'Kullanılabilir' : 'Test modu';
    if (!rt.adapter.supportedMethods.includes(method)) {
      status = 'SETUP_PENDING';
      statusLabel = rt.adapter.code === 'NONE'
        ? 'Kurulum bekleniyor — ödeme kuruluşu sözleşmesi ve entegrasyonu yok'
        : 'Kurulum bekleniyor — ödeme kuruluşunun bu yöntem için entegrasyonu yapılmadı';
    } else if (!enabled.includes(method)) {
      status = 'DISABLED';
      statusLabel = 'Yönetici tarafından etkinleştirilmedi';
    } else if (method === 'NFC' && clientType !== 'MOBILE') {
      status = 'MOBILE_ONLY';
      statusLabel = 'Yalnızca mobil uygulamada (tarayıcılar temassız kart okuyamaz)';
    } else if (!readiness.ok) {
      status = 'SERVICE_UNAVAILABLE';
      statusLabel = 'Şu anda kullanılamıyor';
    }
    return { method, label: METHOD_LABEL[method], help: METHOD_HELP[method], status, statusLabel, isSimulator: rt.adapter.isSimulator };
  });
}

export async function assertMethodAvailable(deps: Deps, db: DbClient, kind: 'TOPUP' | 'BILL_PAYMENT', utilityId: string, method: PaymentMethod, clientType: ClientType) {
  const opt = (await paymentMethodOptions(deps, db, kind, utilityId, clientType)).find((o) => o.method === method)!;
  if (opt.status !== 'AVAILABLE') throw new AppError(409, 'PAYMENT_METHOD_UNAVAILABLE', `${opt.label}: ${opt.statusLabel}.`, { method, status: opt.status });
}
