import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function FormSection({ title, description, children, actions, className }: { title: string; description?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={cn('min-w-0 rounded-2xl border border-border bg-surface', className)}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4"><div className="min-w-0"><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-1 text-xs text-muted">{description}</p>}</div>{actions}</div>
    <div className="min-w-0 space-y-5 p-5">{children}</div>
  </section>;
}
