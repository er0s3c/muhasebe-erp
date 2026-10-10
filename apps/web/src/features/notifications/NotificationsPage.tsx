import { Bell, BellOff, Check, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { NOTIFICATION_KINDS, type NotificationKind } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { NotificationItem, NotificationList, NotificationScanResult } from '../../lib/types';
import { NOTIFICATION_INVALIDATE, SeverityBadge, SeverityIcon, useNotificationActions } from './common';

type Status = 'unread' | 'active' | 'all';

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });

/** Bildirim listesi: süzgeçler (okunmamış / etkin / tümü, tür), okundu işaretle, kapat ve bağlantıdan ilgili ekrana git. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const toast = useToast();
  const actions = useNotificationActions();
  const [status, setStatus] = useState<Status>('unread');
  const [kind, setKind] = useState<NotificationKind | ''>('');
  const { limit, more, atMax } = useListLimit(`${status}|${kind}`, 50, 200);
  const qs = `status=${status}&limit=${limit}${kind ? `&kind=${kind}` : ''}`;
  const { data, isPending, error } = useCQuery<NotificationList>(['notifications', 'list', status, kind, limit], `/api/notifications?${qs}`, { staleTime: 0 });
  const scan = useCMutation((_: void, call) => call<NotificationScanResult>('/api/notifications/scan', { method: 'POST' }), NOTIFICATION_INVALIDATE);
  const items = data?.notifications ?? [];

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => toast.success(t('notifications.scanDone', { created: r.result.created, resolved: r.result.resolved })),
      onError: (e) => toast.error(errorMessage(e)),
    });

  const open = async (n: NotificationItem) => {
    await actions.markRead(n);
    navigate(n.link);
  };

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        description={t('notifications.subtitle')}
        actions={
          <>
            <Link to="/settings/notifications">
              <Button>
                <SlidersHorizontal className="size-4" aria-hidden />
                {t('notifications.preferences')}
              </Button>
            </Link>
            {can('settings.manage') && (
              <Button loading={scan.isPending} onClick={runScan} title={t('notifications.scanHint')}>
                <RefreshCw className="size-4" aria-hidden />
                {t('notifications.scanNow')}
              </Button>
            )}
            <Button disabled={!data || data.unreadCount === 0 || actions.busy} onClick={() => void actions.markAllRead()}>
              <Check className="size-4" aria-hidden />
              {t('notifications.markAllRead')}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedTabs variant="filter"
          value={status}
          onChange={setStatus}
          items={[
            { key: 'unread', label: data && status === 'unread' ? `${t('notifications.filters.unread')} (${data.unreadCount})` : t('notifications.filters.unread') },
            { key: 'active', label: t('notifications.filters.active') },
            { key: 'all', label: t('notifications.filters.all') },
          ]}
        />
        <div className="w-full sm:w-64">
          <Select aria-label={t('notifications.kindFilter')} value={kind} onChange={(e) => setKind(e.target.value as NotificationKind | '')}>
            <option value="">{t('notifications.allKinds')}</option>
            {NOTIFICATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`notifications.kinds.${k}.label`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending ? (
        <PageLoading />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={status === 'unread' ? <BellOff className="size-5" /> : <Bell className="size-5" />}
            title={status === 'unread' ? t('notifications.emptyUnread') : t('notifications.empty')}
            description={t('notifications.emptyDesc')}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <Card>
            <ul className="divide-y divide-border" data-testid="notification-list">
              {items.map((n) => (
                <li key={n.id} className="flex flex-wrap items-start gap-3 px-5 py-4 text-sm" data-testid="notification-row" data-unread={n.readAt ? undefined : true} data-kind={n.kind}>
                  <SeverityIcon severity={n.severity} className="mt-0.5 size-5 shrink-0" />
                  <div className="min-w-0 flex-1 basis-64">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={cn(n.readAt ? 'text-muted' : 'text-text')}>{n.title}</p>
                      <SeverityBadge severity={n.severity} />
                      {!n.readAt && <span className="text-xs text-text">{t('notifications.unread')}</span>}
                      {n.resolvedAt && <span className="text-xs text-muted">{t('notifications.resolved')}</span>}
                      {n.dismissedAt && <span className="text-xs text-muted">{t('notifications.dismissed')}</span>}
                    </div>
                    <p className="mt-1 text-[13px] text-muted">{n.body}</p>
                    <p className="mt-1 text-xs text-muted">
                      {t(`notifications.kinds.${n.kind}.label`)} · {fmtWhen(n.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" onClick={() => void open(n)}>
                      {t('notifications.open')}
                    </Button>
                    {!n.readAt && (
                      <Button size="sm" disabled={actions.busy} onClick={() => void actions.markRead(n)}>
                        <Check className="size-3.5" aria-hidden />
                        {t('notifications.markRead')}
                      </Button>
                    )}
                    {!n.dismissedAt && !n.resolvedAt && (
                      <Button size="sm" disabled={actions.busy} onClick={() => void actions.dismiss(n)}>
                        <X className="size-3.5" aria-hidden />
                        {t('notifications.dismiss')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <TruncatedNote truncated={data?.truncated} shown={items.length} onMore={more} atMax={atMax} />
        </div>
      )}
      <p className="mt-4 text-xs text-muted">{t('notifications.privacyNote')}</p>
    </>
  );
}
