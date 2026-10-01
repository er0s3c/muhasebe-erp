import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  RELEASE_TARGETS,
  compareVersions,
  releaseFileName,
  releaseVersionSchema,
  signToken,
  type ReleaseFile,
  type ReleaseTarget,
  type UpdateOffer,
} from '@erp/license-core';
import { audit } from '../audit';
import type { Queryable } from '../db/client';
import { activations, customers, licenses, releases } from '../db/schema';
import { ApiError, badRequest, conflict, notFound } from '../errors';
import { adminRoute } from './admin-auth';

/** Panel arşivi bu boyutta parçalar halinde yükler (sunucunun istek zaman aşımı kısa tutulur). */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** İndirme belirteci ömrü: güncelleme bu süre içinde başlamalıdır (sonraki kalp atışı yenisini verir). */
const DOWNLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const idParam = z.object({ id: z.uuid() });
type ReleaseRow = typeof releases.$inferSelect;

export function releasesDir(app: FastifyInstance): string {
  const d = app.config.RELEASES_DIR;
  return isAbsolute(d) ? d : resolve(process.cwd(), d);
}
const releaseDir = (app: FastifyInstance, version: string) => join(releasesDir(app), version);

// ---- İndirme belirteci (HMAC; anahtar LICENSE_DATA_KEY'den türetilir) --------------------------------------------------
const tokenKey = (dataKey: string) => Buffer.from(hkdfSync('sha256', dataKey, 'erp-license', 'release-download-v1', 32));

