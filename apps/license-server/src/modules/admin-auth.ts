import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';
import { verifyTotp } from '@erp/license-core';
import { audit } from '../audit';
import { decryptSecret } from '../crypto';
import type { Tx } from '../db/client';
import { adminSessions, admins } from '../db/schema';
import { ApiError, forbidden, unauthorized } from '../errors';

export const SESSION_COOKIE = 'lic_admin';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Yönetim uçlarının bir işaret taşıdığını söyler; rota envanteri testi kayıtsız korumasız rota bulursa başarısız olur. */
export const ADMIN_GUARD = Symbol.for('erp.license.admin.guard');
/** Tarayıcıdaki çapraz-köken formlarının gönderemeyeceği özel başlık (CSRF'ye ek savunma; SameSite=Strict zaten var). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'erp-license-admin';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash('dummy-password-for-timing'));

export interface AdminRow {
  id: string;
  email: string;
  fullName: string;
}

export interface AdminCtx {
  tx: Tx;
  admin: AdminRow;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Yalnızca oturum açmış yönetici; tüm istek tek işlemde. Değiştiren istekler CSRF başlığı ve Origin denetiminden geçer. */
export function adminRoute<T>(app: FastifyInstance, handler: (ctx: AdminCtx) => Promise<T>): RouteHandlerMethod {
  const route: RouteHandlerMethod = async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();
    const now = new Date(app.now());
    const [row] = await app.db
      .select({ id: admins.id, email: admins.email, fullName: admins.fullName, isActive: admins.isActive })
      .from(adminSessions)
      .innerJoin(admins, eq(admins.id, adminSessions.adminId))
      .where(and(eq(adminSessions.id, sha256(token)), gt(adminSessions.expiresAt, now)));
    if (!row?.isActive) throw unauthorized();

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers[CSRF_HEADER] !== CSRF_VALUE) throw forbidden('İstek başlığı eksik', 'CSRF');
      const origin = req.headers.origin;
      if (origin) {
        const originHost = (() => {
          try {
            return new URL(origin).host;
          } catch {
            return null;
          }
        })();
        if (originHost !== req.headers.host) throw forbidden('Köken uyuşmuyor', 'CSRF');
      }
    }
    const r = app.limiter.consume(`admin:${row.id}`, 600, 60_000);
    if (!r.ok) throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla istek');
    return app.db.transaction((tx) => handler({ tx, admin: { id: row.id, email: row.email, fullName: row.fullName }, req, reply }));
  };
  return Object.assign(route, { [ADMIN_GUARD]: true });
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/),
});

const LOGIN_WINDOW_MS = 15 * 60_000;

export const adminAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/admin/api/login', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const ipEmailKey = `admin-fail:${req.ip}|${input.email}`;
    const emailKey = `admin-fail:${input.email}`;
    const wait = Math.max(app.limiter.blocked(ipEmailKey, 5), app.limiter.blocked(emailKey, 15));
    if (wait > 0) {
      void reply.header('retry-after', String(wait));
      throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla başarısız giriş; lütfen bekleyin');
    }

    const [admin] = await app.db.select().from(admins).where(eq(admins.email, input.email));
    // Parola ve TOTP her durumda değerlendirilir (hangisinin yanlış olduğu sızmaz; bilinmeyen e-postada da süre harcanır).
    const passwordOk = await verify(admin?.passwordHash ?? (await getDummyHash()), input.password);
    const counter = admin ? verifyTotp(decryptSecret(admin.totpSecretEnc, app.config.LICENSE_DATA_KEY), input.totp, app.now()) : null;
    const replay = counter !== null && admin !== undefined && counter <= admin.totpLastCounter;
    if (!admin || !admin.isActive || !passwordOk || counter === null || replay) {
      app.limiter.hit(ipEmailKey, LOGIN_WINDOW_MS);
      app.limiter.hit(emailKey, LOGIN_WINDOW_MS);
      await audit(app.db, { actor: 'admin', adminId: admin?.id ?? null, action: 'admin.login_failed', ip: req.ip, meta: { email: input.email, reason: replay ? 'totp_replay' : undefined } });
      throw unauthorized('E-posta, parola ya da doğrulama kodu hatalı', 'INVALID_CREDENTIALS');
    }
    app.limiter.reset(ipEmailKey);

    // Aynı kodun yeniden kullanımı koşullu güncellemeyle atomik engellenir.
    const claimed = await app.db
      .update(admins)
      .set({ totpLastCounter: counter, lastLoginAt: new Date(app.now()) })
      .where(sql`${admins.id} = ${admin.id} and ${admins.totpLastCounter} < ${counter}`)
      .returning({ id: admins.id });
    if (claimed.length === 0) throw unauthorized('E-posta, parola ya da doğrulama kodu hatalı', 'INVALID_CREDENTIALS');

    const token = randomBytes(32).toString('base64url');
    await app.db.insert(adminSessions).values({
      id: sha256(token),
      adminId: admin.id,
      expiresAt: new Date(app.now() + SESSION_TTL_MS),
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
    });
    await audit(app.db, { actor: 'admin', adminId: admin.id, action: 'admin.login', ip: req.ip });
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: app.config.ADMIN_COOKIE_SECURE,
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { admin: { id: admin.id, email: admin.email, fullName: admin.fullName } };
  });

  app.post(
    '/admin/api/logout',
    adminRoute(app, async ({ tx, req, reply }) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await tx.delete(adminSessions).where(eq(adminSessions.id, sha256(token)));
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    }),
  );

  app.get(
    '/admin/api/me',
    adminRoute(app, async ({ admin }) => ({ admin })),
  );
};
