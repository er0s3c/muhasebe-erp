import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
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
}

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      disabled={disabled || loading}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center justify-center gap-2 whitespace-normal break-words rounded-md text-center transition-colors [&>svg]:shrink-0',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
