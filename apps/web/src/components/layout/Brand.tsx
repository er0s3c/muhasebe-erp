import { cn } from '../../lib/cn';

/** Özgün marka işareti (kendi tasarımımız). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 22V10h3.2l3.8 6.4L19.8 10H23v12h-2.8v-7.2l-3 5h-2.4l-3-5V22z" fill="var(--brand-contrast)" />
    </svg>
  );
}
