import { useState } from 'react';
import { api, dt } from '../../api';
import { Loading, Msg, useAction, useLoad } from '../../components/ui';
import { AdminError, ModeBadge, SecretMeta } from './common';

const CAPS: [string, string][] = [['accountQuery', 'Abone sorgulama'], ['cardTopup', 'Kart yükleme'], ['billQuery', 'Fatura sorgulama'], ['billPayment', 'Fatura ödeme'], ['statusQuery', 'İşlem durum sorgulama'], ['reconciliation', 'Mutabakat']];

export function UtilityIntegration() {
  const u = useLoad<any>('/api/admin/utilities');
  const a = useAction();
  const [edit, setEdit] = useState<{ id: string; env: 'TEST' | 'LIVE'; f: any } | null>(null);
  const [secret, setSecret] = useState<{ id: string; env: string; kind: string; value: string; externalRef: string } | null>(null);
  const [nu, setNu] = useState({ code: '', fullName: '', city: '' });
  const blank = { adapterCode: 'NONE', integrationCode: '', contactName: '', contactEmail: '', contactPhone: '', agreementStatus: 'NOT_STARTED', authorizationStatus: 'AWAITING', apiBaseUrl: '', authMethod: '', documentationRef: '', agreementDocumentRef: '', capabilities: Object.fromEntries(CAPS.map(([k]) => [k, false])) };
  return (
    <>
      <h1>Su İdaresi Entegrasyonu</h1>
      <div className="alert warn">Uç noktalar ve veri biçimleri yalnızca kurumun resmî teknik dokümanından alınır. Doküman ve yazılı izin gelene kadar entegrasyon "Yapılandırma bekleniyor" durumunda kalır. İzinsiz veri kazıma veya yetkisiz erişim kullanılmaz.</div>
      <AdminError error={a.error ?? u.error} onVerified={u.reload} /><Msg message={a.message} />
      <Loading loading={u.loading}>
        {u.data?.utilities.length === 0 && <p>Kayıtlı su idaresi yok.</p>}
        {u.data?.utilities.map((x: any) => (
          <div className="card" key={x.id}>
            <div className="row"><h2 style={{ margin: 0, flex: 1 }}>{x.fullName}</h2><span className={`badge ${x.isActive ? 'ok' : ''}`}>{x.isActive ? 'Platformda etkin' : 'Pasif'}</span>
              <button className="secondary" onClick={async () => { await a.run(() => api(`/api/admin/utilities/${x.id}/active`, { body: { isActive: !x.isActive } })); u.reload(); }}>{x.isActive ? 'Pasifleştir' : 'Etkinleştir'}</button></div>
            <p className="muted">Kurum kodu: {x.code} {x.city && `· ${x.city}`}</p>
            {(['TEST', 'LIVE'] as const).map((env) => {
              const i = x[env.toLowerCase()];
              return (
                <div className="card" key={env}>
                  <h3 style={{ marginTop: 0 }}><ModeBadge mode={env} /> {i?.status ?? 'Yapılandırma bekleniyor'}</h3>
                  {i && (
                    <dl className="kv">
                      <dt>Adaptör</dt><dd>{i.adapterCode}</dd>
                      <dt>Entegrasyon kodu</dt><dd>{i.integrationCode ?? '—'}</dd>
                      <dt>Teknik iletişim</dt><dd>{[i.technicalContact?.name, i.technicalContact?.email, i.technicalContact?.phone].filter(Boolean).join(' · ') || '—'}</dd>
                      <dt>Sözleşme / izin</dt><dd>{i.agreementStatus} / {i.authorizationStatus}</dd>
                      <dt>API temel adresi</dt><dd>{i.apiBaseUrl ?? '—'}</dd>
                      <dt>Kimlik doğrulama</dt><dd>{i.authMethod ?? '—'}</dd>
                      <dt>Kimlik bilgisi</dt><dd><SecretMeta m={i.credential} /></dd>
                      <dt>Sertifika</dt><dd><SecretMeta m={i.certificate} /></dd>
                      <dt>Yetenekler</dt><dd>{CAPS.map(([k, l]) => <span key={k} className={`badge ${i.capabilities[k] ? 'ok' : ''}`} style={{ marginRight: 4 }}>{l}</span>)}</dd>
                      <dt>Son bağlantı testi</dt><dd>{i.lastConnectionTestOk == null ? 'Yapılmadı' : i.lastConnectionTestOk ? 'Başarılı' : 'Başarısız'} {dt(i.lastConnectionTestAt)}</dd>
                      <dt>Son başarılı işlem</dt><dd>{dt(i.lastSuccessAt)}</dd>
                      <dt>Son hata</dt><dd>{i.lastError ?? '—'} {i.lastErrorAt && dt(i.lastErrorAt)}</dd>
                      <dt>Teknik doküman</dt><dd>{i.documentationRef ?? '—'}</dd>
                      <dt>Sözleşme belgesi</dt><dd>{i.agreementDocumentRef ?? '—'}</dd>
                    </dl>
                  )}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="secondary" onClick={() => setEdit({ id: x.id, env, f: i ? { ...blank, ...i, contactName: i.technicalContact?.name ?? '', contactEmail: i.technicalContact?.email ?? '', contactPhone: i.technicalContact?.phone ?? '', apiBaseUrl: i.apiBaseUrl ?? '', authMethod: i.authMethod ?? '', integrationCode: i.integrationCode ?? '', documentationRef: i.documentationRef ?? '', agreementDocumentRef: i.agreementDocumentRef ?? '' } : blank })}>Düzenle</button>
                    {i && <button className="secondary" onClick={() => setSecret({ id: x.id, env, kind: 'CREDENTIAL', value: '', externalRef: '' })}>Kimlik bilgisi / sertifika gir</button>}
                    {i && <button className="secondary" onClick={async () => { const r = await a.run(() => api(`/api/admin/utilities/${x.id}/integration/${env}/test`, { method: 'POST' })); if (r && !r.ok) a.setError({ message: `Bağlantı testi başarısız: ${r.message}` }); u.reload(); }}>Bağlantı testi</button>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </Loading>
      {edit && (
        <div className="card">
          <h2>{edit.env} entegrasyon ayarları</h2>
          <form onSubmit={async (e) => { e.preventDefault(); const f = edit.f; const n = (s: string) => s || null;
            const body = { adapterCode: f.adapterCode, integrationCode: n(f.integrationCode), technicalContact: Object.fromEntries(Object.entries({ name: f.contactName, email: f.contactEmail, phone: f.contactPhone }).filter(([, v]) => v)), agreementStatus: f.agreementStatus, authorizationStatus: f.authorizationStatus, apiBaseUrl: n(f.apiBaseUrl), authMethod: n(f.authMethod), capabilities: f.capabilities, documentationRef: n(f.documentationRef), agreementDocumentRef: n(f.agreementDocumentRef) };
            if (await a.run(() => api(`/api/admin/utilities/${edit.id}/integration/${edit.env}`, { method: 'PUT', body }), 'Kaydedildi. Bağlantı testi yeniden yapılmalıdır.')) { setEdit(null); u.reload(); } }}>
            <label htmlFor="ad">Adaptör</label>
            <select id="ad" value={edit.f.adapterCode} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, adapterCode: e.target.value } })}>
              {u.data?.availableAdapters.filter((x: any) => edit.env === 'TEST' || !x.isSimulator).map((x: any) => <option key={x.code} value={x.code}>{x.code}{x.isSimulator ? ' (simülatör — yalnızca test)' : x.code === 'NONE' ? ' (yapılandırma bekleniyor)' : ''}</option>)}
            </select>
            {[['integrationCode', 'Kurum/entegrasyon kodu'], ['contactName', 'Teknik iletişim adı'], ['contactEmail', 'Teknik iletişim e-posta'], ['contactPhone', 'Teknik iletişim telefon'], ['apiBaseUrl', 'API temel adresi (https)'], ['documentationRef', 'Teknik doküman referansı'], ['agreementDocumentRef', 'Sözleşme/izin belge referansı']].map(([k, l]) => (
              <div key={k}><label htmlFor={k}>{l}</label><input id={k} value={edit.f[k!] ?? ''} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, [k!]: e.target.value } })} /></div>
            ))}
            <label htmlFor="am">Kimlik doğrulama yöntemi</label>
            <select id="am" value={edit.f.authMethod} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, authMethod: e.target.value } })}><option value="">—</option><option>API_KEY</option><option>OAUTH2_CLIENT_CREDENTIALS</option><option>MUTUAL_TLS</option><option>OTHER</option></select>
            <label htmlFor="ag">Sözleşme durumu</label>
            <select id="ag" value={edit.f.agreementStatus} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, agreementStatus: e.target.value } })}><option value="NOT_STARTED">Başlamadı</option><option value="IN_NEGOTIATION">Görüşülüyor</option><option value="SIGNED">İmzalandı</option><option value="REVOKED">İptal</option></select>
            <label htmlFor="au">İzin/erişim durumu</label>
            <select id="au" value={edit.f.authorizationStatus} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, authorizationStatus: e.target.value } })}><option value="AWAITING">Yetkilendirme bekleniyor</option><option value="TEST_ACCESS">Test erişimi</option><option value="PRODUCTION_ACCESS">Üretim erişimi</option><option value="REVOKED">İptal</option></select>
            <fieldset style={{ marginTop: 12 }}><legend>Kurumun desteklediği işlemler</legend>
              {CAPS.map(([k, l]) => <label key={k} className="row" style={{ fontWeight: 400, margin: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!edit.f.capabilities[k]} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, capabilities: { ...edit.f.capabilities, [k]: e.target.checked } } })} />{l}</label>)}
            </fieldset>
            <div className="row" style={{ marginTop: 8 }}><button>Kaydet</button><button type="button" className="secondary" onClick={() => setEdit(null)}>Vazgeç</button></div>
          </form>
        </div>
      )}
      {secret && (
        <div className="card">
          <h2>Kimlik bilgisi / sertifika ({secret.env})</h2>
          <p className="muted">Değer şifreli saklanır, panelde yalnızca tanımlı olup olmadığı ve maskeli referansı gösterilir.</p>
          <form onSubmit={async (e) => { e.preventDefault(); const body: any = { kind: secret.kind }; if (secret.value) body.value = secret.value; if (secret.externalRef) body.externalRef = secret.externalRef;
            if (await a.run(() => api(`/api/admin/utilities/${secret.id}/integration/${secret.env}/secrets`, { method: 'PUT', body }), 'Kaydedildi.')) { setSecret(null); u.reload(); } }}>
            <label htmlFor="sk">Tür</label><select id="sk" value={secret.kind} onChange={(e) => setSecret({ ...secret, kind: e.target.value })}><option value="CREDENTIAL">Kimlik bilgisi / API anahtarı</option><option value="CERTIFICATE">Sertifika</option></select>
            <label htmlFor="sv">Değer</label><textarea id="sv" rows={3} autoComplete="off" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} />
            <label htmlFor="sr">veya harici secret manager referansı</label><input id="sr" value={secret.externalRef} onChange={(e) => setSecret({ ...secret, externalRef: e.target.value })} />
            <div className="row" style={{ marginTop: 8 }}><button>Kaydet</button><button type="button" className="secondary" onClick={() => setSecret(null)}>Vazgeç</button></div>
          </form>
        </div>
      )}
      <div className="card">
        <h2>Su idaresi ekle</h2>
        <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api('/api/admin/utilities', { body: { code: nu.code, fullName: nu.fullName, city: nu.city || undefined } }), 'Eklendi.')) u.reload(); }}>
          <label htmlFor="uc">Kurum kodu (büyük harf)</label><input id="uc" value={nu.code} onChange={(e) => setNu({ ...nu, code: e.target.value.toUpperCase() })} />
          <label htmlFor="uf">Kurumun tam adı</label><input id="uf" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
          <label htmlFor="ui">Şehir</label><input id="ui" value={nu.city} onChange={(e) => setNu({ ...nu, city: e.target.value })} />
          <button style={{ marginTop: 8 }}>Ekle</button>
        </form>
      </div>
    </>
  );
}
