import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider, can, useAuth } from './auth';
import { useLoad } from './components/ui';
import { ForgotPassword, Home, Legal, Login, Register, TokenAction } from './pages/public';
import { Bills, Cards, History, Notifications, ReceiptView, Receipts, Security, Subscriptions, Support, Topup, TransactionDetail } from './pages/user';
import { AdminAlerts, AdminAudit, AdminGoLive, AdminLegal, AdminOverview, AdminSupport, AdminSystem, AdminUsers } from './pages/admin/AdminPages';
import { PaymentService } from './pages/admin/PaymentService';
import { UtilityIntegration } from './pages/admin/Utility';

function ModeBanner() {
  const s = useLoad<any>('/api/platform/status');
  if (!s.data) return null;
  return s.data.mode === 'LIVE'
    ? null
    : <div className="mode-banner" role="status">TEST MODU — Gerçek ödeme alınmaz, gerçek kart yüklemesi veya fatura tahsilatı yapılmaz.</div>;
}

function Header() {
  const { me, logout } = useAuth();
  return (
    <header className="top">
      <Link to="/" className="brand">Su Ödeme Merkezi</Link>
      <nav className="main" aria-label="Ana menü">
        {me ? (
          <>
            <NavLink to="/kart-yukle">Kart yükle</NavLink>
            <NavLink to="/fatura">Fatura öde</NavLink>
            <NavLink to="/aboneliklerim">Aboneliklerim</NavLink>
            <NavLink to="/kartlarim">Kartlarım</NavLink>
            <NavLink to="/islemler">İşlemler</NavLink>
            <NavLink to="/makbuzlar">Makbuzlar</NavLink>
            <NavLink to="/bildirimler">Bildirimler</NavLink>
            <NavLink to="/destek">Destek</NavLink>
            <NavLink to="/guvenlik">Profil</NavLink>
            {can(me, 'admin.access') && <NavLink to="/yonetim">Yönetim</NavLink>}
            <button className="secondary" onClick={() => void logout()}>Çıkış</button>
          </>
        ) : (
          <>
            <NavLink to="/giris">Giriş yap</NavLink>
            <NavLink to="/kayit">Kayıt ol</NavLink>
          </>
        )}
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="muted" style={{ textAlign: 'center', padding: 24 }}>
      <Link to="/yasal/KVKK_NOTICE">KVKK Aydınlatma</Link> · <Link to="/yasal/PRIVACY_POLICY">Gizlilik</Link> · <Link to="/yasal/TERMS_OF_USE">Kullanım koşulları</Link> · <Link to="/yasal/COOKIE_POLICY">Çerezler</Link>
    </footer>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading, mfaPending } = useAuth();
  if (loading) return <p className="muted">Yükleniyor…</p>;
  if (!me || mfaPending) return <Navigate to="/giris" replace />;
  return <>{children}</>;
}

function AdminShell({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted">Yükleniyor…</p>;
  // Arayüz kontrolü yalnızca kolaylıktır; her yönetim isteği sunucuda rol + MFA ile doğrulanır.
  if (!me || !can(me, 'admin.access')) return <Navigate to="/" replace />;
  if (me.mfa.enrollmentRequired) return <Navigate to="/guvenlik" replace />;
  return (
    <div className="admin-shell">
      <nav aria-label="Yönetim menüsü">
        <NavLink to="/yonetim" end>Genel bakış</NavLink>
        <NavLink to="/yonetim/odeme-hizmeti">Güvenli Ödeme Hizmeti</NavLink>
        <NavLink to="/yonetim/su-idaresi">Su İdaresi Entegrasyonu</NavLink>
        <NavLink to="/yonetim/kullanicilar">Kullanıcılar ve roller</NavLink>
        <NavLink to="/yonetim/uyarilar">Uyarılar</NavLink>
        <NavLink to="/yonetim/destek">Destek</NavLink>
        <NavLink to="/yonetim/denetim">Denetim kayıtları</NavLink>
        <NavLink to="/yonetim/sistem">Sistem ve yedekleme</NavLink>
        <NavLink to="/yonetim/yayin-kontrol">Yayın öncesi kontrol</NavLink>
        <NavLink to="/yonetim/hukuki">Hukuki uyum</NavLink>
      </nav>
      <main id="icerik">{children}</main>
    </div>
  );
}

const authed = (el: ReactNode) => <RequireAuth>{el}</RequireAuth>;
const admin = (el: ReactNode) => <AdminShell>{el}</AdminShell>;

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <a className="skip" href="#icerik">İçeriğe geç</a>
        <ModeBanner />
        <Header />
        <Routes>
          <Route path="/yonetim/*" element={
            <Routes>
              <Route index element={admin(<AdminOverview />)} />
              <Route path="odeme-hizmeti" element={admin(<PaymentService />)} />
              <Route path="su-idaresi" element={admin(<UtilityIntegration />)} />
              <Route path="kullanicilar" element={admin(<AdminUsers />)} />
              <Route path="uyarilar" element={admin(<AdminAlerts />)} />
              <Route path="destek" element={admin(<AdminSupport />)} />
              <Route path="denetim" element={admin(<AdminAudit />)} />
              <Route path="sistem" element={admin(<AdminSystem />)} />
              <Route path="yayin-kontrol" element={admin(<AdminGoLive />)} />
              <Route path="hukuki" element={admin(<AdminLegal />)} />
            </Routes>
          } />
          <Route path="*" element={
            <main id="icerik">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/giris" element={<Login />} />
                <Route path="/kayit" element={<Register />} />
                <Route path="/eposta-dogrula" element={<TokenAction kind="verify" />} />
                <Route path="/parola-unuttum" element={<ForgotPassword />} />
                <Route path="/parola-sifirla" element={<TokenAction kind="reset" />} />
                <Route path="/yonetici-daveti" element={<TokenAction kind="invite" />} />
                <Route path="/yasal/:docType" element={<Legal />} />
                <Route path="/aboneliklerim" element={authed(<Subscriptions />)} />
                <Route path="/kartlarim" element={authed(<Cards />)} />
                <Route path="/kart-yukle" element={authed(<Topup />)} />
                <Route path="/fatura" element={authed(<Bills />)} />
                <Route path="/islemler" element={authed(<History />)} />
                <Route path="/islemler/yukleme/:id" element={authed(<TransactionDetail kind="yukleme" />)} />
                <Route path="/islemler/fatura/:id" element={authed(<TransactionDetail kind="fatura" />)} />
                <Route path="/makbuzlar" element={authed(<Receipts />)} />
                <Route path="/makbuzlar/:id" element={authed(<ReceiptView />)} />
                <Route path="/destek" element={authed(<Support />)} />
                <Route path="/bildirimler" element={authed(<Notifications />)} />
                <Route path="/guvenlik" element={authed(<Security />)} />
                <Route path="*" element={<p>Sayfa bulunamadı.</p>} />
              </Routes>
            </main>
          } />
        </Routes>
        <Footer />
      </BrowserRouter>
    </AuthProvider>
  );
}
