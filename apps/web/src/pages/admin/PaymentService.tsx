import { useState } from 'react';
import { api, dt, tl } from '../../api';
import { Loading, Msg, StatusBadge, TestBadge, useAction, useLoad } from '../../components/ui';
import { AdminError, ModeBadge, SecretMeta } from './common';

const TABS = [
  ['A', 'Genel Bakış'], ['B', 'Sağlayıcı Yapılandırması'], ['C', 'Sözleşme Bilgileri'], ['D', 'Komisyon ve Ücretler'],
  ['E', 'İşlem Takibi'], ['F', 'İade ve İnceleme'], ['G', 'Mutabakat'], ['H', 'Güvenli Bağlantı'],
] as const;

export function PaymentService() {
  const [tab, setTab] = useState<string>('A');
  const o = useLoad<any>('/api/admin/payment-service/overview');
  return (
    <>
      <h1>Güvenli Ödeme Hizmeti {o.data && <ModeBadge mode={o.data.mode} />}</h1>
      {o.data && <div className={`alert ${o.data.mode === 'LIVE' ? 'err' : 'warn'}`}><strong>{o.data.modeBanner}</strong></div>}
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{k}. {label}</button>)}
      </div>
      {tab === 'A' && <Overview o={o} />}
      {tab === 'B' && <Providers />}
      {tab === 'C' && <Contract />}
      {tab === 'D' && <Fees />}
      {tab === 'E' && <Transactions />}
      {tab === 'F' && <Refunds />}
      {tab === 'G' && <Reconciliation />}
      {tab === 'H' && <Connection />}
    </>
  );
}

