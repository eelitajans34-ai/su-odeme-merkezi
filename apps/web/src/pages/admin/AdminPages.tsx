import { useState, type FormEvent } from 'react';
import { api, dt, tl } from '../../api';
import { Loading, Msg, StatusBadge, useAction, useLoad } from '../../components/ui';
import { AdminError, ModeBadge } from './common';

export function AdminOverview() {
  const o = useLoad<any>('/api/admin/payment-service/overview');
  const h = useLoad<any>('/api/admin/system/health');
  return (
    <>
      <h1>Yönetim paneli</h1>
      <AdminError error={o.error} onVerified={o.reload} />
      <Loading loading={o.loading}>
        {o.data && (
          <>
            <div className={`alert ${o.data.mode === 'LIVE' ? 'err' : 'warn'}`}><strong>{o.data.modeBanner}</strong></div>
            <div className="grid">
              <div className="card"><div className="muted">Ödeme hizmeti</div><strong>{o.data.configurationStatus}</strong></div>
              <div className="card"><div className="muted">Teyit bekleyen işlem</div><strong>{o.data.counts.pending_fulfillment}</strong></div>
              <div className="card"><div className="muted">İncelemedeki işlem</div><strong>{o.data.counts.requires_review}</strong></div>
              <div className="card"><div className="muted">Açık iade</div><strong>{o.data.counts.pending_refunds}</strong></div>
              <div className="card"><div className="muted">Son mutabakat</div><strong>{dt(o.data.counts.last_reconciliation)}</strong></div>
              <div className="card"><div className="muted">Uzun bekleyen işlem</div><strong>{h.data?.stalePendingTransactions ?? '…'}</strong></div>
            </div>
            <h2>Açık uyarılar</h2>
            {o.data.alerts.length === 0 && <p className="muted">Açık uyarı yok.</p>}
            {o.data.alerts.map((a: any) => <div key={a.id} className={`alert ${a.severity === 'CRITICAL' ? 'err' : 'warn'}`}><strong>{a.title}</strong> — {a.body} <span className="muted">{dt(a.created_at)}</span></div>)}
          </>
        )}
      </Loading>
    </>
  );
}

