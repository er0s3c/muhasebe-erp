import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bell,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Check,
  ChevronsUpDown,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  X,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { api } from '../../lib/api';
import { fmtDate, useLicense } from '../../lib/license';
import { clearForbidden, useForbiddenOn } from '../../lib/forbidden';
import { useNavigation, usePublicConfig } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Feedback';
import { Field, Input } from '../ui/Field';
import { Modal } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { NotificationBell } from '../../features/notifications/NotificationBell';
import { BrandLogo } from './Brand';
import { CommandPalette } from './CommandPalette';
import { navIcon } from './icons';
import { PrintLetterhead } from '../print/PrintLetterhead';
import { usePrintSetup } from '../print/usePrintSetup';
import { useTheme } from './theme';
import * as Tooltip from '@radix-ui/react-tooltip';
import { FeedbackButton } from '../../features/support/FeedbackButton';
import { AdaAIButton } from '../../features/ai/AdaAIButton';
import { InstallAppButton } from './InstallAppButton';
import { BranchPicker } from './BranchPicker';
import { buildDisplayNavigation, findActiveNavigation, isPosFocusPath, type DisplayNavItem } from './navigation';
import type { RouteHandle } from '../../app/guards';
import { FormGuard, useUnsavedChanges } from '../ui/UnsavedChanges';
import { useActiveBranch } from '../../lib/branch';

const COLLAPSE_KEY = 'sidebarCollapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

/** lg kırılımı (Tailwind 1024px): üstünde menü sabit kenar çubuğu, altında açılır çekmece. */
const DESKTOP_QUERY = '(min-width: 1024px)';
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const useIsDesktop = () =>
  useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches);

const menuContent =
  'z-50 min-w-56 rounded-xl border border-border bg-surface p-1.5 [animation:pop-in_0.12s_ease-out]';
const menuItem =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2';

export function AppShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { activeCompany } = useSession();
  const activeBranch = useActiveBranch(activeCompany?.id ?? 'none');
  usePrintSetup(activeCompany?.name ?? '');
  const matches = useMatches();
  const handle = [...matches].reverse().find(match => (match.handle as RouteHandle | undefined)?.layout)?.handle as RouteHandle | undefined;
  const layout = handle?.layout ?? 'normal';
  const posFocus = isPosFocusPath(location.pathname);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const isDesktop = useIsDesktop();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMobileOpen(false), [location.pathname, location.search, location.hash, isDesktop]);
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
    <Tooltip.Provider delayDuration={150}>
      <div className="relative flex h-full min-h-0 overflow-hidden print:block print:h-auto print:overflow-visible">
      <a
        href="#main"
        className="sr-only z-[70] rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {t('shell.skipToContent')}
      </a>

      {!posFocus && <>
        <aside className={cn('hidden w-64 shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 print:hidden lg:flex', collapsed && 'w-[68px]')}>
          <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} onClose={() => setMobileOpen(false)} />
        </aside>
        <Dialog.Root open={mobileOpen && !isDesktop} onOpenChange={setMobileOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-inverted/45 lg:hidden" />
            <Dialog.Content
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-xl lg:hidden"
              onCloseAutoFocus={event => { event.preventDefault(); menuButtonRef.current?.focus(); }}
            >
              <Dialog.Title className="sr-only">{t('common.mainMenu')}</Dialog.Title>
              <Dialog.Description className="sr-only">Şirketinizi ve çalışma ekranınızı seçin.</Dialog.Description>
              <Sidebar collapsed={false} mobile onToggle={toggleCollapsed} onClose={() => setMobileOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-4 py-2 print:hidden sm:gap-3 sm:px-6">
          {posFocus ? <>
            <Link to="/" aria-label="Ada ERP ana sayfa" className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><BrandLogo mark className="h-8" /></Link>
            <Link to="/" aria-label="ERP’ye dön" className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text"><ArrowLeft className="size-4" aria-hidden /><span className="hidden sm:inline">ERP’ye dön</span></Link>
            <div className="hidden w-52 sm:block"><CompanySwitcher collapsed={false} /></div>
          </> : <button
            ref={menuButtonRef}
            className="shrink-0 rounded-md p-2 text-muted hover:bg-surface-2 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={t('shell.openMenu')}
            aria-expanded={mobileOpen}
          >
            <Menu className="size-5" />
          </button>}
          <button
            onClick={() => setPaletteOpen(true)}
            className={cn('flex h-10 min-w-0 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-sm text-muted transition-colors hover:border-border-strong sm:px-3.5', posFocus && 'max-w-64')}
            aria-label={t('shell.commandPalette')}
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="hidden flex-1 text-left sm:inline">{t('shell.search')}</span>
            <span className="flex-1 text-left sm:hidden">{t('shell.searchShort')}</span>
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[12px] sm:inline">
              Ctrl K
            </kbd>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="hidden sm:block"><BranchPicker /></div>
            {!posFocus && <><InstallAppButton /><FeedbackButton /><AdaAIButton /></>}
            <NotificationBell />
            <ThemeButton />
            <UserMenu
              onChangePassword={() => setPasswordOpen(true)}
              onLogout={() => navigate('/login')}
            />
          </div>
        </header>
        <BranchPicker mobile />

        <main id="main" className="relative min-h-0 min-w-0 flex-1 overflow-y-auto print:overflow-visible">
          <div data-layout={posFocus ? 'pos' : layout} className={cn('mx-auto w-full px-4 py-6 sm:px-8 sm:py-8', layout === 'wide' ? 'max-w-[1600px]' : layout === 'form' ? 'max-w-[960px]' : 'max-w-[1200px]', posFocus && 'max-w-[1600px] sm:py-5')}>
            <PrintLetterhead />
            <LicenseBanner />
            <VerifyEmailBanner />
            <ForbiddenNotice />
            {!posFocus && <ShellBreadcrumbs />}
            <FormGuard scopeKey={`${activeCompany?.id}:${activeBranch}:${location.pathname}`}><Outlet /></FormGuard>
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ChangePasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
    </Tooltip.Provider>
  );
}

