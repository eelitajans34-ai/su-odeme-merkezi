import type { Actor, Deps } from '../context.js';
import { badRequest } from '../lib/errors.js';
import type { ProviderTxnRecord } from '../integrations/payment/types.js';
import type { UtilityTxnRecord } from '../integrations/utility/types.js';
import { audit } from './audit.js';

interface Item {
  issue_type: string;
  source_type?: 'TOPUP' | 'BILL_PAYMENT' | null;
  source_id?: string | null;
  local_amount_minor?: number | null;
  provider_amount_minor?: number | null;
  utility_amount_minor?: number | null;
  local_status?: string | null;
  provider_status?: string | null;
  utility_status?: string | null;
  provider_ref?: string | null;
  utility_ref?: string | null;
}

/**
 * Mutabakat: yerel kayıtlar ↔ ödeme sağlayıcısı listesi ↔ su idaresi listesi.
 * Dış kaynak yapılandırılmadıysa bu açıkça kaydedilir ("SKIPPED_NOT_CONFIGURED"); iç kontroller yine çalışır.
 */
export async function runReconciliation(deps: Deps, actor: Actor, from: Date, to: Date) {
  if (!(to > from)) throw badRequest('Bitiş tarihi başlangıçtan sonra olmalı.');
  const db = deps.db;
  const { mode } = await deps.integrations.mode(db);
  const items: Item[] = [];
  const notes: string[] = [];

  const local = (
    await db.query(
      `SELECT 'TOPUP' AS type, t.id, t.status, t.total_minor, t.amount_minor, t.utility_request_id, t.utility_ref, t.user_id, t.water_card_id AS target, p.provider_payment_ref, p.status AS pay_status, p.amount_minor AS pay_amount, p.provider_id,
              (SELECT 1 FROM receipts r WHERE r.source_type='TOPUP' AND r.source_id=t.id) AS has_receipt, t.completed_at
         FROM topup_transactions t LEFT JOIN payment_transactions p ON p.id = t.payment_transaction_id
        WHERE t.environment = $1 AND t.created_at >= $2 AND t.created_at < $3
       UNION ALL
       SELECT 'BILL_PAYMENT', t.id, t.status, t.total_minor, t.amount_minor, t.utility_request_id, t.utility_ref, t.user_id, t.subscription_id, p.provider_payment_ref, p.status, p.amount_minor, p.provider_id,
              (SELECT 1 FROM receipts r WHERE r.source_type='BILL_PAYMENT' AND r.source_id=t.id), t.completed_at
         FROM bill_payment_transactions t LEFT JOIN payment_transactions p ON p.id = t.payment_transaction_id
        WHERE t.environment = $1 AND t.created_at >= $2 AND t.created_at < $3`,
      [mode, from, to],
    )
  ).rows;

  // Ödeme sağlayıcısı listesi
  let providerList: ProviderTxnRecord[] | null = null;
  const pr = await deps.integrations.paymentRuntime(db);
  if (pr.provider && pr.adapter.supportsTransactionList) {
    try {
      providerList = await pr.adapter.listTransactions(pr.ctx, from, to);
    } catch (e) {
      notes.push('Ödeme sağlayıcısı işlem listesi alınamadı.');
    }
  } else notes.push('Ödeme sağlayıcısı işlem listesi: yapılandırılmadı.');

  // Su idaresi listeleri
  let utilityList: UtilityTxnRecord[] | null = null;
  const utilities = (await db.query('SELECT DISTINCT utility_id FROM utility_integrations WHERE environment = $1', [mode])).rows;
  for (const u of utilities) {
    const rt = await deps.integrations.utilityRuntime(db, u.utility_id, mode);
    if (rt.adapter.listTransactions && rt.integration?.supports_reconciliation) {
      try {
        utilityList = [...(utilityList ?? []), ...(await rt.adapter.listTransactions(rt.ctx, from, to))];
      } catch {
        notes.push(`${rt.utility.full_name}: işlem listesi alınamadı.`);
      }
    }
  }
  if (!utilityList) notes.push('Su idaresi işlem listesi: yapılandırılmadı veya mutabakat desteklenmiyor.');

  const providerByRef = new Map((providerList ?? []).map((p) => [p.providerPaymentRef, p]));
  const utilityById = new Map((utilityList ?? []).map((u) => [u.utilityRequestId, u]));
  const seenProvider = new Set<string>();
  let matched = 0;

  for (const l of local) {
    let ok = true;
    if (providerList && l.provider_payment_ref) {
      seenProvider.add(l.provider_payment_ref);
      const p = providerByRef.get(l.provider_payment_ref);
      if (!p) {
        if (l.pay_status === 'SUCCEEDED') { items.push({ issue_type: 'MISSING_AT_PROVIDER', source_type: l.type, source_id: l.id, local_amount_minor: l.pay_amount, local_status: l.pay_status, provider_ref: l.provider_payment_ref }); ok = false; }
      } else {
        if (p.amountMinor !== Number(l.pay_amount)) { items.push({ issue_type: 'AMOUNT_MISMATCH', source_type: l.type, source_id: l.id, local_amount_minor: l.pay_amount, provider_amount_minor: p.amountMinor, provider_ref: p.providerPaymentRef }); ok = false; }
        const localPaid = ['SUCCEEDED', 'REFUNDED'].includes(l.pay_status);
        const provPaid = ['SUCCEEDED', 'REFUNDED'].includes(p.status);
        if (localPaid !== provPaid || (l.pay_status === 'REFUNDED') !== (p.status === 'REFUNDED')) {
          items.push({ issue_type: 'STATUS_MISMATCH', source_type: l.type, source_id: l.id, local_status: l.pay_status, provider_status: p.status, provider_ref: p.providerPaymentRef }); ok = false;
        }
      }
    }
    if (utilityList) {
      const u = utilityById.get(l.utility_request_id);
      if (l.status === 'COMPLETED' && (!u || u.status !== 'CONFIRMED')) {
        items.push({ issue_type: u ? 'STATUS_MISMATCH' : 'MISSING_AT_UTILITY', source_type: l.type, source_id: l.id, local_status: l.status, utility_status: u?.status ?? null, utility_ref: l.utility_ref }); ok = false;
      } else if (u && u.status === 'CONFIRMED' && l.status !== 'COMPLETED') {
        items.push({ issue_type: 'STATUS_MISMATCH', source_type: l.type, source_id: l.id, local_status: l.status, utility_status: u.status, utility_ref: u.utilityRef }); ok = false;
      } else if (u && u.amountMinor !== Number(l.amount_minor)) {
        items.push({ issue_type: 'AMOUNT_MISMATCH', source_type: l.type, source_id: l.id, local_amount_minor: l.amount_minor, utility_amount_minor: u.amountMinor, utility_ref: u.utilityRef }); ok = false;
      }
    }
    if (l.status === 'COMPLETED' && !l.has_receipt) { items.push({ issue_type: 'MISSING_RECEIPT', source_type: l.type, source_id: l.id, local_status: l.status }); ok = false; }
    if (ok) matched++;
  }
  for (const p of providerList ?? []) {
    if (!seenProvider.has(p.providerPaymentRef) && p.status === 'SUCCEEDED') {
      const known = await db.query('SELECT 1 FROM payment_transactions WHERE provider_payment_ref = $1', [p.providerPaymentRef]);
      if (!known.rows[0]) items.push({ issue_type: 'MISSING_LOCALLY', provider_amount_minor: p.amountMinor, provider_status: p.status, provider_ref: p.providerPaymentRef });
    }
  }
  // Mükerrer işlem şüphesi: aynı kullanıcı + hedef + tutar, 10 dakika içinde birden fazla tamamlanmış işlem
  const groups = new Map<string, any[]>();
  for (const l of local.filter((x) => x.status === 'COMPLETED')) {
    const k = `${l.type}|${l.user_id}|${l.target}|${l.amount_minor}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => new Date(a.completed_at).getTime() - new Date(b.completed_at).getTime());
    for (let i = 1; i < g.length; i++) {
      if (new Date(g[i].completed_at).getTime() - new Date(g[i - 1].completed_at).getTime() < 10 * 60_000) {
        items.push({ issue_type: 'DUPLICATE_SUSPECT', source_type: g[i].type, source_id: g[i].id, local_amount_minor: g[i].amount_minor, local_status: g[i].status });
      }
    }
  }

  const status = !providerList && !utilityList ? 'SKIPPED_NOT_CONFIGURED' : items.length ? 'COMPLETED_WITH_ISSUES' : 'COMPLETED';
  const run = (
    await db.query(
      `INSERT INTO reconciliation_runs (period_start, period_end, environment, status, provider_source, utility_source, matched_count, issue_count, notes, started_by, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING *`,
      [from, to, mode, status, providerList ? 'PROVIDER_API' : 'NOT_CONFIGURED', utilityList ? 'UTILITY_API' : 'NOT_CONFIGURED', matched, items.length, notes.join(' '), actor.userId],
    )
  ).rows[0];
  for (const it of items) {
    await db.query(
      `INSERT INTO reconciliation_items (run_id, issue_type, source_type, source_id, local_amount_minor, provider_amount_minor, utility_amount_minor, local_status, provider_status, utility_status, provider_ref, utility_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [run.id, it.issue_type, it.source_type ?? null, it.source_id ?? null, it.local_amount_minor ?? null, it.provider_amount_minor ?? null, it.utility_amount_minor ?? null, it.local_status ?? null, it.provider_status ?? null, it.utility_status ?? null, it.provider_ref ?? null, it.utility_ref ?? null],
    );
  }
  await audit(db, { actorUserId: actor.userId, actorType: 'ADMIN', action: 'reconciliation.run', targetType: 'reconciliation_run', targetId: run.id, ip: actor.ip, details: { from, to, status, issues: items.length } });
  if (items.length) {
    await deps.notifications.alertAdmins({ eventType: 'RECONCILIATION_MISMATCH', severity: items.some((i) => i.issue_type === 'DUPLICATE_SUSPECT') ? 'CRITICAL' : 'WARNING', title: 'Mutabakat uyuşmazlığı', body: `${items.length} kayıt manuel inceleme kuyruğunda.`, data: { runId: run.id } });
  }
  return run;
}

export function itemsToCsv(rows: any[]): string {
  const cols = ['issue_type', 'source_type', 'source_id', 'local_amount_minor', 'provider_amount_minor', 'utility_amount_minor', 'local_status', 'provider_status', 'utility_status', 'provider_ref', 'utility_ref', 'review_status', 'review_note'];
  const esc = (v: unknown) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV/formül enjeksiyonu önlemi
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
