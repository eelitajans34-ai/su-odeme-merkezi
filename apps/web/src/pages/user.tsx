import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dt, newIdempotencyKey, tl, toMinor } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, Msg, StatusBadge, TestBadge, useAction, useLoad } from '../components/ui';

// ---------------- Aboneliklerim ----------------
export function Subscriptions() {
  const subs = useLoad<any[]>('/api/subscriptions');
  const utils = useLoad<any[]>('/api/utilities');
  const [f, setF] = useState({ utilityId: '', subscriberNo: '', nickname: '' });
  const [qr, setQr] = useState('');
  const a = useAction();
  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await a.run(() => api('/api/subscriptions', { body: { utilityId: f.utilityId, subscriberNo: f.subscriberNo, nickname: f.nickname || undefined } }), 'Abonelik eklendi.');
    if (r) { setF({ ...f, subscriberNo: '', nickname: '' }); subs.reload(); }
  }
  async function addQr(e: FormEvent) {
    e.preventDefault();
    const r = await a.run(() => api('/api/subscriptions/qr', { body: { payload: qr } }), 'QR ile abonelik eklendi.');
    if (r) { setQr(''); subs.reload(); }
  }
  return (
    <>
      <h1>Aboneliklerim</h1>
      <Loading loading={subs.loading}>
        {subs.data?.length === 0 && <p>Henüz abonelik eklemediniz.</p>}
        <div className="grid">
          {subs.data?.map((s) => (
            <div className="card" key={s.id}>
              <strong>{s.nickname ?? s.utilityName}</strong> <TestBadge show={s.isTestData} />
              <dl className="kv">
                <dt>Su idaresi</dt><dd>{s.utilityName}</dd>
                <dt>Abone no</dt><dd>{s.subscriberMasked}</dd>
                <dt>Doğrulama</dt><dd>{s.verificationStatus === 'VERIFIED' ? 'Su idaresince doğrulandı' : s.verificationStatus === 'INTEGRATION_PENDING' ? 'Entegrasyon bekleniyor — doğrulanamadı' : s.verificationStatus}</dd>
              </dl>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="secondary" onClick={async () => { if (confirm('Abonelik kaldırılsın mı?')) { await a.run(() => api(`/api/subscriptions/${s.id}`, { method: 'DELETE' })); subs.reload(); } }}>Kaldır</button>
              </div>
            </div>
          ))}
        </div>
      </Loading>
      <div className="card">
        <h2>Yeni abonelik ekle</h2>
        <form onSubmit={add}>
          <label htmlFor="u">Su idaresi</label>
          <select id="u" required value={f.utilityId} onChange={(e) => setF({ ...f, utilityId: e.target.value })}>
            <option value="">Seçin</option>
            {utils.data?.map((u) => <option key={u.id} value={u.id}>{u.name} — {u.statusLabel}</option>)}
          </select>
          <label htmlFor="sn">Abone numarası</label>
          <input id="sn" required value={f.subscriberNo} onChange={(e) => setF({ ...f, subscriberNo: e.target.value })} />
          <label htmlFor="nn">Kısa ad (isteğe bağlı)</label>
          <input id="nn" value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
          <button disabled={a.busy} style={{ marginTop: 12 }}>Ekle</button>
        </form>
        <h2>QR kod ile ekle</h2>
        <p className="muted">Mobil uygulamada kamera ile taranır. Yalnızca su idaresinin tanımladığı ve doğrulanabilen QR biçimleri kabul edilir; tanınmazsa elle girin.</p>
        <form onSubmit={addQr} className="row">
          <input aria-label="QR içeriği" placeholder="QR içeriği" value={qr} onChange={(e) => setQr(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
          <button disabled={a.busy || !qr}>QR ile ekle</button>
        </form>
        <ErrorBox error={a.error} />
        <Msg message={a.message} />
      </div>
    </>
  );
}

// ---------------- Su kartlarım ----------------
export function Cards() {
  const cards = useLoad<any[]>('/api/cards');
  const subs = useLoad<any[]>('/api/subscriptions');
  const [f, setF] = useState({ subscriptionId: '', cardSerial: '' });
  const a = useAction();
  return (
    <>
      <h1>Su kartlarım</h1>
      <Loading loading={cards.loading}>
        {cards.data?.length === 0 && <p>Kayıtlı kartınız yok.</p>}
        <div className="table-wrap card">
          <table>
            <thead><tr><th>Kart</th><th>Abonelik</th><th>Su idaresi</th><th>Yükleme yöntemi</th><th /></tr></thead>
            <tbody>
              {cards.data?.map((c) => (
                <tr key={c.id}>
                  <td>{c.nickname ?? c.cardMasked}</td><td>{c.subscriberMasked}</td><td>{c.utilityName}</td>
                  <td>{({ REMOTE_CREDIT: 'Uzaktan yükleme', CARD_WRITE_AT_TERMINAL: 'Terminalde karta yazma', NOT_SUPPORTED: 'Desteklenmiyor', UNKNOWN: 'Bilinmiyor' } as any)[c.topupMethod]}</td>
                  <td>{c.subscriptionVerified && c.topupMethod !== 'NOT_SUPPORTED' && <Link to={`/kart-yukle?kart=${c.id}`}>Yükle</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
      <div className="card">
        <h2>Kart ekle</h2>
        <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api(`/api/subscriptions/${f.subscriptionId}/cards`, { body: { cardSerial: f.cardSerial } }), 'Kart eklendi.')) cards.reload(); }}>
          <label htmlFor="s">Abonelik</label>
          <select id="s" required value={f.subscriptionId} onChange={(e) => setF({ ...f, subscriptionId: e.target.value })}>
            <option value="">Seçin</option>
            {subs.data?.map((s) => <option key={s.id} value={s.id}>{s.utilityName} — {s.subscriberMasked}</option>)}
          </select>
          <label htmlFor="cs">Kart numarası</label>
          <input id="cs" required value={f.cardSerial} onChange={(e) => setF({ ...f, cardSerial: e.target.value })} />
          <ErrorBox error={a.error} />
          <Msg message={a.message} />
          <button disabled={a.busy} style={{ marginTop: 12 }}>Ekle</button>
        </form>
      </div>
    </>
  );
}

// ---------------- Su kartına bakiye yükle ----------------
export function Topup() {
  const cards = useLoad<any[]>('/api/cards');
  const params = new URLSearchParams(location.search);
  const [cardId, setCardId] = useState(params.get('kart') ?? '');
  const [amount, setAmount] = useState('100');
  const [quote, setQuote] = useState<any>(null);
  const [idem, setIdem] = useState(newIdempotencyKey());
  const q = useAction();
  const p = useAction();
  const eligible = useMemo(() => (cards.data ?? []).filter((c) => c.subscriptionVerified && c.topupMethod !== 'NOT_SUPPORTED'), [cards.data]);

  useEffect(() => { setQuote(null); setIdem(newIdempotencyKey()); }, [cardId, amount]);

  async function getQuote(e: FormEvent) {
    e.preventDefault();
    const r = await q.run(() => api('/api/topups/quote', { body: { waterCardId: cardId, amountMinor: toMinor(amount) } }));
    if (r) setQuote(r);
  }
  async function pay() {
    const r = await p.run(() => api('/api/topups', { body: { waterCardId: cardId, amountMinor: quote.amountMinor }, idempotencyKey: idem }));
    if (r?.checkoutUrl) location.assign(r.checkoutUrl);
  }
  return (
    <>
      <h1>Su kartına bakiye yükle</h1>
      <div className="card">
        <form onSubmit={getQuote}>
          <label htmlFor="c">Su kartı</label>
          <select id="c" required value={cardId} onChange={(e) => setCardId(e.target.value)}>
            <option value="">Seçin</option>
            {eligible.map((c) => <option key={c.id} value={c.id}>{c.utilityName} — {c.nickname ?? c.cardMasked}</option>)}
          </select>
          {cards.data && eligible.length === 0 && <p className="muted">Yüklemeye uygun kart yok. Abonelik su idaresince doğrulanmalı ve kart uzaktan yüklemeyi desteklemelidir.</p>}
          <label htmlFor="a">Yükleme tutarı (TL)</label>
          <input id="a" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            {['50', '100', '200', '500'].map((v) => <button type="button" className="secondary" key={v} onClick={() => setAmount(v)}>{v} TL</button>)}
          </div>
          <ErrorBox error={q.error} />
          <button disabled={q.busy || !cardId} style={{ marginTop: 12 }}>Tutarı hesapla</button>
        </form>
      </div>
      {quote && (
        <div className="card" aria-live="polite">
          <h2>Ödeme özeti</h2>
          <dl className="kv">
            <dt>Yükleme tutarı</dt><dd>{tl(quote.amountMinor)}</dd>
            <dt>Hizmet bedeli</dt><dd>{tl(quote.feeMinor)}</dd>
            <dt>Toplam</dt><dd className="total">{tl(quote.totalMinor)}</dd>
          </dl>
          <p className="muted">{quote.feeDescription}</p>
          {!quote.readiness?.ok && (
            <div className="alert warn"><strong>Şu anda yükleme yapılamıyor:</strong><ul>{quote.readiness?.reasons?.map((r: string) => <li key={r}>{r}</li>)}</ul></div>
          )}
          {quote.readiness?.mode === 'TEST' && <div className="alert warn">TEST MODU: Gerçek ödeme alınmaz ve gerçek kart yüklemesi yapılmaz.</div>}
          <p className="muted">Ödemeniz güvenli ödeme sağlayıcısının sayfasında alınır; kart bilgileriniz bu sitede saklanmaz. Yükleme, su idaresi teyit ettikten sonra tamamlanmış sayılır.</p>
          <ErrorBox error={p.error} />
          <button disabled={p.busy || !quote.readiness?.ok} onClick={pay}>Ödemeye geç</button>
        </div>
      )}
    </>
  );
}

export function TransactionDetail({ kind }: { kind: 'yukleme' | 'fatura' }) {
  const { id } = useParams();
  const base = kind === 'yukleme' ? '/api/topups' : '/api/bill-payments';
  const tx = useLoad<any>(`${base}/${id}`, [id]);
  const a = useAction();
  useEffect(() => {
    // Ödeme dönüşünde durum sunucu tarafında sağlayıcıdan sorgulanır (istemci beyanına güvenilmez)
    if (tx.data && ['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(tx.data.status)) {
      void a.run(() => api(`${base}/${id}/refresh`, { method: 'POST' })).then((r) => r && tx.setData(r));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.data?.id]);
  const t = tx.data;
  return (
    <Loading loading={tx.loading}>
      <ErrorBox error={tx.error} />
      {t && (
        <div className="card">
          <h1>{kind === 'yukleme' ? 'Kart yükleme işlemi' : 'Fatura ödeme işlemi'} <TestBadge show={t.isTest} /></h1>
          <p><StatusBadge status={t.status} text={t.statusText} /></p>
          {['UNKNOWN', 'REQUIRES_REVIEW', 'TOPUP_PENDING', 'COLLECTION_PENDING', 'PAYMENT_CONFIRMED'].includes(t.status) && (
            <div className="alert warn">İşleminiz su idaresinin teyidini bekliyor. Lütfen tekrar ödeme yapmayın; sonuç netleştiğinde bildirim alacaksınız.</div>
          )}
          <dl className="kv">
            <dt>İşlem no</dt><dd>{t.ref}</dd>
            <dt>Su idaresi</dt><dd>{t.utilityName}</dd>
            <dt>Abone no</dt><dd>{t.subscriberMasked}</dd>
            {t.cardMasked && (<><dt>Kart</dt><dd>{t.cardMasked}</dd></>)}
            <dt>Tutar</dt><dd>{tl(t.amountMinor)}</dd>
            <dt>Hizmet bedeli</dt><dd>{tl(t.feeMinor)}</dd>
            <dt>Toplam</dt><dd>{tl(t.totalMinor)}</dd>
            <dt>Oluşturulma</dt><dd>{dt(t.createdAt)}</dd>
            <dt>Tamamlanma</dt><dd>{dt(t.completedAt)}</dd>
            {t.utilityRef && (<><dt>Su idaresi ref.</dt><dd>{t.utilityRef}</dd></>)}
          </dl>
          {t.errorMessage && <div className="alert err">{t.errorMessage}</div>}
          <div className="row" style={{ marginTop: 12 }}>
            {t.receiptId && <Link className="btn" to={`/makbuzlar/${t.receiptId}`}>Makbuzu görüntüle</Link>}
            <button className="secondary" onClick={() => tx.reload()}>Durumu yenile</button>
            {['REQUIRES_REVIEW', 'FAILED', 'UNKNOWN', 'REFUND_PENDING'].includes(t.status) && <Link to={`/destek?islem=${t.id}&tur=${t.type}`}>Destek talebi oluştur</Link>}
          </div>
        </div>
      )}
    </Loading>
  );
}

// ---------------- Fatura sorgula ve öde ----------------
export function Bills() {
  const subs = useLoad<any[]>('/api/subscriptions');
  const [subId, setSubId] = useState('');
  const [inq, setInq] = useState<any>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [quote, setQuote] = useState<any>(null);
  const a = useAction();
  async function inquire(e: FormEvent) {
    e.preventDefault();
    setQuote(null);
    const r = await a.run(() => api('/api/bill-payments/inquiries', { body: { subscriptionId: subId }, idempotencyKey: newIdempotencyKey() }));
    if (r) { setInq(r); setSelected(r.bills.map((b: any) => b.billId)); }
  }
  async function getQuote() {
    const r = await a.run(() => api(`/api/bill-payments/${inq.id}/quote`, { body: { billIds: selected } }));
    if (r) setQuote(r);
  }
  async function pay() {
    const r = await a.run(() => api(`/api/bill-payments/${inq.id}/pay`, { body: { billIds: selected } }));
    if (r?.checkoutUrl) location.assign(r.checkoutUrl);
  }
  return (
    <>
      <h1>Su faturası sorgula ve öde</h1>
      <div className="card">
        <form onSubmit={inquire}>
          <label htmlFor="s">Abonelik</label>
          <select id="s" required value={subId} onChange={(e) => setSubId(e.target.value)}>
            <option value="">Seçin</option>
            {subs.data?.map((s) => <option key={s.id} value={s.id} disabled={s.verificationStatus !== 'VERIFIED'}>{s.utilityName} — {s.subscriberMasked}{s.verificationStatus !== 'VERIFIED' ? ' (doğrulanmadı)' : ''}</option>)}
          </select>
          <button disabled={a.busy || !subId} style={{ marginTop: 12 }}>Borç sorgula</button>
        </form>
        <ErrorBox error={a.error} />
      </div>
      {inq && (
        <div className="card">
          <h2>Sorgu sonucu <TestBadge show={inq.isTest} /></h2>
          {inq.status !== 'BILL_FOUND' ? (
            <p>{inq.errorMessage ?? inq.statusText}</p>
          ) : (
            <>
              <p className="muted">Bu sorgu {dt(inq.inquiryExpiresAt)} tarihine kadar geçerlidir.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Seç</th><th>Dönem</th><th>Son ödeme</th><th>Tutar</th></tr></thead>
                  <tbody>
                    {inq.bills.map((b: any) => (
                      <tr key={b.billId}>
                        <td><input type="checkbox" style={{ width: 'auto' }} aria-label={`${b.period} faturasını seç`} checked={selected.includes(b.billId)} onChange={(e) => { setQuote(null); setSelected(e.target.checked ? [...selected, b.billId] : selected.filter((x) => x !== b.billId)); }} /></td>
                        <td>{b.period}</td><td>{b.dueDate}</td><td>{tl(b.amountMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="secondary" disabled={!selected.length || a.busy} onClick={getQuote} style={{ marginTop: 12 }}>Toplamı hesapla</button>
              {quote && (
                <>
                  <dl className="kv" style={{ marginTop: 12 }}>
                    <dt>Fatura tutarı</dt><dd>{tl(quote.amountMinor)}</dd>
                    <dt>Hizmet bedeli</dt><dd>{tl(quote.feeMinor)}</dd>
                    <dt>Toplam</dt><dd className="total">{tl(quote.totalMinor)}</dd>
                  </dl>
                  <p className="muted">{quote.feeDescription}</p>
                  <p className="muted">Fatura, su idaresi tahsilatı teyit ettikten sonra "ödendi" olarak gösterilir.</p>
                  <button disabled={a.busy} onClick={pay}>Ödemeye geç</button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- İşlem geçmişi ----------------
export function History() {
  const tx = useLoad<any[]>('/api/transactions');
  return (
    <>
      <h1>İşlem geçmişi</h1>
      <Loading loading={tx.loading}>
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Tarih</th><th>Tür</th><th>İşlem no</th><th>Tutar</th><th>Durum</th></tr></thead>
            <tbody>
              {tx.data?.map((t) => (
                <tr key={t.id}>
                  <td>{dt(t.createdAt)}</td>
                  <td>{t.type === 'TOPUP' ? 'Kart yükleme' : 'Fatura'} <TestBadge show={t.isTest} /></td>
                  <td><Link to={`/islemler/${t.type === 'TOPUP' ? 'yukleme' : 'fatura'}/${t.id}`}>{t.ref}</Link></td>
                  <td>{tl(t.totalMinor)}</td>
                  <td><StatusBadge status={t.status} text={t.statusText} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {tx.data?.length === 0 && <p>Henüz işleminiz yok.</p>}
        </div>
      </Loading>
    </>
  );
}

// ---------------- Makbuzlar ----------------
export function Receipts() {
  const r = useLoad<any[]>('/api/receipts');
  return (
    <>
      <h1>Makbuzlarım</h1>
      <Loading loading={r.loading}>
        {r.data?.length === 0 && <p>Makbuz yok. Makbuzlar yalnızca su idaresince teyit edilmiş işlemler için düzenlenir.</p>}
        {r.data?.map((x) => (
          <div className="card row" key={x.id}>
            <span style={{ flex: 1 }}>{x.content.baslik} — {x.receipt_no} <TestBadge show={x.environment === 'TEST'} /></span>
            <span>{tl(x.content.toplamKurus)}</span>
            <Link to={`/makbuzlar/${x.id}`}>Görüntüle</Link>
          </div>
        ))}
      </Loading>
    </>
  );
}

export function ReceiptView() {
  const { id } = useParams();
  const r = useLoad<any>(`/api/receipts/${id}`, [id]);
  const c = r.data?.content;
  async function share() {
    const text = `${c.baslik}\nMakbuz no: ${r.data.receipt_no}\nİşlem no: ${c.islemNo}\nToplam: ${tl(c.toplamKurus)}`;
    if (navigator.share) await navigator.share({ title: c.baslik, text }).catch(() => undefined);
    else await navigator.clipboard.writeText(text);
  }
  return (
    <Loading loading={r.loading}>
      <ErrorBox error={r.error} />
      {c && (
        <div className="card">
          {c.ortamUyarisi && <div className="alert warn"><strong>{c.ortamUyarisi}</strong></div>}
          <h1>{c.baslik}</h1>
          <dl className="kv">
            <dt>Makbuz no</dt><dd>{r.data.receipt_no}</dd>
            <dt>İşlem no</dt><dd>{c.islemNo}</dd>
            <dt>Su idaresi</dt><dd>{c.suIdaresi}</dd>
            <dt>Abone no</dt><dd>{c.aboneNo}</dd>
            {c.kartNo && (<><dt>Kart</dt><dd>{c.kartNo}</dd></>)}
            <dt>Tutar</dt><dd>{tl(c.tutarKurus)}</dd>
            <dt>Hizmet bedeli</dt><dd>{tl(c.hizmetBedeliKurus)}</dd>
            <dt>Toplam</dt><dd>{tl(c.toplamKurus)}</dd>
            <dt>Ödeme referansı</dt><dd>{c.odemeReferansi}</dd>
            <dt>Su idaresi referansı</dt><dd>{c.suIdaresiReferansi}</dd>
            <dt>Tarih</dt><dd>{dt(c.tamamlanmaZamani)}</dd>
          </dl>
          <p className="muted">{c.teyit}</p>
          <div className="row no-print"><button onClick={() => print()}>Yazdır / PDF</button><button className="secondary" onClick={share}>Paylaş</button></div>
        </div>
      )}
    </Loading>
  );
}

// ---------------- Destek ve iade talepleri ----------------
export function Support() {
  const params = new URLSearchParams(location.search);
  const tickets = useLoad<any[]>('/api/support-tickets');
  const [f, setF] = useState({ category: params.get('islem') ? 'REFUND' : 'OTHER', subject: '', message: '' });
  const [open, setOpen] = useState<string | null>(null);
  const msgs = useLoad<any[]>(open ? `/api/support-tickets/${open}/messages` : null, [open]);
  const [reply, setReply] = useState('');
  const a = useAction();
  async function create(e: FormEvent) {
    e.preventDefault();
    const body: any = { ...f };
    if (params.get('islem')) { body.relatedId = params.get('islem'); body.relatedType = params.get('tur'); }
    if (await a.run(() => api('/api/support-tickets', { body }), 'Talebiniz alındı.')) { setF({ ...f, subject: '', message: '' }); tickets.reload(); }
  }
  return (
    <>
      <h1>İade ve destek talepleri</h1>
      <div className="card">
        <h2>Yeni talep</h2>
        <form onSubmit={create}>
          <label htmlFor="c">Konu türü</label>
          <select id="c" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="REFUND">İade talebi</option><option value="TRANSACTION">İşlem sorunu</option><option value="ACCOUNT">Hesap</option>
            <option value="KVKK_REQUEST">KVKK başvurusu (veri erişim/silme vb.)</option><option value="OTHER">Diğer</option>
          </select>
          <label htmlFor="s">Başlık</label>
          <input id="s" required minLength={3} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
          <label htmlFor="m">Açıklama</label>
          <textarea id="m" required minLength={5} rows={4} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
          <p className="muted">Parola, kart numarası veya doğrulama kodu paylaşmayın.</p>
          <ErrorBox error={a.error} /><Msg message={a.message} />
          <button disabled={a.busy}>Gönder</button>
        </form>
      </div>
      <Loading loading={tickets.loading}>
        {tickets.data?.map((t) => (
          <div className="card" key={t.id}>
            <div className="row"><strong style={{ flex: 1 }}>{t.subject}</strong><span className="badge">{t.status}</span></div>
            <p className="muted">{t.ticket_no} · {dt(t.created_at)}</p>
            <button className="secondary" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Kapat' : 'Mesajlar'}</button>
            {open === t.id && (
              <div>
                {msgs.data?.map((m, i) => <p key={i}><strong>{m.author_role === 'USER' ? 'Siz' : 'Destek'}:</strong> {m.body}</p>)}
                <form className="row" onSubmit={async (e) => { e.preventDefault(); await a.run(() => api(`/api/support-tickets/${t.id}/messages`, { body: { message: reply } })); setReply(''); msgs.reload(); }}>
                  <input aria-label="Yanıt" value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} /><button disabled={!reply}>Yanıtla</button>
                </form>
              </div>
            )}
          </div>
        ))}
      </Loading>
    </>
  );
}

// ---------------- Bildirimler ----------------
export function Notifications() {
  const n = useLoad<any[]>('/api/notifications');
  return (
    <>
      <h1>Bildirimler</h1>
      <Loading loading={n.loading}>
        {n.data?.length === 0 && <p>Bildirim yok.</p>}
        {n.data?.map((x) => (
          <div className="card" key={x.id} style={{ opacity: x.read_at ? 0.75 : 1 }}>
            <div className="row"><strong style={{ flex: 1 }}>{x.title}</strong><span className="muted">{dt(x.created_at)}</span></div>
            <p>{x.body}</p>
            {!x.read_at && <button className="secondary" onClick={async () => { await api(`/api/notifications/${x.id}/read`, { method: 'POST' }); n.reload(); }}>Okundu işaretle</button>}
          </div>
        ))}
      </Loading>
    </>
  );
}

// ---------------- Profil ve güvenlik ----------------
export function Security() {
  const { me, refresh } = useAuth();
  const sessions = useLoad<any[]>('/api/auth/sessions');
  const [profile, setProfile] = useState({ fullName: me?.fullName ?? '', phone: me?.phone ?? '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [totp, setTotp] = useState<any>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const a = useAction();
  return (
    <>
      <h1>Profil ve güvenlik</h1>
      <ErrorBox error={a.error} /><Msg message={a.message} />
      {me?.mfa.enrollmentRequired && <div className="alert warn">Hesabınız için iki aşamalı doğrulama kurulumu zorunludur. Kurulum tamamlanmadan yönetim işlemleri yapılamaz.</div>}
      <div className="card">
        <h2>Profil</h2>
        <form onSubmit={async (e) => { e.preventDefault(); await a.run(() => api('/api/profile', { method: 'PATCH', body: { fullName: profile.fullName || undefined, phone: profile.phone || null } }), 'Profil güncellendi.'); await refresh(); }}>
          <label htmlFor="fn">Ad soyad</label><input id="fn" value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} />
          <label htmlFor="ph">Telefon</label><input id="ph" type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
          <p className="muted">E-posta: {me?.email}</p>
          <button disabled={a.busy}>Kaydet</button>
        </form>
      </div>
      <div className="card">
        <h2>İki aşamalı doğrulama (TOTP)</h2>
        <p>Durum: <strong>{me?.mfa.enrolled ? 'Etkin' : 'Kapalı'}</strong></p>
        {!totp && <button onClick={async () => setTotp(await a.run(() => api('/api/auth/mfa/totp/start', { method: 'POST' })))}>{me?.mfa.enrolled ? 'Doğrulama uygulamasını değiştir' : 'Doğrulama uygulaması kur'}</button>}
        {totp && !codes && (
          <form onSubmit={async (e) => { e.preventDefault(); const r = await a.run(() => api('/api/auth/mfa/totp/confirm', { body: { code } }), 'İki aşamalı doğrulama etkinleştirildi.'); if (r) { setCodes(r.recoveryCodes); await refresh(); } }}>
            <p>Doğrulama uygulamanıza (Google Authenticator, Microsoft Authenticator vb.) aşağıdaki anahtarı ekleyin:</p>
            <p><code style={{ wordBreak: 'break-all' }}>{totp.secret}</code></p>
            <p className="muted"><a href={totp.otpauthUri}>Uygulamada aç</a> (mobil cihazda)</p>
            <label htmlFor="tc">Uygulamadaki 6 haneli kod</label>
            <input id="tc" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
            <button disabled={a.busy} style={{ marginTop: 8 }}>Onayla</button>
          </form>
        )}
        {codes && (
          <div className="alert warn">
            <strong>Kurtarma kodlarınızı güvenli bir yere kaydedin. Bir daha gösterilmeyecek.</strong>
            <ul>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          </div>
        )}
        <p className="muted">Passkey desteği yol haritasındadır. SMS tek başına yönetici güvenliği için kullanılmaz.</p>
      </div>
      <div className="card">
        <h2>Parola değiştir</h2>
        <form onSubmit={async (e) => { e.preventDefault(); if (await a.run(() => api('/api/auth/password/change', { body: pw }), 'Parola değiştirildi; diğer oturumlar kapatıldı.')) setPw({ currentPassword: '', newPassword: '' }); }}>
          <label htmlFor="cp">Mevcut parola</label><input id="cp" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          <label htmlFor="np">Yeni parola</label><input id="np" type="password" minLength={12} autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          <button disabled={a.busy} style={{ marginTop: 8 }}>Değiştir</button>
        </form>
      </div>
      <div className="card">
        <h2>Açık oturumlar</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Cihaz</th><th>IP</th><th>Son etkinlik</th><th /></tr></thead>
          <tbody>{sessions.data?.map((s) => (
            <tr key={s.id}><td>{s.client_type} {s.current && <span className="badge ok">Bu oturum</span>}<div className="muted">{s.user_agent?.slice(0, 60)}</div></td><td>{s.ip}</td><td>{dt(s.last_seen_at)}</td>
              <td>{!s.current && <button className="secondary" onClick={async () => { await a.run(() => api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' })); sessions.reload(); }}>Sonlandır</button>}</td></tr>
          ))}</tbody>
        </table></div>
        <button className="danger" onClick={async () => { await a.run(() => api('/api/auth/sessions/revoke-others', { method: 'POST' }), 'Diğer tüm oturumlar sonlandırıldı.'); sessions.reload(); }}>Diğer tüm oturumları sonlandır</button>
      </div>
    </>
  );
}
