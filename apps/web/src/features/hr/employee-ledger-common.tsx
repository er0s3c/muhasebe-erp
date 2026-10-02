import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { AdvanceStatus } from '../../lib/types';
import { TREASURY_INVALIDATE } from '../treasury/common';

/** Personel cari/avans değişince etkilenen sorgular: cari ekranları, bordro, kasa/banka ve raporlar. */
export const LEDGER_INVALIDATE = [['employee-ledger'], ['payroll'], ['employee'], ...TREASURY_INVALIDATE, ['reports']];

const TONE: Record<AdvanceStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'brand'> = { open: 'warning', partial: 'brand', settled: 'success', cancelled: 'danger' };

export function AdvanceStatusBadge({ status }: { status: AdvanceStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`employeeLedger.status.${status}`)}</Badge>;
}

/** "Doğrulanmadı" rozeti: avans kesintisi üst sınırı kullanıcı parametresidir, hukuki doğruluğu denetlenmemiştir. */
export function LedgerUnverifiedBadge() {
  const { t } = useTranslation();
  return (
    <Badge tone="warning">
      <AlertTriangle className="mr-1 size-3" aria-hidden />
      {t('employeeLedger.unverified')}
    </Badge>
  );
}
