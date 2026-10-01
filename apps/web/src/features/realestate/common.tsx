import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { SalesContractStatus, UnitStatus } from '../../lib/types';

/** Birim/sözleşme/tahsilat değişince etkilenen sorgular (yevmiye, cari, proje raporu, kasa/banka da etkilenir). */
export const REAL_ESTATE_INVALIDATE = [
  ['units'],
  ['sales-contracts'],
  ['sales-contract'],
  ['sales-installments'],
  ['sales-summary'],
  ['projects'],
  ['project'],
  ['journal'],
  ['parties'],
  ['party'],
  ['treasury'],
  ['reports'],
];

export const UNIT_STATUSES: readonly UnitStatus[] = ['available', 'reserved', 'sold', 'handed_over'];
export const CONTRACT_STATUSES: readonly SalesContractStatus[] = ['draft', 'active', 'handed_over', 'terminated', 'cancelled'];
export const UNIT_TYPES = ['apartment', 'villa', 'shop', 'office', 'land', 'parking', 'storage', 'other'] as const;

const UNIT_TONE = { available: 'neutral', reserved: 'warning', sold: 'success', handed_over: 'brand' } as const;
const CONTRACT_TONE = { draft: 'neutral', active: 'success', handed_over: 'brand', terminated: 'danger', cancelled: 'danger' } as const;

export function UnitStatusBadge({ status }: { status: UnitStatus }) {
  const { t } = useTranslation();
  return <Badge tone={UNIT_TONE[status]}>{t(`realEstate.unitStatus.${status}`)}</Badge>;
}
export function ContractStatusBadge({ status }: { status: SalesContractStatus }) {
  const { t } = useTranslation();
  return <Badge tone={CONTRACT_TONE[status]}>{t(`realEstate.contractStatus.${status}`)}</Badge>;
}

export const unitLabel = (u: { block: string; unitNo: string }) => (u.block ? `${u.block}-${u.unitNo}` : u.unitNo);
