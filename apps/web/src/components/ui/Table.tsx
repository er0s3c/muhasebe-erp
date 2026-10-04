import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
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
        'sticky top-0 z-10 whitespace-nowrap border-b border-border bg-surface-2 px-4 py-2.5 text-left text-[11px] font-normal uppercase tracking-[0.05em] text-muted',
        num && 'num',
        className,
      )}
      {...props}
    />
  );
}
export function Td({ className, num, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <td className={cn('border-b border-border/70 px-4 py-2.5 align-middle', num && 'num', className)} {...props} />;
}
export function Tr({ className, clickable, ...props }: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return <tr className={cn('last:[&>td]:border-b-0', clickable && 'cursor-pointer hover:bg-surface-2/70', className)} {...props} />;
}
