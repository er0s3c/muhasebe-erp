import { cn } from '../../lib/cn';

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
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1', className)}>
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={value === it.key}
          onClick={() => onChange(it.key)}
          className={cn(
            'rounded-md px-4 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
            value === it.key ? 'bg-brand text-brand-contrast' : 'text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
