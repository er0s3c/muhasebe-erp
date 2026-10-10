import { useEffect, useState, type HTMLAttributes, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** Tablo kabı: geniş tablo kendi içinde kayar. `relative`: hücrelerdeki mutlak konumlu öğeler (sr-only vb.) kabın dışına taşıp belgeyi yatay kaydırmasın; `min-w-0`: esnek sütunda kab tablo genişliğine uzamasın (UI-9). */
export function TableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('relative min-w-0 max-w-full overflow-auto rounded-2xl border border-border bg-surface', className)} {...props} />;
}
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}
/** Başlık: büyük harf mikro etiket (Ash), hairline alt çizgi; kalın yazı yok. */
export function Th({ className, num, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-border bg-surface-2 px-4 py-3 text-left text-xs font-medium text-muted in-data-[density=compact]:py-2',
        num && 'num',
        className,
      )}
      {...props}
    />
  );
}
export function Td({ className, num, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <td className={cn('border-b border-border/70 px-4 py-2.5 align-middle in-data-[density=compact]:py-1.5 in-data-[density=compact]:text-[13px]', num && 'num', className)} {...props} />;
}
export function Tr({ className, clickable, onClick, onKeyDown, ...props }: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return <tr
    tabIndex={clickable && onClick ? 0 : undefined}
    className={cn('transition-colors last:[&>td]:border-b-0 hover:bg-surface-2/45', clickable && 'cursor-pointer hover:bg-surface-2/80 focus-visible:bg-surface-2', className)}
    onClick={onClick}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && !onKeyDown && event.target === event.currentTarget && onClick && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.currentTarget.click();
      }
    }}
    {...props}
  />;
}

/**
 * Uzun listelerde ilk boyamayı hızlandırır: ilk `initial` satır hemen, kalanı tarayıcı boşta kaldıkça parça parça çizilir.
 * (`content-visibility` tablo satırlarına uygulanmadığı için bağımlılıksız kademeli çizim.) Liste değişince baştan başlar.
 */
export function useProgressiveRows<T>(rows: readonly T[], initial = 120, step = 240): readonly T[] {
  // Dizinin kimliği her render'da değişebilir; yalnız uzunluk izlenir (render içinde, efektsiz). Liste uzarsa ("daha fazla")
  // çizilmiş satırlar korunur, kısalırsa (filtre) baştan başlanır: kaydırma konumu zıplamaz.
  const total = rows.length;
  const [state, setState] = useState({ len: total, count: initial });
  let count = state.count;
  if (state.len !== total) {
    count = total > state.len ? Math.max(initial, Math.min(state.count, state.len)) : initial;
    setState({ len: total, count });
  }
  useEffect(() => {
    if (count >= total) return;
    const g = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const grow = () => setState(s => ({ ...s, count: Math.min(total, s.count + step) }));
    if (g.requestIdleCallback && g.cancelIdleCallback) {
      const id = g.requestIdleCallback(grow, { timeout: 200 });
      return () => g.cancelIdleCallback!(id);
    }
    const id = setTimeout(grow, 16);
    return () => clearTimeout(id);
  }, [count, total, step]);
  return count >= total ? rows : rows.slice(0, count);
}

/** JSX içinde kademeli satır çizimi: `<ProgressiveRows rows={list}>{row => <Tr key=…/>}</ProgressiveRows>`. */
export function ProgressiveRows<T>({ rows, children }: { rows: readonly T[]; children: (row: T, index: number) => ReactNode }) {
  const visible = useProgressiveRows(rows);
  return <>{visible.map(children)}</>;
}
