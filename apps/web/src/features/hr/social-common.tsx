import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { SocialDeclarationStatus, SocialWarningCode } from '../../lib/types';

/** Sosyal güvenlik verisi değişince etkilenen sorgular (bildirim, bordro ay kilidi, puantaj). */
export const SOCIAL_INVALIDATE = [['social'], ['payroll'], ['attendance']];

export function SocialStatusBadge({ status }: { status: SocialDeclarationStatus }) {
  const { t } = useTranslation();
  return <Badge tone={status === 'finalized' ? 'success' : 'neutral'}>{t(`social.status.${status}`)}</Badge>;
}

export function SocialUnverifiedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone="warning" className={className}>
      <AlertTriangle className="mr-1 size-3" aria-hidden />
      {t('social.unverifiedBadge')}
    </Badge>
  );
}

export function useSocialWarningText() {
  const { t } = useTranslation();
  return (code: SocialWarningCode) => t(`social.warnings.${code}`);
}
