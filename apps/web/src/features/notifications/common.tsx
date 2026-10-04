import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NotificationSeverity } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCQuery } from '../../lib/queries';
import type { NotificationCount, NotificationItem } from '../../lib/types';

/** Bildirimle ilgili sorgu önekleri: okundu/kapat/tarama sonrası hepsi tazelenir. */
export const NOTIFICATION_INVALIDATE = [['notifications']];

/** Okunmamış sayacı: 60 saniyede bir ve pencereye dönüldüğünde yenilenir (arka sekmede yoklanmaz). */
export function useUnreadCount() {
  const q = useCQuery<NotificationCount>(['notifications', 'count'], '/api/notifications/unread-count', {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
    allowForbidden: true,
  });
  return q.data ?? { count: 0, hasCritical: false };
}

/** Okundu / kapat / tümünü okundu işlemleri (hata toast'la bildirilir). */
export function useNotificationActions() {
  const toast = useToast();
  const onError = { onError: (e: Error) => toast.error(errorMessage(e)) };
  const read = useCMutation((id: string, call) => call(`/api/notifications/${id}/read`, { method: 'POST' }), NOTIFICATION_INVALIDATE);
  const dismiss = useCMutation((id: string, call) => call(`/api/notifications/${id}/dismiss`, { method: 'POST' }), NOTIFICATION_INVALIDATE);
  const readAll = useCMutation((_: void, call) => call('/api/notifications/read-all', { method: 'POST' }), NOTIFICATION_INVALIDATE);
  return {
    markRead: (n: NotificationItem) => (n.readAt ? Promise.resolve() : read.mutateAsync(n.id).then(() => undefined, (e) => onError.onError(e))),
    dismiss: (n: NotificationItem) => dismiss.mutateAsync(n.id).then(() => undefined, (e) => onError.onError(e)),
    markAllRead: () => readAll.mutateAsync().then(() => undefined, (e) => onError.onError(e)),
    busy: read.isPending || dismiss.isPending || readAll.isPending,
  };
}

const TONE: Record<NotificationSeverity, 'neutral' | 'warning' | 'danger'> = { info: 'neutral', warning: 'warning', critical: 'danger' };
const ICON = { info: Info, warning: AlertTriangle, critical: AlertOctagon } as const;

/** Önem simgesi (renge ek olarak şekil + metin: renk körlüğü). */
export function SeverityIcon({ severity, className }: { severity: NotificationSeverity; className?: string }) {
  const { t } = useTranslation();
  const Icon = ICON[severity];
  const tone = severity === 'critical' ? 'text-danger' : severity === 'warning' ? 'text-warning' : 'text-muted';
  return <Icon className={`${tone} ${className ?? 'size-4'}`} role="img" aria-label={t(`notifications.severity.${severity}`)} />;
}

export function SeverityBadge({ severity }: { severity: NotificationSeverity }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[severity]}>{t(`notifications.severity.${severity}`)}</Badge>;
}
