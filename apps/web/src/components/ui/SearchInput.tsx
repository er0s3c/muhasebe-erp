import { Search, X } from 'lucide-react';
import { useRef } from 'react';
import { useHotkey } from '../../lib/hotkeys';
import { Input } from './Field';
import { cn } from '../../lib/cn';

export function SearchInput({ value, onChange, placeholder = 'Ara…', className, onClear, 'aria-label': label = 'Ara', hotkey = true }: {
  value: string; onChange: (value: string) => void; placeholder?: string; className?: string; onClear?: () => void; 'aria-label'?: string;
  /** "/" tuşu bu arama kutusuna odaklar (sayfada son çizilen arama kutusu kazanır). */
  hotkey?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useHotkey('/', () => { ref.current?.focus(); ref.current?.select(); }, { scope: 'page', enabled: hotkey });
  return <div role="search" className={cn('relative min-w-0 w-full sm:max-w-sm', className)}>
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    <Input ref={ref} type="search" aria-label={label} aria-keyshortcuts={hotkey ? '/' : undefined} className="pl-9 pr-10" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    {!value && hotkey && <kbd aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 text-[11px] text-muted md:block">/</kbd>}
    {value && <button type="button" aria-label="Aramayı temizle" className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:text-text" onClick={() => { onChange(''); onClear?.(); ref.current?.focus(); }}><X className="size-4" /></button>}
  </div>;
}
