import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { adminPasskeys, admins } from '../db/schema';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../errors';
import { adminRoute, startSession } from './admin-auth';
import { TOTP_ISSUER } from './admin-setup';

/**
 * Giriş anahtarları (WebAuthn/passkey). Kayıt yalnızca oturum açmış yöneticiye açıktır; giriş, keşfedilebilir anahtarla
 * (e-posta sorulmadan) yapılır ve kullanıcı doğrulaması (PIN/biyometri/kasa kilidi) zorunludur: anahtar tek başına iki
 * etkenin yerini tutar. Anahtarlar parola kasalarında (Vaultwarden/Bitwarden, iCloud, Google) ya da donanım anahtarında durabilir.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_IP = 10;

/** Tek kullanımlık, süreli meydan okumalar (bellek içi; tek örnek varsayımı, bkz. MemoryLimiter). */
class ChallengeStore {
  private readonly entries = new Map<string, { challenge: string; exp: number }>();

  constructor(
    private readonly now: () => number,
    private readonly max = 1000,
  ) {}

  put(key: string, challenge: string): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.exp <= t) this.entries.delete(k);
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.delete(key);
    this.entries.set(key, { challenge, exp: t + CHALLENGE_TTL_MS });
  }

  take(key: string): string | undefined {
    const e = this.entries.get(key);
    this.entries.delete(key);
    return e && e.exp > this.now() ? e.challenge : undefined;
  }
}

/** Anahtarın bağlandığı köken ve alan adı (RP ID): üretimde `LICENSE_ADMIN_ORIGIN`, yoksa istekteki köken. */
function relyingParty(app: FastifyInstance, req: FastifyRequest) {
  const origin = app.config.LICENSE_ADMIN_ORIGIN ?? `${req.protocol}://${req.host}`;
  return { origin, rpID: new URL(origin).hostname };
}

const uuidBytes = (id: string) => new Uint8Array(Buffer.from(id.replaceAll('-', ''), 'hex'));
const serialize = (p: typeof adminPasskeys.$inferSelect) => ({ id: p.id, name: p.name, backedUp: p.backedUp, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt });

const webauthnResponse = z.object({ id: z.string().min(1).max(1024) }).passthrough();
const registerSchema = z.object({ name: z.string().trim().max(60).optional(), response: webauthnResponse });
const loginSchema = z.object({ challengeId: z.string().min(1).max(64), response: webauthnResponse });

