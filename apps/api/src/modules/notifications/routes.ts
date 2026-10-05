import type { FastifyPluginAsync } from 'fastify';
import { eligibleNotificationKinds, idParam, notificationListQuerySchema, todayIso, updateNotificationPreferencesSchema } from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { dismiss, getPreferences, listNotifications, markAllRead, markRead, unreadCount, updatePreferences } from './service';
import { scanCompany } from './scan';
import { notificationScanOptions } from './scheduler';

/**
 * Bildirim uçları. Her üye KENDİ bildirimini okur/kapatır ve kendi tercihini yönetir: kapı olarak her rolde bulunan `settings.read`
 * kullanılır (sahiplik RLS'tedir: kullanıcı başkasının satırını göremez ve yazamaz). Şirket taraması yönetim izni (`settings.manage`) ister.
 * Bildirim yeni bir modül değildir (çekirdek); kaynakları kendi modül ve izinlerine göre üretilir.
 */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const member = { permission: 'settings.read' } as const;
  const manage = { permission: 'settings.manage' } as const;
  const prefCtx = (c: TenantCtx) => ({ userId: c.user.id, permissions: c.access.permissions, enabledModules: c.enabledModules, companyId: c.company.id, today: todayIso() });

  const kindsOf = (c: TenantCtx) => eligibleNotificationKinds(c.access.permissions, c.enabledModules);
  app.get('/api/notifications', tenantRoute(app, member, async (c) => listNotifications(c.tx, notificationListQuerySchema.parse(c.req.query), kindsOf(c))));
  app.get('/api/notifications/unread-count', tenantRoute(app, member, async (c) => unreadCount(c.tx, kindsOf(c))));
  app.post('/api/notifications/read-all', tenantRoute(app, member, async (c) => markAllRead(c.tx, kindsOf(c))));
  app.post('/api/notifications/:id/read', tenantRoute(app, member, async ({ tx, req }) => ({ notification: await markRead(tx, idParam.parse(req.params).id) })));
  app.post('/api/notifications/:id/dismiss', tenantRoute(app, member, async ({ tx, req }) => ({ notification: await dismiss(tx, idParam.parse(req.params).id) })));

  /** Şirketin bildirimlerini şimdi taratır (demo/doğrulama): kilit başka bir örnekteyse bekler. Yalnızca sahip/yönetici. */
  app.post(
    '/api/notifications/scan',
    tenantRoute(app, { ...manage, limit: { name: 'notify-scan', max: 20, windowMs: 60_000 } }, async ({ company, user }) => ({
      result: await scanCompany(app.db, { companyId: company.id, orgId: user.orgId }, { ...notificationScanOptions(app), wait: true }),
    })),
  );

  app.get('/api/notification-preferences', tenantRoute(app, member, async (c) => getPreferences(c.tx, prefCtx(c), app.mailer.enabled)));
  app.put(
    '/api/notification-preferences',
    tenantRoute(app, member, async (c) => {
      await updatePreferences(c.tx, prefCtx(c), updateNotificationPreferencesSchema.parse(c.req.body));
      return getPreferences(c.tx, prefCtx(c), app.mailer.enabled);
    }),
  );
};
