import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  createBrowserRouter,
  RouterProvider,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { ErrorState, PageLoading } from '@ui/Feedback';
import { Button } from '@ui/Button';
import { Brand } from '@ui/Brand';
import { FormGuard, RouteChangeGuard, useUnsavedChanges } from '@ui/UnsavedChanges';
import { QueryStateBoundary } from '@ui/QueryStateBoundary';
import { api, ApiError, errorText } from './api';
import { cn } from '../../../apps/web/src/lib/cn';
import { AuditPage } from './pages/AuditPage';
import { CustomersPage } from './pages/CustomersPage';
import { DashboardPage } from './pages/DashboardPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { LicenseDetailPage } from './pages/LicenseDetailPage';
import { LicensesPage } from './pages/LicensesPage';
import { LoginPage } from './pages/LoginPage';
import { ReleasesPage } from './pages/ReleasesPage';
import { SecurityPage } from './pages/SecurityPage';
import { SetupPage } from './pages/SetupPage';

interface Me {
  admin: { id: string; email: string; fullName: string };
}

const links = [
  { to: '/', label: 'Özet', end: true },
  { to: '/customers', label: 'Müşteriler' },
  { to: '/licenses', label: 'Lisanslar' },
  { to: '/releases', label: 'Sürümler' },
  { to: '/feedback', label: 'Geri bildirimler' },
  { to: '/audit', label: 'Denetim kaydı' },
  { to: '/security', label: 'Güvenlik' },
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
  const location = useLocation();
  const menuRef = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  const theme = useTheme();
  const { confirmLeave } = useUnsavedChanges();
  const me = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api<Me>('/admin/api/me'),
    retry: false,
  });

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const revealActive = () => {
      const active = menu.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const bounds = menu.getBoundingClientRect(),
        link = active.getBoundingClientRect();
      if (link.left < bounds.left) menu.scrollLeft -= bounds.left - link.left;
      else if (link.right > bounds.right) menu.scrollLeft += link.right - bounds.right;
    };
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [location.pathname, me.data?.admin.id]);

  if (me.isPending) return <PageLoading />;
  if (me.error instanceof ApiError && me.error.status === 401)
    return <Navigate to="/login" replace />;
  if (me.error) return <div className="mx-auto max-w-xl p-6"><ErrorState title="Yönetici oturumu yüklenemedi" description={errorText(me.error)} onRetry={() => void me.refetch()} retrying={me.isFetching} /></div>;
  if (!me.data) return <PageLoading />;

  const logout = async () => {
    await confirmLeave(async () => {
    try {
      await api('/admin/api/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      navigate('/login', { replace: true });
    }
    });
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex min-w-0 max-w-[1200px] flex-wrap items-center gap-2 px-4 py-3 sm:gap-3 sm:px-8 lg:h-14 lg:flex-nowrap lg:py-0">
          <NavLink to="/" aria-label="Ada ERP lisans yönetimi ana sayfa" className="flex shrink-0 items-center gap-3"><Brand className="h-7" /><span className="hidden border-l border-border pl-3 text-sm text-muted sm:inline">Lisans yönetimi</span></NavLink>
          <nav
            ref={menuRef}
            aria-label="Ana menü"
            className="order-last flex min-w-0 flex-1 basis-full items-center gap-1 overflow-x-auto lg:order-none lg:basis-0"
          >
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cn(
                    'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-brand text-brand-contrast'
                      : 'text-muted hover:bg-surface-2 hover:text-text',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto hidden max-w-48 truncate text-sm text-muted xl:inline">
            {me.data.admin.email}
          </span>
          <Button
            className="ml-auto shrink-0 xl:ml-0"
            size="sm"
            variant="ghost"
            onClick={theme.toggle}
            aria-label="Temayı değiştir"
          >
            {theme.dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button className="shrink-0" size="sm" variant="secondary" onClick={() => void logout()}>
            <LogOut className="size-4" aria-hidden /> Çıkış
          </Button>
        </div>
      </header>
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
          <FormGuard scopeKey={me.data.admin.id}><Outlet context={{ admin: me.data.admin }} /></FormGuard>
        </div>
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  { element: <RouteChangeGuard><QueryStateBoundary><Outlet /></QueryStateBoundary></RouteChangeGuard>, children: [
  { path: '/login', element: <LoginPage /> },
  { path: '/setup', element: <SetupPage /> },
  { element: <Shell />, children: [
    { index: true, element: <DashboardPage /> },
    { path: 'customers', element: <CustomersPage /> },
    { path: 'licenses', element: <LicensesPage /> },
    { path: 'licenses/:id', element: <LicenseDetailPage /> },
    { path: 'releases', element: <ReleasesPage /> },
    { path: 'feedback', element: <FeedbackPage /> },
    { path: 'audit', element: <AuditPage /> },
    { path: 'security', element: <SecurityPage /> },
    { path: '*', element: <Navigate to="/" replace /> },
  ] },
  ] },
]);

export function App() {
  return <RouterProvider router={router} />;
}
