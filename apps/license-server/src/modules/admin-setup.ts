import { createHash, timingSafeEqual } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { count, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateTotpSecret, otpauthUri, verifyTotp } from '@erp/license-core';
import { audit } from '../audit';
import { decryptSecret, encryptSecret, setupToken } from '../crypto';
import { admins } from '../db/schema';
import { ApiError, badRequest, conflict, unauthorized } from '../errors';
import { startSession } from './admin-auth';

/**
 * İlk yönetici kurulumu (yalnızca hiç yönetici yokken): kurulum kodu + e-posta + parola (iki kez) + TOTP doğrulaması.
 * Kurulum kodu `LICENSE_DATA_KEY`'den türetilir (`cli setup:token`); panel internete açıkken hesabı ilk gelenin kapmasını önler.
 * Bekleyen TOTP sırrı sunucuda tutulmaz: şifreli ve süreli bir blob olarak istemciye verilir, tamamlarken geri gelir.
 */
export const TOTP_ISSUER = 'Muhasebe Lisans';
const PENDING_TTL_MS = 30 * 60_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS_PER_IP = 10;
/** pg_advisory_xact_lock anahtarı: eşzamanlı iki kurulumdan yalnızca biri yönetici oluşturur. */
const SETUP_LOCK = 0x4c494353;

const normalizeToken = (v: string) => v.toUpperCase().replace(/[^A-Z2-7]/g, '');
const digest = (v: string) => createHash('sha256').update(v).digest();

const tokenSchema = z.string().trim().min(1, 'Kurulum kodu gerekli').max(64);

const setupSchema = z
  .object({
    setupToken: tokenSchema,
    email: z.string().trim().toLowerCase().max(254).pipe(z.email('Geçerli bir e-posta adresi girin')),
    fullName: z.string().trim().max(100).optional(),
    password: z.string().min(12, 'Parola en az 12 karakter olmalı').max(200),
    passwordConfirm: z.string().max(200),
    pending: z.string().min(1).max(2000),
    totp: z.string().regex(/^\d{6}$/, 'Doğrulama kodu 6 haneli olmalı'),
  })
  .refine((v) => v.password === v.passwordConfirm, { path: ['passwordConfirm'], message: 'Parolalar eşleşmiyor' });

async function setupNeeded(app: FastifyInstance): Promise<boolean> {
  const [row] = await app.db.select({ n: count() }).from(admins);
  return (row?.n ?? 0) === 0;
}

const setupClosed = () => conflict('Kurulum tamamlanmış; yönetici hesabıyla giriş yapın', 'SETUP_CLOSED');

/** Kurulum kodunu sabit zamanlı karşılaştırır; başarısız denemeler IP başına sınırlanır. */
function checkToken(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, given: string): void {
  const key = `setup-fail:${req.ip}`;
  const wait = app.limiter.blocked(key, MAX_FAILS_PER_IP);
  if (wait > 0) {
    void reply.header('retry-after', String(wait));
    throw new ApiError(429, 'RATE_LIMITED', 'Çok fazla hatalı deneme; lütfen bekleyin');
  }
  const ok = timingSafeEqual(digest(normalizeToken(given)), digest(normalizeToken(setupToken(app.config.LICENSE_DATA_KEY))));
  if (!ok) {
    app.limiter.hit(key, FAIL_WINDOW_MS);
    throw unauthorized('Kurulum kodu hatalı', 'INVALID_SETUP_TOKEN');
  }
}

export const adminSetupRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/api/setup', async () => ({ needed: await setupNeeded(app) }));

  /** 1. adım: kurulum kodunu doğrular ve yeni bir TOTP sırrı üretir (kasaya/uygulamaya eklenmek üzere). */
  app.post('/admin/api/setup/totp', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const input = z.object({ setupToken: tokenSchema, email: z.string().trim().toLowerCase().max(254).optional() }).parse(req.body);
    if (!(await setupNeeded(app))) throw setupClosed();
    checkToken(app, req, reply, input.setupToken);
    const secret = generateTotpSecret();
    const pending = encryptSecret(JSON.stringify({ kind: 'setup-totp', secret, exp: app.now() + PENDING_TTL_MS }), app.config.LICENSE_DATA_KEY);
    return { secret, otpauthUri: otpauthUri(secret, input.email || 'yonetici', TOTP_ISSUER), pending };
  });

  /** 2. adım: hesabı oluşturur (parola iki kez + uygulamadaki ilk kod) ve oturumu açar. */
  app.post('/admin/api/setup', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const input = setupSchema.parse(req.body);
    if (!(await setupNeeded(app))) throw setupClosed();
    checkToken(app, req, reply, input.setupToken);

    let secret: string;
    try {
      const p = JSON.parse(decryptSecret(input.pending, app.config.LICENSE_DATA_KEY)) as { kind?: string; secret?: string; exp?: number };
      if (p.kind !== 'setup-totp' || typeof p.secret !== 'string' || typeof p.exp !== 'number') throw new Error('biçim');
      if (p.exp <= app.now()) throw badRequest('Kurulum süresi doldu; yeni doğrulama anahtarı alın', 'SETUP_EXPIRED');
      secret = p.secret;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw badRequest('Kurulum bilgisi geçersiz; baştan başlayın', 'SETUP_INVALID');
    }
    const counter = verifyTotp(secret, input.totp, app.now());
    if (counter === null) throw badRequest('Doğrulama kodu hatalı; uygulamadaki güncel kodu girin', 'INVALID_TOTP');

    const passwordHash = await hash(input.password);
    const admin = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
      const [row] = await tx.select({ n: count() }).from(admins);
      if ((row?.n ?? 0) > 0) throw setupClosed();
      const [created] = await tx
        .insert(admins)
        .values({
          email: input.email,
          fullName: input.fullName || input.email,
          passwordHash,
          totpSecretEnc: encryptSecret(secret, app.config.LICENSE_DATA_KEY),
          totpLastCounter: counter,
          lastLoginAt: new Date(app.now()),
        })
        .returning({ id: admins.id, email: admins.email, fullName: admins.fullName });
      await audit(tx, { actor: 'admin', adminId: created!.id, action: 'admin.setup', targetType: 'admin', targetId: created!.id, ip: req.ip, meta: { email: input.email } });
      return created!;
    });
    return { admin: await startSession(app, req, reply, admin) };
  });
};
