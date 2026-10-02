import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { ImportFileStatus } from '../../lib/types';
import { STOCK_INVALIDATE } from '../inventory/common';

/** İthalat dosyası değişince etkilenen sorgular: dosyalar, stok değeri, yevmiye ve raporlar. */
export const IMPORT_INVALIDATE = [
  ['import-files'],
  ['import-file'],
  ['import-sources'],
  ['import-report'],
  ...STOCK_INVALIDATE,
  ['journal'],
  ['journal-entry'],
  ['trial-balance'],
  ['reports'],
  ['dashboard'],
];

const TONE = { draft: 'neutral', allocated: 'brand', posted: 'success', cancelled: 'danger' } as const;

export function ImportStatusBadge({ status }: { status: ImportFileStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`landed.status.${status}`)}</Badge>;
}

export const IMPORT_METHODS = ['value', 'quantity', 'weight', 'manual'] as const;
export const IMPORT_COST_KINDS = ['freight', 'insurance', 'customs_duty', 'other_tax', 'brokerage', 'other'] as const;
