import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');

/**
 * Fastify `trustProxy` değeri: `false` | `true` | IP/CIDR listesi (`10.0.0.0/8,172.16.0.0/12`) ya da `proxy-addr` anahtar
 * sözcükleri (`loopback`, `linklocal`, `uniquelocal`).
 * Varsayılan `false`: uygulama doğrudan internete açıkken `X-Forwarded-For` başlığı sahte IP üretemesin
 * (IP; oran sınırını ve denetim kaydını besler). Ters vekilin (Caddy, nginx, cloudflared) arkasında vekilin adresini
 * kapsayan bir liste verin; Docker Compose kurulumunda `loopback,uniquelocal`.
 *
 * Atlama SAYISI (`1`) kabul edilmez: Fastify ≥ 5.12 sayısal değeri güvenlik gereği hiçbir adrese güvenmeyen bir işleve çevirir
 * (`fastify/lib/request.js`, getTrustProxyFn), yani `X-Forwarded-For` tamamen yok sayılır ve tüm istekler vekilin adresinden
 * gelmiş görünür (oran sınırı tek kovaya düşer, denetim kaydına yanlış IP yazılır). `loadConfig` bunu açık bir hatayla reddeder.
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
    BACKUP_DATABASE_URL: z.string().optional(),
    BACKUP_DIRECTORY: z.string().default('data/backups'),
    BACKUP_PG_BIN: z.string().default(''),
    BACKUP_SIGNING_KEY: z.preprocess(v=>v===''?undefined:v,z.string().min(32).optional()),
    /** Local development only; production uses native PostgreSQL clients. */
    BACKUP_DOCKER_CONTAINER: z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
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
    RATE_LIMIT_STORE: z.enum(['memory','postgres']).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
    /** Yenileme çerezi `Secure` bayrağı; varsayılan yalnızca production'da açık (düz http'de tarayıcı çerezi atar). */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    /** Yeni kuruluş kaydı (`POST /api/auth/register`). Özel kurulumda ilk sahip kaydından sonra kapatılır. */
    REGISTRATION_ENABLED: flag(true),
    /** Aynı anda çalışabilecek dışa aktarma sayısı (bellek içi üretilir; aşılırsa 429 EXPORT_BUSY). */
    EXPORT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    /** Bağlantı havuzu üst sınırı. Havuz dolu ve `DB_CONNECT_TIMEOUT_MS` içinde bağlantı boşalmazsa istek 503 BUSY (Retry-After) alır. */
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    /** Havuzdan bağlantı bekleme üst süresi (ms). */
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    /** Tek bir SQL ifadesi için üst süre (ms); 0 = kapalı. Yavaş bir sorgunun bağlantı havuzunu tıkamasını önler (yük ölçümünde en ağır istek ~2 sn). */
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
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
    CONSTRUCTION_STORAGE_DIR: z.string().default('data/construction'),
    CONSTRUCTION_PYTHON: z.string().default('python'),
    CONSTRUCTION_TESSDATA_DIR: z.string().default('data/construction-runtime/tessdata'),
    CONSTRUCTION_JOBS_ENABLED: flag(true),
    CONSTRUCTION_AI_URL: z.url().startsWith('https://').optional(),
    CONSTRUCTION_AI_KEY: z.string().optional(),
    CONSTRUCTION_AI_MODEL: z.string().default(''),
    /**
     * Lisans sunucusu (satıcı) adresi; verilmezse derlemede gömülen adres kullanılır. Sahte bir sunucu kira üretemez
     * (kiralar derlemeye gömülü satıcı anahtarıyla doğrulanır); yine de üretimde https zorunludur.
     */
    LICENSE_SERVER_URL: z.string().url().optional(),
    /** Yalnızca test düzenekleri için: üretimde düz http lisans sunucusu adresine izin verir. */
    LICENSE_ALLOW_INSECURE_URL: flag(false),
    /** Ana makine kimliği dosyası (compose, ana makinenin /etc/machine-id dosyasını salt-okunur bağlar). */
    LICENSE_HOST_ID_FILE: z.string().optional(),
    /** Kurulum kitinin hedefi (sihirbaz yazar): uzaktan güncellemede hangi arşivin teklif edileceğini belirler. */
    ERP_KIT_TARGET: z.enum(['linux-x64', 'win-x64']).optional(),
    /** Ana makinedeki güncelleyicinin uygulamayla konuştuğu paylaşılan gizli belirteç (sihirbaz üretir); yoksa uzaktan güncelleme kapalı. */
    ERP_UPDATER_TOKEN: z.string().min(32).optional(),
    /** YALNIZCA geliştirme/test: üretim dışı ortamda lisans denetimini açar (üretim paketinde zaten her zaman açıktır). */
    LICENSE_ENFORCEMENT_DEV: flag(false),
    /** YALNIZCA geliştirme/test: pakete gömülü halka yokken kullanılacak açık anahtar halkası (JSON). Üretimde yok sayılır/reddedilir. */
    LICENSE_DEV_KEYRING: z.string().optional(),
    /**
     * Bildirim zamanlayıcısı (docs/OPERATIONS.md §9b): her şirkete ayrı işlemde ve kendi RLS bağlamıyla uygulama içi bildirimleri üretir/çözer,
     * kapanmış eski bildirimleri budar ve (SMTP açıksa, kullanıcı istediyse) günde en çok bir e-posta özeti gönderir. Testlerde süreç
     * başlatılmaz (zamanlayıcıyı yalnızca server.ts başlatır).
     */
    NOTIFY_ENABLED: flag(true),
    NOTIFY_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
    /** Okunmuş/kapatılmış/çözülmüş bildirimlerin saklama süresi (gün). */
    NOTIFY_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    /** E-posta özetinin gönderileceği ilk yerel saat (Europe/Nicosia, 0–23). */
    NOTIFY_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
    /** Sürüm etiketi (imaj derlemesinde verilir); destek için `/api/public-config` döndürür. */
    APP_VERSION: z.string().default('dev'),
  })
  .superRefine((env, ctx) => {
    if (typeof env.TRUST_PROXY === 'number') {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'Sayısal TRUST_PROXY (atlama sayısı) Fastify 5\'te yok sayılır; vekilin adresini kapsayan bir liste verin (Docker Compose için: loopback,uniquelocal) ya da vekil yoksa false',
      });
    }
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
    if (env.NODE_ENV === 'production' && env.LICENSE_DEV_KEYRING) {
      ctx.addIssue({ code: 'custom', path: ['LICENSE_DEV_KEYRING'], message: 'LICENSE_DEV_KEYRING yalnızca geliştirme içindir; üretimde kullanılamaz' });
    }
    if (env.NODE_ENV === 'production' && env.LICENSE_SERVER_URL?.startsWith('http://') && !env.LICENSE_ALLOW_INSECURE_URL) {
      ctx.addIssue({ code: 'custom', path: ['LICENSE_SERVER_URL'], message: 'Üretimde lisans sunucusu adresi https olmalı' });
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
    RATE_LIMIT_STORE: env.RATE_LIMIT_STORE ?? (env.NODE_ENV==='production'?'postgres':'memory'),
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