function Sidebar({
  collapsed,
  onToggle,
  onClose,
  mobile = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  mobile?: boolean;
}) {
  const { t } = useTranslation();
  const { data: nav, isPending, error, refetch } = useNavigation();
  const location = useLocation();
  const groups = useMemo(() => buildDisplayNavigation(nav?.groups), [nav?.groups]);
  const active = findActiveNavigation(groups, location.pathname, location.search);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ overview: true });
  const groupId = useId();
  useEffect(() => {
    if (active) setExpanded(current => ({ ...current, [active.group.key]: true }));
  }, [active?.group.key, location.pathname, location.search]);

  return (
    <>
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4',
          collapsed && 'justify-center px-0',
        )}
      >
        {/* Logo ve ad ana sayfaya götürür (dar ekranda menüyü de kapatır) */}
        <Link
          to="/"
          onClick={onClose}
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label={t('shell.home')}
        >
          <BrandLogo mark={collapsed} className="h-8" />
        </Link>
        {mobile && <button
          className="ml-auto rounded-md p-2 text-muted hover:bg-surface-2"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X className="size-5" />
        </button>}
      </div>

      <div className={cn('px-3 pt-3', collapsed && 'px-2')}>
        <CompanySwitcher collapsed={collapsed} />
      </div>

      <nav className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3', collapsed && 'px-2')} aria-label={t('common.mainMenu')}>
        {isPending && <p role="status" className="px-2 py-3 text-xs text-muted">{collapsed ? '…' : 'Menü yükleniyor…'}</p>}
        {error && <div role="alert" className="space-y-2 px-2 py-3 text-xs text-danger"><span className={collapsed ? 'sr-only' : ''}>Menü yüklenemedi.</span><button className="underline" onClick={() => void refetch()} aria-label="Menüyü tekrar yükle">{collapsed ? '↻' : 'Tekrar dene'}</button></div>}
        {groups.map(group => {
          const Icon = navIcon(group.icon);
          const selected = active?.group.key === group.key;
          if (collapsed) return <Dropdown.Root key={group.key}>
            <Dropdown.Trigger aria-label={group.label} title={group.label} className={cn('mb-1 flex h-10 w-full items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand', selected && 'bg-brand/15 text-text')}>
              <Icon className="size-5" aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Portal><Dropdown.Content side="right" align="start" sideOffset={12} collisionPadding={12} className={cn(menuContent, 'max-h-[calc(100dvh-2rem)] max-w-80 overflow-y-auto')}>
              <Dropdown.Label className="px-3 py-2 text-xs font-semibold text-muted">{group.label}</Dropdown.Label>
              {group.items.map(item => <Dropdown.Item key={item.key} asChild><SidebarLink item={item} active={active?.item.key === item.key} onClose={onClose} /></Dropdown.Item>)}
            </Dropdown.Content></Dropdown.Portal>
          </Dropdown.Root>;
          const open = expanded[group.key] ?? selected;
          return <div key={group.key} className="mb-1">
            <button id={`${groupId}-${group.key}`} aria-expanded={open} aria-controls={`${groupId}-${group.key}-items`} onClick={() => setExpanded(current => ({ ...current, [group.key]: !open }))} className={cn('flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand', selected && 'text-text')}>
              <Icon className="size-[18px] shrink-0" aria-hidden /><span className="min-w-0 flex-1">{group.label}</span><ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
            <ul id={`${groupId}-${group.key}-items`} aria-labelledby={`${groupId}-${group.key}`} hidden={!open} className="mb-3 ml-3 mt-1 space-y-0.5 border-l border-border pl-2">
              {group.items.map(item => <li key={item.key}><SidebarLink item={item} active={active?.item.key === item.key} onClose={onClose} /></li>)}
            </ul>
          </div>;
        })}
      </nav>

      {!mobile && <div className="border-t border-border p-3">
        <button
          onClick={onToggle}
          className={cn(
            'flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-text',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? t('shell.expand') : t('shell.collapse')}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[18px]" />
          ) : (
            <PanelLeftClose className="size-[18px]" />
          )}
          {!collapsed && <span>{t('shell.collapse')}</span>}
        </button>
      </div>}
    </>
  );
}

