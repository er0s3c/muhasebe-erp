import { hash } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  WEAK_PASSWORD_MESSAGE,
  forgotPasswordSchema,
  isWeakPassword,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@erp/shared';
import { refreshTokens, users } from '../../db/schema';
import { authedRoute } from '../../http/context';
import { AppError, unprocessable } from '../../http/errors';
import { assertSameOrigin } from '../../http/origin';
import { passwordChangedMail, resetPasswordMail, verifyEmailMail } from '../mail/templates';
import { queueMail } from '../mail/queue';
import { recordSecurityEvent } from './events';
import { consumeUserToken, issueUserToken } from './tokens';

const HOUR_MS = 60 * 60 * 1000;

/** Parola sıfırlama, e-posta doğrulama ve yeniden doğrulama uçları (giden posta yapılandırılmışsa anlamlıdır). */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  const linkTo = (path: string, token: string) => `${app.config.APP_BASE_URL}${path}?token=${encodeURIComponent(token)}`;
  const mailOff = () => new AppError(503, 'MAIL_DISABLED', 'Bu kurulumda e-posta gönderimi kapalı; şirket yöneticinizden şifrenizi sıfırlamasını isteyin');

  /**
   * Her zaman 202 ve aynı gövde: kayıtlı olan/olmayan e-posta ayırt edilemez. Aynı e-postaya saatte en çok 3
   * bağlantı gönderilir (aşılırsa yine 202, ama gönderilmez).
   */
  app.post('/api/auth/forgot-password', { config: limit }, async (req, reply) => {
    assertSameOrigin(req, app.config);
    if (!app.mailer.enabled) throw mailOff();
    const { email } = forgotPasswordSchema.parse(req.body);
    if (app.limiter.consume(`forgot:${email}`, 3, HOUR_MS).ok) {
      const [user] = await app.db.select().from(users).where(eq(users.email, email));
      if (user?.isActive) {
        const token = await issueUserToken(app.db, user.id, 'reset_password', req.ip);
        queueMail(app, resetPasswordMail(user.email, user.fullName, linkTo('/reset-password', token)));
        await recordSecurityEvent(app.db, app.log, req, { event: 'password_reset_requested', organizationId: user.organizationId, userId: user.id, email: user.email });
      }
    }
    void reply.code(202);
    return { ok: true };
  });

  app.post('/api/auth/reset-password', { config: limit }, async (req) => {
    assertSameOrigin(req, app.config);
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const passwordHash = await hash(newPassword);

    const user = await app.db.transaction(async (tx) => {
      // Jeton tek atomik güncellemeyle tüketilir; aşağıda bir hata olursa işlem geri alınır ve jeton yeniden kullanılabilir kalır.
      const userId = await consumeUserToken(tx, token, 'reset_password');
      if (!userId) return null;
      const [u] = await tx.select().from(users).where(eq(users.id, userId));
      if (!u?.isActive) return null;
      if (isWeakPassword(newPassword, { email: u.email })) throw unprocessable(WEAK_PASSWORD_MESSAGE, 'WEAK_PASSWORD');
      await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
        .where(eq(users.id, u.id));
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
      return u;
    });
    if (!user) throw new AppError(400, 'INVALID_TOKEN', 'Bağlantı geçersiz ya da süresi dolmuş; yeni bir sıfırlama isteyin');

    await recordSecurityEvent(app.db, app.log, req, { event: 'password_reset_completed', organizationId: user.organizationId, userId: user.id, email: user.email });
    if (app.mailer.enabled) queueMail(app, passwordChangedMail(user.email, user.fullName));
    return { ok: true };
  });

  app.post('/api/auth/verify-email', { config: limit }, async (req) => {
    assertSameOrigin(req, app.config);
    const { token } = verifyEmailSchema.parse(req.body);
    const user = await app.db.transaction(async (tx) => {
      const userId = await consumeUserToken(tx, token, 'verify_email');
      if (!userId) return null;
      const [u] = await tx
        .update(users)
        .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
        .where(eq(users.id, userId))
        .returning();
      return u ?? null;
    });
    if (!user) throw new AppError(400, 'INVALID_TOKEN', 'Bağlantı geçersiz ya da süresi dolmuş; yeni bir doğrulama e-postası isteyin');
    await recordSecurityEvent(app.db, app.log, req, { event: 'email_verified', organizationId: user.organizationId, userId: user.id, email: user.email });
    return { ok: true };
  });

  app.post(
    '/api/auth/resend-verification',
    authedRoute(
      app,
      async ({ user, req }) => {
        if (!app.mailer.enabled) throw mailOff();
        const [u] = await app.db.select().from(users).where(eq(users.id, user.id));
        if (!u) throw new AppError(404, 'NOT_FOUND', 'Kullanıcı bulunamadı');
        if (u.emailVerifiedAt) return { ok: true, alreadyVerified: true };
        const gate = app.limiter.consume(`resend:${u.id}`, 1, 60_000);
        if (!gate.ok) throw new AppError(429, 'RATE_LIMITED', 'Doğrulama e-postası az önce gönderildi; bir dakika sonra tekrar deneyin');
        const token = await issueUserToken(app.db, u.id, 'verify_email', req.ip);
        queueMail(app, verifyEmailMail(u.email, u.fullName, linkTo('/verify-email', token)));
        return { ok: true, alreadyVerified: false };
      },
      { allowMustChange: true },
    ),
  );
};
