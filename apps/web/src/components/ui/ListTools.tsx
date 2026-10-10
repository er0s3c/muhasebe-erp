import type { ReactNode } from 'react';
import { Button } from './Button';
import { cn } from '../../lib/cn';

export function ListToolbar({ children, summary, onReset, className }: { children: ReactNode; summary?: ReactNode; onReset?: () => void; className?: string }) {
  return <section aria-label="Liste filtreleri" data-form-guard="off" className={cn('mb-5 space-y-3', className)}>
    <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    {(summary || onReset) && <div className="flex flex-wrap items-center gap-2 text-xs text-muted">{summary}{onReset && <Button size="sm" variant="ghost" onClick={onReset}>Filtreleri temizle</Button>}</div>}
  </section>;
}

export function ResultFooter({ shown, total, hasMore, onMore, loading, maxReached, children, className }: {
  shown: number; total?: number; hasMore?: boolean; onMore?: () => void; loading?: boolean; maxReached?: boolean; children?: ReactNode; className?: string;
}) {
  return <div className={cn('mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted', className)}>
    <span aria-live="polite">{total !== undefined ? `${total.toLocaleString('tr-TR')} kayıttan ${shown.toLocaleString('tr-TR')} gösteriliyor` : `${shown.toLocaleString('tr-TR')} kayıt gösteriliyor`}{maxReached && ' · Diğer kayıtlar için filtreleri daraltın.'}</span>
    {children}{onMore && (hasMore ?? (total !== undefined && shown < total)) && <Button size="sm" loading={loading} onClick={onMore}>Daha fazla göster</Button>}
  </div>;
}