function SidebarLink({ item, active, onClose, ...props }: { item: DisplayNavItem; active: boolean; onClose: () => void } & Omit<React.ComponentProps<typeof Link>, 'to'>) {
  const { t } = useTranslation();
  const Icon = navIcon(item.icon);
  return <Link {...props} to={item.path} onClick={onClose} aria-current={active ? 'page' : undefined} className={cn('flex min-h-10 items-center gap-2.5 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand data-[highlighted]:bg-surface-2', active && 'bg-brand/15 font-medium text-text', props.className)}>
    <Icon className="size-4 shrink-0" aria-hidden /><span className="min-w-0 truncate">{item.label ?? t(item.labelKey as never)}</span>
  </Link>;
}

function ShellBreadcrumbs() {
  const { t } = useTranslation();
  const { pathname, search } = useLocation();
  const { data } = useNavigation();
  const groups = useMemo(() => buildDisplayNavigation(data?.groups), [data?.groups]);
  const active = findActiveNavigation(groups, pathname, search);
  if (pathname === '/') return null;
  const currentPath = active?.item.path.split('?')[0];
  const detail = currentPath && currentPath !== pathname;
  const extras: Record<string, string> = { '/account/security': 'Hesap güvenliği', '/settings/notifications': 'Bildirim tercihleri', '/workspace/project-control': 'Proje 360', '/workspace/handover': 'Teslim işlemleri' };
  const label = active ? active.item.label ?? t(active.item.labelKey as never) : extras[pathname] ?? (pathname.endsWith('/new') ? 'Yeni kayıt' : pathname.startsWith('/invoices/') ? 'Fatura ayrıntısı' : pathname.startsWith('/delivery-notes/') ? 'İrsaliye ayrıntısı' : pathname.startsWith('/sales/docs/') ? 'Satış belgesi' : 'Çalışma ekranı');
  return <nav aria-label="Gezinti yolu" className="mb-4 print:hidden"><ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
    <li><Link to="/" className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">Genel bakış</Link></li>
    {active && <><li aria-hidden><ChevronRight className="size-3" /></li><li>{active.group.label}</li></>}
    <li aria-hidden><ChevronRight className="size-3" /></li>
    <li>{detail ? <Link to={active!.item.path} className="hover:text-text">{label}</Link> : <span aria-current="page" className="text-text">{label}</span>}</li>
    {detail && <><li aria-hidden><ChevronRight className="size-3" /></li><li aria-current="page" className="text-text">{pathname.endsWith('/new') ? 'Yeni kayıt' : 'Kayıt ayrıntısı'}</li></>}
  </ol></nav>;
}

function CompanySwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { companies, activeCompany, setActiveCompanyId } = useSession();
  const { confirmLeave } = useUnsavedChanges();
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
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-inverted text-xs text-on-inverted">
          {initials}
        </span>
        <span className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
          <span className="block truncate text-sm">{activeCompany.name}</span>
          <span className="block truncate text-xs text-muted">
            {t(`sectors.${activeCompany.sector}`)}
          </span>
        </span>
        <ChevronsUpDown
          className={cn('size-4 shrink-0 text-muted', collapsed && 'lg:hidden')}
          aria-hidden
        />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={6} className={menuContent}>
          <Dropdown.Label className="micro px-3 py-1.5">{t('shell.switchCompany')}</Dropdown.Label>
          {companies.map((c) => (
            <Dropdown.Item
              key={c.id}
              className={menuItem}
              onSelect={() => { if (c.id !== activeCompany.id) void confirmLeave(() => { setActiveCompanyId(c.id); navigate('/'); }); }}
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
    <button
      onClick={toggle}
      className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
      aria-label={t('shell.theme')}
      title={theme === 'dark' ? t('shell.themeLight') : t('shell.themeDark')}
    >
      {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}

function UserMenu({
  onChangePassword,
  onLogout,
}: {
  onChangePassword: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const { user, logout } = useSession();
  const { confirmLeave } = useUnsavedChanges();
  const navigate = useNavigate();
  if (!user) return null;
  const initials = user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toLocaleUpperCase('tr-TR'))
    .join('');
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className="flex size-9 items-center justify-center rounded-md bg-inverted text-xs text-on-inverted"
        aria-label={user.fullName}
      >
        {initials}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} className={menuContent}>
          <div className="px-3 py-2">
            <p className="text-sm">{user.fullName}</p>
            <p className="text-xs text-muted">{user.email}</p>
          </div>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item className={menuItem} onSelect={() => navigate('/notifications')}>
            <Bell className="size-4 text-muted" aria-hidden />
            {t('shell.notifications')}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={() => navigate('/settings/notifications')}>
            <SlidersHorizontal className="size-4 text-muted" aria-hidden />
            {t('shell.notificationPrefs')}
          </Dropdown.Item>
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
              void confirmLeave(async () => { await logout(); onLogout(); });
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

function ChangePasswordModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
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
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
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
          <Button
            variant="primary"
            loading={busy}
            disabled={!current || next.length < 10}
            onClick={submit}
          >
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
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('auth.newPassword')}
          hint={t('auth.passwordHint')}
          error={error ?? undefined}
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** Bu sayfadaki bir sorgu 403 döndüyse: eksik görünen alanların nedeni yetkidir, "kayıt yok" değil (UI-7). */
function ForbiddenNotice() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const forbidden = useForbiddenOn(pathname);
  useEffect(() => clearForbidden(pathname), [pathname]);
  if (!forbidden) return null;
  return (
    <div className="mb-6 print:hidden" data-testid="forbidden-notice">
      <Callout tone="warning">{t('common.forbiddenPartial')}</Callout>
    </div>
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
        {t('license.banner.expiringBody', {
          count: Math.max(0, data.daysUntilExpiry),
          date: fmtDate(data.license?.validUntil),
        })}
      </Callout>
    );
  }
  return banner ? (
    <div className="mb-6 print:hidden" data-testid="license-banner">
      {banner}
    </div>
  ) : null;
}
