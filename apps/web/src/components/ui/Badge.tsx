import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
/** Etiketler 6px (hap yok). `brand` = Ink çerçeveli nötr; sarı yalnızca eylem yüzeylerinde kullanılır. */
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  brand: 'border border-border-strong text-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs', tones[tone], className)}>
      {children}
    </span>
  );
}
