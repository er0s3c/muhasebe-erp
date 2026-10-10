import { useRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useHotkey } from '../../lib/hotkeys';
import { PageHelpTooltip, SectionHelp } from '../layout/PageHelpTooltip';
import { FavoriteStar, RecentRecorder } from '../layout/PageHeaderExtras';
import { useEmbedded, useInShell } from '../layout/shellContext';
import type { NavHelpEntry } from '../layout/helpTypes';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from './Button';

/** Kart: beyaz yüzey + 1px hairline; yükseklik gölgeyle değil çerçeveyle ifade edilir. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 rounded-2xl border border-border bg-surface', className)} {...props} />;
}

/**
 * Kart/bölüm başlığı. `help` verildiğinde başlığın yanında küçük "i" rehberi çıkar (metin satır içi; ek indirme yok).
 */
export function CardHeader({
  title,
  description,
  action,
  help,
  meta,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  help?: string | NavHelpEntry;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          {help && <SectionHelp title={title} help={help} />}
          {meta}
        </div>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 print:hidden">{action}</div>}
    </div>
  );
}

/** "Yeni …" eylemi: önce açık işaret (`data-hotkey="new"`), yoksa metni "Yeni" ile başlayan ilk etkin düğme/bağlantı. */
function findPrimaryNew(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const marked = root.querySelector<HTMLElement>('[data-hotkey="new"]');
  if (marked) return marked;
  for (const el of root.querySelectorAll<HTMLElement>('a, button')) {
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (/^\s*(\+\s*)?yeni\b/i.test(el.textContent ?? '')) return el;
  }
  return null;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  helpKey?: string;
  help?: NavHelpEntry | null;
  showHelp?: boolean;
  breadcrumbs?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  /** Başlığın üstündeki küçük bağlam satırı (ör. "Cari kartı", belge türü). */
  eyebrow?: ReactNode;
  /** Başlık yanındaki durum rozetleri, belge kodu vb. */
  meta?: ReactNode;
  /** Favori yıldızı (varsayılan açık). */
  favorite?: boolean;
  /** Kayıt ekranları son ziyaretlere yazılır: `{ kind: 'Fatura' }`. */
  recent?: { kind?: string; title?: string } | false;
  /** Editörlerde başlık ve eylemler kaydırırken üstte kalır. */
  sticky?: boolean;
  /** Liste ekranına dönüş bağlantısı (detay/editör ekranları). */
  back?: { to: string; label: string };
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  helpKey,
  help,
  showHelp = true,
  breadcrumbs,
  onBack,
  backLabel = 'Geri dön',
  eyebrow,
  meta,
  favorite = true,
  recent = false,
  sticky = false,
  back,
  className,
}: PageHeaderProps) {
  const embedded = useEmbedded();
  const inShell = useInShell() && !embedded;
  const Heading = embedded ? 'h2' : 'h1';
  const actionsRef = useRef<HTMLDivElement>(null);
  useHotkey(
    'n',
    () => findPrimaryNew(actionsRef.current)?.click(),
    { description: 'Sayfadaki “Yeni” eylemi', group: 'Sayfa', scope: 'page', enabled: !!actions },
  );
  return (
    <header
      className={cn(
        'mb-6 flex flex-wrap items-end justify-between gap-3',
        className,
        sticky &&
          'sticky top-0 z-(--layer-sticky) -mx-4 border-b border-border bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8 print:static print:border-0',
      )}
    >
      <div className="min-w-0 max-w-full">
        {breadcrumbs && <div className="mb-2 text-xs text-muted">{breadcrumbs}</div>}
        {back && !embedded && (
          <Link to={back.to} className="mb-2 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus print:hidden">
            <ArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}
        {eyebrow && <div className="micro mb-1">{eyebrow}</div>}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {onBack && (
            <Button size="sm" variant="ghost" onClick={onBack} aria-label={backLabel} className="-ml-2">
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
          )}
          <Heading className={cn('min-w-0 break-words font-semibold tracking-tight', embedded ? 'text-subheading' : 'text-heading max-sm:text-heading-sm')}>{title}</Heading>
          {showHelp && <PageHelpTooltip title={title} description={description} helpKey={helpKey} help={help} />}
          {inShell && favorite && <FavoriteStar title={title} />}
          {meta && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{meta}</div>}
        </div>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
        {inShell && recent && <RecentRecorder title={recent.title ?? title} kind={recent.kind} />}
      </div>
      {actions && (
        <div ref={actionsRef} className="flex min-w-0 max-w-full flex-wrap items-center gap-2 print:hidden">
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * Yalnız başlık satırı (h1 + "i" rehberi + favori + son ziyaret): başlık düzeni özel olan detay ekranlarında
 * kendi yerleşimini korurken PageHeader ile aynı rehber/kişisel davranışı verir.
 */
export function PageTitle({
  title,
  helpKey,
  help,
  description,
  favorite = true,
  recent = false,
  children,
}: {
  title: string;
  helpKey?: string;
  help?: NavHelpEntry | null;
  description?: string;
  favorite?: boolean;
  recent?: { kind?: string; title?: string } | false;
  /** Başlıktan sonra gelen rozetler. */
  children?: ReactNode;
}) {
  const inShell = useInShell();
  return (
    <>
      <h1 className="min-w-0 break-words text-heading font-semibold tracking-tight max-sm:text-heading-sm">{title}</h1>
      <PageHelpTooltip title={title} description={description} helpKey={helpKey} help={help} />
      {inShell && favorite && <FavoriteStar title={title} />}
      {children}
      {inShell && recent && <RecentRecorder title={recent.title ?? title} kind={recent.kind} />}
    </>
  );
}