export function AdminUsers() {
  const [search, setSearch] = useState('');
  const users = useLoad<any[]>(`/api/admin/users?search=${encodeURIComponent(search)}`, [search]);
  const a = useAction();
  async function role(id: string, role: string, action: 'GRANT' | 'REVOKE') {
    if (!confirm(`${role} rolü ${action === 'GRANT' ? 'verilsin' : 'kaldırılsın'} mi?`)) return;
    if (await a.run(() => api(`/api/admin/users/${id}/roles`, { body: { role, action } }), 'Rol güncellendi.')) users.reload();
  }
  return (
    <>
      <h1>Kullanıcılar ve roller</h1>
      <input aria-label="Ara" placeholder="E-posta veya ad ile ara" value={search} onChange={(e) => setSearch(e.target.value)} />
      <AdminError error={a.error ?? users.error} onVerified={users.reload} /><Msg message={a.message} />
      <Loading loading={users.loading}>
        <div className="card table-wrap"><table>
          <thead><tr><th>E-posta</th><th>Durum</th><th>Roller</th><th>MFA</th><th>Son giriş</th><th>İşlem</th></tr></thead>
          <tbody>{users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.email}{u.is_test_account && <span className="badge test"> TEST</span>}</td><td>{u.status}</td><td>{u.roles.join(', ')}</td>
              <td>{u.mfa_enabled ? 'Etkin' : '—'}</td><td>{dt(u.last_login_at)}</td>
              <td className="row">
                {['SUPPORT', 'FINANCE', 'SUPER_ADMIN'].map((r) => u.roles.includes(r)
                  ? <button key={r} className="secondary" onClick={() => role(u.id, r, 'REVOKE')}>−{r}</button>
                  : <button key={r} className="secondary" onClick={() => role(u.id, r, 'GRANT')}>+{r}</button>)}
                <button className="secondary" onClick={() => a.run(() => api(`/api/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }), 'Oturumlar kapatıldı.')}>Oturumları kapat</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      </Loading>
      <p className="muted">Rol değişiklikleri sunucu tarafında, son 15 dakika içinde doğrulanmış MFA ile yapılır ve denetim kaydına yazılır.</p>
    </>
  );
}

export function AdminAudit() {
  const [action, setAction] = useState('');
  const logs = useLoad<any[]>(`/api/admin/audit-logs?action=${encodeURIComponent(action)}`, [action]);
  return (
    <>
      <h1>Denetim kayıtları</h1>
      <input aria-label="Eylem filtresi" placeholder="Eylem (ör. role., refund., secret.)" value={action} onChange={(e) => setAction(e.target.value)} />
      <AdminError error={logs.error} onVerified={logs.reload} />
      <div className="card table-wrap"><table>
        <thead><tr><th>Zaman</th><th>Aktör</th><th>Eylem</th><th>Hedef</th><th>IP</th><th>Ayrıntı</th></tr></thead>
        <tbody>{logs.data?.map((l) => (
          <tr key={l.id}><td>{dt(l.created_at)}</td><td>{l.actor_type} {l.actor_email}</td><td>{l.action}</td><td>{l.target_type} {l.target_id?.slice(0, 12)}</td><td>{l.ip}</td><td><code style={{ fontSize: 12 }}>{JSON.stringify(l.details).slice(0, 160)}</code></td></tr>
        ))}</tbody>
      </table></div>
    </>
  );
}

export function AdminAlerts() {
  const alerts = useLoad<any[]>('/api/admin/alerts');
  const channels = useLoad<any[]>('/api/admin/notification-channels');
  const a = useAction();
  return (
    <>
      <h1>Bildirim ve sistem uyarıları</h1>
      <AdminError error={a.error ?? alerts.error} onVerified={alerts.reload} />
      <div className="card">
        <h2>Bildirim kanalları</h2>
        <ul>{channels.data?.map((c) => <li key={c.channel}>{c.channel}: <strong>{c.status === 'NOT_CONFIGURED' ? 'Sağlayıcı bağlanmadı — gönderim yapılmıyor' : c.status}</strong></li>)}</ul>
        <p className="muted">E-posta için standart SMTP yapılandırılabilir. SMS ve push sağlayıcıları sözleşme sonrası eklenecek; o zamana kadar gönderilmiş gibi gösterilmez.</p>
        <EmailChannelForm onSaved={channels.reload} />
      </div>
      {alerts.data?.map((x) => (
        <div key={x.id} className={`alert ${x.acknowledged_at ? '' : x.severity === 'CRITICAL' ? 'err' : 'warn'}`}>
          <div className="row"><strong style={{ flex: 1 }}>{x.title}</strong><span className="muted">{dt(x.created_at)}</span></div>
          <p>{x.body}</p>
          {!x.acknowledged_at && <button className="secondary" onClick={async () => { await a.run(() => api(`/api/admin/alerts/${x.id}/ack`, { method: 'POST' })); alerts.reload(); }}>Gördüm</button>}
        </div>
      ))}
    </>
  );
}

export function AdminSupport() {
  const t = useLoad<any[]>('/api/admin/support-tickets');
  const [open, setOpen] = useState<string | null>(null);
  const msgs = useLoad<any[]>(open ? `/api/admin/support-tickets/${open}/messages` : null, [open]);
  const [reply, setReply] = useState({ message: '', status: 'WAITING_USER' });
  const a = useAction();
  return (
    <>
      <h1>Destek talepleri</h1>
      <AdminError error={a.error ?? t.error} onVerified={t.reload} />
      {t.data?.map((x) => (
        <div className="card" key={x.id}>
          <div className="row"><strong style={{ flex: 1 }}>{x.ticket_no} · {x.subject}</strong><span className="badge">{x.category}</span><span className="badge">{x.status}</span></div>
          <p className="muted">{x.email} · {dt(x.created_at)} {x.related_type && `· ${x.related_type} ${x.related_id}`}</p>
          <button className="secondary" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Kapat' : 'Aç'}</button>
          {open === x.id && (
            <>
              {msgs.data?.map((m, i) => <p key={i}><strong>{m.author_role}:</strong> {m.body}</p>)}
              <form onSubmit={async (e: FormEvent) => { e.preventDefault(); await a.run(() => api(`/api/admin/support-tickets/${x.id}/reply`, { body: reply })); setReply({ ...reply, message: '' }); msgs.reload(); t.reload(); }}>
                <textarea aria-label="Yanıt" rows={3} value={reply.message} onChange={(e) => setReply({ ...reply, message: e.target.value })} />
                <div className="row"><select aria-label="Durum" value={reply.status} onChange={(e) => setReply({ ...reply, status: e.target.value })} style={{ maxWidth: 220 }}>
                  <option value="IN_PROGRESS">İşlemde</option><option value="WAITING_USER">Kullanıcı yanıtı bekleniyor</option><option value="RESOLVED">Çözüldü</option><option value="CLOSED">Kapatıldı</option>
                </select><button disabled={!reply.message}>Yanıtla</button></div>
              </form>
            </>
          )}
        </div>
      ))}
    </>
  );
}

export function AdminSystem() {
  const h = useLoad<any>('/api/admin/system/health');
  const a = useAction();
  const d = h.data;
  return (
    <>
      <h1>Sistem sağlığı, yedekleme ve bakım</h1>
      <AdminError error={a.error ?? h.error} onVerified={h.reload} /><Msg message={a.message} />
      {d && (
        <>
          <div className="grid">
            <div className="card"><div className="muted">Veritabanı</div><strong>{d.database}</strong></div>
            <div className="card"><div className="muted">Ortam</div><strong>{d.appEnv}</strong></div>
            <div className="card"><div className="muted">Gizli bilgi deposu</div><strong>{d.secretManager}</strong></div>
            <div className="card"><div className="muted">Son başarılı yedek</div><strong>{dt(d.lastSuccessfulBackup)}</strong></div>
            <div className="card"><div className="muted">Son geri yükleme testi</div><strong>{dt(d.lastRestoreTest)}</strong></div>
          </div>
          <h2>Ayarlar</h2>
          <div className="card table-wrap"><table><tbody>
            {d.settings.map((s: any) => (
              <tr key={s.key}><td><code>{s.key}</code><div className="muted">{s.description}</div></td><td><code>{JSON.stringify(s.value)}</code></td>
                <td>{s.key === 'maintenance_mode' && <button className="secondary" onClick={async () => { await a.run(() => api(`/api/admin/system/settings/${s.key}`, { method: 'PUT', body: { value: !s.value } }), 'Güncellendi.'); h.reload(); }}>{s.value ? 'Bakım modunu kapat' : 'Bakım modunu aç'}</button>}</td></tr>
            ))}
          </tbody></table></div>
          <h2>Süresi yaklaşan anahtarlar</h2>
          {d.expiringSecrets.length === 0 ? <p className="muted">Yok.</p> : <ul>{d.expiringSecrets.map((s: any) => <li key={s.ref}>{s.ref} — {dt(s.expires_at)}</li>)}</ul>}
          <h2>Yedekleme kayıtları</h2>
          <div className="card table-wrap"><table><thead><tr><th>Tür</th><th>Durum</th><th>Depolama</th><th>Zaman</th></tr></thead><tbody>
            {d.backups.map((b: any, i: number) => <tr key={i}><td>{b.kind}</td><td><StatusBadge status={b.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED'} text={b.status} /></td><td>{b.storage_ref}</td><td>{dt(b.created_at)}</td></tr>)}
          </tbody></table></div>
          <h2>Migration geçmişi</h2>
          <ul>{d.migrations.map((m: any) => <li key={m.version}>{m.name} — {dt(m.applied_at)}</li>)}</ul>
        </>
      )}
    </>
  );
}

export function AdminGoLive() {
  const g = useLoad<any>('/api/admin/golive');
  const [ev, setEv] = useState<Record<string, string>>({});
  const a = useAction();
  return (
    <>
      <h1>Yayın öncesi zorunlu kontrol</h1>
      <AdminError error={a.error ?? g.error} onVerified={g.reload} /><Msg message={a.message} />
      {g.data && (
        <>
          <div className="alert warn">{g.data.notice}</div>
          <div className="card table-wrap"><table>
            <thead><tr><th>Madde</th><th>Durum</th><th>Kanıt</th><th /></tr></thead>
            <tbody>{g.data.items.map((i: any) => (
              <tr key={i.code}>
                <td>{i.title}{i.is_automated && <div className="muted">Sistem tarafından ayrıca kontrol edilir</div>}</td>
                <td><span className={`badge ${i.status === 'VERIFIED' ? 'ok' : i.status === 'REJECTED' ? 'err' : 'warn'}`}>{i.status === 'VERIFIED' ? 'Doğrulandı' : i.status === 'REJECTED' ? 'Reddedildi' : 'Eksik'}</span>{i.verified_by_email && <div className="muted">{i.verified_by_email} · {dt(i.verified_at)}</div>}</td>
                <td>{i.evidence_ref ?? <input aria-label="Kanıt belge referansı" placeholder="Belge referansı" value={ev[i.code] ?? ''} onChange={(e) => setEv({ ...ev, [i.code]: e.target.value })} />}</td>
                <td>{i.status !== 'VERIFIED'
                  ? <button disabled={!ev[i.code]} onClick={async () => { await a.run(() => api(`/api/admin/golive/${i.code}/verify`, { body: { status: 'VERIFIED', evidenceRef: ev[i.code] } }), 'Madde güncellendi.'); g.reload(); }}>Doğrula</button>
                  : <button className="secondary" onClick={async () => { await a.run(() => api(`/api/admin/golive/${i.code}/verify`, { body: { status: 'OPEN' } })); g.reload(); }}>Geri al</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <h2>Canlı kullanımı engelleyen maddeler</h2>
          {g.data.blockers.length === 0 ? <p>Engel yok.</p> : <ul>{g.data.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>}
        </>
      )}
    </>
  );
}

export function AdminLegal() {
  const docs = useLoad<any[]>('/api/admin/legal-documents');
  const dp = useLoad<any[]>('/api/admin/data-processors');
  const [f, setF] = useState({ docType: 'KVKK_NOTICE', version: '1.0-taslak', title: '', bodyMarkdown: '', publish: false, legalReviewedBy: '' });
  const a = useAction();
  return (
    <>
      <h1>Hukuki uyum ve veri koruma</h1>
      <div className="alert warn">Bu ekranlar hazırlık amaçlıdır. KVKK ve ödeme mevzuatı yükümlülükleri; şirketin faaliyet türü, verilerin niteliği ve veri aktarımına göre hukuk danışmanı tarafından değerlendirilmelidir.</div>
      <AdminError error={a.error ?? docs.error} onVerified={docs.reload} /><Msg message={a.message} />
      <div className="card table-wrap"><table><thead><tr><th>Tür</th><th>Sürüm</th><th>Başlık</th><th>Durum</th></tr></thead><tbody>
        {docs.data?.map((d) => <tr key={d.id}><td>{d.doc_type}</td><td>{d.version}</td><td>{d.title}</td><td>{d.is_draft ? 'Taslak' : `Yayımlandı (${d.legal_reviewed_by})`}</td></tr>)}
      </tbody></table></div>
      <div className="card">
        <h2>Yeni metin sürümü</h2>
        <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api('/api/admin/legal-documents', { body: { ...f, legalReviewedBy: f.legalReviewedBy || undefined } }), 'Kaydedildi.')) docs.reload(); }}>
          <label htmlFor="dt">Tür</label>
          <select id="dt" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}>
            {['KVKK_NOTICE', 'PRIVACY_POLICY', 'TERMS_OF_USE', 'COOKIE_POLICY', 'RETENTION_POLICY', 'EXPLICIT_CONSENT'].map((x) => <option key={x}>{x}</option>)}
          </select>
          <label htmlFor="v">Sürüm</label><input id="v" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />
          <label htmlFor="t">Başlık</label><input id="t" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <label htmlFor="b">Metin</label><textarea id="b" rows={8} value={f.bodyMarkdown} onChange={(e) => setF({ ...f, bodyMarkdown: e.target.value })} />
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.publish} onChange={(e) => setF({ ...f, publish: e.target.checked })} /> Yayımla (hukuki inceleme tamamlandı)</label>
          {f.publish && (<><label htmlFor="r">İnceleyen hukukçu / kurum</label><input id="r" value={f.legalReviewedBy} onChange={(e) => setF({ ...f, legalReviewedBy: e.target.value })} /></>)}
          <button disabled={a.busy} style={{ marginTop: 8 }}>Kaydet</button>
        </form>
      </div>
      <h2>Veri işleyen / hizmet sağlayıcı envanteri</h2>
      <div className="card table-wrap"><table><thead><tr><th>Ad</th><th>Rol</th><th>Veri kategorileri</th><th>Yurt dışı aktarım</th><th>Durum</th></tr></thead><tbody>
        {dp.data?.map((d) => <tr key={d.id}><td>{d.name}</td><td>{d.role}</td><td>{d.data_categories.join(', ')}</td><td>{d.transfer_abroad == null ? 'Belirlenmedi' : d.transfer_abroad ? 'Evet' : 'Hayır'}</td><td>{d.status}</td></tr>)}
      </tbody></table></div>
    </>
  );
}

export { tl };

function EmailChannelForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState({ providerName: '', status: 'TEST', smtpUrl: '' });
  const [result, setResult] = useState<string | null>(null);
  const a = useAction();
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      const r = await a.run(() => api('/api/admin/notification-channels/EMAIL', { method: 'PUT', body: { providerName: f.providerName, status: f.status, smtpUrl: f.smtpUrl || undefined } }), 'E-posta kanalı kaydedildi.');
      if (r) { setF({ ...f, smtpUrl: '' }); onSaved(); }
    }}>
      <h3>E-posta (SMTP)</h3>
      <AdminError error={a.error} /><Msg message={a.message} />
      <label htmlFor="ep">Sağlayıcı adı</label>
      <input id="ep" required value={f.providerName} onChange={(e) => setF({ ...f, providerName: e.target.value })} />
      <label htmlFor="es">Durum</label>
      <select id="es" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        <option value="TEST">Test</option><option value="ACTIVE">Etkin</option><option value="DISABLED">Kapalı</option>
      </select>
      <label htmlFor="eu">SMTP bağlantı adresi (yalnızca değiştirirken; kaydedildikten sonra gösterilmez)</label>
      <input id="eu" type="password" autoComplete="off" placeholder="smtps://kullanici:parola@sunucu:465" value={f.smtpUrl} onChange={(e) => setF({ ...f, smtpUrl: e.target.value })} />
      <div className="row">
        <button type="submit" disabled={a.busy}>Kaydet</button>
        <button type="button" className="secondary" disabled={a.busy} onClick={async () => {
          const r = await a.run(() => api<{ status: string; error?: string }>('/api/admin/notification-channels/EMAIL/test', { method: 'POST' }));
          if (r) setResult(r.status === 'SENT' ? 'Deneme e-postası gönderildi (gelen kutunuzu kontrol edin).' : `Gönderilmedi: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
        }}>Kendime deneme e-postası gönder</button>
      </div>
      {result && <p>{result}</p>}
    </form>
  );
}
