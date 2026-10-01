import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { useCQuery } from '../../lib/queries';
import type { ApprovalRequestRow, CostCode, ProgressStatus, SubcontractStatus, VariationReason, VariationStatus } from '../../lib/types';

/** Sözleşme/hakediş/onay değişince etkilenen sorgular (proje maliyet raporu taahhüt ve gerçekleşenle birlikte tazelenir). */
export const SUBCONTRACT_INVALIDATE = [['subcontracts'], ['subcontract'], ['progress'], ['approvals'], ['projects'], ['project'], ['journal'], ['variations'], ['variation']];

export const SUBCONTRACT_STATUSES: readonly SubcontractStatus[] = ['draft', 'active', 'completed', 'terminated'];
export const PROGRESS_STATUSES: readonly ProgressStatus[] = ['draft', 'submitted', 'posted', 'cancelled'];

export const VARIATION_STATUSES: readonly VariationStatus[] = ['draft', 'submitted', 'awaiting_client', 'applied', 'rejected', 'cancelled'];
export const VARIATION_REASONS: readonly VariationReason[] = ['client_request', 'design_change', 'site_condition', 'omission_error', 'other'];

const SC_TONE = { draft: 'neutral', active: 'success', completed: 'brand', terminated: 'danger' } as const;
const PR_TONE = { draft: 'neutral', submitted: 'warning', posted: 'success', cancelled: 'danger' } as const;

export function SubcontractStatusBadge({ status }: { status: SubcontractStatus }) {
  const { t } = useTranslation();
  return <Badge tone={SC_TONE[status]}>{t(`subcontracts.status.${status}`)}</Badge>;
}

export function ProgressStatusBadge({ status }: { status: ProgressStatus }) {
  const { t } = useTranslation();
  return <Badge tone={PR_TONE[status]}>{t(`subcontracts.progressStatus.${status}`)}</Badge>;
}

export function ApprovalStatusBadge({ status }: { status: ApprovalRequestRow['status'] }) {
  const { t } = useTranslation();
  const tone = status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : status === 'cancelled' ? 'neutral' : 'warning';
  return <Badge tone={tone}>{t(`subcontracts.approval.status.${status}`)}</Badge>;
}

export function useCostCodes(enabled = true) {
  const { data } = useCQuery<{ costCodes: CostCode[] }>(['cost-codes'], '/api/cost-codes', { enabled });
  return data?.costCodes ?? [];
}

const VO_TONE = { draft: 'neutral', submitted: 'warning', awaiting_client: 'warning', applied: 'success', rejected: 'danger', cancelled: 'neutral' } as const;

export function VariationStatusBadge({ status }: { status: VariationStatus }) {
  const { t } = useTranslation();
  return <Badge tone={VO_TONE[status]}>{t(`variations.status.${status}`)}</Badge>;
}
