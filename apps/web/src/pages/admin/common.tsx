import { useState } from 'react';
import { api, type ApiError } from '../../api';
import { ErrorBox } from '../../components/ui';

/** Hassas işlemde sunucu "MFA_STEP_UP_REQUIRED" dönerse kodu yeniden isteyen hata kutusu. */
export function AdminError({ error, onVerified }: { error: unknown; onVerified?: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const e = error as ApiError | null;
  if (e && (e.code === 'MFA_STEP_UP_REQUIRED' || e.code === 'MFA_REQUIRED') && !done) {
    return (
      <div className="alert warn" role="alert">
        <p>{e.message}</p>
        <form className="row" onSubmit={async (ev) => { ev.preventDefault(); try { await api('/api/auth/mfa/verify', { body: { code } }); setDone(true); onVerified?.(); } catch (x) { setErr(x); } }}>
          <input aria-label="Doğrulama kodu" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(ev) => setCode(ev.target.value.trim())} style={{ maxWidth: 160 }} />
          <button>Doğrula</button>
        </form>
        <ErrorBox error={err} />
      </div>
    );
  }
  if (done) return <div className="alert ok">Doğrulandı. İşlemi yeniden deneyin.</div>;
  return <ErrorBox error={error} />;
}

export function SecretMeta({ m }: { m: any }) {
  if (!m) return <span className="badge warn">Tanımlı değil</span>;
  if (!m.isSet) return <span className="badge warn">Tanımlı değil</span>;
  return (
    <span>
      <span className="badge ok">Tanımlı</span> <code>{m.ref}</code> {m.hint && <span className="muted">{m.hint}</span>} <span className="muted">parmak izi {m.fingerprint}</span>
      {m.expiresAt && <span className="muted"> · bitiş {new Date(m.expiresAt).toLocaleDateString('tr-TR')}</span>}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  return mode === 'LIVE' ? <span className="badge err">CANLI</span> : <span className="badge test">TEST</span>;
}
