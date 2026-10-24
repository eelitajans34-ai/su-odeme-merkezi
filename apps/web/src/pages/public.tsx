import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, Msg, useAction, useLoad } from '../components/ui';

export function Home() {
  const { me } = useAuth();
  const status = useLoad<any>('/api/platform/status');
  return (
    <>
      <h1>Su kartı yükleme ve fatura ödeme</h1>
      <p>Su kartınıza bakiye yükleyin, su faturanızı sorgulayıp ödeyin. İşlem sonucu yalnızca su idaresi teyit ettikten sonra "tamamlandı" olarak gösterilir.</p>
      {status.data?.environmentNotice && <div className="alert warn">{status.data.environmentNotice}</div>}
      <div className="grid">
        <div className="card">
          <h2>Su kartına bakiye yükle</h2>
          <p className="muted">Kayıtlı kartınızı seçin, tutarı belirleyin, hizmet bedeli ve toplamı ödeme öncesi görün.</p>
          <Link className="btn" to={me ? '/kart-yukle' : '/giris'}>Yükleme yap</Link>
        </div>
        <div className="card">
          <h2>Su faturası sorgula ve öde</h2>
          <p className="muted">Güncel borcunuz resmî sistemden sorgulanır.</p>
          <Link className="btn" to={me ? '/fatura' : '/giris'}>Fatura sorgula</Link>
        </div>
      </div>
      <div className="card">
        <h2>Hizmet durumu</h2>
        <p>Ödeme hizmeti: <strong>{status.data?.paymentProvider ?? '…'}</strong></p>
        <p className="muted">Su idaresi ve ödeme kuruluşu entegrasyonları yetkilendirme tamamlanana kadar "Kurulum bekleniyor" olarak gösterilir.</p>
      </div>
    </>
  );
}

export function Login() {
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [step, setStep] = useState<'creds' | 'mfa'>('creds');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const a = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step === 'creds') {
      const r = await a.run(() => api('/api/auth/login', { body: { email, password, clientType: 'WEB' } }));
      if (!r) return;
      if (r.mfaRequired) return setStep('mfa');
      await refresh();
      nav(r.mfaEnrollmentRequired ? '/guvenlik' : '/');
    } else {
      const ok = await a.run(() => api('/api/auth/mfa/verify', { body: useRecovery ? { recoveryCode: code } : { code } }));
      if (ok) {
        await refresh();
        nav('/');
      }
    }
  }

  return (
    <div className="card" style={{ maxWidth: 440 }}>
      <h1>Giriş yap</h1>
      <form onSubmit={submit}>
        {step === 'creds' ? (
          <>
            <label htmlFor="email">E-posta</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <label htmlFor="pw">Parola</label>
            <input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        ) : (
          <>
            <p>Doğrulama uygulamanızdaki 6 haneli kodu girin.</p>
            <label htmlFor="code">{useRecovery ? 'Kurtarma kodu' : 'Doğrulama kodu'}</label>
            <input id="code" inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.trim())} />
            <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => setUseRecovery(!useRecovery)}>
              {useRecovery ? 'Doğrulama kodu kullan' : 'Kurtarma kodu kullan'}
            </button>
          </>
        )}
        <ErrorBox error={a.error} />
        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={a.busy}>{step === 'creds' ? 'Giriş yap' : 'Doğrula'}</button>
          <Link to="/parola-unuttum">Parolamı unuttum</Link>
          <Link to="/kayit">Kayıt ol</Link>
        </div>
      </form>
    </div>
  );
}

