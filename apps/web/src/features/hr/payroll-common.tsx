import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { PayrollRunStatus, PayrollWarningRow } from '../../lib/types';

/** Bordro değişince etkilenen sorgular (bordro, puantaj kilidi, defter). */
export const PAYROLL_INVALIDATE = [['payroll'], ['attendance']];

const STATUS_TONE: Record<PayrollRunStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'brand'> = {
  draft: 'neutral',
  approved: 'brand',
  paid: 'success',
  cancelled: 'danger',
};

export function PayrollStatusBadge({ status }: { status: PayrollRunStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`payroll.status.${status}`)}</Badge>;
}

/** "Doğrulanmadı" rozeti: bordroda doğrulanmamış parametre kullanıldıysa (⚠). */
export function UnverifiedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone="warning" className={className}>
      <AlertTriangle className="mr-1 size-3" aria-hidden />
      {t('payroll.unverifiedBadge')}
    </Badge>
  );
}

/** Uyarı kodu → Türkçe ileti (eksik parametre adları dahil). */
export function useWarningText() {
  const { t } = useTranslation();
  return (w: PayrollWarningRow) =>
    t(`payroll.warnings.${w.code}`, {
      keys: (w.keys ?? []).map((k) => t(`payroll.params.keys.${k}`)).join(', '),
      count: w.count ?? 0,
    });
}

/** Parametre anahtarı + birim biçimi: "%10", "×1,5", "30", "7,5". */
export function formatParamValue(unit: string, value: string): string {
  const n = Number(value);
  const txt = n.toLocaleString('tr-TR', { maximumFractionDigits: 6 });
  if (unit === 'percent') return `%${txt}`;
  if (unit === 'multiplier') return `×${txt}`;
  if (unit === 'flag') return n ? '1' : '0';
  return txt;
}

export { PAYROLL_PARAM_META } from '@erp/shared';
