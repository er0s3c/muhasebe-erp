import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Callout } from '../../components/ui/Feedback';
import { useCQuery } from '../../lib/queries';

/**
 * Seçilen tarih aralığı kapalı bir mali yıla değiyorsa uyarı: o yıla kayıt yapılamaz, kapanış fişleri raporlarda ayrı gösterilir.
 * Yıl durumu `ledger.read` ile okunur; ek izin gerekmez.
 */
export function ClosedYearBanner({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const { data } = useCQuery<{ years: { id: string; name: string }[] }>(
    ['fiscal-years', 'closed', from, to],
    from && to && from <= to ? `/api/fiscal-years/closed?${new URLSearchParams({ from, to })}` : null,
  );
  if (!data || data.years.length === 0) return null;
  return (
    <div className="mb-4 print:hidden" data-testid="closed-year-banner">
      <Callout
        tone="info"
        title={t('yearend.banner.closed', { name: data.years.map((y) => y.name).join(', ') })}
        action={
          <Link to="/accounting/year-end" className="inline-flex items-center gap-1.5 text-sm link">
            <Lock className="size-3.5" aria-hidden />
            {t('yearend.banner.open')}
          </Link>
        }
      />
    </div>
  );
}
