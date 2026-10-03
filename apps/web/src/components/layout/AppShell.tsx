import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, KeyRound, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, ShieldCheck, Sun, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { api } from '../../lib/api';
import { fmtDate, useLicense } from '../../lib/license';
import { useNavigation, usePublicConfig } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Feedback';
import { Field, Input } from '../ui/Field';
import { Modal } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { BrandMark } from './Brand';
import { CommandPalette } from './CommandPalette';
import { navIcon } from './icons';
import { PrintLetterhead } from '../print/PrintLetterhead';
import { usePrintSetup } from '../print/usePrintSetup';
import { useTheme } from './theme';

const COLLAPSE_KEY = 'sidebarCollapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

const menuContent =
  'z-50 min-w-56 rounded-xl border border-border bg-surface p-1.5 [animation:pop-in_0.12s_ease-out]';
const menuItem =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2';

export function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  usePrintSetup(useSession().activeCompany?.name ?? '');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* özel pencere */
      }
      return !c;
    });
  };

  return (
    <div className="flex h-full print:block print:h-auto">
      <a href="#main" className="sr-only z-[70] rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        {t('shell.skipToContent')}
      </a>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-inverted/50 backdrop-blur-[8px] lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface transition-[transform,width] duration-200 print:hidden lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed && 'lg:w-[68px]',
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} onClose={() => setMobileOpen(false)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur [box-shadow:var(--shadow-subtle)] print:hidden sm:px-6">
          <button className="rounded-md p-2 text-muted hover:bg-surface-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label={t('shell.openMenu')}>
            <Menu className="size-5" />
          </button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-10 w-full max-w-md items-center gap-2.5 rounded-lg border border-border bg-bg px-3.5 text-sm text-muted transition-colors hover:border-border-strong"
            aria-label={t('shell.commandPalette')}
          >
            <Search className="size-4" aria-hidden />
            <span className="hidden flex-1 text-left sm:inline">{t('shell.search')}</span>
            <span className="flex-1 text-left sm:hidden">{t('shell.searchShort')}</span>
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[11px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <ThemeButton />
            <UserMenu onChangePassword={() => setPasswordOpen(true)} onLogout={() => navigate('/login')} />
          </div>
        </header>

        <main id="main" className="flex-1 overflow-y-auto print:overflow-visible">
          <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
            <PrintLetterhead />
            <LicenseBanner />
            <VerifyEmailBanner />
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ChangePasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}

function Sidebar({ collapsed, onToggle, onClose }: { collapsed: boolean; onToggle: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: nav } = useNavigation();

  return (
    <>
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4', collapsed && 'lg:justify-center lg:px-0')}>
        {/* Logo ve ad ana sayfaya götürür (dar ekranda menüyü de kapatır) */}
        <Link to="/" onClick={onClose} className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label={t('shell.home')}>
          <BrandMark />
          <span className={cn('text-base', collapsed && 'lg:hidden')}>{t('app.name')}</span>
        </Link>
        <button className="ml-auto rounded-md p-1.5 text-muted hover:bg-surface-2 lg:hidden" onClick={onClose} aria-label={t('common.close')}>
          <X className="size-5" />
        </button>
      </div>

      <div className={cn('px-3 pt-3', collapsed && 'lg:px-2')}>
        <CompanySwitcher collapsed={collapsed} />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Ana menü">
        {nav?.groups.map((group) => (
          <div key={group.key} className="mb-4">
            <p className={cn('micro px-3 pb-1.5', collapsed && 'lg:hidden')}>
              {t(group.labelKey as never)}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const Icon = navIcon(item.icon);
                const label = t(item.labelKey as never);
                return (
                  <li key={item.key}>
                    <NavLink
                      to={item.path}
                      end={item.path === '/'}
                      title={collapsed ? label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'group flex h-9 items-center gap-3 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text',
                          isActive && 'bg-brand text-brand-contrast hover:bg-brand hover:text-brand-contrast',
                          collapsed && 'lg:justify-center lg:px-0',
                        )
                      }
                    >
                      <Icon className="size-[18px] shrink-0" aria-hidden />
                      <span className={cn('truncate', collapsed && 'lg:sr-only')}>{label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="hidden border-t border-border p-3 lg:block">
        <button
          onClick={onToggle}
          className={cn('flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-text', collapsed && 'justify-center px-0')}
          aria-label={collapsed ? t('shell.expand') : t('shell.collapse')}
        >
          {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
          {!collapsed && <span>{t('shell.collapse')}</span>}
        </button>
      </div>
    </>
  );
}

function CompanySwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { companies, activeCompany, setActiveCompanyId } = useSession();
  if (!activeCompany) return null;
  const initials = activeCompany.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toLocaleUpperCase('tr-TR'))
    .join('');

  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg p-2 text-left transition-colors hover:border-border-strong',
          collapsed && 'lg:justify-center lg:border-transparent lg:bg-transparent lg:p-1',
        )}
        aria-label={t('shell.switchCompany')}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-inverted text-xs text-on-inverted">{initials}</span>
        <span className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
          <span className="block truncate text-sm">{activeCompany.name}</span>
          <span className="block truncate text-xs text-muted">{t(`sectors.${activeCompany.sector}`)}</span>
        </span>
        <ChevronsUpDown className={cn('size-4 shrink-0 text-muted', collapsed && 'lg:hidden')} aria-hidden />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className={menuContent}>
          <Dropdown.Label className="micro px-3 py-1.5">{t('shell.switchCompany')}</Dropdown.Label>
          {companies.map((c) => (
            <Dropdown.Item
              key={c.id}
              className={menuItem}
              onSelect={() => {
                setActiveCompanyId(c.id);
                navigate('/');
              }}
            >
              <span className="flex-1 truncate">{c.name}</span>
              {c.id === activeCompany.id && <Check className="size-4" aria-hidden />}
            </Dropdown.Item>
          ))}
          {companies.some((c) => c.role === 'owner' || c.role === 'admin') && (
            <>
              <Dropdown.Separator className="my-1 h-px bg-border" />
              <Dropdown.Item className={menuItem} onSelect={() => navigate('/company/new')}>
                <Plus className="size-4 text-muted" aria-hidden />
                {t('shell.newCompany')}
              </Dropdown.Item>
            </>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ThemeButton() {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  return (
    <button onClick={toggle} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text" aria-label={t('shell.theme')} title={theme === 'dark' ? t('shell.themeLight') : t('shell.themeDark')}>
      {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}

function UserMenu({ onChangePassword, onLogout }: { onChangePassword: () => void; onLogout: () => void }) {
  const { t } = useTranslation();
  const { user, logout } = useSession();
  const navigate = useNavigate();
  if (!user) return null;
  const initials = user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toLocaleUpperCase('tr-TR'))
    .join('');
  return (
    <Dropdown.Root>
      <Dropdown.Trigger className="flex size-9 items-center justify-center rounded-md bg-inverted text-xs text-on-inverted" aria-label={user.fullName}>
        {initials}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} className={menuContent}>
          <div className="px-3 py-2">
            <p className="text-sm">{user.fullName}</p>
            <p className="text-xs text-muted">{user.email}</p>
          </div>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item className={menuItem} onSelect={onChangePassword}>
            <KeyRound className="size-4 text-muted" aria-hidden />
            {t('shell.changePassword')}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={() => navigate('/account/security')}>
            <ShieldCheck className="size-4 text-muted" aria-hidden />
            {t('shell.security')}
          </Dropdown.Item>
          <Dropdown.Item
            className={menuItem}
            onSelect={() => {
              void logout().then(onLogout);
            }}
          >
            <LogOut className="size-4 text-muted" aria-hidden />
            {t('shell.logout')}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ChangePasswordModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success(t('auth.passwordChanged'));
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('shell.changePassword')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!current || next.length < 10} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (current && next.length >= 10) void submit();
        }}
      >
        <Field label={t('auth.currentPassword')}>
          {(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label={t('auth.newPassword')} hint={t('auth.passwordHint')} error={error ?? undefined}>
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

/** E-posta doğrulanmamışsa (ve posta açıksa) yeniden gönderme bağlantısı içeren uyarı. */
function VerifyEmailBanner() {
  const { t } = useTranslation();
  const { user } = useSession();
  const publicConfig = usePublicConfig();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user || user.emailVerified || !publicConfig.data?.mailEnabled) return null;

  const resend = async () => {
    setBusy(true);
    try {
      await api('/api/auth/resend-verification', { method: 'POST' });
      toast.success(t('auth.verifyResent'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 print:hidden">
      <Callout
        tone="warning"
        title={t('auth.verifyBannerTitle')}
        action={
          <Button size="sm" loading={busy} onClick={resend}>
            {t('auth.verifyResend')}
          </Button>
        }
      >
        {t('auth.verifyBannerBody', { email: user.email })}
      </Callout>
    </div>
  );
}

/**
 * Lisans uyarıları: salt-okunur mod (kırmızı), tolerans süresi (sarı) ve bitişe 14 gün kala hatırlatma.
 * Lisans denetimi kapalıyken (geliştirme) hiçbir şey göstermez.
 */
function LicenseBanner() {
  const { t } = useTranslation();
  const { data } = useLicense();
  if (!data?.enforced) return null;

  const manage = data.isOwner ? (
    <Link to="/settings/license">
      <Button size="sm">{t('license.banner.manage')}</Button>
    </Link>
  ) : undefined;

  let banner: ReactNode = null;
  if (data.state === 'restricted') {
    banner = (
      <Callout tone="danger" title={t('license.banner.restrictedTitle')} action={manage}>
        {data.message}
      </Callout>
    );
  } else if (data.state === 'grace') {
    banner = (
      <Callout tone="warning" title={t('license.banner.graceTitle')} action={manage}>
        {t('license.banner.graceBody', { date: fmtDate(data.graceUntil) })}
      </Callout>
    );
  } else if (data.state === 'active' && data.expiresSoon && data.daysUntilExpiry !== null) {
    banner = (
      <Callout tone="warning" title={t('license.banner.expiringTitle')} action={manage}>
        {t('license.banner.expiringBody', { count: Math.max(0, data.daysUntilExpiry), date: fmtDate(data.license?.validUntil) })}
      </Callout>
    );
  }
  return banner ? <div className="mb-6 print:hidden" data-testid="license-banner">{banner}</div> : null;
}