function Overview({ o }: { o: ReturnType<typeof useLoad<any>> }) {
  const d = o.data;
  return (
    <Loading loading={o.loading}>
      <AdminError error={o.error} onVerified={o.reload} />
      {d && (
        <>
          <div className="grid">
            <div className="card"><div className="muted">Yapılandırma</div><strong>{d.configurationStatus}</strong><div className="muted">{d.provider ? `${d.provider.name} (${d.provider.adapter}${d.provider.isSimulator ? ' — simülatör' : ''})` : 'Sağlayıcı seçilmedi'}</div></div>
            <div className="card"><div className="muted">Bekleyen tahsilat</div><strong>{d.counts.pending_payments}</strong></div>
            <div className="card"><div className="muted">İade bekleyen</div><strong>{d.counts.pending_refunds}</strong></div>
            <div className="card"><div className="muted">Son geçerli webhook</div><strong>{dt(d.counts.last_valid_webhook)}</strong><div className="muted">Reddedilen (24 sa): {d.counts.rejected_webhooks_24h}</div></div>
            <div className="card"><div className="muted">Son başarılı mutabakat</div><strong>{dt(d.counts.last_reconciliation)}</strong></div>
          </div>
          {!d.readiness.ok && <div className="alert warn"><strong>İşlem başlatmayı engelleyen eksikler:</strong><ul>{d.readiness.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
          <h2>Son ödeme işlemleri</h2>
          <div className="card table-wrap"><table><thead><tr><th>Ref</th><th>Tür</th><th>Tutar</th><th>Durum</th><th>Zaman</th></tr></thead><tbody>
            {d.recentPayments.map((p: any) => <tr key={p.public_ref}><td>{p.public_ref} <TestBadge show={p.environment === 'TEST'} /></td><td>{p.purpose}</td><td>{tl(p.amount_minor)}</td><td>{p.status}</td><td>{dt(p.created_at)}</td></tr>)}
          </tbody></table></div>
          <h2>Entegrasyon hataları ve uyarılar</h2>
          {d.alerts.map((a: any) => <div key={a.id} className={`alert ${a.severity === 'CRITICAL' ? 'err' : 'warn'}`}>{a.title} — {a.body}</div>)}
        </>
      )}
    </Loading>
  );
}

function Providers() {
  const p = useLoad<any>('/api/admin/payment-service/providers');
  const a = useAction();
  const [newP, setNewP] = useState({ code: '', displayName: '', adapterCode: 'NONE' });
  const [secret, setSecret] = useState<{ provider: string; kind: string; environment: string; value: string; externalRef: string; expiresAt: string } | null>(null);
  const [edit, setEdit] = useState<{ id: string; env: string; f: any } | null>(null);
  const blank = { apiBaseUrl: '', merchantId: '', webhookToleranceSeconds: 300, currency: 'TRY', minAmountMinor: 100, maxAmountMinor: 500000, dailyUserLimitMinor: 1000000, allowedIps: '', supportsRefund: false };
  return (
    <>
      <AdminError error={a.error ?? p.error} onVerified={p.reload} /><Msg message={a.message} />
      <Loading loading={p.loading}>
        {p.data?.providers.length === 0 && <p>Henüz ödeme sağlayıcısı tanımlanmadı. <strong>Kurulum bekleniyor.</strong></p>}
        {p.data?.providers.map((x: any) => (
          <div className="card" key={x.id}>
            <div className="row"><h2 style={{ margin: 0, flex: 1 }}>{x.displayName}</h2>{x.isActive ? <span className="badge ok">Etkin sağlayıcı</span> : <button className="secondary" onClick={async () => { await a.run(() => api(`/api/admin/payment-service/providers/${x.id}/activate`, { method: 'POST' }), 'Etkin sağlayıcı değişti.'); p.reload(); }}>Etkinleştir</button>}</div>
            <p className="muted">Kod: {x.code} · Adaptör: {x.adapterCode}{x.adapterCode === 'NONE' && ' (Yetkilendirme bekleniyor — sağlayıcı dokümanı olmadan entegrasyon kodu yazılmaz)'}</p>
            {(['TEST', 'LIVE'] as const).map((env) => {
              const c = x[env.toLowerCase()];
              return (
                <div key={env} className="card" style={{ borderColor: env === 'LIVE' ? 'var(--err)' : undefined }}>
                  <h3 style={{ marginTop: 0 }}><ModeBadge mode={env} /> ortamı</h3>
                  {!c ? <p className="muted">Yapılandırılmadı.</p> : (
                    <dl className="kv">
                      <dt>API temel adresi</dt><dd>{c.apiBaseUrl ?? '—'}</dd>
                      <dt>İş yeri no</dt><dd>{c.merchantId ?? '—'}</dd>
                      <dt>API anahtarı</dt><dd><SecretMeta m={c.apiKey} /></dd>
                      <dt>Webhook imza sırrı</dt><dd><SecretMeta m={c.webhookSecret} /></dd>
                      <dt>Webhook URL</dt><dd><code>{c.webhookUrl}</code></dd>
                      <dt>İmza doğrulama</dt><dd>{c.webhookSignatureRequired ? `Zorunlu (±${c.webhookToleranceSeconds} sn)` : 'Kapalı'}</dd>
                      <dt>Para birimi</dt><dd>{c.currency}</dd>
                      <dt>İşlem limitleri</dt><dd>{tl(c.minAmountMinor)} – {tl(c.maxAmountMinor)}; günlük {tl(c.dailyUserLimitMinor)}</dd>
                      <dt>İade API</dt><dd>{c.supportsRefund ? 'Destekleniyor' : 'Yok'}</dd>
                      <dt>Bağlantı testi</dt><dd>{c.lastConnectionTestOk == null ? 'Yapılmadı' : c.lastConnectionTestOk ? `Başarılı (${dt(c.lastConnectionTestAt)})` : `Başarısız: ${c.lastConnectionError}`}</dd>
                      <dt>Son değişiklik</dt><dd>{dt(c.updatedAt)} {c.updatedBy && `· ${c.updatedBy}`}</dd>
                    </dl>
                  )}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="secondary" onClick={() => setEdit({ id: x.id, env, f: c ? { ...blank, ...c, allowedIps: (c.allowedIps ?? []).join(', ') } : blank })}>Düzenle</button>
                    <button className="secondary" onClick={() => setSecret({ provider: x.id, kind: 'API_KEY', environment: env, value: '', externalRef: '', expiresAt: '' })}>Anahtar gir / döndür</button>
                    <button className="secondary" onClick={async () => { const r = await a.run(() => api(`/api/admin/payment-service/providers/${x.id}/test/${env}`, { method: 'POST' })); if (r) a.setError(r.ok ? null : { message: `Bağlantı testi başarısız: ${r.message}` }); p.reload(); }}>Bağlantı testi</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </Loading>
      {edit && (
        <div className="card">
          <h2>{edit.env} yapılandırması</h2>
          <form onSubmit={async (e) => { e.preventDefault(); const f = edit.f; const body = { apiBaseUrl: f.apiBaseUrl || null, merchantId: f.merchantId || null, webhookToleranceSeconds: Number(f.webhookToleranceSeconds), currency: f.currency, minAmountMinor: Number(f.minAmountMinor), maxAmountMinor: Number(f.maxAmountMinor), dailyUserLimitMinor: Number(f.dailyUserLimitMinor), allowedIps: String(f.allowedIps).split(',').map((s: string) => s.trim()).filter(Boolean), supportsRefund: !!f.supportsRefund };
            if (await a.run(() => api(`/api/admin/payment-service/providers/${edit.id}/config/${edit.env}`, { method: 'PUT', body }), 'Kaydedildi. Bağlantı testi yeniden yapılmalıdır.')) { setEdit(null); p.reload(); } }}>
            {[['apiBaseUrl', 'API temel adresi (https)'], ['merchantId', 'Merchant / iş yeri numarası'], ['currency', 'Para birimi'], ['webhookToleranceSeconds', 'Webhook zaman toleransı (sn)'], ['minAmountMinor', 'Asgari tutar (kuruş)'], ['maxAmountMinor', 'Azami tutar (kuruş)'], ['dailyUserLimitMinor', 'Kullanıcı günlük limit (kuruş)'], ['allowedIps', 'İzinli IP listesi (virgülle)']].map(([k, l]) => (
              <div key={k}><label htmlFor={k}>{l}</label><input id={k} value={edit.f[k] ?? ''} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, [k]: e.target.value } })} /></div>
            ))}
            <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!edit.f.supportsRefund} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, supportsRefund: e.target.checked } })} /> Sözleşme iade API'sini kapsıyor</label>
            <div className="row" style={{ marginTop: 8 }}><button>Kaydet</button><button type="button" className="secondary" onClick={() => setEdit(null)}>Vazgeç</button></div>
          </form>
        </div>
      )}
      {secret && (
        <div className="card">
          <h2>Gizli anahtar gir ({secret.environment})</h2>
          <p className="muted">Değer şifreli saklanır ve bir daha gösterilmez. Mümkünse bulut secret manager yolu (harici referans) kullanın. Test ve canlı anahtarlar ayrı tutulur.</p>
          <form onSubmit={async (e) => { e.preventDefault(); const body: any = { kind: secret.kind, environment: secret.environment }; if (secret.value) body.value = secret.value; if (secret.externalRef) body.externalRef = secret.externalRef; if (secret.expiresAt) body.expiresAt = new Date(secret.expiresAt).toISOString();
            if (await a.run(() => api(`/api/admin/payment-service/providers/${secret.provider}/secrets`, { method: 'PUT', body }), 'Anahtar kaydedildi.')) { setSecret(null); p.reload(); } }}>
            <label htmlFor="k">Tür</label>
            <select id="k" value={secret.kind} onChange={(e) => setSecret({ ...secret, kind: e.target.value })}><option value="API_KEY">API anahtarı</option><option value="WEBHOOK_SECRET">Webhook imza sırrı</option></select>
            <label htmlFor="sv">Değer</label><input id="sv" type="password" autoComplete="off" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} />
            <label htmlFor="se">veya harici secret manager referansı</label><input id="se" value={secret.externalRef} onChange={(e) => setSecret({ ...secret, externalRef: e.target.value })} />
            <label htmlFor="sx">Geçerlilik bitişi (isteğe bağlı)</label><input id="sx" type="date" value={secret.expiresAt} onChange={(e) => setSecret({ ...secret, expiresAt: e.target.value })} />
            <div className="row" style={{ marginTop: 8 }}><button>Kaydet</button><button type="button" className="secondary" onClick={() => setSecret(null)}>Vazgeç</button></div>
          </form>
        </div>
      )}
      <div className="card">
        <h2>Sağlayıcı ekle</h2>
        <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api('/api/admin/payment-service/providers', { body: newP }), 'Sağlayıcı eklendi.')) p.reload(); }}>
          <label htmlFor="pc">Kod (küçük harf)</label><input id="pc" value={newP.code} onChange={(e) => setNewP({ ...newP, code: e.target.value })} />
          <label htmlFor="pn">Görünen ad</label><input id="pn" value={newP.displayName} onChange={(e) => setNewP({ ...newP, displayName: e.target.value })} />
          <label htmlFor="pa">Adaptör</label>
          <select id="pa" value={newP.adapterCode} onChange={(e) => setNewP({ ...newP, adapterCode: e.target.value })}>
            {p.data?.availableAdapters.map((x: any) => <option key={x.code} value={x.code}>{x.code}{x.isSimulator ? ' (simülatör — yalnızca test)' : x.code === 'NONE' ? ' (kurulum bekleniyor)' : ''}</option>)}
          </select>
          <button style={{ marginTop: 8 }}>Ekle</button>
        </form>
      </div>
    </>
  );
}

