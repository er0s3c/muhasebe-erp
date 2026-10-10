import { cn } from '../../lib/cn';
import { useId, type ReactNode } from 'react';

interface TabItem<T extends string> {
  key: T;
  label: string;
}

/**
 * Bölmeli sekme/seçici. Aktif seçenek sarı dolgu + Ink metindir (aktif durum = eylem yüzeyi).
 * `role="tablist"/"tab"` ve `aria-selected` korunur.
 */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  className,
  variant = 'tabs',
  label = 'Bölümler',
  panelId,
  id,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
  variant?: 'tabs' | 'filter';
  label?: string;
  panelId?: (key: T) => string;
  id?: string;
}) {
  const generatedId = useId();
  const groupId = id ?? generatedId;
  return (
    <div role={variant === 'tabs' ? 'tablist' : 'group'} aria-label={label} className={cn('inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-border bg-surface p-1', className)}>
      {items.map((it, index) => (
        <button
          type="button"
          key={it.key}
          id={`${groupId}-${it.key}`}
          role={variant === 'tabs' ? 'tab' : undefined}
          aria-selected={variant === 'tabs' ? value === it.key : undefined}
          aria-pressed={variant === 'filter' ? value === it.key : undefined}
          aria-controls={variant === 'tabs' ? panelId?.(it.key) : undefined}
          tabIndex={variant === 'tabs' && value !== it.key ? -1 : 0}
          onClick={() => onChange(it.key)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % items.length;
            else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault();
            onChange(items[next].key);
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
            buttons?.[next]?.focus();
          }}
          className={cn(
            'min-h-9 rounded-md px-4 py-1.5 text-sm font-medium transition-colors max-md:min-h-11',
            value === it.key ? 'bg-brand text-brand-contrast' : 'text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, labelledBy, children, hidden }: { id: string; labelledBy: string; children: ReactNode; hidden?: boolean }) {
  return <div id={id} role="tabpanel" aria-labelledby={labelledBy} tabIndex={0} hidden={hidden} className="min-w-0">{children}</div>;
}
