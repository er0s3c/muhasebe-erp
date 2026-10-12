import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
/** Etiketler 6px (hap yok). `brand` = Ink çerçeveli nötr; sarı yalnızca eylem yüzeylerinde kullanılır. */
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  brand: 'border border-border-strong text-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

/** `dot`: durum yalnız renge bağlı kalmasın diye metnin önüne küçük işaret (metin her zaman görünür kalır). */
export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs', tones[tone], className)}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
