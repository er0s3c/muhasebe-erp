import { Brand } from '../ui/Brand';
import { useTheme } from './theme';

/**
 * Ada ERP logosu. Mevcut simge ve ortak canlı kelime markası.
 * `onDark` her zaman koyu zeminde duran yüzeyler içindir (örn. giriş sayfasının koyu paneli): tema ne olursa olsun açık yazılı sürüm.
 * `mark`: yalnızca simge (dar menü). Boyut `className` ile (yükseklik) verilir; genişlik orantılıdır.
 */
export function BrandLogo({
  mark = false,
  onDark = false,
  className,
}: {
  mark?: boolean;
  onDark?: boolean;
  className?: string;
}) {
  const { theme } = useTheme();
  return <Brand mark={mark} onDark={onDark || theme === 'dark'} className={className} />;
}
