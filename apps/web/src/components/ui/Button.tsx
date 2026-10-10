import { Loader2 } from 'lucide-react';
import { cloneElement, forwardRef, isValidElement, type ButtonHTMLAttributes, type ReactElement } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

/**
 * Birincil eylem tek sarı dolgulu düğmedir; ikincil eylem Ink çerçeveli şeffaf düğmedir.
 * Silme gibi geri dönüşsüz eylemler çerçeveli/metin kırmızıdır (dolgu yok).
 */
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-brand-contrast hover:bg-brand-hover',
  secondary: 'border border-text bg-transparent text-text hover:bg-surface-2',
  ghost: 'text-text hover:bg-surface-2',
  danger: 'border border-danger bg-transparent text-danger hover:bg-danger-soft',
};
const sizes: Record<Size, string> = {
  sm: 'min-h-8 px-3 py-1.5 text-[13px] gap-1.5',
  md: 'min-h-10 px-5 py-2 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Tek bir Link/anchor üzerinde aynı görünüm; iç içe button/link üretmez. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, type = 'button', asChild, ...rest }, ref) {
  const styles = cn(
    'ui-button inline-flex max-w-full shrink-0 items-center justify-center gap-2 whitespace-normal break-words rounded-md text-center font-medium transition-colors [&>svg]:shrink-0',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    variants[variant], sizes[size], className,
  );
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string; onClick?: ButtonProps['onClick']; tabIndex?: number; 'aria-disabled'?: boolean }>;
    return cloneElement(child, {
      ...rest,
      className: cn(styles, child.props.className),
      'aria-disabled': disabled || loading || undefined,
      tabIndex: disabled || loading ? -1 : child.props.tabIndex,
      onClick: (event) => {
        if (disabled || loading) { event.preventDefault(); return; }
        child.props.onClick?.(event);
        if (!event.defaultPrevented) rest.onClick?.(event);
      },
    });
  }
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      data-size={size}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={styles}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label'> { label: string }
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, className, ...props }, ref) {
  return <Button ref={ref} aria-label={label} title={label} className={cn('w-10 px-0 max-md:w-11', className)} {...props} />;
});
