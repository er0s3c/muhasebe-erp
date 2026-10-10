import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { PageHelpTooltip } from '../layout/PageHelpTooltip';
import type { NavHelpEntry } from '../layout/navHelpData';
import { ArrowLeft } from 'lucide-react';
import { Button } from './Button';

/** Kart: beyaz yüzey + 1px hairline; yükseklik gölgeyle değil çerçeveyle ifade edilir. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 rounded-2xl border border-border bg-surface', className)} {...props} />;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-base font-medium">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      {action && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 print:hidden">{action}</div>}
    </div>
  );
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
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  helpKey?: string;
  help?: NavHelpEntry | null;
  showHelp?: boolean;
  breadcrumbs?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-w-full">
        {breadcrumbs && <div className="mb-2 text-xs text-muted">{breadcrumbs}</div>}
        <div className="flex min-w-0 items-center gap-2">
          {onBack && <Button size="sm" variant="ghost" onClick={onBack} aria-label={backLabel}><ArrowLeft className="size-4" aria-hidden /></Button>}
          <h1 className="min-w-0 break-words text-heading font-semibold tracking-tight">{title}</h1>
          {showHelp && (
            <PageHelpTooltip
              title={title}
              description={description}
              helpKey={helpKey}
              help={help}
            />
          )}
        </div>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </div>
  );
}
