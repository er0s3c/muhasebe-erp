import { Star } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useFavorites, useRecordRecent } from '../../lib/personal';
import { useToast } from '../ui/Toast';

/** Sayfayı (yol + sorgu) favorilere ekler/çıkarır; favoriler menünün en üstünde ve Ctrl+K'da görünür. */
export function FavoriteStar({ title }: { title: string }) {
  const { pathname, search } = useLocation();
  const path = `${pathname}${search}`;
  const { isFavorite, toggle } = useFavorites();
  const toast = useToast();
  const active = isFavorite(path);
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={active ? `${title} favorilerden çıkar` : `${title} favorilere ekle`}
      title={active ? 'Favorilerden çıkar' : 'Favorilere ekle'}
      onClick={() => {
        toggle({ path, title }).catch(() => toast.error('Favori kaydedilemedi. Bağlantınızı kontrol edip tekrar deneyin.'));
      }}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus print:hidden',
        active ? 'border-transparent bg-brand text-brand-contrast' : 'border-border text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      <Star className={cn('size-3.5', active && 'fill-current')} aria-hidden />
    </button>
  );
}

export function RecentRecorder({ title, kind }: { title: string; kind?: string }) {
  const { pathname, search } = useLocation();
  useRecordRecent(title ? { path: `${pathname}${search}`, title, ...(kind ? { kind } : {}) } : null);
  return null;
}