function Contract() {
  const p = useLoad<any>('/api/admin/payment-service/providers');
  const [pid, setPid] = useState('');
  const c = useLoad<any>(pid ? `/api/admin/payment-service/providers/${pid}/contract` : null, [pid]);
  const [f, setF] = useState<any>(null);
  const a = useAction();
  const cur = f ?? (c.data && !c.data.empty ? {
    legalName: c.data.legal_name ?? '', contractNumber: c.data.contract_number ?? '', contractDate: c.data.contract_date?.slice(0, 10) ?? '', serviceStartDate: c.data.service_start_date?.slice(0, 10) ?? '',
    contactName: c.data.authorized_contact?.name ?? '', contactEmail: c.data.authorized_contact?.email ?? '', contactPhone: c.data.authorized_contact?.phone ?? '',
    supportChannel: c.data.support_channel ?? '', contractDocumentRef: c.data.contract_document_ref ?? '', testAccessStatus: c.data.test_access_status, productionAccessStatus: c.data.production_access_status, liveApprovalStatus: c.data.live_approval_status,
  } : { legalName: '', contractNumber: '', contractDate: '', serviceStartDate: '', contactName: '', contactEmail: '', contactPhone: '', supportChannel: '', contractDocumentRef: '', testAccessStatus: 'NONE', productionAccessStatus: 'NONE', liveApprovalStatus: 'NOT_APPROVED' });
  const set = (k: string, v: string) => setF({ ...cur, [k]: v });
  return (
    <div className="card">
      <AdminError error={a.error} /><Msg message={a.message} />
      <label htmlFor="pp">Sağlayıcı</label>
      <select id="pp" value={pid} onChange={(e) => { setPid(e.target.value); setF(null); }}><option value="">Seçin</option>{p.data?.providers.map((x: any) => <option key={x.id} value={x.id}>{x.displayName}</option>)}</select>
      {pid && (
        <form onSubmit={async (e) => { e.preventDefault(); const n = (s: string) => s || null;
          await a.run(() => api(`/api/admin/payment-service/providers/${pid}/contract`, { method: 'PUT', body: { legalName: n(cur.legalName), contractNumber: n(cur.contractNumber), contractDate: n(cur.contractDate), serviceStartDate: n(cur.serviceStartDate), authorizedContact: Object.fromEntries(Object.entries({ name: cur.contactName, email: cur.contactEmail, phone: cur.contactPhone }).filter(([, v]) => v)), supportChannel: n(cur.supportChannel), contractDocumentRef: n(cur.contractDocumentRef), testAccessStatus: cur.testAccessStatus, productionAccessStatus: cur.productionAccessStatus, liveApprovalStatus: cur.liveApprovalStatus } }), 'Sözleşme bilgileri kaydedildi.'); }}>
          {[['legalName', 'Ticari unvan'], ['contractNumber', 'Sözleşme numarası'], ['contractDate', 'Sözleşme tarihi', 'date'], ['serviceStartDate', 'Hizmet başlangıç tarihi', 'date'], ['contactName', 'Yetkili adı'], ['contactEmail', 'Yetkili e-posta'], ['contactPhone', 'Yetkili telefon'], ['supportChannel', 'Destek iletişim kanalı'], ['contractDocumentRef', 'Sözleşme belge referansı']].map(([k, l, t]) => (
            <div key={k}><label htmlFor={k}>{l}</label><input id={k} type={t ?? 'text'} value={cur[k!]} onChange={(e) => set(k!, e.target.value)} /></div>
          ))}
          <label htmlFor="ta">Test erişimi</label><select id="ta" value={cur.testAccessStatus} onChange={(e) => set('testAccessStatus', e.target.value)}><option value="NONE">Yok</option><option value="REQUESTED">Talep edildi</option><option value="GRANTED">Verildi</option></select>
          <label htmlFor="pa2">Üretim erişimi</label><select id="pa2" value={cur.productionAccessStatus} onChange={(e) => set('productionAccessStatus', e.target.value)}><option value="NONE">Yok</option><option value="REQUESTED">Talep edildi</option><option value="GRANTED">Verildi</option></select>
          <label htmlFor="la">Canlı kullanım onayı</label><select id="la" value={cur.liveApprovalStatus} onChange={(e) => set('liveApprovalStatus', e.target.value)}><option value="NOT_APPROVED">Onaylanmadı</option><option value="PENDING">Beklemede</option><option value="APPROVED">Onaylandı</option></select>
          <button style={{ marginTop: 8 }}>Kaydet</button>
        </form>
      )}
    </div>
  );
}

