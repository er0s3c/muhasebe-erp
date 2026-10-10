import { ChevronsUpDown } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');

/** Arama yapılabilen, klavyeyle gezilebilen seçim kutusu (hesap seçici vb.). */
export function Combobox({ options, value, onChange, placeholder, disabled, className, ...rest }: ComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const matches = useMemo(() => {
    const q = norm(query.trim());
    return q ? options.filter((o) => norm(`${o.label} ${o.keywords ?? ''}`).includes(q)) : options;
  }, [options, query]);
  const filtered = useMemo(() => matches.slice(0, 80), [matches]);

  useEffect(() => {
    setActive(query ? 0 : Math.max(0, filtered.findIndex((option) => option.value === value)));
  }, [query, open, value, filtered]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, listId]);

  const choose = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Anchor asChild><div ref={rootRef} className={cn('relative min-w-0', className)}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open && !disabled}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
        disabled={disabled}
        className="ui-control h-10 w-full rounded-lg border border-border-strong bg-surface px-3.5 pr-8 text-sm placeholder:text-muted/70 transition-colors focus:border-text focus:outline-none disabled:opacity-60"
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
            setActive((a) => open ? Math.min(a + 1, Math.max(0, filtered.length - 1)) : 0);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && filtered[active]) {
            e.preventDefault();
            choose(filtered[active]);
          } else if (e.key === 'Escape') {
            if (open) { e.preventDefault(); e.stopPropagation(); }
            setOpen(false);
          } else if (e.key === 'Tab') {
            setOpen(false);
            setQuery('');
          } else if (open && (e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
            e.preventDefault();
            setActive(e.key === 'Home' ? 0 : Math.max(0, filtered.length - 1));
          }
        }}
        {...rest}
      />
      <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div></Popover.Anchor>
      {open && (
        <Popover.Portal><Popover.Content align="start" sideOffset={6} collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => { if (rootRef.current?.contains(event.target as Node)) event.preventDefault(); }}
          className="z-[60] w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface py-1">
        <ul id={listId} role="listbox" className="max-h-[min(16rem,var(--radix-popover-content-available-height))] overflow-y-auto">
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('common.noResults')}</li>}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => choose(o)}
              onMouseEnter={() => setActive(i)}
              className={cn('flex min-h-10 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm max-md:min-h-11', i === active && 'bg-surface-2', o.value === value && 'font-medium text-text underline decoration-border-strong underline-offset-4')}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
            </li>
          ))}
        </ul>
        {matches.length > filtered.length && <p className="border-t border-border px-3 py-2 text-xs text-muted" role="status">İlk 80 sonuç gösteriliyor. Aramayı daraltın.</p>}
        </Popover.Content></Popover.Portal>
      )}
    </Popover.Root>
  );
}
