import { Children, cloneElement, forwardRef, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { DateInput } from './DateInput';

export { Select } from './Select';

/** Girdi: 10px yarıçap, hairline çerçeve; odakta Ink çerçeve (sarı yalnızca eylem yüzeylerinde). */
const control =
  'ui-control min-w-0 w-full rounded-lg border border-border-strong bg-surface px-3.5 text-sm text-text placeholder:text-muted/70 ' +
  'transition-colors focus:border-text focus:outline-none aria-invalid:border-danger aria-invalid:focus:border-danger disabled:bg-surface-2 disabled:opacity-70';

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

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}
export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (id: string, props: FieldControlProps) => ReactNode;
}

/** Etiket + kontrol + ipucu/hata; erişilebilirlik için id bağlar. */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const metadata: FieldControlProps = {
    id,
    'aria-describedby': error || hint ? messageId : undefined,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
  };
  // Gerçek kontrolü id ile bulur; bileşik kontrolün kendi doğrulamasını ve açıklamalarını korur.
  const associate = (node: ReactNode): ReactNode => Children.map(node, child => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<FieldControlProps & { children?: ReactNode }>;
    if (element.props.id === id) {
      const descriptions = [element.props['aria-describedby'], metadata['aria-describedby']].filter(Boolean).join(' ') || undefined;
      return cloneElement(element, {
        'aria-describedby': descriptions,
        'aria-invalid': element.props['aria-invalid'] ?? metadata['aria-invalid'],
        'aria-required': element.props['aria-required'] ?? metadata['aria-required'],
      });
    }
    return element.props.children ? cloneElement(element, {}, associate(element.props.children)) : element;
  });
  return (
    <div className={cn('min-w-0 flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-text">
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </label>
      {associate(children(id, metadata))}
      {error ? (
        <p id={messageId} role="alert" className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
