import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

interface Opt {
  value: string;
  label: string;
  disabled: boolean;
}

const sameOpts = (a: Opt[], b: Opt[]) => a.length === b.length && a.every((o, i) => o.value === b[i]!.value && o.label === b[i]!.label && o.disabled === b[i]!.disabled);

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;

/** Girdi görünümü (Field.tsx `control` ile aynı): 10px yarıçap, hairline çerçeve; odakta/açıkken Ink çerçeve. */
const trigger =
  'relative flex h-10 min-w-0 w-full items-center rounded-lg border border-border-strong bg-surface px-3.5 pr-8 text-left text-sm text-text ' +
  'transition-colors focus:border-text focus:outline-none data-[state=open]:border-text has-[+select:focus-visible]:border-text disabled:bg-surface-2 disabled:opacity-70';

const content =
  'z-50 max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[min(28rem,92vw)] ' +
  'overflow-y-auto rounded-xl border border-border bg-surface p-1.5 [animation:pop-in_0.12s_ease-out] print:hidden';

const item =
  'flex cursor-pointer select-none items-center justify-between gap-3 rounded-md px-3 py-2 text-sm outline-none ' +
  'data-[highlighted]:bg-surface-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/**
 * Açılır seçim kutusu. Tarayıcının kendi (stillenemeyen) açılır listesi yerine tema renkli bir menü gösterir.
 * API `<select>` ile aynıdır: `<option>` çocukları, `value`/`defaultValue`, `onChange(e)`, `ref` ve react-hook-form
 * `register` olduğu gibi çalışır. Asıl kontrol, görünmez ama erişilebilir gerçek bir `<select>`tir (etiket, odak,
 * ok tuşları, ekran okuyucu ve testler ona bağlanır); görünür kutu yalnızca fareyle/Enter/Boşluk ile açılan
 * görsel katmandır ve seçimde `<select>`e `change` olayı gönderir. `className` görünür kutuya uygulanır.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, disabled, onKeyDown, ...props },
  ref,
) {
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [opts, setOpts] = useState<Opt[]>([]);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);

  const sync = useCallback(() => {
    const el = nativeRef.current;
    if (!el) return;
    const next = Array.from(el.options).map((o) => ({ value: o.value, label: o.text, disabled: o.disabled }));
    setOpts((prev) => (sameOpts(prev, next) ? prev : next));
    setValue(el.value);
  }, []);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  // Seçenekler/değer her çizimde yerel select'ten okunur (çocuklar bileşen olabilir: CurrencyOptions).
  useLayoutEffect(sync);

  const setRefs = useCallback(
    (el: HTMLSelectElement | null) => {
      nativeRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
      // react-hook-form reset/setValue `el.value = x` ile yazar; görünür kutu da güncellensin.
      if (el && !Object.prototype.hasOwnProperty.call(el, 'value')) {
        Object.defineProperty(el, 'value', {
          configurable: true,
          get() {
            return nativeValue.get!.call(this);
          },
          set(v: string) {
            nativeValue.set!.call(this, v);
            syncRef.current();
          },
        });
      }
    },
    [ref],
  );

  const choose = (v: string) => {
    const el = nativeRef.current;
    if (!el) return;
    if (v !== el.value) {
      nativeValue.set!.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
    nativeRef.current?.focus();
  };

  // Menü açılınca seçili öğeye odaklan ve listede görünür kıl (Radix varsayılan olarak ilk öğeye odaklanır)
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const current = contentRef.current?.querySelector<HTMLElement>('[data-state="checked"]');
      current?.focus();
      current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const selected = opts.find((o) => o.value === value);

  return (
    <>
      <Dropdown.Root open={open} onOpenChange={setOpen}>
        <Dropdown.Trigger
          ref={triggerRef}
          disabled={disabled}
          tabIndex={-1}
          aria-hidden="true"
          title={selected?.label}
          className={cn(trigger, className)}
        >
          <span className={cn('min-w-0 flex-1 truncate', value === '' && 'text-muted')}>{selected?.label || ' '}</span>
          <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-muted" aria-hidden />
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            ref={contentRef}
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className={content}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              nativeRef.current?.focus();
            }}
          >
            <Dropdown.RadioGroup value={value} onValueChange={choose}>
              {opts.map((o) => (
                <Dropdown.RadioItem key={o.value} value={o.value} disabled={o.disabled} className={cn(item, o.value === '' && 'text-muted')}>
                  <span className="min-w-0 break-words">{o.label || ' '}</span>
                  <Dropdown.ItemIndicator>
                    <Check className="size-4 text-text" aria-hidden />
                  </Dropdown.ItemIndicator>
                </Dropdown.RadioItem>
              ))}
            </Dropdown.RadioGroup>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <select
        {...props}
        ref={setRefs}
        disabled={disabled}
        // Enter/Boşluk/Alt+Aşağı özel menüyü açar; ok tuşları ve harfle arama yerel davranışta kalır
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Enter' || e.key === ' ' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="native-select sr-only"
      >
        {children}
      </select>
    </>
  );
});
