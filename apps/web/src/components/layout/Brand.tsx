import { cn } from '../../lib/cn';

/**
 * Ada Muhasebe logosu. Koyu yazılı sürüm açık temada, açık yazılı sürüm koyu temada görünür (`dark:` sınıf tabanlı);
 * `onDark` her zaman koyu zeminde duran yüzeyler içindir (örn. giriş sayfasının koyu paneli): tema ne olursa olsun açık yazılı sürüm.
 * `mark`: yalnızca simge (dar menü). Boyut `className` ile (yükseklik) verilir; genişlik orantılıdır.
 */
export function BrandLogo({ mark = false, onDark = false, className }: { mark?: boolean; onDark?: boolean; className?: string }) {
  const light = mark ? '/logo-mark.webp' : '/logo.webp';
  const dark = mark ? '/logo-mark-on-dark.webp' : '/logo-on-dark.webp';
  const size = mark ? { width: 256, height: 192 } : { width: 960, height: 190 };
  const base = cn('w-fit max-w-none shrink-0 select-none', className);
  if (onDark) return <img src={dark} alt="Ada Muhasebe" className={base} draggable={false} {...size} />;
  return (
    <>
      <img src={light} alt="Ada Muhasebe" className={cn(base, 'dark:hidden')} draggable={false} {...size} />
      <img src={dark} alt="" aria-hidden className={cn(base, 'hidden dark:block')} draggable={false} {...size} />
    </>
  );
}
