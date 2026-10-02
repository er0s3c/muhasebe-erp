import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { ForeignDocStatus, GuaranteeStatus } from '../../lib/types';

/** Yabancı işçi verisi değişince etkilenen sorgular (belgeler, teminatlar, ayarlar, erişim günlüğü). */
export const FOREIGN_INVALIDATE = [['foreign'], ['privacy']];

const DOC_TONE = { valid: 'success', expiring: 'warning', expired: 'danger', revoked: 'neutral' } as const;

export function ForeignStatusBadge({ status }: { status: ForeignDocStatus }) {
  const { t } = useTranslation();
  return <Badge tone={DOC_TONE[status]}>{t(`foreign.status.${status}`)}</Badge>;
}

export function GuaranteeStatusBadge({ status }: { status: GuaranteeStatus }) {
  const { t } = useTranslation();
  return <Badge tone={status === 'held' ? 'warning' : 'neutral'}>{t(`foreign.gStatus.${status}`)}</Badge>;
}

export function ForeignUnverifiedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone="warning" className={className}>
      <AlertTriangle className="mr-1 size-3" aria-hidden />
      {t('foreign.unverifiedBadge')}
    </Badge>
  );
}
