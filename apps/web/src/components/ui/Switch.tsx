import { cn } from '../../lib/cn';

/**
 * Açma/kapama anahtarı. Açık durum sarı dolgu (aktif durum = eylem yüzeyi), kapalı durum hairline Bone; hap yok, köşeler 6px'dur.
 * Erişilebilirlik: `role="switch"` + `aria-checked`; klavye ile Boşluk/Enter.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  loading,
  label,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  /** Ekran okuyucu adı (görünmez). */
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
        checked ? 'border-text bg-brand' : 'border-border-strong bg-surface-2',
        (disabled || loading) && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block size-4 rounded-[3px] transition-transform',
          checked ? 'translate-x-[22px] bg-text' : 'translate-x-[3px] bg-muted',
        )}
      />
    </button>
  );
}
