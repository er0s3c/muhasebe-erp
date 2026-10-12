import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { useQueryLoadFailed } from './QueryFeedbackContext';

export function Spinner({ className }: { className?: string }) {
  const { t } = useTranslation();
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} role="img" aria-label={t('common.loadingLabel')} />;
}

export function PageLoading() {
  const failed = useQueryLoadFailed();
  if (failed) return null;
  return (
    <div role="status" aria-label="Yükleniyor" className="flex h-48 items-center justify-center">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-text">{icon}</div>}
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ title = 'Bilgiler yüklenemedi', description, error, onRetry, retrying, action, className }: {
  title?: string; description?: string; error?: unknown; onRetry?: () => void; retrying?: boolean; action?: ReactNode; className?: string;
}) {
  return <div className={cn('rounded-2xl border border-danger/30 bg-surface px-5 py-5', className)} role="alert">
    <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden /><div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-sm text-muted">{description ?? (error instanceof TypeError ? 'Bağlantıyı kontrol edip yeniden deneyin.' : 'İşlem tamamlanamadı. Yeniden deneyebilirsiniz.')}</p>{(onRetry || action) && <div className="mt-4 flex flex-wrap gap-2">{onRetry && <Button size="sm" loading={retrying} onClick={onRetry}>Tekrar dene</Button>}{action}</div>}</div></div>
  </div>;
}

export function ListSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return <div role="status" aria-label="Liste yükleniyor" className="overflow-hidden rounded-2xl border border-border bg-surface"><span className="sr-only">Liste yükleniyor…</span>{Array.from({ length: rows }, (_, row) => <div key={row} className="flex gap-4 border-b border-border p-4 last:border-0">{Array.from({ length: columns }, (_, column) => <div key={column} className="ui-skeleton h-4 min-w-0 flex-1 rounded-md" />)}</div>)}</div>;
}
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return <div role="status" aria-label="Form yükleniyor" className="space-y-5 rounded-2xl border border-border bg-surface p-5">{Array.from({ length: fields }, (_, index) => <div key={index} className="space-y-2"><div className="ui-skeleton h-3 w-28 rounded" /><div className="ui-skeleton h-10 rounded-lg" /></div>)}</div>;
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
