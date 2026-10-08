import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { DateInput } from './DateInput';

export { Select } from './Select';

/** Girdi: 10px yarıçap, hairline çerçeve; odakta Ink çerçeve (sarı yalnızca eylem yüzeylerinde). */
const control =
  'min-w-0 w-full rounded-lg border border-border-strong bg-surface px-3.5 text-sm text-text placeholder:text-muted/70 ' +
  'transition-colors focus:border-text focus:outline-none disabled:bg-surface-2 disabled:opacity-70';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  // Tarih/ay girdileri tema renkli takvimle gelir (tarayıcının kendi açılırı stillenemez)
  const { type, onClick, onKeyDown, ...rest } = props;
  if (type === 'date' || type === 'month') return <DateInput ref={ref} className={className} {...rest} onClick={onClick} onKeyDown={onKeyDown} type={type as 'date' | 'month'} />;
  const hasPicker = type === 'time' || type === 'datetime-local';
  const showPicker = (input: HTMLInputElement) => {
    if (!hasPicker || input.matches(':disabled') || input.readOnly || !input.showPicker) return false;
    try {
      input.showPicker();
      return true;
    } catch {
      // Desteklenmeyen ortamlarda saat alanı klavyeyle düzenlenmeye devam eder.
      return false;
    }
  };
  return (
    <input
      ref={ref}
      className={cn(control, 'h-10', hasPicker && 'cursor-pointer', className)}
      {...rest}
      type={type}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) showPicker(event.currentTarget);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented && (event.key === ' ' || (event.altKey && event.key === 'ArrowDown')) && showPicker(event.currentTarget)) event.preventDefault();
      }}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-20 py-2.5', className)} {...props} />;
});

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (id: string) => ReactNode;
}

/** Etiket + kontrol + ipucu/hata; erişilebilirlik için id bağlar. */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  return (
    <div className={cn('min-w-0 flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] text-text">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
