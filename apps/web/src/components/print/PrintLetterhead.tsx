import { useTranslation } from 'react-i18next';
import { formatDateTR, todayIso } from '@erp/shared';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

interface CompanyRow {
  name: string;
  taxNumber: string | null;
  taxOffice: string | null;
}

/**
 * Basılı çıktının her sayfa görünümünde en üstte yer alan kurumsal antet: şirket unvanı, vergi dairesi/numarası ve
 * yazdırma tarihi. Ekranda görünmez (AppShell içinde bir kez bulunur).
 */
export function PrintLetterhead() {
  const { t } = useTranslation();
  const company = useCompany();
  const { data } = useCQuery<{ company: CompanyRow }>(['company'], '/api/company');
  const info = [
    data?.company.taxOffice ? `${t('settings.company.taxOffice')}: ${data.company.taxOffice}` : null,
    data?.company.taxNumber ? `${t('settings.company.taxNumber')}: ${data.company.taxNumber}` : null,
  ].filter(Boolean);
  return (
    <div className="print-letterhead" aria-hidden>
      <div>
        <p className="text-[15pt] leading-tight">{company.name}</p>
        {info.length > 0 && <p className="text-[8.5pt] text-[#55534f]">{info.join(' · ')}</p>}
      </div>
      <p className="whitespace-nowrap text-[8.5pt] text-[#55534f]">{t('reports.print.printedAt', { date: formatDateTR(todayIso()) })}</p>
    </div>
  );
}