function Fees() {
  const fees = useLoad<any[]>('/api/admin/payment-service/fees');
  const a = useAction();
  const [f, setF] = useState({ transactionType: 'TOPUP', feeType: 'FIXED', fixedFeeMinor: '0', percentBps: '0', minFeeMinor: '0', maxFeeMinor: '', minAmountMinor: '100', maxAmountMinor: '500000', userFacingDescription: '', isSample: true, effectiveFrom: '' });
  return (
    <>
      <div className="alert warn">Gerçek sözleşme bilgileri girilene kadar tarifeler "örnek/test" olarak işaretlenir ve canlı işlemlerde kullanılamaz.</div>
      <AdminError error={a.error ?? fees.error} onVerified={fees.reload} /><Msg message={a.message} />
      <div className="card table-wrap"><table>
        <thead><tr><th>Tür</th><th>Ücret</th><th>Tutar aralığı</th><th>Açıklama</th><th>Yürürlük</th><th>Oluşturan</th></tr></thead>
        <tbody>{fees.data?.map((x) => (
          <tr key={x.id}><td>{x.transaction_type} {x.is_sample && <span className="badge test">ÖRNEK</span>}</td>
            <td>{x.fee_type}: {tl(x.fixed_fee_minor)} + %{(x.percent_bps / 100).toFixed(2)} (min {tl(x.min_fee_minor)}{x.max_fee_minor != null && `, maks ${tl(x.max_fee_minor)}`})</td>
            <td>{tl(x.min_amount_minor)} – {tl(x.max_amount_minor)}</td><td>{x.user_facing_description}</td><td>{dt(x.effective_from)}</td><td>{x.created_by_email ?? 'sistem'}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="card">
        <h2>Yeni tarife sürümü</h2>
        <form onSubmit={async (e) => { e.preventDefault(); const n = (s: string) => Number(s);
          if (await a.run(() => api('/api/admin/payment-service/fees', { body: { transactionType: f.transactionType, feeType: f.feeType, fixedFeeMinor: n(f.fixedFeeMinor), percentBps: n(f.percentBps), minFeeMinor: n(f.minFeeMinor), maxFeeMinor: f.maxFeeMinor ? n(f.maxFeeMinor) : null, minAmountMinor: n(f.minAmountMinor), maxAmountMinor: n(f.maxAmountMinor), userFacingDescription: f.userFacingDescription, isSample: f.isSample, effectiveFrom: new Date(f.effectiveFrom || Date.now()).toISOString() } }), 'Tarife eklendi.')) fees.reload(); }}>
          <label htmlFor="tt">İşlem türü</label><select id="tt" value={f.transactionType} onChange={(e) => setF({ ...f, transactionType: e.target.value })}><option value="TOPUP">Kart yükleme</option><option value="BILL_PAYMENT">Fatura ödeme</option></select>
          <label htmlFor="ft">Hizmet bedeli türü</label><select id="ft" value={f.feeType} onChange={(e) => setF({ ...f, feeType: e.target.value })}><option value="NONE">Yok</option><option value="FIXED">Sabit</option><option value="PERCENT">Oransal</option><option value="FIXED_PLUS_PERCENT">Sabit + oransal</option></select>
          {[['fixedFeeMinor', 'Sabit ücret (kuruş)'], ['percentBps', 'Oransal ücret (baz puan, 100 = %1)'], ['minFeeMinor', 'Asgari ücret (kuruş)'], ['maxFeeMinor', 'Azami ücret (kuruş, boş = yok)'], ['minAmountMinor', 'Asgari işlem tutarı (kuruş)'], ['maxAmountMinor', 'Azami işlem tutarı (kuruş)'], ['userFacingDescription', 'Kullanıcıya gösterilecek açıklama']].map(([k, l]) => (
            <div key={k}><label htmlFor={k}>{l}</label><input id={k} value={(f as any)[k]} onChange={(e) => setF({ ...f, [k!]: e.target.value })} /></div>
          ))}
          <label htmlFor="ef">Yürürlük tarihi</label><input id="ef" type="datetime-local" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.isSample} onChange={(e) => setF({ ...f, isSample: e.target.checked })} /> Örnek/test tarifesi (sözleşmeye dayanmıyor)</label>
          <button style={{ marginTop: 8 }}>Ekle</button>
        </form>
      </div>
    </>
  );
}

function Transactions() {
  const [filter, setFilter] = useState({ type: '', status: '', ref: '' });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const t = useLoad<any[]>(`/api/admin/payment-service/transactions?${qs}`, [qs]);
  const [hist, setHist] = useState<{ id: string; rows: any[] } | null>(null);
  return (
    <>
      <div className="row">
        <select aria-label="Tür" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })} style={{ maxWidth: 180 }}><option value="">Tüm türler</option><option value="TOPUP">Kart yükleme</option><option value="BILL_PAYMENT">Fatura</option></select>
        <input aria-label="Durum" placeholder="Durum (ör. UNKNOWN)" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value.toUpperCase() })} style={{ maxWidth: 200 }} />
        <input aria-label="İşlem no" placeholder="İşlem no" value={filter.ref} onChange={(e) => setFilter({ ...filter, ref: e.target.value })} style={{ maxWidth: 220 }} />
      </div>
      <AdminError error={t.error} onVerified={t.reload} />
      <div className="card table-wrap"><table>
        <thead><tr><th>İşlem no</th><th>Kullanıcı / abonelik</th><th>Tür</th><th>Ödeme ref.</th><th>Su idaresi ref.</th><th>Tutar</th><th>Durum</th><th>Oluşturma / tamamlanma</th><th>Hata</th><th>İade</th></tr></thead>
        <tbody>{t.data?.map((x) => (
          <tr key={x.id}>
            <td><button className="secondary" onClick={async () => setHist({ id: x.id, rows: await api(`/api/admin/payment-service/transactions/${x.type}/${x.id}/history`) })}>{x.public_ref}</button> <TestBadge show={x.environment === 'TEST'} /></td>
            <td>{x.userEmail}<div className="muted">{x.subscriberMasked}</div></td><td>{x.type}</td>
            <td>{x.payment_ref}<div className="muted">{x.provider_payment_ref}</div></td><td>{x.utility_ref ?? '—'}</td>
            <td>{tl(x.total_minor)}</td><td><StatusBadge status={x.status} /></td><td>{dt(x.created_at)}<div className="muted">{dt(x.completed_at)}</div></td>
            <td>{x.error_code}</td><td>{x.refund_status ?? '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {hist && (
        <div className="card"><h2>Durum geçmişi</h2><ol>{hist.rows.map((h, i) => <li key={i}>{dt(h.created_at)} — {h.from_status ?? '∅'} → <strong>{h.to_status}</strong> ({h.actor}) {h.reason}</li>)}</ol><button className="secondary" onClick={() => setHist(null)}>Kapat</button></div>
      )}
    </>
  );
}

