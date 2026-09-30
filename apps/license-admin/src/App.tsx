import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { PageLoading } from '@ui/Feedback';
import { Button } from '@ui/Button';
import { api, ApiError } from './api';
import { cn } from '../../web/src/lib/cn';
import { AuditPage } from './pages/AuditPage';
import { CustomersPage } from './pages/CustomersPage';
import { DashboardPage } from './pages/DashboardPage';
import { LicenseDetailPage } from './pages/LicenseDetailPage';
import { LicensesPage } from './pages/LicensesPage';
import { LoginPage } from './pages/LoginPage';

interface Me {
  admin: { id: string; email: string; fullName: string };
}

const links = [
  { to: '/', label: 'Özet', end: true },
  { to: '/customers', label: 'Müşteriler' },
  { to: '/licenses', label: 'Lisanslar' },
  { to: '/audit', label: 'Denetim kaydı' },
];

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      /* özel pencere */
    }
    setDark(next);
  };
  return { dark, toggle };
}

function Shell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: () => api<Me>('/admin/api/me'), retry: false });

  if (me.isPending) return <PageLoading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (!me.data) return <PageLoading />;

  const logout = async () => {
    try {
      await api('/admin/api/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-4 sm:px-8">
          <span className="text-base">Lisans yönetimi</span>
          <nav aria-label="Ana menü" className="flex flex-1 items-center gap-1 overflow-x-auto">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) => cn('whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors', isActive ? 'bg-brand text-brand-contrast' : 'text-muted hover:bg-surface-2 hover:text-text')}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <span className="hidden text-sm text-muted sm:inline">{me.data.admin.email}</span>
          <Button size="sm" variant="ghost" onClick={theme.toggle} aria-label="Temayı değiştir">
            {theme.dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void logout()}>
            <LogOut className="size-4" aria-hidden /> Çıkış
          </Button>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route index element={<DashboardPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="licenses" element={<LicensesPage />} />
        <Route path="licenses/:id" element={<LicenseDetailPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
