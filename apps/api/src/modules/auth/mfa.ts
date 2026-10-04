import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { generateTotpSecret, otpauthUri, verifyTotp } from '@erp/license-core';
import type { Queryable } from '../../db/client';
import { userMfa, users } from '../../db/schema';
import { authedRoute } from '../../http/context';
import { AppError, unprocessable } from '../../http/errors';
import { assertSameOrigin } from '../../http/origin';
import { recordSecurityEvent } from './events';

const ISSUER = 'Ada Muhasebe';
const RECOVERY_CODE_COUNT = 8;
export const MFA_MAX_FAILS = 5;
export const MFA_WINDOW_MS = 15 * 60 * 1000;

const keyOf = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'erp-api', 'user-mfa-secret-v1', 32));

/** TOTP sırrı diskte şifrelidir (AES-256-GCM; anahtar JWT_SECRET'ten HKDF ile türetilir). */
export function encryptMfaSecret(plain: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(key), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptMfaSecret(blob: string, key: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Geçersiz şifreli değer');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
/** Kurtarma kodu biçimi: xxxxx-xxxxx (küçük harf + rakam); girişte tire/boşluk/büyük harf toleranslıdır. */
const normalizeRecovery = (v: string) => v.toLowerCase().replace(/[\s-]/g, '');
const newRecoveryCode = () => {
  const raw = randomBytes(8).toString('hex').slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
};

export async function getMfa(db: Queryable, userId: string) {
  const [row] = await db.select().from(userMfa).where(eq(userMfa.userId, userId));
  return row;
}

export async function mfaEnabled(db: Queryable, userId: string): Promise<boolean> {
  return !!(await getMfa(db, userId))?.enabledAt;
}

/**
 * Giriş ikinci adımı: 6 haneli TOTP (aynı sayaç yeniden kullanılamaz) ya da tek kullanımlık kurtarma kodu.
 * Başarılıysa true; hatalıysa false (çağıran sayaç/olay işlemini yapar).
 */
export async function checkMfaCode(db: Queryable, jwtSecret: string, userId: string, input: string): Promise<'totp' | 'recovery' | null> {
  const row = await getMfa(db, userId);
  if (!row?.enabledAt) return null;
  const code = input.trim();
  if (/^\d{6}$/.test(code)) {
    const counter = verifyTotp(decryptMfaSecret(row.secretEnc, jwtSecret), code, Date.now());
    if (counter === null || (row.lastCounter !== null && counter <= row.lastCounter)) return null;
    // Koşullu güncelleme: aynı kodla eşzamanlı iki deneme yalnızca birini geçirir.
    const upd = await db.execute(sqlUpdateCounter(userId, counter));
    return upd.rows.length > 0 ? 'totp' : null;
  }
  const norm = normalizeRecovery(code);
  if (!/^[0-9a-f]{10}$/.test(norm)) return null;
  const h = sha256(norm);
  if (!row.recoveryHashes.includes(h)) return null;
  const left = row.recoveryHashes.filter((x) => x !== h);
  const upd = await db
    .update(userMfa)
    .set({ recoveryHashes: left })
    .where(eq(userMfa.userId, userId))
    .returning({ userId: userMfa.userId });
  return upd.length > 0 ? 'recovery' : null;
}

const sqlUpdateCounter = (userId: string, counter: number) =>
  sql`update user_mfa set last_counter = ${counter} where user_id = ${userId} and (last_counter is null or last_counter < ${counter}) returning user_id`;

const codeSchema = z.object({ code: z.string().trim().min(6).max(20) });
const disableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) });