function Refunds() {
  const r = useLoad<any[]>('/api/admin/payment-service/refunds');
  const review = useLoad<any[]>('/api/admin/payment-service/transactions?status=REQUIRES_REVIEW');
  const a = useAction();
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  return (
    <>
      <div className="alert warn">İade yalnızca ödeme sağlayıcısının iade API'si sözleşmede ve adaptörde destekleniyorsa gönderilir. Aksi hâlde "Manuel işlem gerekli" olarak kalır; düğme sahte başarılı sonuç üretmez.</div>
      <AdminError error={a.error ?? r.error} onVerified={r.reload} /><Msg message={a.message} />
      <h2>İade talepleri</h2>
      <div className="card table-wrap"><table>
        <thead><tr><th>Ödeme ref.</th><th>Kaynak</th><th>Tutar</th><th>Neden</th><th>Durum</th><th>Onaylayan</th><th>Doğrulama</th><th>İşlem</th></tr></thead>
        <tbody>{r.data?.map((x) => (
          <tr key={x.id}>
            <td>{x.payment_ref}</td><td>{x.source_type}</td><td>{tl(x.amount_minor)}</td><td>{x.reason}</td><td>{x.status}<div className="muted">{x.failure_message}</div></td>
            <td>{x.approved_by_email ?? '—'} <div className="muted">{dt(x.approved_at)}</div></td><td>{x.verification_method ?? '—'} {x.evidence_ref}</td>
            <td className="row">
              {x.status === 'PENDING_APPROVAL' && <>
                <button onClick={async () => { if (confirm('İade onaylansın mı?')) { await a.run(() => api(`/api/admin/payment-service/refunds/${x.id}/approve`, { method: 'POST' }), 'İade işlendi.'); r.reload(); } }}>Onayla</button>
                <button className="secondary" onClick={async () => { const note = prompt('Red gerekçesi'); if (note) { await a.run(() => api(`/api/admin/payment-service/refunds/${x.id}/reject`, { body: { note } })); r.reload(); } }}>Reddet</button>
              </>}
              {x.status === 'MANUAL_ACTION_REQUIRED' && <>
                <input aria-label="Sağlayıcı iade kanıtı" placeholder="Sağlayıcı iade referansı" value={evidence[x.id] ?? ''} onChange={(e) => setEvidence({ ...evidence, [x.id]: e.target.value })} style={{ maxWidth: 200 }} />
                <button disabled={!evidence[x.id]} onClick={async () => { await a.run(() => api(`/api/admin/payment-service/refunds/${x.id}/manual-complete`, { body: { evidenceRef: evidence[x.id] } }), 'Kanıtla kapatıldı.'); r.reload(); }}>Kanıtla kapat</button>
              </>}
            </td>
          </tr>
        ))}</tbody>
      </table></div>
      <h2>İnceleme bekleyen işlemler</h2>
      <div className="card table-wrap"><table><tbody>{review.data?.map((x) => (
        <tr key={x.id}><td>{x.public_ref}</td><td>{x.type}</td><td>{tl(x.total_minor)}</td><td>{x.payment_status}</td>
          <td>{x.payment_status === 'SUCCEEDED' && <button className="secondary" onClick={async () => { const reason = prompt('İade nedeni'); if (reason) { await a.run(() => api('/api/admin/payment-service/refunds', { body: { sourceType: x.type, sourceId: x.id, reason } }), 'İade talebi açıldı.'); r.reload(); review.reload(); } }}>İade talebi aç</button>}</td></tr>
      ))}</tbody></table>{review.data?.length === 0 && <p className="muted">İncelemede işlem yok.</p>}</div>
    </>
  );
}

