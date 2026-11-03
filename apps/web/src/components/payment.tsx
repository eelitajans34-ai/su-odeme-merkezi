import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export interface MethodOption {
  method: 'HOSTED_CARD' | 'QR' | 'NFC';
  label: string;
  help: string;
  status: 'AVAILABLE' | 'SETUP_PENDING' | 'DISABLED' | 'MOBILE_ONLY' | 'SERVICE_UNAVAILABLE';
  statusLabel: string;
  isSimulator: boolean;
}

/** Ödeme yöntemi seçimi. Kullanılamayan yöntemler gizlenmez; gerçek durumlarıyla (ör. "Kurulum bekleniyor") gösterilir. */
export function MethodPicker({ options, value, onChange }: { options: MethodOption[]; value: string; onChange: (m: MethodOption['method']) => void }) {
  return (
    <fieldset className="methods">
      <legend>Ödeme yöntemi</legend>
      {options.map((o) => {
        const ok = o.status === 'AVAILABLE';
        return (
          <label key={o.method} className={`method${ok ? '' : ' off'}${value === o.method ? ' on' : ''}`}>
            <input type="radio" name="odeme-yontemi" value={o.method} disabled={!ok} checked={value === o.method} onChange={() => onChange(o.method)} />
            <span className="method-body">
              <strong>{o.label}</strong>
              <span className={`badge ${ok ? (o.isSimulator ? 'test' : 'ok') : 'warn'}`}>{o.statusLabel}</span>
              <span className="muted">{o.help}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * QR ile ödeme: karekod banka/cüzdan uygulamasıyla okutulur. Sonuç ekrandan değil, sunucunun sağlayıcıdan
 * aldığı imzalı bildirim ve durum sorgusuyla belirlenir; bu bileşen yalnızca durumu sorar.
 */
export function QrPayment({ txId, payload, expiresAt, isTest, onSettled }: { txId: string; payload: string; expiresAt: string; isTest: boolean; onSettled?: () => void }) {
  const nav = useNavigate();
  const [img, setImg] = useState<string | null>(null);
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));
  const [copied, setCopied] = useState(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => { QRCode.toDataURL(payload, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setImg).catch(() => setImg(null)); }, [payload]);
  useEffect(() => {
    const tick = setInterval(() => setLeft(Math.max(0, new Date(expiresAt).getTime() - Date.now())), 1000);
    const poll = setInterval(async () => {
      const t = await api<any>(`/api/bill-payments/${txId}/refresh`, { method: 'POST' }).catch(() => null);
      if (t && t.status !== 'AWAITING_PAYMENT') (settled.current ? settled.current() : nav(`/islemler/fatura/${txId}`));
    }, 4000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [txId, expiresAt, nav]);
  const mm = Math.floor(left / 60000);
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
  return (
    <div className="qr-pay" aria-live="polite">
      {isTest && <div className="alert warn"><strong>TEST karekodu.</strong> Gerçek ödeme için kullanılamaz; okutulduğunda ödeme simülatörü açılır.</div>}
      {left > 0 ? (
        <>
          {img ? <img src={img} width={240} height={240} alt="Ödeme karekodu" /> : <p className="muted">Karekod hazırlanıyor…</p>}
          <p>Banka veya cüzdan uygulamanızla okutun ve ödemeyi orada onaylayın. Kalan süre: <strong>{mm}:{ss}</strong></p>
          <p className="muted">Ödeme onaylandığında bu sayfa kendiliğinden güncellenir. Fatura, su idaresi tahsilatı teyit ettikten sonra "ödendi" olarak gösterilir.</p>
          <div className="row">
            <button type="button" className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(payload); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Kopyalandı' : 'Karekod içeriğini kopyala'}</button>
            {!onSettled && <button type="button" className="secondary" onClick={() => nav(`/islemler/fatura/${txId}`)}>İşlem durumunu gör</button>}
          </div>
        </>
      ) : (
        <div className="alert err">Karekodun süresi doldu. Ödeme yapmadıysanız hesabınızdan tahsilat yapılmamıştır; faturayı yeniden sorgulayıp tekrar deneyin.</div>
      )}
    </div>
  );
}
