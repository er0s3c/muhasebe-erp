import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  LicenseTokenError,
  activateRequestSchema,
  deactivateRequestSchema,
  envelopeBodySchema,
  hashActivationCode,
  heartbeatRequestSchema,
  normalizeActivationCode,
  peekEnvelope,
  signToken,
  verifyEnvelope,
  type EnvelopeKind,
} from '@erp/license-core';
import { audit } from '../audit';
import { activations, customers, licenses } from '../db/schema';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { buildLease, countActiveActivations, getLicenseForUpdate, requireSupportedSectors, type ActivationRow } from './licenses';
import { updateOfferFor } from './releases';

/** İstemci ile satıcı saati arasında kabul edilen en büyük fark (yeniden oynatma penceresi de budur). */
export const MAX_SKEW_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 10;
const IP_HISTORY_MAX = 10;
const CLONE_IP_THRESHOLD = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** İmza/biçim hatalarını 400'e çevirir (belirteç hataları istemci hatasıdır). */
function checked<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LicenseTokenError) throw new ApiError(400, err.code === 'BAD_SIGNATURE' ? 'BAD_SIGNATURE' : 'MALFORMED', 'İstek imzası ya da biçimi geçersiz');
    throw err;
  }
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const timeChallenges = new Map<string, { installationId: string; serverTime: number; expires: number }>();
  app.post('/v2/time', { bodyLimit: 1024 }, async (req) => {
    rate(`time:${req.ip}`, 30, 60_000);
    const { installationId, nonce } = activateRequestSchema.pick({ installationId: true, nonce: true }).parse(req.body);
    const now = app.now();
    for (const [id, value] of timeChallenges) if (value.expires < now) timeChallenges.delete(id);
    if (timeChallenges.size >= 2000 || timeChallenges.has(nonce)) throw conflict('Zaman isteğini yeniden deneyin', 'TIME_CHALLENGE_LIMIT');
    const [activation] = await app.db.select({ lastTs: activations.lastTs }).from(activations).where(eq(activations.installationId, installationId));
    const serverTime = Math.max(now, Number(activation?.lastTs ?? 0) + 1);
    timeChallenges.set(nonce, { installationId, serverTime, expires: now + 120_000 });
    return { token: signToken('server-time', { installationId, nonce, serverTime, expiresAt: serverTime + 120_000 }, app.signer) };
  });
  const verifyTime = (payload: { protocolVersion?: 2; timeNonce?: string; installationId: string; ts: number }) => {
    if (payload.protocolVersion !== 2) { tsCheck(payload.ts); return; }
    const proof = timeChallenges.get(payload.timeNonce ?? '');
    timeChallenges.delete(payload.timeNonce ?? '');
    if (!proof || proof.installationId !== payload.installationId || proof.expires < app.now() || proof.serverTime !== payload.ts) throw conflict('Zaman doğrulaması geçersiz; yeniden deneyin', 'TIME_PROOF_REQUIRED');
  };
  app.get('/healthz', async () => ({ ok: true, version: app.config.APP_VERSION, protocolVersions: [1, 2] }));

  const tsCheck = (ts: number) => {
    if (Math.abs(app.now() - ts) > MAX_SKEW_MS) {
      throw new ApiError(400, 'CLOCK_SKEW', 'Sunucu saatiniz doğru değil (en fazla 10 dakika fark kabul edilir); saati düzeltip yeniden deneyin', { serverTime: app.now() });
    }
  };
  const rate = (key: string, max: number, windowMs: number) => {
    const r = app.limiter.consume(key, max, windowMs);
    if (!r.ok) throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla istek; lütfen biraz sonra tekrar deneyin', { retryAfterSec: r.retryAfterSec });
  };

  // ---- Etkinleştirme -----------------------------------------------------------------------------------
  app.post('/v1/activate', { bodyLimit: 16 * 1024 }, async (req) => {
    rate(`activate:${req.ip}`, 30, 10 * 60_000);
    const wait = app.limiter.blocked(`activate-fail:${req.ip}`, MAX_FAILS_PER_IP);
    if (wait > 0) throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla başarısız deneme; lütfen biraz sonra tekrar deneyin', { retryAfterSec: wait });

    const body = envelopeBodySchema.parse(req.body);
    if (!body.pub) throw badRequest('Kurulum açık anahtarı gerekli', 'PUBKEY_REQUIRED');
    const payload = activateRequestSchema.parse(checked(() => verifyEnvelope('activate', body, body.pub!)));
    verifyTime(payload);

    const normalized = normalizeActivationCode(payload.code);
    const fail = (status: number, code: string, message: string): never => {
      app.limiter.hit(`activate-fail:${req.ip}`, FAIL_WINDOW_MS);
      throw new ApiError(status, code, message);
    };
    if (!normalized) return fail(400, 'INVALID_CODE', 'Etkinleştirme kodu geçersiz');

    const [found] = await app.db
      .select({ license: licenses, customer: customers.name })
      .from(licenses)
      .innerJoin(customers, eq(customers.id, licenses.customerId))
      .where(eq(licenses.codeHash, hashActivationCode(normalized)));
    if (!found) return fail(404, 'INVALID_CODE', 'Etkinleştirme kodu geçersiz');

    const token = await app.db.transaction(async (tx) => {
      const license = await getLicenseForUpdate(tx, found.license.id);
      const now = app.now();
      if (license.status === 'revoked') throw forbidden('Bu lisans iptal edilmiş', 'LICENSE_REVOKED');
      if (license.status === 'suspended') throw forbidden('Bu lisans askıya alınmış; satıcıyla iletişime geçin', 'LICENSE_SUSPENDED');
      if (license.validUntil.getTime() < now) throw forbidden('Bu lisansın süresi dolmuş; yenileme için satıcıyla iletişime geçin', 'LICENSE_EXPIRED');
      requireSupportedSectors(license, payload.supportedSectors);

      const [existing] = await tx.select().from(activations).where(eq(activations.installationId, payload.installationId));
      let activation: ActivationRow;
      if (existing) {
        if (existing.licenseId !== license.id) throw conflict('Bu kurulum başka bir lisansa bağlı', 'INSTALLATION_IN_USE');
        if (existing.publicKey !== body.pub) throw conflict('Kurulum anahtarı uyuşmuyor', 'INSTALLATION_KEY_MISMATCH');
        if (existing.status === 'deactivated' && (await countActiveActivations(tx, license.id)) >= license.maxActivations) {
          throw conflict(`Bu lisans en fazla ${license.maxActivations} sunucuda etkinleştirilebilir`, 'ACTIVATION_LIMIT');
        }
        const changed = existing.fingerprint !== payload.fingerprint;
        const changes = existing.fingerprintChanges + (changed ? 1 : 0);
        [activation] = await tx
          .update(activations)
          .set({
            status: 'active',
            deactivatedAt: null,
            fingerprint: payload.fingerprint,
            fingerprintChanges: changes,
            appVersion: payload.appVersion,
            lastSeenAt: new Date(now),
            lastIp: req.ip,
            ...(changes > 3 ? { flagged: true, flagReason: 'Sunucu parmak izi sık değişiyor (olası paylaşım/klon)' } : {}),
          })
          .where(eq(activations.id, existing.id))
          .returning();
      } else {
        if ((await countActiveActivations(tx, license.id)) >= license.maxActivations) {
          throw conflict(`Bu lisans en fazla ${license.maxActivations} sunucuda etkinleştirilebilir; eski sunucuyu devre dışı bırakın ya da satıcıyla iletişime geçin`, 'ACTIVATION_LIMIT');
        }
        [activation] = await tx
          .insert(activations)
          .values({
            licenseId: license.id,
            installationId: payload.installationId,
            publicKey: body.pub!,
            fingerprint: payload.fingerprint,
            appVersion: payload.appVersion,
            lastSeenAt: new Date(now),
            lastIp: req.ip,
            ipHistory: [{ ip: req.ip, at: now }],
          })
          .returning();
      }
      await audit(tx, { actor: 'installation', action: existing ? 'activation.reactivate' : 'activation.create', targetType: 'activation', targetId: activation!.id, ip: req.ip, meta: { licenseId: license.id, appVersion: payload.appVersion } });
      const lease = buildLease(license, found.customer, { installationId: payload.installationId, fingerprint: payload.fingerprint }, { typ: 'lease', nonce: payload.nonce, now, protocolVersion: payload.protocolVersion });
      return signToken('lease', lease, app.signer);
    });
    return { lease: token };
  });

  // ---- Kurulum imzalı istekler: kalp atışı ve devre dışı bırakma ------------------------------------------
  /** Zarfı, sabitlenmiş kurulum anahtarıyla doğrular ve yükü döndürür. */
  async function authenticateInstallation<T>(
    req: { body: unknown; ip: string },
    kind: EnvelopeKind,
    parse: (raw: unknown) => T & { installationId: string; ts: number; protocolVersion?: 2; timeNonce?: string },
  ): Promise<{ payload: T & { installationId: string; ts: number }; activation: ActivationRow }> {
    const env = envelopeBodySchema.pick({ p: true, s: true }).parse(req.body);
    const claimed = parse(checked(() => peekEnvelope(env)));
    const [activation] = await app.db.select().from(activations).where(eq(activations.installationId, claimed.installationId));
    if (!activation) throw notFound('Bu kurulum tanınmıyor; yeniden etkinleştirin', 'UNKNOWN_INSTALLATION');
    const payload = parse(checked(() => verifyEnvelope(kind, env, activation.publicKey)));
    if (activation.status !== 'active') throw forbidden('Bu kurulum devre dışı bırakılmış; yeniden etkinleştirin', 'DEACTIVATED');
    verifyTime(payload);
    return { payload, activation };
  }

  app.post('/v1/heartbeat', { bodyLimit: 16 * 1024 }, async (req) => {
    rate(`heartbeat:${req.ip}`, 120, 10 * 60_000);
    const { payload, activation } = await authenticateInstallation(req, 'heartbeat', (raw) => heartbeatRequestSchema.parse(raw));
    if (payload.fingerprint !== activation.fingerprint) {
      throw conflict('Sunucu parmak izi değişti; uygulamadan yeniden etkinleştirin', 'FINGERPRINT_CHANGED');
    }
    return app.db.transaction(async (tx) => {
      const now = app.now();
      // Yeniden oynatma koruması: yalnızca daha yeni `ts` kabul edilir; koşullu güncelleme eşzamanlı çift isteği de eler.
      const history = [...activation.ipHistory.filter((h) => h.ip !== req.ip), { ip: req.ip, at: now }].slice(-IP_HISTORY_MAX);
      const recentIps = new Set(history.filter((h) => now - h.at <= DAY_MS).map((h) => h.ip));
      const clone = recentIps.size >= CLONE_IP_THRESHOLD;
      const claimed = await tx
        .update(activations)
        .set({
          lastTs: payload.ts,
          lastSeenAt: new Date(now),
          lastIp: req.ip,
          appVersion: payload.appVersion,
          platform: payload.platform ?? activation.platform,
          reportedDevices: payload.stats.devices,
          reportedCompanies: payload.stats.companies,
          ipHistory: history,
          ...(clone && !activation.flagged ? { flagged: true, flagReason: `Son 24 saatte ${recentIps.size} farklı IP'den kalp atışı (olası klon)` } : {}),
        })
        .where(sql`${activations.id} = ${activation.id} and ${activations.lastTs} < ${payload.ts}`)
        .returning({ id: activations.id });
      if (claimed.length === 0) throw conflict('İstek yeniden oynatılmış ya da eski', 'REPLAY');
      const [row] = await tx
        .select({ license: licenses, customer: customers.name })
        .from(licenses)
        .innerJoin(customers, eq(customers.id, licenses.customerId))
        .where(eq(licenses.id, activation.licenseId));
      requireSupportedSectors(row!.license, payload.supportedSectors);
      const lease = buildLease(row!.license, row!.customer, { installationId: activation.installationId, fingerprint: activation.fingerprint }, { typ: 'lease', nonce: payload.nonce, now, protocolVersion: payload.protocolVersion });
      // Uzaktan güncelleme: satıcı bu lisansa bir sürüm gönderdiyse teklif (imzalı manifesto + indirme belirteci) eklenir
      const update = await updateOfferFor(app, tx, {
        license: row!.license,
        installationId: activation.installationId,
        appVersion: payload.appVersion,
        platform: payload.platform ?? (activation.platform as 'linux-x64' | 'win-x64' | null) ?? undefined,
        now,
      });
      return { lease: signToken('lease', lease, app.signer), ...(update ? { update } : {}) };
    });
  });

  app.post('/v1/deactivate', { bodyLimit: 16 * 1024 }, async (req) => {
    rate(`deactivate:${req.ip}`, 20, 10 * 60_000);
    const { activation } = await authenticateInstallation(req, 'deactivate', (raw) => deactivateRequestSchema.parse(raw));
    await app.db.transaction(async (tx) => {
      await getLicenseForUpdate(tx, activation.licenseId);
      const done = await tx
        .update(activations)
        .set({ status: 'deactivated', deactivatedAt: new Date(app.now()) })
        .where(sql`${activations.id} = ${activation.id} and ${activations.status} = 'active'`)
        .returning({ id: activations.id });
      if (done.length > 0) {
        await tx.update(licenses).set({ transfersUsed: sql`${licenses.transfersUsed} + 1`, updatedAt: new Date() }).where(eq(licenses.id, activation.licenseId));
        await audit(tx, { actor: 'installation', action: 'activation.deactivate', targetType: 'activation', targetId: activation.id, ip: req.ip, meta: { licenseId: activation.licenseId } });
      }
    });
    return { ok: true };
  });
};
