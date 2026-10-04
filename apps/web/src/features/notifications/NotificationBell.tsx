import * as Popover from '@radix-ui/react-popover';
import { Bell, BellOff, Check, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useCQuery } from '../../lib/queries';
import type { NotificationItem, NotificationList } from '../../lib/types';
import { SeverityIcon, useNotificationActions, useUnreadCount } from './common';

/** Açılır listedeki en yeni bildirim sayısı. */
const BELL_LIMIT = 8;

/**
 * Üst çubuktaki zil: okunmamış sayısı rozeti (60 sn'de bir ve pencereye dönüldüğünde yenilenir), açılır listede en yeni 8 bildirim ve
 * "Tümünü gör". Açılır liste klavyeyle (Tab, Esc) kullanılır; kapanınca odak zile döner (Radix). Rozet yalnızca renge değil sayıya dayanır.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { count, hasCritical } = useUnreadCount();
  const [open, setOpen] = useState(false);
  const actions = useNotificationActions();
  const { data, isPending, error } = useCQuery<NotificationList>(['notifications', 'list', 'bell'], `/api/notifications?status=active&limit=${BELL_LIMIT}`, {
    enabled: open,
    staleTime: 0,
    allowForbidden: true,
  });
  const items = data?.notifications ?? [];
  const label = count > 0 ? t('notifications.bellLabel', { count }) : t('notifications.bellLabelNone');

  const openItem = async (n: NotificationItem) => {
    await actions.markRead(n);
    setOpen(false);
    navigate(n.link);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
          aria-label={label}
          aria-haspopup="dialog"
          data-testid="notification-bell"
        >
          <Bell className="size-[18px]" aria-hidden />
          {count > 0 && (
            <span
              aria-hidden
              data-testid="notification-badge"
              data-critical={hasCritical || undefined}
              className={cn(
                'absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-inverted px-1 text-[10px] leading-none text-on-inverted',
                hasCritical && 'border border-danger-on-inverted',
              )}
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t('notifications.title')}
          className="z-50 w-[min(26rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface [animation:pop-in_0.12s_ease-out] print:hidden"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 className="text-sm">{t('notifications.title')}</h2>
            <button
              type="button"
              className="text-[13px] link disabled:opacity-50"
              disabled={count === 0 || actions.busy}
              onClick={() => void actions.markAllRead()}
            >
              {t('notifications.markAllRead')}
            </button>
          </div>
          {error ? (
            <p className="px-4 py-6 text-center text-sm text-danger">{t('notifications.loadError')}</p>
          ) : isPending ? (
            <p className="px-4 py-6 text-center text-sm text-muted">{t('common.loadingLabel')}</p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <BellOff className="size-5 text-muted" aria-hidden />
              <p className="text-sm text-muted">{t('notifications.emptyShort')}</p>
            </div>
          ) : (
            <ul className="max-h-[min(24rem,60vh)] divide-y divide-border overflow-y-auto" data-testid="notification-bell-list">
              {items.map((n) => (
                <li key={n.id} className="flex items-start gap-1 px-2 py-1" data-unread={n.readAt ? undefined : true}>
                  <button
                    type="button"
                    onClick={() => void openItem(n)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-surface-2"
                  >
                    <SeverityIcon severity={n.severity} className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm', n.readAt && 'text-muted')}>{n.title}</span>
                      <span className="mt-0.5 block text-xs text-muted">{new Date(n.createdAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </span>
                    {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-[2px] bg-inverted" aria-label={t('notifications.unread')} role="img" />}
                  </button>
                  {!n.readAt && (
                    <button type="button" className="mt-1.5 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label={t('notifications.markRead')} onClick={() => void actions.markRead(n)}>
                      <Check className="size-4" aria-hidden />
                    </button>
                  )}
                  <button type="button" className="mt-1.5 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text" aria-label={t('notifications.dismiss')} onClick={() => void actions.dismiss(n)}>
                    <X className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border px-4 py-3 text-center">
            <Link to="/notifications" className="text-sm link" onClick={() => setOpen(false)}>
              {t('notifications.viewAll')}
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
