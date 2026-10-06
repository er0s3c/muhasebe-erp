import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import { GUARD, authedRoute, type AuthUser, type GuardMeta } from '../http/context';
import { AppError, forbidden } from '../http/errors';
import { recordSecurityEvent, type SecurityEventName } from '../modules/auth/events';
import { assertLicensed, restrictionMessage } from './gate';
import { isInstallationAdmin, pinInstallationOwner } from './installation';
import type { LicenseSnapshot } from './service';

const codeSchema = z.object({ code: z.string().trim().min(10).max(64) });
const offlineLeaseSchema = z.object({ lease: z.string().trim().min(50).max(16_384) });

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

/** Yanıt gövdesi. Kurulum kimliği, son hata gibi ayrıntılar yalnızca sahibe gösterilir. */
function view(snap: LicenseSnapshot, usage: { companies: number; devices: number }, owner: boolean) {
  const l = snap.lease;
  return {
    enforced: snap.enforced,
    state: snap.state,
    reason: snap.reason ?? null,
    message: snap.state === 'restricted' ? restrictionMessage(snap.reason) : null,
    expiresSoon: snap.expiresSoon,
    daysUntilExpiry: snap.daysUntilExpiry ?? null,
    activeUntil: iso(snap.activeUntil),
    graceUntil: iso(snap.graceUntil),
    license: l
      ? {
          customer: l.customer,
          kind: l.kind,
          sectors: l.sectors,
          deviceLimit: l.deviceLimit,
          companyLimit: l.companyLimit,
          deviceIdleDays: l.deviceIdleDays,
          graceDays: l.graceDays,
          validUntil: iso(l.validUntil),
          leaseUntil: iso(l.leaseUntil),
          offline: l.typ === 'offline-lease',
        }
      : null,
    usage,
    isOwner: owner,
    ...(owner
      ? {
          installationId: snap.installationId,
          fingerprintStrength: snap.fingerprintStrength,
          serverConfigured: snap.serverConfigured,
          lastCheckAt: iso(snap.lastCheckAt),
          lastSuccessAt: iso(snap.lastSuccessAt),
          lastError: snap.lastError,
          pendingOfflineRequest: snap.pendingOfflineRequest,
        }
      : {}),
  };
}

interface AdminCtx {
  req: FastifyRequest;
  reply: FastifyReply;
  /** Kimliksiz (lisanssız kurulumda etkinleştirme) çağrıda null. */
  actor: AuthUser | null;
}

/**
 * Lisans yönetim uçları. `anonymousWhenUnlicensed`: kurulum henüz lisanssızken (kullanıcı da yok) kimliksiz çağrılabilir;
 * bir kira varsa (kısıtlı durum dahil) giriş yapmış kurulum sahibi (kurulumun sahibi kuruluşta şirket sahibi) gerekir. Kaba kuvvete karşı IP başına oran sınırı vardır.
 */
function licenseAdminRoute<T>(
  app: FastifyInstance,
  opts: { anonymousWhenUnlicensed: boolean; limit: { name: string; max: number; windowMs: number } },
  handler: (ctx: AdminCtx) => Promise<T>,
): RouteHandlerMethod {
  const authed = authedRoute(app, async ({ tx, user, req, reply }) => {
    if (!(await isInstallationAdmin(tx, user))) throw forbidden('Bu işlem yalnızca kurulum sahibine açıktır', 'OWNER_ONLY');
    return handler({ req, reply, actor: user });
  });
  const route: RouteHandlerMethod = async function (req, reply) {
    const r = await app.limiter.consume(`${opts.limit.name}:${req.ip}`, opts.limit.max, opts.limit.windowMs);
    if (!r.ok) {
      void reply.header('retry-after', String(r.retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', 'Çok fazla istek; lütfen biraz sonra tekrar deneyin');
    }
    await assertLicensed(app.license, req);
    if (opts.anonymousWhenUnlicensed && (await app.license.current()).state === 'unlicensed') {
      return handler({ req, reply, actor: null });
    }
    return authed.call(this, req, reply);
  };
  // Kimlik her durumda isteniyorsa sözleşme testi için kapı işaretlenir; koşullu açık uçlar bilerek işaretsizdir (PUBLIC listesi).
  return opts.anonymousWhenUnlicensed ? route : Object.assign(route, { [GUARD]: { kind: 'authed' } satisfies GuardMeta });
}

export const licenseRoutes: FastifyPluginAsync = async (app) => {
  const audit = (ctx: AdminCtx, event: SecurityEventName, meta?: Record<string, unknown>) =>
    recordSecurityEvent(app.db, app.log, ctx.req, { event, organizationId: ctx.actor?.orgId ?? null, userId: ctx.actor?.id ?? null, meta });

  /** Lisans durumu: giriş yapmış her kullanıcı (bant uyarıları, sektör kilidi); ayrıntılar yalnızca sahibe. */
  app.get(
    '/api/license',
    authedRoute(
      app,
      async ({ tx, user }) => {
        const [snap, usage, owner] = await Promise.all([app.license.current(), app.license.usage(), isInstallationAdmin(tx, user)]);
        return view(snap, usage, owner);
      },
      { allowMustChange: true },
    ),
  );

  const respond = async (snap: LicenseSnapshot, owner: boolean) => view(snap, await app.license.usage(), owner);

  app.post(
    '/api/license/activate',
    licenseAdminRoute(app, { anonymousWhenUnlicensed: true, limit: { name: 'license-activate', max: 10, windowMs: 10 * 60_000 } }, async (ctx) => {
      const { code } = codeSchema.parse(ctx.req.body);
      const snap = await app.license.activate(code);
      await pinInstallationOwner(app.db);
      await audit(ctx, 'license_activated', { state: snap.state });
      return respond(snap, true);
    }),
  );

  app.post(
    '/api/license/refresh',
    licenseAdminRoute(app, { anonymousWhenUnlicensed: false, limit: { name: 'license-refresh', max: 20, windowMs: 10 * 60_000 } }, async (ctx) => {
      const snap = await app.license.heartbeat();
      await audit(ctx, 'license_refreshed', { state: snap.state });
      return respond(snap, true);
    }),
  );

  app.post(
    '/api/license/offline-request',
    licenseAdminRoute(app, { anonymousWhenUnlicensed: true, limit: { name: 'license-offline', max: 20, windowMs: 10 * 60_000 } }, async () => ({
      requestCode: (await app.license.offlineRequest()).requestCode,
    })),
  );

  app.post(
    '/api/license/offline-activate',
    licenseAdminRoute(app, { anonymousWhenUnlicensed: true, limit: { name: 'license-offline', max: 20, windowMs: 10 * 60_000 } }, async (ctx) => {
      const { lease } = offlineLeaseSchema.parse(ctx.req.body);
      const snap = await app.license.offlineActivate(lease);
      await pinInstallationOwner(app.db);
      await audit(ctx, 'license_offline_activated', { state: snap.state });
      return respond(snap, true);
    }),
  );

  app.post(
    '/api/license/deactivate',
    licenseAdminRoute(app, { anonymousWhenUnlicensed: false, limit: { name: 'license-deactivate', max: 5, windowMs: 10 * 60_000 } }, async (ctx) => {
      const snap = await app.license.deactivate();
      await audit(ctx, 'license_deactivated', { state: snap.state });
      return respond(snap, true);
    }),
  );
};