export function Register() {
  const [f, setF] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [kvkk, setKvkk] = useState(false);
  const [terms, setTerms] = useState(false);
  const notice = useLoad<any>('/api/legal/KVKK_NOTICE');
  const termsDoc = useLoad<any>('/api/legal/TERMS_OF_USE');
  const a = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const consentDocumentIds = [notice.data?.id, termsDoc.data?.id].filter(Boolean);
    await a.run(() => api('/api/auth/register', { body: { email: f.email, password: f.password, fullName: f.fullName || undefined, phone: f.phone || undefined, consentDocumentIds } }), 'Kayıt alındı. E-posta adresinize gönderilen bağlantıyla hesabınızı doğrulayın.');
  }
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h1>Kayıt ol</h1>
      <form onSubmit={submit}>
        <label htmlFor="n">Ad soyad</label>
        <input id="n" autoComplete="name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        <label htmlFor="e">E-posta</label>
        <input id="e" type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <label htmlFor="p">Cep telefonu (isteğe bağlı)</label>
        <input id="p" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <label htmlFor="pw">Parola</label>
        <input id="pw" type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-describedby="pwhelp" />
        <p id="pwhelp" className="muted">En az 12 karakter; büyük harf, küçük harf ve rakam içermeli.</p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={kvkk} onChange={(e) => setKvkk(e.target.checked)} required />
          <span><Link to="/yasal/KVKK_NOTICE" target="_blank">KVKK aydınlatma metnini</Link> okudum.</span>
        </label>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={terms} onChange={(e) => setTerms(e.target.checked)} required />
          <span><Link to="/yasal/TERMS_OF_USE" target="_blank">Kullanım koşullarını</Link> kabul ediyorum.</span>
        </label>
        <ErrorBox error={a.error} />
        <Msg message={a.message} />
        <button disabled={a.busy} style={{ marginTop: 12 }}>Kayıt ol</button>
      </form>
    </div>
  );
}

export function TokenAction({ kind }: { kind: 'verify' | 'reset' | 'invite' }) {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const [password, setPassword] = useState('');
  const a = useAction();
  const title = { verify: 'E-posta doğrulama', reset: 'Yeni parola belirle', invite: 'Yönetici davetini kabul et' }[kind];
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (kind === 'verify') await a.run(() => api('/api/auth/verify-email', { body: { token } }), 'E-posta adresiniz doğrulandı. Giriş yapabilirsiniz.');
    if (kind === 'reset') await a.run(() => api('/api/auth/password/reset', { body: { token, password } }), 'Parolanız güncellendi. Tüm oturumlar kapatıldı; yeniden giriş yapın.');
    if (kind === 'invite') await a.run(() => api('/api/auth/invite/accept', { body: { token, password } }), 'Parolanız belirlendi. Giriş yaptıktan sonra iki aşamalı doğrulamayı kurmanız zorunludur.');
  }
  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>{title}</h1>
      <form onSubmit={submit}>
        {kind !== 'verify' && (
          <>
            <label htmlFor="pw">Yeni parola</label>
            <input id="pw" type="password" minLength={12} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </>
        )}
        <ErrorBox error={a.error} />
        <Msg message={a.message} />
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={a.busy || !token}>Onayla</button>
          {a.message && <Link to="/giris">Giriş yap</Link>}
        </div>
      </form>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const a = useAction();
  return (
    <div className="card" style={{ maxWidth: 440 }}>
      <h1>Parola sıfırlama</h1>
      <form onSubmit={async (e) => { e.preventDefault(); await a.run(() => api('/api/auth/password/forgot', { body: { email } }), 'Hesap mevcutsa sıfırlama bağlantısı e-posta adresinize gönderildi.'); }}>
        <label htmlFor="e">E-posta</label>
        <input id="e" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <ErrorBox error={a.error} />
        <Msg message={a.message} />
        <button disabled={a.busy} style={{ marginTop: 12 }}>Bağlantı gönder</button>
      </form>
      <p className="muted">Hesap mevcutsa sıfırlama bağlantısı e-posta adresinize gönderilir.</p>
    </div>
  );
}

const LEGAL_TITLES: Record<string, string> = {
  KVKK_NOTICE: 'KVKK Aydınlatma Metni', PRIVACY_POLICY: 'Gizlilik Politikası', TERMS_OF_USE: 'Kullanım Koşulları', COOKIE_POLICY: 'Çerez Politikası', RETENTION_POLICY: 'Veri Saklama ve İmha Politikası',
};

export function Legal() {
  const { docType = 'PRIVACY_POLICY' } = useParams();
  const d = useLoad<any>(`/api/legal/${docType}`, [docType]);
  return (
    <div className="card">
      <h1>{LEGAL_TITLES[docType] ?? 'Hukuki metin'}</h1>
      <Loading loading={d.loading}>
        {d.data?.notice && <div className="alert warn">{d.data.notice}</div>}
        {d.data?.body_markdown && <div style={{ whiteSpace: 'pre-wrap' }}>{d.data.body_markdown}</div>}
        {d.data?.version && <p className="muted">Sürüm {d.data.version}</p>}
      </Loading>
      <p className="muted">Bu metinler hukuk danışmanı tarafından hazırlanmalı ve onaylanmalıdır. Ekranın varlığı KVKK yükümlülüklerinin tamamlandığı anlamına gelmez.</p>
    </div>
  );
}

export { LEGAL_TITLES };