function Reconciliation() {
  const runs = useLoad<any[]>('/api/admin/payment-service/reconciliation/runs');
  const queue = useLoad<any[]>('/api/admin/payment-service/reconciliation/review-queue');
  const a = useAction();
  const today = new Date();
  const [range, setRange] = useState({ from: new Date(today.getTime() - 86400_000).toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) });
  return (
    <>
      <AdminError error={a.error ?? runs.error} onVerified={runs.reload} /><Msg message={a.message} />
      <div className="card">
        <h2>Mutabakat çalıştır</h2>
        <div className="row">
          <label htmlFor="rf" style={{ margin: 0 }}>Başlangıç</label><input id="rf" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ maxWidth: 180 }} />
          <label htmlFor="rt" style={{ margin: 0 }}>Bitiş</label><input id="rt" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ maxWidth: 180 }} />
          <button onClick={async () => { await a.run(() => api('/api/admin/payment-service/reconciliation/runs', { body: { from: new Date(range.from).toISOString(), to: new Date(new Date(range.to).getTime() + 86400_000).toISOString() } }), 'Mutabakat tamamlandı.'); runs.reload(); queue.reload(); }}>Çalıştır</button>
        </div>
        <p className="muted">Ödeme sağlayıcısı ve su idaresi işlem listeleri yalnızca ilgili entegrasyon yapılandırıldığında karşılaştırılır; aksi durumda çalışma "kaynak yapılandırılmadı" olarak kaydedilir.</p>
      </div>
      <h2>Çalışmalar</h2>
      <div className="card table-wrap"><table>
        <thead><tr><th>Dönem</th><th>Durum</th><th>Sağlayıcı / su idaresi kaynağı</th><th>Eşleşen</th><th>Sorunlu</th><th>Not</th><th /></tr></thead>
        <tbody>{runs.data?.map((r) => (
          <tr key={r.id}><td>{dt(r.period_start)} – {dt(r.period_end)}</td><td>{r.status}</td><td>{r.provider_source} / {r.utility_source}</td><td>{r.matched_count}</td><td>{r.issue_count}</td><td className="muted">{r.notes}</td>
            <td><a href={`/api/admin/payment-service/reconciliation/runs/${r.id}/export.csv`}>CSV dışa aktar</a></td></tr>
        ))}</tbody>
      </table></div>
      <h2>Manuel inceleme kuyruğu</h2>
      <div className="card table-wrap"><table>
        <thead><tr><th>Sorun</th><th>Kaynak</th><th>Yerel / sağlayıcı / su idaresi tutar</th><th>Durumlar</th><th /></tr></thead>
        <tbody>{queue.data?.map((i) => (
          <tr key={i.id}><td><strong>{({ AMOUNT_MISMATCH: 'Tutar uyuşmazlığı', STATUS_MISMATCH: 'Durum uyuşmazlığı', MISSING_AT_PROVIDER: 'Sağlayıcıda yok', MISSING_AT_UTILITY: 'Su idaresinde yok', MISSING_LOCALLY: 'Yerelde yok', DUPLICATE_SUSPECT: 'Çift işlem şüphesi', MISSING_RECEIPT: 'Eksik makbuz' } as any)[i.issue_type] ?? i.issue_type}</strong></td>
            <td>{i.source_type} {i.source_id?.slice(0, 8)}</td><td>{tl(i.local_amount_minor)} / {tl(i.provider_amount_minor)} / {tl(i.utility_amount_minor)}</td><td>{i.local_status} / {i.provider_status} / {i.utility_status}</td>
            <td className="row">{(['RESOLVED', 'NOT_AN_ISSUE'] as const).map((s) => <button key={s} className="secondary" onClick={async () => { const note = prompt('İnceleme notu'); if (note) { await a.run(() => api(`/api/admin/payment-service/reconciliation/items/${i.id}/review`, { body: { reviewStatus: s, note } })); queue.reload(); } }}>{s === 'RESOLVED' ? 'Çözüldü' : 'Sorun değil'}</button>)}</td></tr>
        ))}</tbody>
      </table>{queue.data?.length === 0 && <p className="muted">Kuyruk boş.</p>}</div>
    </>
  );
}

