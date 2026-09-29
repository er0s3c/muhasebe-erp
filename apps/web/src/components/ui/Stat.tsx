import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Card } from './Card';

/** Gösterge kartı: sönük etiket, iri (28px) tek ağırlıklı değer, isteğe bağlı alt not. */
export function Stat({ label, children, sub, className }: { label: string; children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-5', className)}>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1.5 text-heading">{children}</p>
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
}
