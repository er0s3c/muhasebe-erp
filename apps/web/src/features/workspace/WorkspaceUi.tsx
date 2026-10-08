import { Search } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Input } from '../../components/ui/Field';
import { todayIso } from '@erp/shared';
export function StatusBadge({ status, dueDate }: { status: string; dueDate?: string }) {
  const late = status === 'open' && !!dueDate && dueDate < todayIso();
  return (
    <Badge tone={late ? 'danger' : status === 'done' ? 'success' : 'neutral'}>
      {late
        ? 'Gecikmiş'
        : status === 'done'
          ? 'Tamamlandı'
          : status === 'cancelled'
            ? 'İptal'
            : 'Açık'}
    </Badge>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = 'Başlık veya not ara…',
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative min-w-0 basis-full sm:basis-48 sm:flex-1">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
      <Input
        type="search"
        aria-label="Listede ara"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9"
      />
    </div>
  );
}
