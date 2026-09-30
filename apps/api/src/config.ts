import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');

/**
 * Fastify `trustProxy` değeri: `false` | `true` | atlama sayısı (`1`) | IP/CIDR listesi (`10.0.0.0/8,172.16.0.0/12`).
 * Varsayılan `false`: uygulama doğrudan internete açıkken `X-Forwarded-For` başlığı sahte IP üretemesin
 * (IP; oran sınırını ve denetim kaydını besler). Ters vekilin (Caddy, nginx) arkasında `1` verin.
 */
export function parseTrustProxy(value: string): boolean | number | string[] {
  const v = value.trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Üretimde kabul edilmeyen, örnek/geliştirme amaçlı gizli anahtar kalıpları. */
const WEAK_SECRET = /dev-only|change-me|example|test-secret|ci-only|password|secret-secret/i;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    /** Çalışma zamanı bağlantısı (RLS'e tabi rol). Sahip rolünün bağlantısı buraya konmaz. */
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET en az 32 karakter olmalı'),
    /**
     * İzinli tarayıcı kökenleri (virgülle). Üretimde web arayüzü API ile aynı kökenden sunulduğundan
     * boş bırakılır (CORS eklentisi kaydedilmez); geliştirmede varsayılan Vite adresidir.
     */
    CORS_ORIGIN: z.string().optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
    /** Yenilemeyle uzasa da bir oturumun (ilk girişten itibaren) mutlak ömrü. */
    SESSION_MAX_DAYS: z.coerce.number().int().min(1).default(90),
    /** Testlerde kapatılır. */
    RATE_LIMIT_ENABLED: flag(true),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
    /** Yenileme çerezi `Secure` bayrağı; varsayılan yalnızca production'da açık (düz http'de tarayıcı çerezi atar). */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    /** Yeni kuruluş kaydı (`POST /api/auth/register`). Özel kurulumda ilk sahip kaydından sonra kapatılır. */
    REGISTRATION_ENABLED: flag(true),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    /** 0 = kapalı. Yavaş bir sorgunun bağlantı havuzunu tıkamasını önler; değer yük ölçümünden sonra ayarlanır. */
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
    /**
     * Giden posta (parola sıfırlama, e-posta doğrulama). `SMTP_URL` (örn. smtps://kullanici:parola@smtp.ornek.com:465)
     * verilirse gönderim açılır; TLS sertifikası doğrulanır. `MAIL_TRANSPORT=log` yalnızca geliştirme içindir:
     * bağlantıları günlüğe yazar (üretimde reddedilir).
     */
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).optional(),
    /** E-postalardaki bağlantıların kökü (örn. https://erp.ornek.com); posta açıkken üretimde zorunlu. */
    APP_BASE_URL: z.string().url().optional(),
    /** Derlenmiş web arayüzü klasörü (apps/web/dist); verilirse API aynı kökenden arayüzü de sunar. */
    WEB_DIST_DIR: z.string().optional(),
    /** Sürüm etiketi (imaj derlemesinde verilir); destek için `/api/public-config` döndürür. */
    APP_VERSION: z.string().default('dev'),
  })
  .superRefine((env, ctx) => {
    if (env.SMTP_URL && !env.MAIL_FROM) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'SMTP_URL verildiğinde MAIL_FROM (gönderen adresi) gerekli' });
    }
    if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'log') {
      ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: "MAIL_TRANSPORT=log üretimde kullanılamaz (bağlantıları günlüğe yazar)" });
    }
    const mailOn = Boolean(env.SMTP_URL) || env.MAIL_TRANSPORT === 'log';
    if (env.NODE_ENV === 'production' && mailOn && !env.APP_BASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'Posta açıkken APP_BASE_URL (bağlantı kökü) gerekli' });
    }
    if (env.NODE_ENV === 'production' && WEAK_SECRET.test(env.JWT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'Üretimde örnek/geliştirme JWT_SECRET değeri kullanılamaz; rastgele üretin (ör. openssl rand -base64 48)',
      });
    }
  })
  .transform((env) => ({
    ...env,
    MAIL_MODE: (env.MAIL_TRANSPORT === 'log' ? 'log' : env.SMTP_URL ? 'smtp' : 'off') as 'smtp' | 'log' | 'off',
    APP_BASE_URL: (env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    CORS_ORIGIN: (env.CORS_ORIGIN ?? (env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Boş değer = tanımsız (docker compose `${DEĞİŞKEN:-}` ile boş string geçirir)
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new Error(`Geçersiz ortam değişkenleri:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