function Connection() {
  const c = useLoad<any>('/api/admin/payment-service/connection');
  const a = useAction();
  return (
    <Loading loading={c.loading}>
      <AdminError error={a.error ?? c.error} onVerified={c.reload} /><Msg message={a.message} />
      {c.data && (
        <>
          <div className="card">
            <h2>Üretim ortamına geçiş</h2>
            {c.data.liveBlockers.length ? <><p>Canlı moda geçiş şu maddeler nedeniyle engelli:</p><ul>{c.data.liveBlockers.map((b: string) => <li key={b}>{b}</li>)}</ul></> : <p>Engel yok.</p>}
            <div className="row">
              <button className="danger" onClick={async () => { if (confirm('Canlı moda geçilsin mi? Gerçek ödemeler alınacaktır.')) await a.run(() => api('/api/admin/payment-service/mode', { body: { mode: 'LIVE' } }), 'Canlı mod etkin.'); }}>Canlı moda geç</button>
              <button className="secondary" onClick={() => a.run(() => api('/api/admin/payment-service/mode', { body: { mode: 'TEST' } }), 'Test moduna dönüldü.')}>Test moduna dön</button>
            </div>
          </div>
          <h2>Anahtar ve sertifika geçerliliği</h2>
          <div className="card table-wrap"><table><thead><tr><th>Referans</th><th>Ortam</th><th>Parmak izi</th><th>İpucu</th><th>Bitiş</th><th>Son değişim</th></tr></thead><tbody>
            {c.data.secrets.map((s: any) => <tr key={s.ref}><td><code>{s.ref}</code></td><td><ModeBadge mode={s.environment} /></td><td>{s.fingerprint}</td><td>{s.last4_hint}</td><td>{dt(s.expires_at)}</td><td>{dt(s.rotated_at)}</td></tr>)}
          </tbody></table></div>
          <h2>Webhook doğrulama kayıtları</h2>
          <div className="card table-wrap"><table><thead><tr><th>Zaman</th><th>Tür</th><th>İmza</th><th>Ret nedeni</th><th>İşlendi</th></tr></thead><tbody>
            {c.data.webhooks.map((w: any, i: number) => <tr key={i}><td>{dt(w.received_at)}</td><td>{w.event_type}</td><td>{w.signature_valid ? <span className="badge ok">Geçerli</span> : <span className="badge err">Geçersiz</span>}</td><td>{w.rejection_reason}</td><td>{w.processed_at ? dt(w.processed_at) : w.processing_error ?? '—'}</td></tr>)}
          </tbody></table></div>
          <h2>Bağlantı test kayıtları</h2>
          <div className="card table-wrap"><table><thead><tr><th>Zaman</th><th>Ortam</th><th>Sonuç</th><th>Mesaj</th><th>Süre</th></tr></thead><tbody>
            {c.data.tests.map((t: any, i: number) => <tr key={i}><td>{dt(t.created_at)}</td><td>{t.environment}</td><td>{t.ok ? 'Başarılı' : 'Başarısız'} ({t.result_code})</td><td>{t.message}</td><td>{t.latency_ms} ms</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </Loading>
  );
}
