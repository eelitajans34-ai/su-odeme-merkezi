import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface Me {
  id: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  roles: string[];
  permissions: string[];
  isStaff: boolean;
  mfa: { enrolled: boolean; verifiedThisSession: boolean; enrollmentRequired: boolean };
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  mfaPending: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mfaPending = !!me && me.mfa.enrolled && !me.mfa.verifiedThisSession;
  return <Ctx.Provider value={{ me, loading, mfaPending, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
/** Arayüzde gizleme yalnızca kolaylıktır; asıl yetki kontrolü sunucudadır. */
export const can = (me: Me | null, perm: string) => !!me?.permissions.includes(perm);
