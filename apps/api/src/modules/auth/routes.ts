import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { WEAK_PASSWORD_MESSAGE, changePasswordSchema, isWeakPassword, loginSchema, mfaVerifySchema, registerSchema } from '@erp/shared';
import type { Queryable } from '../../db/client';
import { organizations, refreshTokens, users } from '../../db/schema';
import { authedRoute } from '../../http/context';
import { AppError, unauthorized, unprocessable } from '../../http/errors';
import { assertSameOrigin } from '../../http/origin';
import { queueMail } from '../mail/queue';
import { verifyEmailMail } from '../mail/templates';
import { recordSecurityEvent } from './events';
import { MFA_MAX_FAILS, MFA_WINDOW_MS, checkMfaCode, mfaEnabled } from './mfa';
import { issueUserToken } from './tokens';

const REFRESH_COOKIE = 'refresh_token';

/**
 * Döndürülen (rotasyonla iptal edilen) bir yenileme token'ının bu süre içinde yeniden sunulması, aynı çerezle
 * eşzamanlı çalışan iki sekmenin çakışması sayılır (çalınma değil). Bu pencerede yeni token VERİLMEZ, yalnızca
 * 409 döner; istemci güncel çerezle bir kez daha dener. Pencere dışı yeniden kullanım çalınma işaretidir.
 */
const ROTATION_GRACE_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Başarısız giriş sayaçları: (e-posta+IP) başına 5, e-posta başına (tüm IP'ler) 30, 15 dakikada. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP_EMAIL = 5;
const LOGIN_MAX_PER_EMAIL = 30;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// Bilinmeyen e-postada da doğrulama süresi harcansın (kullanıcı sayımını zamanlamayla anlamayı zorlaştırır).
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash('dummy-password-for-timing'));

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  emailVerifiedAt: Date | null;
  mustChangePassword: boolean;
}

/** İstemciye dönen kullanıcı özeti (oturum durumunu ve zorunlu parola değişimini içerir). */
export const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  emailVerified: u.emailVerifiedAt !== null,
  mustChangePassword: u.mustChangePassword,
});

interface SessionFamily {
  id: string;
  startedAt: Date;
}

async function issueSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; organizationId: string },
  opts: { db?: Queryable; family?: SessionFamily; deviceId?: string } = {},
) {
  const db = opts.db ?? app.db;
  const accessToken = app.jwt.sign(
    { sub: user.id, org: user.organizationId, ...(opts.deviceId ? { did: opts.deviceId } : {}) },
    { expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS },
  );
  const refreshToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  const familyStart = opts.family?.startedAt ?? new Date(now);
  // Yenilemeyle uzasa da oturum, ilk girişten SESSION_MAX_DAYS sonra biter.
  const expiresAt = Math.min(
    now + app.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
    familyStart.getTime() + app.config.SESSION_MAX_DAYS * DAY_MS,
  );
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(expiresAt),
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
    deviceId: opts.deviceId ?? null,
    ...(opts.family ? { familyId: opts.family.id, familyStartedAt: opts.family.startedAt } : {}),
  });
  void reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: app.config.COOKIE_SECURE,
    path: '/api/auth',
    maxAge: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  });
  return accessToken;
}

