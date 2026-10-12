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
  Star,
  GripVertical,
  Keyboard,
  Rows3,
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
import { useHotkey } from '../../lib/hotkeys';
import { useFavorites, useTableDensity } from '../../lib/personal';
import { preloadRoute } from '../../lib/routePreload';
import { ShellContext } from './shellContext';
import { ShellHotkeys, ShortcutsDialog } from './Shortcuts';
import { loadHelpData } from './helpTypes';
import { normalizeHelpText } from './helpResolve';

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
  'z-50 min-w-56 rounded-xl border border-border bg-surface p-1.5 shadow-pop [animation:pop-in_0.12s_ease-out]';
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
  const { data: nav } = useNavigation();
  const navGroups = useMemo(() => buildDisplayNavigation(nav?.groups), [nav?.groups]);
  useHotkey('mod+s', event => submitActiveForm(event), { description: 'Açık formu kaydet', group: 'Sayfa', allowInInputs: true });

  // Tablo yoğunluğu kullanıcı tercihidir; tüm tablolar `data-density` üzerinden uyum sağlar
  const { value: density } = useTableDensity();
  useEffect(() => {
    document.documentElement.dataset.density = density;
    return () => { delete document.documentElement.dataset.density; };
  }, [density]);

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
    <ShellContext.Provider value={true}>
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
        <header className="z-(--layer-navigation) flex min-h-14 shrink-0 items-center gap-1.5 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur print:hidden sm:gap-3 sm:px-6">
          {posFocus ? <>
            <Link to="/" aria-label="Ada ERP ana sayfa" className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"><BrandLogo mark className="h-8" /></Link>
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
          {!posFocus && <div className="hidden min-w-0 flex-1 xl:block"><ShellBreadcrumbs compact /></div>}
          <button
            onClick={() => setPaletteOpen(true)}
            className={cn('group flex h-10 min-w-0 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-bg px-2.5 text-sm text-muted transition-colors hover:border-border-strong hover:text-text max-[399px]:justify-center sm:px-3.5 xl:max-w-sm', posFocus && 'max-w-64')}
            aria-label={t('shell.commandPalette')}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            <span className="hidden flex-1 truncate text-left sm:inline">{t('shell.search')}</span>
            {/* Çok dar ekranda (ör. 320 px) yalnız simge kalır; erişilebilir ad aria-label'dan gelir */}
            <span className="hidden flex-1 text-left min-[400px]:inline sm:hidden">{t('shell.searchShort')}</span>
            <kbd className="hidden rounded border border-border border-b-2 bg-surface px-1.5 py-0.5 font-sans text-[11px] sm:inline">
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
            {!posFocus && <div className="xl:hidden"><ShellBreadcrumbs /></div>}
            <FormGuard scopeKey={`${activeCompany?.id}:${activeBranch}:${location.pathname}`}>
              {/* Sayfa değişiminde kısa yumuşak giriş (reduced-motion'da kapanır) */}
              <div key={matches[matches.length - 1]?.id} className="min-w-0 motion-safe:animate-[fade-in_160ms_ease-out]"><Outlet /></div>
            </FormGuard>
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ChangePasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
      <ShellHotkeys groups={navGroups} onPalette={() => setPaletteOpen(o => !o)} />
    </div>
    </Tooltip.Provider>
    </ShellContext.Provider>
  );
}

/**
 * Ctrl/⌘+S: açık paneldeki birincil düğme → odaktaki form → içerikteki tek form. Hiçbiri yoksa yalnız tarayıcının
 * "sayfayı kaydet" penceresi engellenir. Gönderim normal düğme/form yolundan geçtiği için doğrulama ve onay aynı kalır.
 */
