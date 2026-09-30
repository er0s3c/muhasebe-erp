import { z } from 'zod';

/** Fastify `trustProxy` değeri (bkz. apps/api/src/config.ts): varsayılan false; Caddy arkasında 1. */
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

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  /** Çalışma zamanı rolü (erp_app). */
  DATABASE_URL: z.string().min(1),
  /** Parola ile mühürlenmiş imza anahtarı dosyası (`cli keygen` üretir). */
  LICENSE_SIGNING_KEY_FILE: z.string().min(1).optional(),
  LICENSE_SIGNING_KEY_PASSPHRASE: z.string().min(12).optional(),
  /** Yönetici TOTP sırlarını diskte şifrelemek için ana sır (≥ 32 karakter, rastgele). Kaybolursa TOTP'ler yeniden kurulur. */
  LICENSE_DATA_KEY: z.string().min(32),
  TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
  /** Yönetim paneli çerezi `Secure` bayrağı; varsayılan yalnızca production'da açık. */
  ADMIN_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Yönetim panelinin tarayıcıdaki kökeni (ör. https://lisans.ornek.com): giriş anahtarları (WebAuthn) bu köken ve alan adına
   * bağlanır. Verilmezse istekteki protokol + Host kullanılır (yalnızca geliştirme için).
   */
  LICENSE_ADMIN_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .optional()
    .transform((v) => (v === undefined ? undefined : new URL(v).origin)),
  RATE_LIMIT_ENABLED: flag(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Derlenmiş yönetim paneli (apps/license-admin/dist); verilirse aynı kökenden sunulur. */
  PANEL_DIST_DIR: z.string().optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  APP_VERSION: z.string().default('dev'),
});

export type Config = Omit<z.infer<typeof envSchema>, 'ADMIN_COOKIE_SECURE'> & { ADMIN_COOKIE_SECURE: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) throw new Error(`Geçersiz ortam değişkenleri:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && !c.LICENSE_SIGNING_KEY_FILE) {
    throw new Error('Üretimde LICENSE_SIGNING_KEY_FILE ve LICENSE_SIGNING_KEY_PASSPHRASE gerekli');
  }
  if (c.LICENSE_SIGNING_KEY_FILE && !c.LICENSE_SIGNING_KEY_PASSPHRASE) {
    throw new Error('LICENSE_SIGNING_KEY_FILE verildi ama LICENSE_SIGNING_KEY_PASSPHRASE yok');
  }
  return { ...c, ADMIN_COOKIE_SECURE: c.ADMIN_COOKIE_SECURE ?? c.NODE_ENV === 'production' };
}
