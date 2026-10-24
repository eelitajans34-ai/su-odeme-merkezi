import { randomUUID } from 'node:crypto';
import type { Bill, StatusOutcome, SubmitOutcome, UtilityContext, UtilityTxnRecord, WaterUtilityAdapter } from './types.js';

/**
 * UYGULAMA İÇİ SU İDARESİ SİMÜLATÖRÜ — GERÇEK YÜKLEME VEYA TAHSİLAT OLUŞTURMAZ.
 * Yalnızca geliştirme/test ortamında kullanılabilir. Abone numaraları "TEST-" ile başlamalıdır;
 * böylece gerçek abone numaraları simülatöre yanlışlıkla gönderilmez.
 *
 * Senaryolar (abone numarasının son hanesine göre):
 *   ...9 → abone bulunamadı
 *   ...8 → yükleme/tahsilat REDDEDİLİR (iade süreci)
 *   ...7 → emir zaman aşımına uğrar (sonuç BELİRSİZ); durum sorgusu PENDING döner
 *   ...6 → emir kabul edilir ama onay bekler (ACCEPTED_PENDING); 2. sorguda onaylanır
 *   ...0 → borç yok
 *   diğer → başarılı
 */
export class SandboxUtilityAdapter implements WaterUtilityAdapter {
  readonly code = 'SANDBOX';
  readonly isSimulator = true;
  readonly submissions = new Map<string, { record: UtilityTxnRecord; count: number; checks: number; scenario: string }>();

  private scenario(subscriberNo: string) {
    return subscriberNo.slice(-1);
  }

  private guard(subscriberNo: string) {
    if (!subscriberNo.startsWith('TEST-')) throw new Error('Simülatör yalnızca TEST- ile başlayan abone numaralarını kabul eder.');
  }

  async testConnection(_ctx: UtilityContext) {
    return { ok: true, code: 'SIMULATOR_OK', message: 'Simülatör erişilebilir (TEST — gerçek su idaresi değildir).' };
  }

  parseQr(payload: string) {
    // Simülatöre özgü QR biçimi: SUTEST:<kurumKodu>:<aboneNo>
    const m = /^SUTEST:([A-Z0-9_-]{2,20}):(TEST-[0-9]{3,12})$/.exec(payload.trim());
    return m ? { utilityCode: m[1]!, subscriberNo: m[2]! } : null;
  }

  async queryAccount(_ctx: UtilityContext, subscriberNo: string) {
    this.guard(subscriberNo);
    if (this.scenario(subscriberNo) === '9') return { found: false };
    return {
      found: true,
      holderNameMasked: 'T*** K***',
      cards: [{ cardSerial: `${subscriberNo.replace('TEST-', 'C')}01`, topupMethod: 'REMOTE_CREDIT' as const }],
    };
  }

  private submit(type: 'TOPUP' | 'BILL_PAYMENT', input: { utilityRequestId: string; subscriberNo: string; amountMinor: number }): SubmitOutcome {
    this.guard(input.subscriberNo);
    const existing = this.submissions.get(input.utilityRequestId);
    if (existing) {
      // İdempotent: aynı istek no ile ikinci emir yeni işlem oluşturmaz
      existing.count += 1;
      return existing.record.status === 'CONFIRMED'
        ? { kind: 'CONFIRMED', utilityRef: existing.record.utilityRef! }
        : existing.record.status === 'REJECTED'
          ? { kind: 'REJECTED', code: 'SIM_REJECTED', message: 'Simülatör reddi' }
          : { kind: 'ACCEPTED_PENDING', utilityRef: existing.record.utilityRef };
    }
    const sc = this.scenario(input.subscriberNo);
    const record: UtilityTxnRecord = { utilityRequestId: input.utilityRequestId, utilityRef: null, type, amountMinor: input.amountMinor, status: 'PENDING' };
    this.submissions.set(input.utilityRequestId, { record, count: 1, checks: 0, scenario: sc });
    if (sc === '8') {
      record.status = 'REJECTED';
      return { kind: 'REJECTED', code: 'SIM_REJECTED', message: 'Simülatör: işlem kurum tarafından reddedildi' };
    }
    if (sc === '7') return { kind: 'AMBIGUOUS', message: 'Simülatör: zaman aşımı (sonuç bilinmiyor)' };
    record.utilityRef = `SIMU-${randomUUID().slice(0, 8)}`;
    if (sc === '6') return { kind: 'ACCEPTED_PENDING', utilityRef: record.utilityRef };
    record.status = 'CONFIRMED';
    return { kind: 'CONFIRMED', utilityRef: record.utilityRef };
  }

  private status(utilityRequestId: string): StatusOutcome {
    const s = this.submissions.get(utilityRequestId);
    if (!s) return { kind: 'NOT_FOUND' };
    s.checks += 1;
    if (s.scenario === '6' && s.checks >= 2 && s.record.status === 'PENDING') s.record.status = 'CONFIRMED';
    if (s.record.status === 'CONFIRMED') return { kind: 'CONFIRMED', utilityRef: s.record.utilityRef!, amountMinor: s.record.amountMinor };
    if (s.record.status === 'REJECTED') return { kind: 'REJECTED', code: 'SIM_REJECTED', message: 'Simülatör reddi' };
    return { kind: 'PENDING' };
  }

  async submitTopup(_ctx: UtilityContext, input: { utilityRequestId: string; subscriberNo: string; cardSerial: string; amountMinor: number }) {
    return this.submit('TOPUP', input);
  }

  async getTopupStatus(_ctx: UtilityContext, id: string) {
    return this.status(id);
  }

  async queryBills(_ctx: UtilityContext, subscriberNo: string): Promise<{ bills: Bill[] }> {
    this.guard(subscriberNo);
    if (this.scenario(subscriberNo) === '0') return { bills: [] };
    return {
      bills: [
        { billId: `${subscriberNo}-2026-09`, period: '2026-09', amountMinor: 18_450, dueDate: '2026-10-15' },
        { billId: `${subscriberNo}-2026-10`, period: '2026-10', amountMinor: 21_075, dueDate: '2026-11-15' },
      ],
    };
  }

  async submitBillPayment(_ctx: UtilityContext, input: { utilityRequestId: string; subscriberNo: string; billIds: string[]; amountMinor: number }) {
    return this.submit('BILL_PAYMENT', input);
  }

  async getCollectionStatus(_ctx: UtilityContext, id: string) {
    return this.status(id);
  }

  async listTransactions(): Promise<UtilityTxnRecord[]> {
    return [...this.submissions.values()].map((s) => ({ ...s.record }));
  }
}