function submitActiveForm(event: KeyboardEvent) {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const dialog = dialogs[dialogs.length - 1];
  if (dialog) {
    const primary = [...dialog.querySelectorAll<HTMLButtonElement>('button[data-variant="primary"]')].filter(b => !b.disabled);
    if (primary.length === 1) return primary[0]!.click();
  }
  const scope = dialog ?? document.getElementById('main');
  const focused = (event.target instanceof HTMLElement ? event.target : null)?.closest<HTMLFormElement>('form:not([role="search"])');
  if (focused && scope?.contains(focused)) return focused.requestSubmit();
  const forms = [...(scope?.querySelectorAll<HTMLFormElement>('form:not([role="search"]):not([method="get"])') ?? [])];
  if (forms.length === 1) forms[0]!.requestSubmit();
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
  const { activeCompany } = useSession();
  const location = useLocation();
  const groups = useMemo(() => buildDisplayNavigation(nav?.groups), [nav?.groups]);
  const active = findActiveNavigation(groups, location.pathname, location.search, activeCompany?.sector === 'CONSTRUCTION' ? 'site_report' : 'collection');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ overview: true });
  const [filter, setFilter] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const groupId = useId();
  const activeGroupKey = active?.group.key;
  useEffect(() => {
    if (activeGroupKey) setExpanded(current => ({ ...current, [activeGroupKey]: true }));
  }, [activeGroupKey, location.pathname, location.search]);
  const labelOf = (item: DisplayNavItem) => item.label ?? t(item.labelKey as never);
  const query = normalizeHelpText(filter);
  const matches = query
    ? groups.flatMap(group => group.items.filter(item => normalizeHelpText(`${labelOf(item)} ${group.label}`).includes(query)).map(item => ({ group, item })))
    : [];

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
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus"
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

      <div className={cn('space-y-2 px-3 pt-3', collapsed && 'px-2')}>
        <CompanySwitcher collapsed={collapsed} />
        {!collapsed && (
          <div role="search" className="relative" data-form-guard="off">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              value={filter}
              onChange={event => setFilter(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') setFilter(''); }}
              placeholder="Menüde ara…"
              aria-label="Menüde ara"
              className="h-9 w-full rounded-lg border border-transparent bg-surface-2 pl-8 pr-2 text-sm outline-none transition-colors placeholder:text-muted hover:border-border focus:border-border-strong focus:bg-surface"
            />
          </div>
        )}
      </div>

      <nav className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3', collapsed && 'px-2')} aria-label={t('common.mainMenu')}>
        {isPending && <p role="status" className="px-2 py-3 text-xs text-muted">{collapsed ? '…' : 'Menü yükleniyor…'}</p>}
        {error && <div role="alert" className="space-y-2 px-2 py-3 text-xs text-danger"><span className={collapsed ? 'sr-only' : ''}>Menü yüklenemedi.</span><button className="underline" onClick={() => void refetch()} aria-label="Menüyü tekrar yükle">{collapsed ? '↻' : 'Tekrar dene'}</button></div>}
        {query ? (
          <div>
            <p className="micro px-3 pb-1" aria-live="polite">{matches.length ? `${matches.length} sonuç` : 'Sonuç yok'}</p>
            <ul className="space-y-0.5">
              {matches.map(({ group, item }) => (
                <li key={item.key}>
                  <SidebarLink item={item} hint={group.label} active={active?.item.key === item.key} onClose={() => { setFilter(''); onClose(); }} />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            {!collapsed && <FavoritesSection onClose={onClose} activePath={`${location.pathname}${location.search}`} />}
            {groups.map(group => {
              const Icon = navIcon(group.icon);
              const selected = active?.group.key === group.key;
              if (collapsed) return <Dropdown.Root key={group.key}>
                <Dropdown.Trigger aria-label={group.label} title={group.label} className={cn('relative mb-1 flex h-10 w-full items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', selected && 'bg-brand-tint text-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-brand')}>
                  <Icon className="size-5" aria-hidden />
                </Dropdown.Trigger>
                <Dropdown.Portal><Dropdown.Content side="right" align="start" sideOffset={12} collisionPadding={12} className={cn(menuContent, 'max-h-[calc(100dvh-2rem)] max-w-80 overflow-y-auto')}>
                  <Dropdown.Label className="px-3 py-2 text-xs font-semibold text-muted">{group.label}</Dropdown.Label>
                  {group.items.map(item => <Dropdown.Item key={item.key} asChild><SidebarLink item={item} active={active?.item.key === item.key} onClose={onClose} /></Dropdown.Item>)}
                </Dropdown.Content></Dropdown.Portal>
              </Dropdown.Root>;
              const open = expanded[group.key] ?? selected;
              return <div key={group.key} className="mb-1">
                <div className="group/heading flex items-center">
                  <button id={`${groupId}-${group.key}`} title={group.label} aria-expanded={open} aria-controls={`${groupId}-${group.key}-items`} onClick={() => setExpanded(current => ({ ...current, [group.key]: !open }))} className={cn('flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', selected && 'text-text')}>
                    <Icon className="size-[18px] shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate">{group.label}</span>
                    <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
                  </button>
                  <GroupHint groupKey={group.key} label={group.label} />
                </div>
                <ul id={`${groupId}-${group.key}-items`} aria-labelledby={`${groupId}-${group.key}`} hidden={!open} className="mb-3 ml-[21px] mt-1 space-y-0.5 border-l border-border pl-2">
                  {group.items.map(item => <li key={item.key}><SidebarLink item={item} active={active?.item.key === item.key} onClose={onClose} /></li>)}
                </ul>
              </div>;
            })}
          </>
        )}
      </nav>

      {!mobile && <div className={cn('flex items-center gap-1 border-t border-border p-3', collapsed && 'flex-col')}>
        <button
          onClick={onToggle}
          className={cn(
            'flex h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-surface-2 hover:text-text',
            collapsed && 'w-full flex-none justify-center px-0',
          )}
          aria-label={collapsed ? t('shell.expand') : t('shell.collapse')}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[18px]" />
          ) : (
            <PanelLeftClose className="size-[18px]" />
          )}
          {!collapsed && <span className="truncate">{t('shell.collapse')}</span>}
        </button>
        <DensityButton collapsed={collapsed} />
        <button
          onClick={() => setShortcutsOpen(true)}
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text', collapsed && 'w-full')}
          aria-label="Klavye kısayolları (?)"
          title="Klavye kısayolları (?)"
        >
          <Keyboard className="size-[18px]" aria-hidden />
        </button>
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>}
    </>
  );
}

/** Grup başlığının yanındaki "i": grubun neyi kapsadığını gösterir (rehber verisi ilk açılışta indirilir). */
function GroupHint({ groupKey, label }: { groupKey: string; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const load = () => {
    if (text !== null) return;
    loadHelpData().then(d => setText(d.NAV_GROUP_HELP[groupKey]?.description ?? ''), () => setText(''));
  };
  return (
    <Tooltip.Root onOpenChange={o => o && load()}>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onFocus={load}
          onPointerEnter={load}
          aria-label={`${label} grubu hakkında`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover/heading:opacity-100 max-lg:opacity-100"
        >
          <span aria-hidden className="flex size-4 items-center justify-center rounded-full border border-current text-[10px] font-semibold leading-none">i</span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={8} collisionPadding={12} className="z-50 max-w-72 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed text-text shadow-pop">
          <p className="mb-0.5 font-semibold">{label}</p>
          <p className="text-muted">{text === null ? 'Yükleniyor…' : text || 'Bu gruptaki ekranlara buradan ulaşırsınız.'}</p>
          <Tooltip.Arrow className="fill-border" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Favoriler: sürükle-bırak ya da Alt+↑/↓ ile sıralanır; yıldız sayfa başlığından eklenir. */
function FavoritesSection({ onClose, activePath }: { onClose: () => void; activePath: string }) {
  const { favorites, toggle, move, reorder } = useFavorites();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  if (!favorites.length) return null;
  const fail = () => toast.error('Favoriler kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin.');
  return (
    <section aria-labelledby="nav-favorites" className="mb-3">
      <p id="nav-favorites" className="micro flex items-center gap-1.5 px-3 pb-1"><Star className="size-3" aria-hidden />Favoriler</p>
      <ul className="space-y-0.5">
        {favorites.map(fav => (
          <li
            key={fav.path}
            draggable
            onDragStart={event => { setDragging(fav.path); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setDragging(null)}
            onDragOver={event => { if (dragging && dragging !== fav.path) event.preventDefault(); }}
            onDrop={event => {
              event.preventDefault();
              if (!dragging || dragging === fav.path) return;
              const order = favorites.map(f => f.path).filter(p => p !== dragging);
              order.splice(order.indexOf(fav.path), 0, dragging);
              setDragging(null);
              reorder(order).catch(fail);
            }}
            className={cn('group/fav relative flex items-center rounded-md', dragging === fav.path && 'opacity-50')}
          >
            <GripVertical className="pointer-events-none absolute -left-2.5 size-3.5 text-muted opacity-0 group-hover/fav:opacity-100" aria-hidden />
            <Link
              to={fav.path}
              onClick={onClose}
              onPointerEnter={() => preloadRoute(fav.path)}
              onFocus={() => preloadRoute(fav.path)}
              onKeyDown={event => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                  event.preventDefault();
                  move(fav.path, event.key === 'ArrowUp' ? -1 : 1).catch(fail);
                }
              }}
              aria-current={activePath === fav.path ? 'page' : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={cn('flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', activePath === fav.path && 'bg-brand-tint font-medium text-text')}
            >
              <Star className="size-3.5 shrink-0 fill-current text-text" aria-hidden />
              <span className="min-w-0 truncate">{fav.title}</span>
            </Link>
            <button
              type="button"
              onClick={() => toggle(fav).catch(fail)}
              aria-label={`${fav.title} favorilerden çıkar`}
              className="absolute right-1 flex size-7 items-center justify-center rounded-md text-muted opacity-0 hover:bg-surface hover:text-text focus-visible:opacity-100 group-hover/fav:opacity-100"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DensityButton({ collapsed }: { collapsed: boolean }) {
  const { value, save } = useTableDensity();
  const toast = useToast();
  const compact = value === 'compact';
  const label = compact ? 'Tablolar: sıkı görünüm (rahat görünüme geç)' : 'Tablolar: rahat görünüm (sıkı görünüme geç)';
  return (
    <button
      onClick={() => save(compact ? 'comfortable' : 'compact').catch(() => toast.error('Görünüm tercihi kaydedilemedi.'))}
      aria-pressed={compact}
      aria-label={label}
      title={label}
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text', compact && 'bg-surface-2 text-text', collapsed && 'w-full')}
    >
      <Rows3 className="size-[18px]" aria-hidden />
    </button>
  );
}

function SidebarLink({ item, active, onClose, hint, ...props }: { item: DisplayNavItem; active: boolean; onClose: () => void; hint?: string } & Omit<React.ComponentProps<typeof Link>, 'to'>) {
  const { t } = useTranslation();
  const Icon = navIcon(item.icon);
  return <Link
    {...props}
    to={item.path}
    onClick={onClose}
    onPointerEnter={() => preloadRoute(item.path)}
    onFocus={() => preloadRoute(item.path)}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'relative flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus data-[highlighted]:bg-surface-2',
      active && 'bg-brand-tint font-medium text-text before:absolute before:-left-[11px] before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-brand',
      props.className,
    )}
  >
    <Icon className="size-4 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1 truncate">{item.label ?? t(item.labelKey as never)}</span>
    {hint && <span className="shrink-0 truncate text-[11px] text-muted">{hint}</span>}
  </Link>;
}

function ShellBreadcrumbs({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { activeCompany } = useSession();
  const { pathname, search } = useLocation();
  const { data } = useNavigation();
  const groups = useMemo(() => buildDisplayNavigation(data?.groups), [data?.groups]);
  const active = findActiveNavigation(groups, pathname, search, activeCompany?.sector === 'CONSTRUCTION' ? 'site_report' : 'collection');
  if (pathname === '/') return compact ? <p className="truncate text-sm font-medium text-text">Genel bakış</p> : null;
  const currentPath = active?.item.path.split('?')[0];
  const detail = currentPath && currentPath !== pathname;
  const extras: Record<string, string> = { '/account/security': 'Hesap güvenliği', '/settings/notifications': 'Bildirim tercihleri', '/workspace/project-control': 'Proje 360', '/workspace/handover': 'Teslim işlemleri' };
  const label = active ? active.item.label ?? t(active.item.labelKey as never) : extras[pathname] ?? (pathname.endsWith('/new') ? 'Yeni kayıt' : pathname.startsWith('/invoices/') ? 'Fatura ayrıntısı' : pathname.startsWith('/delivery-notes/') ? 'İrsaliye ayrıntısı' : pathname.startsWith('/sales/docs/') ? 'Satış belgesi' : 'Çalışma ekranı');
  return <nav aria-label="Gezinti yolu" className={cn('print:hidden', !compact && 'mb-4')}><ol className={cn('flex items-center gap-1.5 text-xs text-muted', compact ? 'min-w-0 flex-nowrap overflow-hidden text-[13px] [&>li]:min-w-0 [&>li]:truncate [&>li:last-child]:shrink-0' : 'flex-wrap')}>
    <li className="shrink-0"><Link to="/" className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">Genel bakış</Link></li>
    {active && <><li aria-hidden className="shrink-0"><ChevronRight className="size-3" /></li><li>{active.group.label}</li></>}
    <li aria-hidden className="shrink-0"><ChevronRight className="size-3" /></li>
    <li>{detail ? <Link to={active!.item.path} className="hover:text-text">{label}</Link> : <span aria-current="page" className="font-medium text-text">{label}</span>}</li>
    {detail && <><li aria-hidden className="shrink-0"><ChevronRight className="size-3" /></li><li aria-current="page" className="font-medium text-text">{pathname.endsWith('/new') ? 'Yeni kayıt' : 'Kayıt ayrıntısı'}</li></>}
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
