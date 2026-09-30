import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../db/client';
import { memberships } from '../db/schema';
import { authedRoute } from '../http/context';
import { forbidden, notFound } from '../http/errors';
import { recordSecurityEvent } from '../modules/auth/events';

const idParams = z.object({ id: z.uuid() });
const renameSchema = z.object({ name: z.string().trim().min(1, 'Ad boş olamaz').max(60, 'Ad en fazla 60 karakter olabilir') });

/** Cihaz yönetimi: herhangi bir şirkette sahip ya da yönetici olan kullanıcı (cihazlar kuruluma özgüdür). */
async function requireDeviceAdmin(tx: Tx, userId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.role, ['owner', 'admin'])))
    .limit(1);
  if (!row) throw forbidden('Cihazları yalnızca şirket sahibi ya da yöneticisi yönetebilir', 'DEVICE_ADMIN_ONLY');
}

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/devices',
    authedRoute(app, async ({ tx, user }) => {
      await requireDeviceAdmin(tx, user.id);
      if (!app.license.enforced) return { enforced: false, limit: null, active: 0, devices: [] };
      return { enforced: true, ...(await app.devices.list(user.orgId, user.deviceId)) };
    }),
  );

  app.patch(
    '/api/devices/:id',
    authedRoute(app, async ({ tx, user, req }) => {
      await requireDeviceAdmin(tx, user.id);
      const { id } = idParams.parse(req.params);
      const { name } = renameSchema.parse(req.body);
      if (!(await app.devices.rename(user.orgId, id, name))) throw notFound('Cihaz');
      await recordSecurityEvent(app.db, app.log, req, { event: 'device_renamed', organizationId: user.orgId, userId: user.id, meta: { deviceId: id } });
      return { ok: true };
    }),
  );

  /** Cihazı kaldırır: koltuk boşalır, oturumları kapanır. Cihaz yeniden giriş yaparsa (boş koltuk varsa) yeni cihaz olur. */
  app.delete(
    '/api/devices/:id',
    authedRoute(app, async ({ tx, user, req }) => {
      await requireDeviceAdmin(tx, user.id);
      const { id } = idParams.parse(req.params);
      if (!(await app.devices.revoke(user.orgId, id, `user:${user.id}`))) throw notFound('Cihaz');
      await recordSecurityEvent(app.db, app.log, req, { event: 'device_revoked', organizationId: user.orgId, userId: user.id, meta: { deviceId: id, by: 'user' } });
      return { ok: true, current: id === user.deviceId };
    }),
  );
};
