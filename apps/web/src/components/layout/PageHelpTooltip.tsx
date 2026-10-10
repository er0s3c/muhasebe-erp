import * as Popover from '@radix-ui/react-popover';
import { Info, Lightbulb, BookOpen } from 'lucide-react';
import { useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { loadHelpData, type NavHelpEntry } from './helpTypes';
import { resolveHelpEntry, type HelpQuery } from './helpResolve';

export { resolveHelpEntry } from './helpResolve';

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

function HelpTooltip({ className, ...query }: PageHelpTooltipProps & { pathname: string; search: string }) {
  return (
    <HelpPopover
      label={query.title ?? 'Bu ekran'}
      className={className}
      heading="Modül Kullanım Rehberi"
      resolve={async () => resolveHelpEntry(await loadHelpData(), query satisfies HelpQuery)}
    />
  );
}

/** Kart/bölüm başlığı için küçük "i": metin satır içinde verilir, rehber verisi indirilmez. */
export function SectionHelp({ title, help, className }: { title: string; help: string | NavHelpEntry; className?: string }) {
  const entry = typeof help === 'string' ? { title, description: help } : help;
  return <HelpPopover label={title} size="sm" heading="Bölüm Rehberi" entry={entry} className={className} />;
}

function HelpPopover({
  label,
  heading,
  entry,
  resolve,
  size = 'md',
  className,
}: {
  label: string;
  heading: string;
  entry?: NavHelpEntry;
  resolve?: () => Promise<NavHelpEntry>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [loaded, setLoaded] = useState<NavHelpEntry | null>(entry ?? null);
  const [failed, setFailed] = useState(false);
  const data = entry ?? loaded;
  const load = () => {
    if (entry || loaded || !resolve) return;
    resolve().then(setLoaded, () => setFailed(true));
  };

  return (
    <Popover.Root onOpenChange={open => open && load()}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label} hakkında rehber`}
          onPointerEnter={load}
          onFocus={load}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full border border-border text-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus print:hidden',
            size === 'sm' ? 'size-5' : 'size-6',
            className,
          )}
        >
          <Info className={size === 'sm' ? 'size-3' : 'size-3.5'} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label={`${label} kullanım rehberi`}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-84 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-3.5 text-xs text-text shadow-pop animate-[pop-in_120ms_ease-out]"
        >
          <div className="mb-2.5 flex items-start gap-2.5 border-b border-border pb-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-contrast">
              <BookOpen className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-semibold leading-tight text-text">{data?.title ?? label}</h4>
              <span className="text-[12px] font-medium uppercase tracking-wider text-muted">{heading}</span>
            </div>
          </div>

          {data ? (
            <div className="space-y-2.5">
              <div>
                <p className="mb-1 text-xs font-medium text-text">Ne işe yarar?</p>
                <p className="text-xs leading-relaxed text-muted">{data.description}</p>
              </div>
              {data.example && (
                <div className="rounded-lg border border-border/70 bg-surface-2/80 p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text">
                    <Lightbulb className="size-3.5 shrink-0" aria-hidden />
                    <span>Kullanım durumu ve örnek</span>
                  </div>
                  <p className="text-xs leading-relaxed text-text">{data.example}</p>
                </div>
              )}
            </div>
          ) : failed ? (
            <p className="text-xs text-danger">Rehber yüklenemedi. Bağlantınızı kontrol edip tekrar açın.</p>
          ) : (
            <div className="space-y-2" aria-busy="true" aria-label="Rehber yükleniyor">
              <div className="ui-skeleton h-3 w-3/4 rounded" />
              <div className="ui-skeleton h-3 w-full rounded" />
              <div className="ui-skeleton h-10 w-full rounded-lg" />
            </div>
          )}

          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
