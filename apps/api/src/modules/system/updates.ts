import { createHash, timingSafeEqual } from 'node:crypto';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db/client';
import { appUpdates } from '../../db/schema';
import { isNewerThanCurrent } from './update-store';
import { authedRoute, type AuthUser } from '../../http/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../http/errors';
import { licenseServerUrl } from '../../licensing';
import { isInstallationAdmin } from '../../licensing/installation';
import { recordSecurityEvent } from '../auth/events';

type UpdateRow = typeof appUpdates.$inferSelect;
const ACTIVE = ['requested', 'downloading', 'applying'] as const;

const serialize = (r: UpdateRow) => ({
  id: r.id,
  version: r.version,
  notes: r.notes,
  status: r.status,
  offeredAt: r.offeredAt.toISOString(),
  requestedAt: r.requestedAt?.toISOString() ?? null,
  scheduledFor: r.scheduledFor?.toISOString() ?? null,
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  fromVersion: r.fromVersion,
  message: r.message,
});

/** Bu gece 02:00 (sunucu yerel saati); 02:00 geçtiyse ertesi gece. */
export function nextNightWindow(now: Date): Date {
  const d = new Date(now);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

const sha = (v: string) => createHash('sha256').update(v).digest();

export const updateRoutes: FastifyPluginAsync = async (app) => {
  const current = app.config.APP_VERSION;
  const platform = app.config.ERP_KIT_TARGET;
  const updaterToken = app.config.ERP_UPDATER_TOKEN;
  const serverUrl = licenseServerUrl(app.config);

  const requireOwner = async (tx: Tx, user: AuthUser) => {
    if (!(await isInstallationAdmin(tx, user))) throw forbidden('Güncellemeleri yalnızca kurulum sahibi yönetir', 'OWNER_ONLY');
  };

  async function overview(tx: Tx) {
    const rows = await tx.select().from(appUpdates).orderBy(desc(appUpdates.offeredAt)).limit(20);
    // Teklif: çalışan sürümden yeni, iptal/bitmiş olmayan en yeni kayıt
    const candidates = rows.filter((r) => isNewerThanCurrent(r.version, current));
    const offer = candidates.find((r) => r.status !== 'done' && r.status !== 'cancelled') ?? null;
    return {
      currentVersion: current,
      platform: platform ?? null,
      updaterReady: Boolean(updaterToken && platform),
      licenseServer: Boolean(serverUrl),
      offer: offer ? serialize(offer) : null,
      history: rows.filter((r) => r.status !== 'offered').map(serialize),
    };
  }

  app.get(
    '/api/system/update',
    authedRoute(app, async ({ tx, user }) => {
      await requireOwner(tx, user);
      return overview(tx);
    }),
  );

  /** Satıcıya hemen sorar (kalp atışı); teklif varsa kaydedilir. */
  app.post(
    '/api/system/update/check',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    authedRoute(app, async ({ tx, user }) => {
      await requireOwner(tx, user);
      await app.license.heartbeat();
      return overview(tx);
    }),
  );

  app.post(
    '/api/system/update/:id/request',
    authedRoute(app, async ({ tx, user, req }) => {
      await requireOwner(tx, user);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const { when } = z.object({ when: z.enum(['now', 'tonight']) }).parse(req.body);
      if (!updaterToken || !platform) {
        throw unprocessable('Bu kurulumda otomatik güncelleyici yok; yeni kiti indirip kurulum sihirbazıyla güncelleyin', 'UPDATER_NOT_CONFIGURED');
      }
      const active = await tx.select({ id: appUpdates.id }).from(appUpdates).where(sql`${appUpdates.status} in ('requested','downloading','applying')`);
      if (active.some((a) => a.id !== id)) throw conflict('Başka bir güncelleme sürüyor', 'UPDATE_IN_PROGRESS');
      const [row] = await tx.select().from(appUpdates).where(eq(appUpdates.id, id)).for('update');
      if (!row) throw notFound('Güncelleme');
      if (!['offered', 'failed', 'rolled_back', 'cancelled'].includes(row.status)) throw conflict('Bu güncelleme zaten onaylanmış ya da tamamlanmış', 'UPDATE_NOT_PENDING');
      // Sürüm düşürme/aynı sürümü yeniden kurma uzaktan yapılmaz (veritabanı yeni şemaya taşınmış olabilir); onarım için kurulum
      // sihirbazı yerelde yeniden çalıştırılır.
      if (!isNewerThanCurrent(row.version, current)) {
        throw conflict(`Çalışan sürüm ${current}; ${row.version} daha yeni değil (sürüm düşürme ve aynı sürümü yeniden kurma uzaktan yapılmaz)`, 'UPDATE_NOT_NEWER');
      }
      if (!row.files.some((f) => f.target === platform)) throw unprocessable('Bu sürümde kurulumunuzun platformu için paket yok', 'UPDATE_NO_PACKAGE');
      const now = new Date();
      const scheduledFor = when === 'now' ? now : nextNightWindow(now);
      const [upd] = await tx
        .update(appUpdates)
        .set({ status: 'requested', requestedBy: user.id, requestedAt: now, scheduledFor, startedAt: null, finishedAt: null, message: null, log: null, fromVersion: current, updatedAt: now })
        .where(eq(appUpdates.id, id))
        .returning();
      await recordSecurityEvent(app.db, app.log, req, { event: 'update_requested', organizationId: user.orgId, userId: user.id, meta: { version: row.version, when } });
      return { update: serialize(upd!) };
    }),
  );

  app.post(
    '/api/system/update/:id/cancel',
    authedRoute(app, async ({ tx, user, req }) => {
      await requireOwner(tx, user);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [upd] = await tx
        .update(appUpdates)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(sql`${appUpdates.id} = ${id} and ${appUpdates.status} = 'requested'`)
        .returning();
      if (!upd) throw conflict('Yalnızca başlamamış güncelleme iptal edilir', 'UPDATE_NOT_CANCELLABLE');
      return { update: serialize(upd) };
    }),
  );

  // ---- Ana makinedeki güncelleyici (kullanıcı oturumu yok; paylaşılan belirteç) -------------------------------------------
  const assertUpdater = (req: FastifyRequest) => {
    const given = req.headers['x-updater-token'];
    if (!updaterToken || typeof given !== 'string' || !timingSafeEqual(sha(given), sha(updaterToken))) {
      throw new AppError(401, 'UPDATER_UNAUTHORIZED', 'Güncelleyici belirteci geçersiz');
    }
  };

  /** Zamanı gelmiş onaylı güncelleme: indirme adresi (lisans sunucusu + kuruluma özel belirteç) ve imzalı manifesto. */
  app.get('/api/system/updater/pending', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    assertUpdater(req);
    const [row] = await app.db
      .select()
      .from(appUpdates)
      .where(sql`${appUpdates.status} in ('requested','downloading','applying') and ${appUpdates.scheduledFor} <= now()`)
      .orderBy(asc(appUpdates.scheduledFor))
      .limit(1);
    if (!row || !platform || !serverUrl) return { update: null };
    // Eski kayıt (ör. sürüm elle yükseltildikten sonra kalan onay) güncelleyiciye verilmez; çalışan sürüm zaten aynıysa
    // güncelleyici yalnızca "bitti" bildirir (önceki denemenin yarıda kalan bildirimi).
    if (row.version !== current && !isNewerThanCurrent(row.version, current)) return { update: null, currentVersion: current };
    const file = row.files.find((f) => f.target === platform);
    if (!file) return { update: null };
    const base = serverUrl.replace(/\/+$/, '');
    return {
      update: {
        id: row.id,
        version: row.version,
        status: row.status,
        manifest: row.manifest,
        file: file.name,
        downloadUrl: `${base}/v1/releases/${encodeURIComponent(row.version)}/${encodeURIComponent(file.name)}?t=${encodeURIComponent(row.downloadToken)}`,
      },
      currentVersion: current,
    };
  });

  const reportSchema = z.object({
    id: z.uuid(),
    status: z.enum(['downloading', 'applying', 'done', 'failed', 'rolled_back']),
    message: z.string().max(2000).optional(),
    log: z.string().max(200_000).optional(),
  });
  const allowedFrom: Record<string, readonly string[]> = {
    downloading: ['requested', 'downloading'],
    applying: ['requested', 'downloading', 'applying'],
    done: ACTIVE,
    failed: ACTIVE,
    rolled_back: ACTIVE,
  };

  app.post('/api/system/updater/report', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    assertUpdater(req);
    const input = reportSchema.parse(req.body);
    const [row] = await app.db.select().from(appUpdates).where(eq(appUpdates.id, input.id));
    if (!row) throw notFound('Güncelleme');
    if (!allowedFrom[input.status]!.includes(row.status)) throw conflict(`Durum ${row.status} → ${input.status} geçersiz`, 'UPDATE_BAD_TRANSITION');
    if (input.status === 'done' && row.version !== current) {
      throw conflict(`Çalışan sürüm ${current}; ${row.version} bekleniyordu`, 'UPDATE_VERSION_MISMATCH');
    }
    const now = new Date();
    const terminal = input.status === 'done' || input.status === 'failed' || input.status === 'rolled_back';
    await app.db
      .update(appUpdates)
      .set({
        status: input.status,
        ...(input.status === 'downloading' && !row.startedAt ? { startedAt: now } : {}),
        ...(terminal ? { finishedAt: now } : {}),
        ...(input.message !== undefined ? { message: input.message } : {}),
        ...(input.log !== undefined ? { log: input.log } : {}),
        updatedAt: now,
      })
      .where(eq(appUpdates.id, input.id));
    return { ok: true };
  });
};
