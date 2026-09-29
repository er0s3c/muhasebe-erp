import { ChevronsUpDown } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

export interface ComboOption {
  value: string;
  label: string;
  /** Aramada eşleşecek ek metin (örn. hesap kodu). */
  keywords?: string;
  hint?: string;
}

interface ComboboxProps {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');

/** Arama yapılabilen, klavyeyle gezilebilen seçim kutusu (hesap seçici vb.). */
export function Combobox({ options, value, onChange, placeholder, disabled, className, ...rest }: ComboboxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return options.slice(0, 80);
    return options.filter((o) => norm(`${o.label} ${o.keywords ?? ''}`).includes(q)).slice(0, 80);
  }, [options, query]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        disabled={disabled}
        className="h-9 w-full rounded-lg border border-border-strong bg-surface px-3 pr-8 text-sm placeholder:text-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:opacity-60"
        placeholder={selected ? selected.label : placeholder}
        value={open ? query : (selected?.label ?? '')}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && filtered[active]) {
            e.preventDefault();
            choose(filtered[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          } else if (e.key === 'Tab') {
            if (open && filtered[active] && query) choose(filtered[active]);
            else setOpen(false);
          }
        }}
        {...rest}
      />
      <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted" aria-hidden />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full min-w-64 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-pop">
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted">Sonuç yok</li>}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-sm', i === active && 'bg-brand-soft', o.value === value && 'font-medium')}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