/** Oturum açmış kullanıcının kendi iki adımlı doğrulama yönetimi. */
export const mfaRoutes: FastifyPluginAsync = async (app) => {
  const limit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  const failKey = (userId: string) => `mfa-fail:${userId}`;
  const guardFails = (userId: string) => {
    const wait = app.limiter.blocked(failKey(userId), MFA_MAX_FAILS);
    if (wait > 0) throw new AppError(429, 'RATE_LIMITED', 'Çok fazla hatalı doğrulama kodu; lütfen biraz sonra tekrar deneyin');
  };

  app.get(
    '/api/auth/mfa',
    authedRoute(app, async ({ tx, user }) => {
      const row = await getMfa(tx, user.id);
      return {
        enabled: !!row?.enabledAt,
        pending: !!row && !row.enabledAt,
        recoveryCodesLeft: row?.enabledAt ? row.recoveryHashes.length : 0,
      };
    }),
  );

  /** Kurulumu başlatır: yeni sır üretir (etkin değilken tekrar çağrılırsa yenilenir). */
  app.post(
    '/api/auth/mfa/setup',
    { config: limit },
    authedRoute(app, async ({ tx, user, req }) => {
      assertSameOrigin(req, app.config);
      const existing = await getMfa(tx, user.id);
      if (existing?.enabledAt) throw unprocessable('İki adımlı doğrulama zaten etkin', 'MFA_ALREADY_ENABLED');
      const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, user.id));
      const secret = generateTotpSecret();
      const secretEnc = encryptMfaSecret(secret, app.config.JWT_SECRET);
      await tx
        .insert(userMfa)
        .values({ userId: user.id, secretEnc })
        .onConflictDoUpdate({ target: userMfa.userId, set: { secretEnc, lastCounter: null, createdAt: new Date() } });
      return { secret, otpauthUri: otpauthUri(secret, u!.email, ISSUER) };
    }),
  );

  /** Uygulama kodunu doğrulayarak etkinleştirir; kurtarma kodları YALNIZCA burada bir kez gösterilir. */
  app.post(
    '/api/auth/mfa/enable',
    { config: limit },
    authedRoute(app, async ({ tx, user, req }) => {
      assertSameOrigin(req, app.config);
      const { code } = codeSchema.parse(req.body);
      guardFails(user.id);
      const row = await getMfa(tx, user.id);
      if (!row) throw unprocessable('Önce kurulumu başlatın', 'MFA_NOT_SETUP');
      if (row.enabledAt) throw unprocessable('İki adımlı doğrulama zaten etkin', 'MFA_ALREADY_ENABLED');
      const counter = verifyTotp(decryptMfaSecret(row.secretEnc, app.config.JWT_SECRET), code, Date.now());
      if (counter === null) {
        app.limiter.hit(failKey(user.id), MFA_WINDOW_MS);
        throw new AppError(400, 'MFA_CODE_INVALID', 'Doğrulama kodu hatalı');
      }
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await tx
        .update(userMfa)
        .set({ enabledAt: new Date(), lastCounter: counter, recoveryHashes: codes.map((c) => sha256(normalizeRecovery(c))) })
        .where(eq(userMfa.userId, user.id));
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_enabled', organizationId: user.orgId, userId: user.id });
      return { recoveryCodes: codes };
    }),
  );

  /** Kapatma: parola + güncel kod (ya da kurtarma kodu) gerekir; çalınmış oturum MFA'yı sessizce kapatamasın. */
  app.post(
    '/api/auth/mfa/disable',
    { config: limit },
    authedRoute(app, async ({ tx, user, req }) => {
      assertSameOrigin(req, app.config);
      const input = disableSchema.parse(req.body);
      guardFails(user.id);
      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      if (!row || !(await verify(row.passwordHash, input.password))) {
        app.limiter.hit(failKey(user.id), MFA_WINDOW_MS);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Mevcut şifre hatalı');
      }
      if (!(await checkMfaCode(tx, app.config.JWT_SECRET, user.id, input.code))) {
        app.limiter.hit(failKey(user.id), MFA_WINDOW_MS);
        throw new AppError(400, 'MFA_CODE_INVALID', 'Doğrulama kodu hatalı');
      }
      await tx.delete(userMfa).where(eq(userMfa.userId, user.id));
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_disabled', organizationId: user.orgId, userId: user.id, meta: { by: user.id } });
      return { ok: true };
    }),
  );

  /** Kurtarma kodlarını yeniler (eskiler geçersizleşir); güncel kod ister. */
  app.post(
    '/api/auth/mfa/recovery-codes',
    { config: limit },
    authedRoute(app, async ({ tx, user, req }) => {
      assertSameOrigin(req, app.config);
      const { code } = codeSchema.parse(req.body);
      guardFails(user.id);
      if (!(await checkMfaCode(tx, app.config.JWT_SECRET, user.id, code))) {
        app.limiter.hit(failKey(user.id), MFA_WINDOW_MS);
        throw new AppError(400, 'MFA_CODE_INVALID', 'Doğrulama kodu hatalı');
      }
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      await tx.update(userMfa).set({ recoveryHashes: codes.map((c) => sha256(normalizeRecovery(c))) }).where(eq(userMfa.userId, user.id));
      await recordSecurityEvent(app.db, app.log, req, { event: 'mfa_recovery_regenerated', organizationId: user.orgId, userId: user.id });
      return { recoveryCodes: codes };
    }),
  );
};

