import * as Popover from '@radix-ui/react-popover';
import { NAV_ITEMS } from '@erp/shared';
import { Info, Lightbulb, BookOpen } from 'lucide-react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { NAV_GROUP_HELP, NAV_ITEM_HELP, type NavHelpEntry } from './navHelpData';

// Navigation is the route source of truth, including query-specific screens.
const PATH_TO_HELP_KEY = Object.fromEntries(NAV_ITEMS.map(item => [item.path, item.key]));

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/i̇/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

export function resolveHelpEntry(
  pathname: string,
  search: string,
  title?: string,
  description?: string,
  helpKey?: string,
  explicitHelp?: NavHelpEntry | null,
): NavHelpEntry {
  if (explicitHelp) return explicitHelp;

  // 1. Direct helpKey
  if (helpKey) {
    if (NAV_ITEM_HELP[helpKey]) return NAV_ITEM_HELP[helpKey];
    if (NAV_GROUP_HELP[helpKey]) return NAV_GROUP_HELP[helpKey];
  }

  // 2. Exact pathname + search or pathname match
  const fullPath = search ? `${pathname}${search}` : pathname;
  const matchedKey = PATH_TO_HELP_KEY[fullPath] || PATH_TO_HELP_KEY[pathname];
  if (matchedKey && NAV_ITEM_HELP[matchedKey]) {
    return NAV_ITEM_HELP[matchedKey];
  }

  // 3. Search in NAV_ITEM_HELP by title
  if (title) {
    const norm = normalizeText(title);
    for (const entry of Object.values(NAV_ITEM_HELP)) {
      if (normalizeText(entry.title) === norm) {
        return entry;
      }
    }
    for (const entry of Object.values(NAV_ITEM_HELP)) {
      const entryNorm = normalizeText(entry.title);
      if (entryNorm.includes(norm) || norm.includes(entryNorm)) {
        return entry;
      }
    }
  }

  // 4. Fallback based on provided title & description
  const safeTitle = title || 'Modül Bilgisi';
  return {
    title: safeTitle,
    description:
      description ||
      `${safeTitle} modülü işletmenizin ilgili operasyonel süreçlerini ve kayıtlarını yönetmenizi sağlar.`,
    example: `Bu ekrandaki kayıt ve işlem ayrıntılarını inceleyin. Kullanılabilen işlemler şirketinizin modülleri ve kullanıcı yetkilerinize göre değişir.`,
  };
}

export interface PageHelpTooltipProps {
  title?: string;
  description?: string;
  helpKey?: string;
  help?: NavHelpEntry | null;
  className?: string;
}

export function PageHelpTooltip(props: PageHelpTooltipProps) {
  const inRouter = useInRouterContext();
  return inRouter ? <RoutedHelpTooltip {...props} /> : <HelpTooltip {...props} pathname="" search="" />;
}

function RoutedHelpTooltip(props: PageHelpTooltipProps) {
  const { pathname, search } = useLocation();
  return <HelpTooltip {...props} pathname={pathname} search={search} />;
}

function HelpTooltip({
  title,
  description,
  helpKey,
  help,
  className,
  pathname,
  search,
}: PageHelpTooltipProps & { pathname: string; search: string }) {
  const helpData = resolveHelpEntry(pathname, search, title, description, helpKey, help);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${helpData.title} hakkında rehber`}
          className={cn(
            'inline-flex items-center justify-center size-6 rounded-full text-muted hover:text-text hover:bg-surface-2 transition-colors border border-border shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text print:hidden',
            className,
          )}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={`${helpData.title} kullanım rehberi`}
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-50 w-84 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-3.5 text-xs text-text"
        >
          <div className="flex items-start gap-2.5 border-b border-border pb-2.5 mb-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text">
              <BookOpen className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h4 className="font-semibold text-text text-sm leading-tight">{helpData.title}</h4>
              <span className="text-[12px] text-muted uppercase tracking-wider font-medium">
                Modül Kullanım Rehberi
              </span>
            </div>
          </div>

          <div className="space-y-2.5">
            <div>
              <p className="mb-1 text-xs text-text">
                Ne İşe Yarar?
              </p>
              <p className="text-xs leading-relaxed text-muted">{helpData.description}</p>
            </div>

            <div className="rounded-lg bg-surface-2/80 p-2.5 border border-border/70">
              <div className="mb-1 flex items-center gap-1.5 text-xs text-text">
                <Lightbulb className="size-3.5 shrink-0" />
                <span>Kullanım Durumu & Örnek</span>
              </div>
              <p className="text-xs leading-relaxed text-text">{helpData.example}</p>
            </div>
          </div>

          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