export function signDownloadToken(dataKey: string, p: { installationId: string; version: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify({ i: p.installationId, v: p.version, e: p.exp }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', tokenKey(dataKey)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyDownloadToken(dataKey: string, token: string, now: number): { installationId: string; version: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', tokenKey(dataKey)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { i?: unknown; v?: unknown; e?: unknown };
    if (typeof p.i !== 'string' || typeof p.v !== 'string' || typeof p.e !== 'number' || p.e < now) return null;
    return { installationId: p.i, version: p.v };
  } catch {
    return null;
  }
}

/**
 * Kalp atışında güncelleme teklifi: lisansa bir sürüm gönderilmişse, sürüm yayımdaysa, kurulumun platformu için dosya varsa ve
 * kurulum zaten o (ya da daha yeni) sürümde değilse imzalı manifesto + kuruluma özel indirme belirteci döner.
 */
export async function updateOfferFor(
  app: FastifyInstance,
  q: Queryable,
  p: { license: { updateVersion: string | null }; installationId: string; appVersion: string; platform: ReleaseTarget | undefined; now: number },
): Promise<UpdateOffer | undefined> {
  const version = p.license.updateVersion;
  if (!version || !p.platform) return undefined;
  if (/^\d+\.\d+\.\d+/.test(p.appVersion) && compareVersions(p.appVersion, version) >= 0) return undefined;
  const [rel] = await q.select().from(releases).where(and(eq(releases.version, version), eq(releases.status, 'published')));
  if (!rel?.manifest || !rel.files.some((f) => f.target === p.platform)) return undefined;
  return {
    manifest: rel.manifest,
    downloadToken: signDownloadToken(app.config.LICENSE_DATA_KEY, { installationId: p.installationId, version, exp: p.now + DOWNLOAD_TOKEN_TTL_MS }),
  };
}

const serialize = (r: ReleaseRow, counts?: { sent: number; installed: number }) => ({
  id: r.id,
  version: r.version,
  notes: r.notes,
  status: r.status,
  files: r.files,
  createdAt: r.createdAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString() ?? null,
  sentLicenses: counts?.sent ?? 0,
  installedActivations: counts?.installed ?? 0,
});

async function loadRelease(q: Queryable, id: string, lock = false): Promise<ReleaseRow> {
  const base = q.select().from(releases).where(eq(releases.id, id));
  const [row] = lock ? await base.for('update') : await base;
  if (!row) throw notFound('Sürüm bulunamadı');
  return row;
}

const sha256File = (path: string) =>
  new Promise<string>((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });

export const releaseRoutes: FastifyPluginAsync = async (app) => {
  const actor = (admin: { id: string }, ip: string) => ({ actor: 'admin' as const, adminId: admin.id, ip });
  // Kit parçaları ham ikili gövdeyle gelir (yalnızca bu eklentideki rotalar için)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: UPLOAD_CHUNK_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.get(
    '/admin/api/releases',
    adminRoute(app, async ({ tx }) => {
      const rows = await tx.select().from(releases).orderBy(desc(releases.createdAt)).limit(100);
      const sent = await tx.select({ v: licenses.updateVersion, n: sql<number>`count(*)::int` }).from(licenses).where(sql`${licenses.updateVersion} is not null`).groupBy(licenses.updateVersion);
      const inst = await tx
        .select({ v: activations.appVersion, n: sql<number>`count(*)::int` })
        .from(activations)
        .where(eq(activations.status, 'active'))
        .groupBy(activations.appVersion);
      const sentBy = new Map(sent.map((r) => [r.v, r.n]));
      const instBy = new Map(inst.map((r) => [r.v, r.n]));
      return { releases: rows.map((r) => serialize(r, { sent: sentBy.get(r.version) ?? 0, installed: instBy.get(r.version) ?? 0 })), chunkBytes: UPLOAD_CHUNK_BYTES };
    }),
  );

  app.post(
    '/admin/api/releases',
    adminRoute(app, async ({ tx, admin, req, reply }) => {
      const input = z.object({ version: releaseVersionSchema, notes: z.string().trim().max(4000).default('') }).parse(req.body);
      const [dup] = await tx.select({ id: releases.id }).from(releases).where(eq(releases.version, input.version));
      if (dup) throw conflict('Bu sürüm numarası zaten var', 'RELEASE_EXISTS');
      const [row] = await tx.insert(releases).values({ version: input.version, notes: input.notes, createdBy: admin.id }).returning();
      await mkdir(releaseDir(app, input.version), { recursive: true });
      await audit(tx, { ...actor(admin, req.ip), action: 'release.create', targetType: 'release', targetId: row!.id, meta: { version: input.version } });
      void reply.code(201);
      return { release: serialize(row!) };
    }),
  );

  app.patch(
    '/admin/api/releases/:id',
    adminRoute(app, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const { notes } = z.object({ notes: z.string().trim().max(4000) }).parse(req.body);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'draft') throw conflict('Yayımlanmış sürümün notu değiştirilemez', 'RELEASE_NOT_DRAFT');
      const [row] = await tx.update(releases).set({ notes }).where(eq(releases.id, id)).returning();
      return { release: serialize(row!) };
    }),
  );

  /**
   * Kit arşivi parçası: `offset` bayttan başlayarak eklenir; son parçada `final=1&size=<toplam>` verilir, sunucu özeti hesaplar.
   * Parça sırası bozulursa 409 ve beklenen konum döner (panel kaldığı yerden sürdürür).
   */
  app.put(
    '/admin/api/releases/:id/files/:name',
    { bodyLimit: UPLOAD_CHUNK_BYTES + 1024 },
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id, name } = z.object({ id: z.uuid(), name: z.string().max(120) }).parse(req.params);
      const q = z
        .object({ offset: z.coerce.number().int().min(0), final: z.enum(['0', '1']).default('0'), size: z.coerce.number().int().positive().optional() })
        .parse(req.query);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'draft') throw conflict('Yayımlanmış sürüme dosya eklenemez', 'RELEASE_NOT_DRAFT');
      const target = RELEASE_TARGETS.find((t) => releaseFileName(rel.version, t) === name);
      if (!target) throw badRequest(`Dosya adı ${releaseFileName(rel.version, 'linux-x64')} ya da ${releaseFileName(rel.version, 'win-x64')} olmalı`, 'RELEASE_FILE_NAME');
      const chunk = req.body;
      if (!Buffer.isBuffer(chunk)) throw badRequest('Gövde application/octet-stream olmalı', 'RELEASE_FILE_BODY');

      const dir = releaseDir(app, rel.version);
      await mkdir(dir, { recursive: true });
      const part = join(dir, `${name}.part`);
      const current = q.offset === 0 ? 0 : existsSync(part) ? (await stat(part)).size : 0;
      if (current !== q.offset) throw new ApiError(409, 'RELEASE_UPLOAD_OFFSET', 'Parça sırası bozuldu; kaldığı yerden sürdürün', { expectedOffset: current });
      const fh = await open(part, q.offset === 0 ? 'w' : 'a');
      try {
        await fh.write(chunk);
      } finally {
        await fh.close();
      }
      const received = q.offset + chunk.length;
      if (q.final !== '1') return { received, done: false };

      if (q.size !== received) throw badRequest(`Beklenen boyut ${q.size}, alınan ${received}`, 'RELEASE_UPLOAD_SIZE');
      const sha256 = await sha256File(part);
      await rename(part, join(dir, name));
      const file: ReleaseFile = { target, name, sha256, size: received };
      const files = [...rel.files.filter((f) => f.target !== target), file].sort((a, b) => a.target.localeCompare(b.target));
      const [row] = await tx.update(releases).set({ files }).where(eq(releases.id, id)).returning();
      await audit(tx, { ...actor(admin, req.ip), action: 'release.file', targetType: 'release', targetId: id, meta: { version: rel.version, target, size: received, sha256 } });
      return { received, done: true, file, release: serialize(row!) };
    }),
  );

  app.delete(
    '/admin/api/releases/:id/files/:target',
    adminRoute(app, async ({ tx, req }) => {
      const { id, target } = z.object({ id: z.uuid(), target: z.enum(RELEASE_TARGETS) }).parse(req.params);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'draft') throw conflict('Yayımlanmış sürümden dosya silinemez', 'RELEASE_NOT_DRAFT');
      await rm(join(releaseDir(app, rel.version), releaseFileName(rel.version, target)), { force: true });
      const [row] = await tx
        .update(releases)
        .set({ files: rel.files.filter((f) => f.target !== target) })
        .where(eq(releases.id, id))
        .returning();
      return { release: serialize(row!) };
    }),
  );

  app.delete(
    '/admin/api/releases/:id',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'draft') throw conflict('Yayımlanmış sürüm silinemez; geri çekin', 'RELEASE_NOT_DRAFT');
      await tx.delete(releases).where(eq(releases.id, id));
      await rm(releaseDir(app, rel.version), { recursive: true, force: true });
      await audit(tx, { ...actor(admin, req.ip), action: 'release.delete', targetType: 'release', targetId: id, meta: { version: rel.version } });
      return { ok: true };
    }),
  );

  /** Yayımla: dosya özetleriyle manifesto satıcı anahtarıyla imzalanır; artık dosya değişmez. */
  app.post(
    '/admin/api/releases/:id/publish',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'draft') throw conflict('Sürüm zaten yayımlanmış ya da geri çekilmiş', 'RELEASE_NOT_DRAFT');
      if (rel.files.length === 0) throw badRequest('Yayımlamadan önce en az bir kit arşivi yükleyin', 'RELEASE_NO_FILES');
      for (const f of rel.files) {
        const path = join(releaseDir(app, rel.version), f.name);
        if (!existsSync(path) || (await sha256File(path)) !== f.sha256) throw conflict(`${f.name} diskte yok ya da değişmiş; yeniden yükleyin`, 'RELEASE_FILE_MISSING');
      }
      const publishedAt = app.now();
      const manifest = signToken('release', { v: 1, typ: 'release', version: rel.version, notes: rel.notes, publishedAt, files: rel.files }, app.signer);
      const [row] = await tx
        .update(releases)
        .set({ status: 'published', manifest, publishedAt: new Date(publishedAt) })
        .where(eq(releases.id, id))
        .returning();
      await audit(tx, { ...actor(admin, req.ip), action: 'release.publish', targetType: 'release', targetId: id, meta: { version: rel.version, files: rel.files.map((f) => f.target) } });
      return { release: serialize(row!) };
    }),
  );

  /** Geri çek: yeni teklif verilmez, gönderilmiş lisanslardaki hedef temizlenir (kurulu olanlar etkilenmez). */
  app.post(
    '/admin/api/releases/:id/withdraw',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const rel = await loadRelease(tx, id, true);
      if (rel.status !== 'published') throw conflict('Yalnızca yayımlanmış sürüm geri çekilir', 'RELEASE_NOT_PUBLISHED');
      const [row] = await tx.update(releases).set({ status: 'withdrawn' }).where(eq(releases.id, id)).returning();
      await tx.update(licenses).set({ updateVersion: null, updateSentAt: null }).where(eq(licenses.updateVersion, rel.version));
      await audit(tx, { ...actor(admin, req.ip), action: 'release.withdraw', targetType: 'release', targetId: id, meta: { version: rel.version } });
      return { release: serialize(row!) };
    }),
  );

  /** Güncelleme gönderilebilecek lisanslar: etkin lisanslar, müşterisi, gönderilen sürüm ve kurulumların bildirdiği sürüm/platform. */
  app.get(
    '/admin/api/update-targets',
    adminRoute(app, async ({ tx }) => {
      const rows = await tx
        .select({ license: licenses, customer: customers.name })
        .from(licenses)
        .innerJoin(customers, eq(customers.id, licenses.customerId))
        .where(eq(licenses.status, 'active'))
        .orderBy(customers.name);
      const ids = rows.map((r) => r.license.id);
      const acts = ids.length
        ? await tx
            .select({ licenseId: activations.licenseId, appVersion: activations.appVersion, platform: activations.platform, lastSeenAt: activations.lastSeenAt })
            .from(activations)
            .where(and(inArray(activations.licenseId, ids), eq(activations.status, 'active')))
        : [];
      return {
        licenses: rows.map((r) => ({
          id: r.license.id,
          customer: r.customer,
          codePrefix: r.license.codePrefix,
          kind: r.license.kind,
          updateVersion: r.license.updateVersion,
          updateSentAt: r.license.updateSentAt?.toISOString() ?? null,
          installations: acts
            .filter((a) => a.licenseId === r.license.id)
            .map((a) => ({ appVersion: a.appVersion, platform: a.platform, lastSeenAt: a.lastSeenAt.toISOString() })),
        })),
      };
    }),
  );

  /** Tek tıkla gönder: seçili (ya da tüm etkin) lisansların kurulumlarına bu sürüm teklif edilir; müşteride sahip onaylar. */
  app.post(
    '/admin/api/releases/:id/send',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = idParam.parse(req.params);
      const input = z.union([z.object({ all: z.literal(true) }), z.object({ licenseIds: z.array(z.uuid()).min(1).max(5000) })]).parse(req.body);
      const rel = await loadRelease(tx, id);
      if (rel.status !== 'published') throw conflict('Önce sürümü yayımlayın', 'RELEASE_NOT_PUBLISHED');
      const where = 'all' in input ? eq(licenses.status, 'active') : and(eq(licenses.status, 'active'), inArray(licenses.id, input.licenseIds));
      const updated = await tx.update(licenses).set({ updateVersion: rel.version, updateSentAt: new Date(app.now()) }).where(where).returning({ id: licenses.id });
      await audit(tx, { ...actor(admin, req.ip), action: 'release.send', targetType: 'release', targetId: id, meta: { version: rel.version, licenses: updated.length, all: 'all' in input } });
      return { sent: updated.length };
    }),
  );

  app.post(
    '/admin/api/update-targets/cancel',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { licenseIds } = z.object({ licenseIds: z.array(z.uuid()).min(1).max(5000) }).parse(req.body);
      const updated = await tx.update(licenses).set({ updateVersion: null, updateSentAt: null }).where(inArray(licenses.id, licenseIds)).returning({ id: licenses.id });
      await audit(tx, { ...actor(admin, req.ip), action: 'release.cancel', targetType: 'license', meta: { licenses: updated.length } });
      return { cancelled: updated.length };
    }),
  );

  // ---- Kurulumların indirmesi (kalp atışında verilen kısa ömürlü belirteçle) ----------------------------------------------
  app.get('/v1/releases/:version/:name', async (req, reply) => {
    const r = app.limiter.consume(`release-dl:${req.ip}`, 20, 60 * 60_000);
    if (!r.ok) throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla indirme isteği', { retryAfterSec: r.retryAfterSec });
    const { version, name } = z.object({ version: releaseVersionSchema, name: z.string().max(120) }).parse(req.params);
    const { t } = z.object({ t: z.string().min(20).max(512) }).parse(req.query);
    const tok = verifyDownloadToken(app.config.LICENSE_DATA_KEY, t, app.now());
    if (!tok || tok.version !== version) throw new ApiError(403, 'DOWNLOAD_TOKEN_INVALID', 'İndirme izni geçersiz ya da süresi dolmuş');
    const [act] = await app.db.select({ status: activations.status }).from(activations).where(eq(activations.installationId, tok.installationId));
    if (act?.status !== 'active') throw new ApiError(403, 'DOWNLOAD_TOKEN_INVALID', 'Bu kurulum etkin değil');
    const [rel] = await app.db.select().from(releases).where(and(eq(releases.version, version), eq(releases.status, 'published')));
    const file = rel?.files.find((f) => f.name === name);
    if (!rel || !file) throw notFound('Sürüm dosyası bulunamadı');
    const path = join(releaseDir(app, version), file.name);
    if (!existsSync(path)) throw notFound('Sürüm dosyası sunucuda yok');
    void reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(file.size))
      .header('content-disposition', `attachment; filename="${file.name}"`)
      .header('x-content-sha256', file.sha256);
    return reply.send(createReadStream(path));
  });
};
