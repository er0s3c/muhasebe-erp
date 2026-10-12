import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { COMPANY_TIME_ZONE, setCompanyTimeZoneResolver, type CreateCompanyInput, type LoginInput, type RegisterInput, type Role, type Sector, type Jurisdiction } from '@erp/shared';
import { clearFieldPackage } from '../features/construction-control/offline';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from './api';
import { setBranchUserId } from './branch';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  emailVerified: boolean;
  /** Yönetici parolayı belirlediyse true: kullanıcı kendi parolasını seçene dek başka ekran açılmaz. */
  mustChangePassword: boolean;
}
export interface CompanySummary {
  id: string;
  name: string;
  sector: Sector;
  baseCurrency: string;
  reportingCurrency: string | null;
  role: Role;
  jurisdiction?: Jurisdiction | null;
  timeZone?: string;
  profileVersionId?: string | null;
  fxProvider?: 'tcmb' | 'kktcmb' | null;
  taxSetupStatus?: string;
}

interface Session {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: SessionUser | null;
  companies: CompanySummary[];
  activeCompany: CompanySummary | null;
  setActiveCompanyId: (id: string) => void;
  /** İki adımlı doğrulama açıksa oturum açılmaz; dönen `mfaToken` ile `verifyMfa` çağrılır. */
  login: (input: LoginInput) => Promise<{ mfaToken: string } | null>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  createCompany: (input: CreateCompanyInput) => Promise<CompanySummary>;
  reload: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);
const ACTIVE_KEY = 'activeCompanyId';
let activeTimeZone = COMPANY_TIME_ZONE;
setCompanyTimeZoneResolver(() => activeTimeZone);
const updateCompanyClock = (companies: CompanySummary[], activeId: string | null) => {
  activeTimeZone = (companies.find(company => company.id === activeId) ?? companies[0])?.timeZone ?? COMPANY_TIME_ZONE;
};

const readActive = () => {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Session['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readActive);

  const loadMe = useCallback(async () => {
    const me = await api<{ user: SessionUser; companies: CompanySummary[] }>('/api/me');
    updateCompanyClock(me.companies, readActive());
    setUser(me.user);
    setBranchUserId(me.user.id);
    setCompanies(me.companies);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    window.dispatchEvent(new Event('erp-session-cleared'));
    void clearFieldPackage();
    setAccessToken(null);
    activeTimeZone = COMPANY_TIME_ZONE;
    setUser(null);
    setBranchUserId(null);
    setCompanies([]);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  // Sayfa yenilenince: refresh çerezi ile oturumu geri kur
  useEffect(() => {
    setSessionLostHandler(clear);
    void (async () => {
      if (await refreshSession()) {
        try {
          await loadMe();
          return;
        } catch {
          /* aşağıda anonim */
        }
      }
      setStatus('anonymous');
    })();
    return () => setSessionLostHandler(null);
  }, [clear, loadMe]);

  const setActiveCompanyId = useCallback((id: string) => {
    void clearFieldPackage();
    if (companies.some(company => company.id === id)) updateCompanyClock(companies, id);
    setActiveId(id);
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* özel pencere */
    }
  }, [companies]);

  const authenticate = useCallback(
    async (path: string, body: unknown) => {
      const res = await api<{ accessToken?: string; mfaRequired?: boolean; mfaToken?: string }>(path, { method: 'POST', body });
      if (res.mfaRequired && res.mfaToken) return { mfaToken: res.mfaToken };
      setAccessToken(res.accessToken!);
      await loadMe();
      return null;
    },
    [loadMe],
  );

  const value = useMemo<Session>(() => {
    const activeCompany = companies.find((c) => c.id === activeId) ?? companies[0] ?? null;
    return {
      status,
      user,
      companies,
      activeCompany,
      setActiveCompanyId,
      login: (input) => authenticate('/api/auth/login', input),
      verifyMfa: async (mfaToken, code) => {
        await authenticate('/api/auth/mfa/verify', { mfaToken, code });
      },
      register: async (input) => {
        await authenticate('/api/auth/register', input);
      },
      logout: async () => {
        try {
          await api('/api/auth/logout', { method: 'POST' });
        } finally {
          clear();
        }
      },
      createCompany: async (input) => {
        const { company } = await api<{ company: { id: string } }>('/api/companies', { method: 'POST', body: input });
        const me = await api<{ user: SessionUser; companies: CompanySummary[] }>('/api/me');
        setCompanies(me.companies);
        setActiveCompanyId(company.id);
        updateCompanyClock(me.companies, company.id);
        queryClient.clear();
        return me.companies.find((c) => c.id === company.id)!;
      },
      reload: loadMe,
    };
  }, [status, user, companies, activeId, setActiveCompanyId, authenticate, clear, loadMe, queryClient]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider eksik');
  return ctx;
}

/** Aktif şirket zorunlu olan ekranlar için. */
export function useCompany(): CompanySummary {
  const { activeCompany } = useSession();
  if (!activeCompany) throw new Error('Aktif şirket yok');
  return activeCompany;
}