export const adminPasskeyRoutes: FastifyPluginAsync = async (app) => {
  const challenges = new ChallengeStore(app.now);

  app.get(
    '/admin/api/passkeys',
    adminRoute(app, async ({ tx, admin }) => {
      const rows = await tx.select().from(adminPasskeys).where(eq(adminPasskeys.adminId, admin.id)).orderBy(adminPasskeys.createdAt);
      return { passkeys: rows.map(serialize) };
    }),
  );

  app.post(
    '/admin/api/passkeys/options',
    adminRoute(app, async ({ tx, admin, req }) => {
      const existing = await tx.select({ id: adminPasskeys.credentialId, transports: adminPasskeys.transports }).from(adminPasskeys).where(eq(adminPasskeys.adminId, admin.id));
      if (existing.length >= MAX_PASSKEYS) throw conflict(`En çok ${MAX_PASSKEYS} giriş anahtarı eklenebilir; kullanmadığınızı silin`, 'PASSKEY_LIMIT');
      const { rpID } = relyingParty(app, req);
      const options = await generateRegistrationOptions({
        rpName: TOTP_ISSUER,
        rpID,
        userName: admin.email,
        userDisplayName: admin.fullName,
        userID: uuidBytes(admin.id),
        attestationType: 'none',
        excludeCredentials: existing,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      challenges.put(`reg:${admin.id}`, options.challenge);
      return { options };
    }),
  );

  app.post(
    '/admin/api/passkeys',
    adminRoute(app, async ({ tx, admin, req }) => {
      const input = registerSchema.parse(req.body);
      const expectedChallenge = challenges.take(`reg:${admin.id}`);
      if (!expectedChallenge) throw badRequest('Süre doldu; giriş anahtarı eklemeyi yeniden başlatın', 'CHALLENGE_EXPIRED');
      const { origin, rpID } = relyingParty(app, req);
      const result = await verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      }).catch(() => null);
      if (!result?.verified) throw badRequest('Giriş anahtarı doğrulanamadı', 'PASSKEY_INVALID');
      const { credential, credentialBackedUp } = result.registrationInfo;

      const [dup] = await tx.select({ id: adminPasskeys.id }).from(adminPasskeys).where(eq(adminPasskeys.credentialId, credential.id));
      if (dup) throw conflict('Bu giriş anahtarı zaten kayıtlı', 'PASSKEY_EXISTS');
      const [row] = await tx
        .insert(adminPasskeys)
        .values({
          adminId: admin.id,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
          name: input.name || (credentialBackedUp ? 'Parola kasası / eşitlenen anahtar' : 'Güvenlik anahtarı'),
          backedUp: credentialBackedUp,
        })
        .returning();
      await audit(tx, { actor: 'admin', adminId: admin.id, action: 'admin.passkey_add', targetType: 'passkey', targetId: row!.id, ip: req.ip, meta: { name: row!.name } });
      return { passkey: serialize(row!) };
    }),
  );

  app.delete(
    '/admin/api/passkeys/:id',
    adminRoute(app, async ({ tx, admin, req }) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [row] = await tx.delete(adminPasskeys).where(and(eq(adminPasskeys.id, id), eq(adminPasskeys.adminId, admin.id))).returning();
      if (!row) throw notFound('Giriş anahtarı bulunamadı');
      await audit(tx, { actor: 'admin', adminId: admin.id, action: 'admin.passkey_remove', targetType: 'passkey', targetId: id, ip: req.ip, meta: { name: row.name } });
      return { ok: true };
    }),
  );

  /** Giriş: meydan okuma üretir (e-posta sorulmaz; tarayıcı/kasa uygun anahtarı önerir). */
  app.post('/admin/api/passkey/options', { bodyLimit: 1024 }, async (req, reply) => {
    const r = app.limiter.consume(`passkey-options:${req.ip}`, 30, 10 * 60_000);
    if (!r.ok) {
      void reply.header('retry-after', String(r.retryAfterSec));
      throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla istek; lütfen bekleyin');
    }
    const options = await generateAuthenticationOptions({ rpID: relyingParty(app, req).rpID, userVerification: 'required' });
    const challengeId = randomBytes(16).toString('base64url');
    challenges.put(`auth:${challengeId}`, options.challenge);
    return { challengeId, options };
  });

  app.post('/admin/api/passkey/login', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const failKey = `passkey-fail:${req.ip}`;
    const wait = app.limiter.blocked(failKey, MAX_FAILS_PER_IP);
    if (wait > 0) {
      void reply.header('retry-after', String(wait));
      throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla başarısız giriş; lütfen bekleyin');
    }
    const fail = async (reason: string, adminId: string | null = null): Promise<never> => {
      app.limiter.hit(failKey, FAIL_WINDOW_MS);
      await audit(app.db, { actor: 'admin', adminId, action: 'admin.login_failed', ip: req.ip, meta: { method: 'passkey', reason } });
      throw unauthorized('Giriş anahtarı doğrulanamadı', 'INVALID_CREDENTIALS');
    };

    const expectedChallenge = challenges.take(`auth:${input.challengeId}`);
    if (!expectedChallenge) throw badRequest('Süre doldu; yeniden deneyin', 'CHALLENGE_EXPIRED');
    const [found] = await app.db
      .select({ passkey: adminPasskeys, admin: { id: admins.id, email: admins.email, fullName: admins.fullName, isActive: admins.isActive } })
      .from(adminPasskeys)
      .innerJoin(admins, eq(admins.id, adminPasskeys.adminId))
      .where(eq(adminPasskeys.credentialId, input.response.id));
    if (!found) return fail('unknown_credential');
    if (!found.admin.isActive) return fail('inactive', found.admin.id);

    const { origin, rpID } = relyingParty(app, req);
    const result = await verifyAuthenticationResponse({
      response: input.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: found.passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(found.passkey.publicKey, 'base64url')),
        counter: found.passkey.counter,
        transports: found.passkey.transports,
      },
      requireUserVerification: true,
    }).catch(() => null);
    if (!result?.verified) return fail('invalid_assertion', found.admin.id);

    const now = new Date(app.now());
    await app.db.update(adminPasskeys).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: now }).where(eq(adminPasskeys.id, found.passkey.id));
    await app.db.update(admins).set({ lastLoginAt: now }).where(eq(admins.id, found.admin.id));
    app.limiter.reset(failKey);
    await audit(app.db, { actor: 'admin', adminId: found.admin.id, action: 'admin.login', ip: req.ip, meta: { method: 'passkey', passkey: found.passkey.name } });
    return { admin: await startSession(app, req, reply, found.admin) };
  });
};
