import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { EmployeeStatus } from '../../lib/types';

/** Personel/kişisel veri değişince etkilenen sorgular. */
export const HR_INVALIDATE = [['employees'], ['employee'], ['privacy']];

export function EmployeeStatusBadge({ status }: { status: EmployeeStatus }) {
  const { t } = useTranslation();
  return <Badge tone={status === 'active' ? 'success' : 'neutral'}>{t(`hr.status.${status}`)}</Badge>;
}
