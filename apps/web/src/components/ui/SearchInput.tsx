import { Search, X } from 'lucide-react';
import { Input } from './Field';
import { cn } from '../../lib/cn';

export function SearchInput({ value, onChange, placeholder = 'Ara…', className, onClear, 'aria-label': label = 'Ara' }: {
  value: string; onChange: (value: string) => void; placeholder?: string; className?: string; onClear?: () => void; 'aria-label'?: string;
}) {
  return <div role="search" className={cn('relative min-w-0 w-full sm:max-w-sm', className)}>
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    <Input type="search" aria-label={label} className="pl-9 pr-10" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    {value && <button type="button" aria-label="Aramayı temizle" className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-text" onClick={() => { onChange(''); onClear?.(); }}><X className="size-4" /></button>}
  </div>;
}