/** Süresi dolmuş ve uzun süre önce iptal edilmiş token satırlarını siler (girişte, kullanıcı başına). */
async function purgeOldTokens(app: FastifyInstance, userId: string) {
  try {
    await app.db.delete(refreshTokens).where(
      and(
        eq(refreshTokens.userId, userId),
        sql`(${refreshTokens.expiresAt} < now() or ${refreshTokens.revokedAt} < now() - interval '30 days')`,
      ),
    );
  } catch (err) {
    app.log.warn({ err }, 'eski yenileme token kayıtları temizlenemedi');
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Eklenti yalnızca RATE_LIMIT_ENABLED iken kayıtlıdır (bkz. app.ts); aksi halde bu ayar yok sayılır.
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/api/auth/register', { config: limit }, async (req, reply) => {
    assertSameOrigin(req, app.config);
    if (!app.config.REGISTRATION_ENABLED) {
      throw new AppError(403, 'REGISTRATION_DISABLED', 'Yeni kayıt bu kurulumda kapalı');
    }
    const input = registerSchema.parse(req.body);
    if (isWeakPassword(input.password, { email: input.email })) throw unprocessable(WEAK_PASSWORD_MESSAGE, 'WEAK_PASSWORD');
    const passwordHash = await hash(input.password);

    const [existing] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email));
    if (existing) throw new AppError(409, 'EMAIL_TAKEN', 'Bu e-posta adresi zaten kayıtlı');
    // Cihaz koltuğu hesap açılmadan ÖNCE denetlenir (koltuk yoksa yetim hesap oluşmasın).
    const device = await app.devices.ensureForRequest(req, reply);

    const user = await app.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.organizationName })
        .returning({ id: organizations.id });
      const [u] = await tx
        .insert(users)
        .values({
          organizationId: org!.id,
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          // Posta altyapısı yoksa doğrulama mümkün değildir; kalıcı bir uyarı çıkmasın diye doğrulanmış sayılır.
          emailVerifiedAt: app.mailer.enabled ? null : new Date(),
        })
        .returning();
      return u!;
    });

    if (app.mailer.enabled) {
      const token = await issueUserToken(app.db, user.id, 'verify_email', req.ip);
      queueMail(app, verifyEmailMail(user.email, user.fullName, `${app.config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`));
    }
    if (device) await app.devices.setLastUser(device.id, user.id);
    const accessToken = await issueSession(app, req, reply, user, { deviceId: device?.id });
    void reply.code(201);
    return { accessToken, user: publicUser(user) };
  });

  app.post('/api/auth/login', { config: limit }, async (req, reply) => {
    assertSameOrigin(req, app.config);
    const input = loginSchema.parse(req.body);

    // Yalnızca başarısız denemeler sayılır; IP sahteciliğine karşı (e-posta+IP) yanında e-posta başına genel sayaç da var.
    const ipEmailKey = `login-fail:${req.ip}|${input.email}`;
    const emailKey = `login-fail:${input.email}`;
    const wait = Math.max(
      app.limiter.blocked(ipEmailKey, LOGIN_MAX_PER_IP_EMAIL),
      app.limiter.blocked(emailKey, LOGIN_MAX_PER_EMAIL),
    );
    if (wait > 0) {
      void reply.header('retry-after', String(wait));
      throw new AppError(429, 'RATE_LIMITED', 'Çok fazla başarısız giriş denemesi; lütfen biraz sonra tekrar deneyin');
    }

    const [user] = await app.db.select().from(users).where(eq(users.email, input.email));

    const ok = await verify(user?.passwordHash ?? (await getDummyHash()), input.password);
    if (!user || !ok || !user.isActive) {
      app.limiter.hit(ipEmailKey, LOGIN_WINDOW_MS);
      app.limiter.hit(emailKey, LOGIN_WINDOW_MS);
      await recordSecurityEvent(app.db, app.log, req, { event: 'login_failed', organizationId: user?.organizationId, userId: user?.id, email: input.email });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı');
    }
    app.limiter.reset(ipEmailKey);

    // İki adımlı doğrulama açıksa oturum VERİLMEZ; kısa ömürlü, yalnızca /api/auth/mfa/verify için geçerli belirteç döner.
    if (await mfaEnabled(app.db, user.id)) {
      const mfaToken = app.jwt.sign({ sub: user.id, org: user.organizationId, purpose: 'mfa' }, { expiresIn: 300 });
      return { mfaRequired: true, mfaToken };
    }
    return completeLogin(req, reply, user);
  });

  async function completeLogin(req: FastifyRequest, reply: FastifyReply, user: typeof users.$inferSelect) {
    // Kayıtlı cihaz (lisans koltuğu): bilinmeyen tarayıcı boş koltuk ister (DEVICE_LIMIT_REACHED).
    const device = await app.devices.ensureForRequest(req, reply, user.id);
    await app.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const accessToken = await issueSession(app, req, reply, user, { deviceId: device?.id });
    await purgeOldTokens(app, user.id);
    await recordSecurityEvent(app.db, app.log, req, { event: 'login_succeeded', organizationId: user.organizationId, userId: user.id, email: user.email });
    return { accessToken, user: publicUser(user) };
  }

  app.post('/api/auth/mfa/verify', { config: limit }, async (req, reply) => {
    assertSameOrigin(req, app.config);
    const input = mfaVerifySchema.parse(req.body);
    let payload: { sub: string; purpose?: string };
    try {
      payload = app.jwt.verify(input.mfaToken);
    } catch {
      throw new AppError(401, 'MFA_TOKEN_INVALID', 'Doğrulama süresi doldu; yeniden giriş yapın');
    }
    if (payload.purpose !== 'mfa') throw new AppError(401, 'MFA_TOKEN_INVALID', 'Doğrulama süresi doldu; yeniden giriş yapın');
    const failKey = `mfa-fail:${payload.sub}`;
    const wait = app.limiter.blocked(failKey, MFA_MAX_FAILS);
    if (wait > 0) {
      void reply.header('retry-after', String(wait));
      throw new AppError(429, 'RATE_LIMITED', 'Çok fazla hatalı doğrulama kodu; lütfen biraz sonra tekrar deneyin');
    }
    const [user] = await app.db.select().from(users).where(eq(users.id, payload.sub));
    if (!user?.isActive) throw unauthorized();
    const used = await checkMfaCode(app.db, app.config.JWT_SECRET, user.id, input.code);
    if (!used) {
      app.limiter.hit(failKey, MFA_WINDOW_MS);
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_failed', organizationId: user.organizationId, userId: user.id, email: user.email });
      throw new AppError(401, 'MFA_CODE_INVALID', 'Doğrulama kodu hatalı');
    }
    app.limiter.reset(failKey);
    if (used === 'recovery') {
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_recovery_used', organizationId: user.organizationId, userId: user.id, email: user.email });
    }
    return completeLogin(req, reply, user);
  });

  app.post('/api/auth/refresh', { config: limit }, async (req, reply) => {
    assertSameOrigin(req, app.config);
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized();

    const [row] = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!row) throw unauthorized();

    if (row.revokedAt) {
      // Cihaz kaldırılınca oturumları kapanır; bu çalınma değil, yönetici işlemidir (toplu çıkış yapılmaz).
      if (row.deviceId && !(await app.devices.isActive(row.deviceId))) {
        void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
        throw new AppError(401, 'DEVICE_REVOKED', 'Bu cihazın erişimi kaldırıldı; yeniden giriş yapın');
      }
      if (row.rotatedAt && Date.now() - row.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
        throw new AppError(409, 'REFRESH_CONFLICT', 'Oturum aynı anda başka bir istekle yenilendi; tekrar deneyin');
      }
      // Tolerans dışında kullanılmış bir token'ın tekrar sunulması çalınma işaretidir: kullanıcının tüm oturumlarını kapat.
      await app.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
      void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      await recordSecurityEvent(app.db, app.log, req, { event: 'refresh_reuse_detected', userId: row.userId });
      throw unauthorized();
    }
    if (row.expiresAt.getTime() < Date.now()) throw unauthorized();
    if (row.familyStartedAt.getTime() + app.config.SESSION_MAX_DAYS * DAY_MS < Date.now()) {
      await app.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
      void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized('Oturumun azami süresi doldu; yeniden giriş yapın');
    }

    const [user] = await app.db.select().from(users).where(eq(users.id, row.userId));
    if (!user?.isActive) throw unauthorized();
    // Yenileme de kayıtlı cihaz ister (lisans denetimi açılmadan önce açılmış oturumlar ilk yenilemede cihaz kazanır).
    const device = await app.devices.ensureForRequest(req, reply, user.id);

    // İptal + yeni token tek işlemde ve tek kazananlı: aynı token'la eşzamanlı ikinci istek 0 satır günceller.
    const accessToken = await app.db.transaction(async (tx) => {
      const rotated = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date(), rotatedAt: new Date() })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (rotated.length === 0) {
        throw new AppError(409, 'REFRESH_CONFLICT', 'Oturum aynı anda başka bir istekle yenilendi; tekrar deneyin');
      }
      return issueSession(app, req, reply, user, {
        db: tx,
        family: { id: row.familyId, startedAt: row.familyStartedAt },
        deviceId: device?.id,
      });
    });
    return { accessToken, user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    assertSameOrigin(req, app.config);
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await app.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
    }
    void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.post(
    '/api/auth/change-password',
    { config: limit },
    authedRoute(app, async ({ tx, user, req }) => {
      const input = changePasswordSchema.parse(req.body);
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      if (!row || !(await verify(row.passwordHash, input.currentPassword))) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Mevcut şifre hatalı');
      }
      if (input.newPassword === input.currentPassword) throw unprocessable('Yeni şifre mevcut şifreden farklı olmalı', 'SAME_PASSWORD');
      if (isWeakPassword(input.newPassword, { email: row.email })) throw unprocessable(WEAK_PASSWORD_MESSAGE, 'WEAK_PASSWORD');
      await tx
        .update(users)
        .set({ passwordHash: await hash(input.newPassword), mustChangePassword: false })
        .where(eq(users.id, user.id));
      // Diğer oturumları kapat; bu isteği gönderen oturum (çerez varsa) açık kalır.
      const current = req.cookies[REFRESH_COOKIE];
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.userId, user.id),
            isNull(refreshTokens.revokedAt),
            ...(current ? [ne(refreshTokens.tokenHash, sha256(current))] : []),
          ),
        );
      await recordSecurityEvent(app.db, app.log, req, { event: 'password_changed', organizationId: row.organizationId, userId: row.id, email: row.email });
      return { ok: true };
    }, { allowMustChange: true }),
  );
};
