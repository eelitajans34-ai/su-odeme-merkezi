import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="alert err" role="alert">
      <div>{e.message ?? 'Bir hata oluştu.'}</div>
      {Array.isArray(e.details?.reasons) && (
        <ul>
          {e.details.reasons.map((r: string) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'ok', REFUNDED: 'ok', FAILED: 'err', REQUIRES_REVIEW: 'warn', UNKNOWN: 'warn', REFUND_PENDING: 'warn',
  TOPUP_PENDING: 'warn', COLLECTION_PENDING: 'warn', PAYMENT_CONFIRMED: 'warn', AWAITING_PAYMENT: '', PAYMENT_PENDING: '',
};

export function StatusBadge({ status, text }: { status: string; text?: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`} title={status}>{text ?? status}</span>;
}

export function TestBadge({ show }: { show: boolean }) {
  return show ? <span className="badge test">TEST</span> : null;
}

/** Basit veri yükleme kancası */
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

export function Loading({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return loading ? <p className="muted" aria-live="polite">Yükleniyor…</p> : <>{children}</>;
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      if (ok) setMessage(ok);
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, message, run, setError };
}

export function Msg({ message }: { message: string | null }) {
  return message ? <div className="alert ok" role="status">{message}</div> : null;
}
