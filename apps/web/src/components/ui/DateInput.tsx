import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { cn } from '../../lib/cn';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

function parse(s: string) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]) - 1, d: m[3] ? Number(m[3]) : 1 } : null;
}

function addDays(s: string, n: number): string {
  const p = parse(s)!;
  const d = new Date(Date.UTC(p.y, p.m, p.d + n));
  return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Ay ekler; gün ayın son gününü aşarsa o güne sıkıştırılır (31 Oca + 1 ay = 28/29 Şub). */
function addMonths(s: string, n: number): string {
  const p = parse(s)!;
  const total = p.y * 12 + p.m + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(y, m, Math.min(p.d, dim));
}

const monthName = (m: number, style: 'long' | 'short') => new Intl.DateTimeFormat('tr-TR', { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, m, 1)));
const WEEKDAYS = ['Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct', 'Pz'];

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;

const nav = 'flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text';
const cellBase = 'flex items-center justify-center rounded-md text-sm transition-colors outline-none focus-visible:outline-2 focus-visible:outline-focus';

interface CalendarProps {
  mode: 'date' | 'month';
  value: string;
  min?: string;
  max?: string;
  required?: boolean;
  onPick: (v: string) => void;
}

function Calendar({ mode, value, min, max, required, onPick }: CalendarProps) {
  const { t } = useTranslation();
  const today = todayIso();
  const isMonth = mode === 'month';
  const start = parse(value) ? `${value}${isMonth ? '-01' : ''}` : isMonth ? `${today.slice(0, 7)}-01` : today;
  const [focus, setFocus] = useState(start);
  const gridRef = useRef<HTMLDivElement>(null);
  const keyboard = useRef(true);
  const f = parse(focus)!;
  const key = isMonth ? 7 : 10;
  const outOfRange = (s: string) => (min && s.slice(0, key) < min.slice(0, key)) || (max && s.slice(0, key) > max.slice(0, key));

  useEffect(() => {
    if (!keyboard.current) return;
    keyboard.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-iso="${focus}"]`)?.focus();
  }, [focus]);

  const move = (next: string) => {
    keyboard.current = true;
    setFocus(next);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = isMonth ? { left: -1, right: 1, up: -3, down: 3 } : { left: -1, right: 1, up: -7, down: 7 };
    const by = (n: number) => (isMonth ? addMonths(focus, n) : addDays(focus, n));
    const map: Record<string, string> = {
      ArrowLeft: by(step.left),
      ArrowRight: by(step.right),
      ArrowUp: by(step.up),
      ArrowDown: by(step.down),
      PageUp: addMonths(focus, e.shiftKey || isMonth ? -12 : -1),
      PageDown: addMonths(focus, e.shiftKey || isMonth ? 12 : 1),
    };
    const next = map[e.key];
    if (next) {
      e.preventDefault();
      move(next);
    }
  };

  const title = isMonth ? String(f.y) : `${monthName(f.m, 'long')} ${f.y}`;
  const days = (() => {
    if (isMonth) return [];
    const lead = (new Date(Date.UTC(f.y, f.m, 1)).getUTCDay() + 6) % 7;
    const first = addDays(iso(f.y, f.m, 1), -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  })();

  return (
    <div className="w-[17.5rem] select-none" onKeyDown={onKeyDown}>
      <div className="mb-2 flex items-center justify-between gap-1">
        <div className="flex">
          <button type="button" className={nav} aria-label={t('common.prevYear')} onClick={() => setFocus(addMonths(focus, -12))}>
            <ChevronsLeft className="size-4" aria-hidden />
          </button>
          {!isMonth && (
            <button type="button" className={nav} aria-label={t('common.prevMonth')} onClick={() => setFocus(addMonths(focus, -1))}>
              <ChevronLeft className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <p className="text-sm" aria-live="polite">
          {title}
        </p>
        <div className="flex">
          {!isMonth && (
            <button type="button" className={nav} aria-label={t('common.nextMonth')} onClick={() => setFocus(addMonths(focus, 1))}>
              <ChevronRight className="size-4" aria-hidden />
            </button>
          )}
          <button type="button" className={nav} aria-label={t('common.nextYear')} onClick={() => setFocus(addMonths(focus, 12))}>
            <ChevronsRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {!isMonth && (
        <div className="mb-1 grid grid-cols-7 text-center" aria-hidden>
          {WEEKDAYS.map((d) => (
            <span key={d} className="micro py-1">
              {d}
            </span>
          ))}
        </div>
      )}

      <div ref={gridRef} className={cn('grid', isMonth ? 'grid-cols-3 gap-1.5' : 'grid-cols-7 gap-y-0.5')}>
        {(isMonth ? Array.from({ length: 12 }, (_, m) => iso(f.y, m, 1)) : days).map((d) => {
          const p = parse(d)!;
          const selected = isMonth ? d.slice(0, 7) === value : d === value;
          const isToday = isMonth ? d.slice(0, 7) === today.slice(0, 7) : d === today;
          const outside = !isMonth && p.m !== f.m;
          const disabled = Boolean(outOfRange(d));
          return (
            <button
              key={d}
              type="button"
              data-iso={d}
              tabIndex={d === focus ? 0 : -1}
              aria-pressed={selected}
              aria-disabled={disabled || undefined}
              aria-current={isToday ? 'date' : undefined}
              className={cn(
                cellBase,
                isMonth ? 'h-10' : 'size-9 justify-self-center',
                selected ? 'bg-brand text-brand-contrast hover:bg-brand-hover' : 'hover:bg-surface-2',
                !selected && isToday && 'border border-border-strong',
                !selected && outside && 'text-muted/60',
                disabled && 'cursor-not-allowed opacity-30 hover:bg-transparent',
              )}
              onClick={() => !disabled && onPick(isMonth ? d.slice(0, 7) : d)}
            >
              {isMonth ? monthName(p.m, 'short') : p.d}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
        <button
          type="button"
          className="rounded-md px-2.5 py-1.5 text-sm text-text transition-colors hover:bg-surface-2 disabled:opacity-40"
          disabled={Boolean(outOfRange(today))}
          onClick={() => onPick(isMonth ? today.slice(0, 7) : today)}
        >
          {isMonth ? t('common.thisMonth') : t('common.today')}
        </button>
        {!required && (
          <button type="button" className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text" onClick={() => onPick('')}>
            {t('common.clear')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Tarih/ay girdisi. Yazma (gg/aa/yyyy), klavye, `ref`, `onChange` ve react-hook-form `register` yerel
 * `<input type="date|month">` ile aynen çalışır; yalnızca tarayıcının stillenemeyen takvim açılırı, tema renkli
 * bir takvimle değiştirilir. `className` (genişlik) dış kapsayıcıya uygulanır.
 */
export const DateInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { type: 'date' | 'month' }>(function DateInput(
  { className, type, ...props },
  ref,
) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');

  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  const pick = (v: string) => {
    const el = inputRef.current;
    if (!el) return;
    nativeValue.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    setOpen(false);
  };

  const locked = props.disabled || props.readOnly;

  return (
    <div className={cn('relative min-w-0 w-full', className)}>
      <input
        ref={setRefs}
        type={type}
        className="h-10 min-w-0 w-full rounded-lg border border-border-strong bg-surface px-3.5 pr-10 text-sm text-text transition-colors focus:border-text focus:outline-none disabled:bg-surface-2 disabled:opacity-70 [&::-webkit-calendar-picker-indicator]:hidden"
        {...props}
      />
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          if (o) setCurrent(inputRef.current?.value ?? '');
          setOpen(o);
        }}
      >
        <Popover.Trigger
          disabled={locked}
          aria-label={t('common.pickDate')}
          className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          <CalendarDays className="size-4" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 rounded-xl border border-border bg-surface p-3 [animation:pop-in_0.12s_ease-out] print:hidden"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              inputRef.current?.focus();
            }}
          >
            <Calendar
              mode={type}
              value={current}
              min={typeof props.min === 'string' ? props.min : undefined}
              max={typeof props.max === 'string' ? props.max : undefined}
              required={props.required}
              onPick={pick}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
});
