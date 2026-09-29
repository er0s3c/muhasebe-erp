import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} aria-label="Yükleniyor" />;
}

export function PageLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-text">{icon}</div>}
      <div>
        <p>{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = 'info' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  info: 'border-border bg-surface-2 text-text',
  warning: 'border-warning/30 bg-warning-soft text-text',
  danger: 'border-danger/30 bg-danger-soft text-text',
};

export function Callout({ tone = 'info', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', tones[tone])}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'info' ? 'text-text' : tone === 'warning' ? 'text-warning' : 'text-danger')} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p>{title}</p>}
        {children && <div className={cn(title && 'mt-0.5 text-muted')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}
