import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '../../components/ui/Card';
import { useCQuery } from '../../lib/queries';
import type { NotificationList } from '../../lib/types';
import { SeverityIcon } from './common';

/** Genel bakış kartı: en yeni 3 okunmamış bildirim. Bildirim yoksa görünmez (sayfa gereksiz kalabalıklaşmaz). */
export function NotificationsCard() {
  const { t } = useTranslation();
  const { data } = useCQuery<NotificationList>(['notifications', 'list', 'dashboard'], '/api/notifications?status=unread&limit=3', { allowForbidden: true });
  if (!data || data.notifications.length === 0) return null;
  return (
    <Card data-testid="dashboard-notifications">
      <CardHeader
        title={`${t('notifications.title')} (${data.unreadCount})`}
        action={
          <Link to="/notifications" className="text-sm link">
            {t('notifications.viewAll')}
          </Link>
        }
      />
      <ul className="divide-y divide-border">
        {data.notifications.map((n) => (
          <li key={n.id}>
            <Link to={n.link} className="flex items-start gap-3 px-5 py-3 text-sm transition-colors hover:bg-surface-2/60">
              <SeverityIcon severity={n.severity} className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1">{n.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
