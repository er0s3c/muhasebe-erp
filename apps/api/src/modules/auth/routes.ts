import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { changePasswordSchema, loginSchema, registerSchema } from '@erp/shared';
import { organizations, refreshTokens, users } from '../../db/schema';
import { authedRoute } from '../../http/context';
import { AppError, unauthorized } from '../../http/errors';

const REFRESH_COOKIE = 'refresh_token';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// Bilinmeyen e-postada da doğrulama süresi harcansın (kullanıcı sayımını zamanlamayla anlamayı zorlaştırır).
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash('dummy-password-for-timing'));

async function issueSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  user: { id: string; organizationId: string },
) {
  const accessToken = app.jwt.sign(
    { sub: user.id, org: user.organizationId },
    { expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS },
  );
  const refreshToken = randomBytes(32).toString('base64url');
  const ttlMs = app.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  await app.db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + ttlMs),
    userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    ip: req.ip,
  });
  void reply.setCookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: app.config.COOKIE_SECURE,
    path: '/api/auth',
    maxAge: Math.floor(ttlMs / 1000),
  });
  return accessToken;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // Eklenti yalnızca RATE_LIMIT_ENABLED iken kayıtlıdır (bkz. app.ts); aksi halde bu ayar yok sayılır.
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/api/auth/register', { config: limit }, async (req, reply) => {
    if (!app.config.REGISTRATION_ENABLED) {
      throw new AppError(403, 'REGISTRATION_DISABLED', 'Yeni kayıt bu kurulumda kapalı');
    }
    const input = registerSchema.parse(req.body);
    const passwordHash = await hash(input.password);

    const [existing] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email));
    if (existing) throw new AppError(409, 'EMAIL_TAKEN', 'Bu e-posta adresi zaten kayıtlı');

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
        })
        .returning({ id: users.id, organizationId: users.organizationId, email: users.email, fullName: users.fullName });
      return u!;
    });

    const accessToken = await issueSession(app, req, reply, user);
    void reply.code(201);
    return { accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } };
  });

  app.post('/api/auth/login', { config: limit }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const [user] = await app.db.select().from(users).where(eq(users.email, input.email));

    const ok = await verify(user?.passwordHash ?? (await getDummyHash()), input.password);
    if (!user || !ok || !user.isActive) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'E-posta veya şifre hatalı');
    }

    await app.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    const accessToken = await issueSession(app, req, reply, user);
    return { accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } };
  });

  app.post('/api/auth/refresh', { config: limit }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized();

    const [row] = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!row) throw unauthorized();

    if (row.revokedAt) {
      // Kullanılmış bir token'ın tekrar sunulması çalınma işaretidir: kullanıcının tüm oturumlarını kapat.
      await app.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, row.userId), isNull(refreshTokens.revokedAt)));
      void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized();
    }
    if (row.expiresAt.getTime() < Date.now()) throw unauthorized();

    const [user] = await app.db.select().from(users).where(eq(users.id, row.userId));
    if (!user?.isActive) throw unauthorized();

    await app.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));
    const accessToken = await issueSession(app, req, reply, user);
    return { accessToken, user: { id: user.id, email: user.email, fullName: user.fullName } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
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
    authedRoute(app, async ({ tx, user, req }) => {
      const input = changePasswordSchema.parse(req.body);
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      if (!row || !(await verify(row.passwordHash, input.currentPassword))) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Mevcut şifre hatalı');
      }
      await tx.update(users).set({ passwordHash: await hash(input.newPassword) }).where(eq(users.id, user.id));
      // Diğer oturumları kapat.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
      return { ok: true };
    }),
  );
};
