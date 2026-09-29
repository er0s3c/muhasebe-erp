import { useTranslation } from 'react-i18next';
import { formatDateTR, todayIso } from '@erp/shared';
import { useCompany } from '../../lib/session';

/**
 * Yalnızca yazdırırken görünen rapor başlığı: şirket unvanı, dönem/süzgeç bilgisi ve yazdırma tarihi.
 * (Ekranda gizlidir; rapor başlığının kendisi sayfanın `PageHeader` başlığıdır.)
 */
export function PrintHeader({ subtitle, note }: { subtitle?: string; note?: string }) {
  const { t } = useTranslation();
  const company = useCompany();
  return (
    <div className="mb-4 hidden border-b border-black pb-2 print:block">
      <p className="text-base">{company.name}</p>
      {subtitle && <p className="text-[10pt]">{subtitle}</p>}
      <p className="text-[9pt] text-neutral-600">
        {t('reports.print.printedAt', { date: formatDateTR(todayIso()) })}
        {note ? ` · ${note}` : ''}
      </p>
    </div>
  );
}
