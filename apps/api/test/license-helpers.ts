import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  DAY_MS,
  activateRequestSchema,
  decodeRequestCode,
  deactivateRequestSchema,
  generateKeyPair,
  heartbeatRequestSchema,
  loadPrivateKey,
  offlineRequestSchema,
  peekEnvelope,
  signToken,
  verifyEnvelope,
  type Envelope,
  type Lease,
  type PublicKeyring,
} from '@erp/license-core';
import type { Sector } from '@erp/shared';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { resetSchema } from '../src/db/reset';
import { LicenseService } from '../src/licensing/service';
import { LicenseServerError, LicenseUnreachableError, type LicenseTransport } from '../src/licensing/transport';
import type { Mailer } from '../src/modules/mail/mailer';
import { storeUpdateOffer } from '../src/modules/system/update-store';

export { DAY_MS };

const OWNER_URL = process.env.TEST_LICENSE_API_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_license_apitest';
const APP_URL = process.env.TEST_LICENSE_API_DATABASE_URL ?? 'postgres://erp_app:erp_app@localhost:5432/erp_license_apitest';
/** Lisans durumuna dokunan tüm test dosyalarını sıraya sokan danışma kilidi (tek satırlık kuruluma özgü tablo). */
const LOCK_KEY = 7_300_101;

/** Test dosyası başına: kilidi al, lisans test veritabanını sıfırla ve migration'ları uygula; dosya bitince bırak. */
export function useLicenseDatabase(): void {
  let lock: pg.Client | null = null;
  beforeAll(async () => {
    lock = new pg.Client({ connectionString: OWNER_URL });
    await lock.connect();
    await lock.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await resetSchema(OWNER_URL);
    await runMigrations(OWNER_URL);
  }, 360_000);
  afterAll(async () => {
    await lock?.end();
  });
}

/** Tablo sahibi rolle kalıcı ham sorgu (lisans test veritabanı). */
export async function licenseOwnerSql(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

/** license_state satırını sıfırlar (tetikleyici yalnızca sahip rolün yetkisiyle geçici kapatılır: test düzeneği). */
export async function resetLicenseState(): Promise<void> {
  await licenseOwnerSql(`
    alter table license_state disable trigger license_state_guard;
    delete from license_state;
    alter table license_state enable trigger license_state_guard;`);
}

// ---- Sahte satıcı -----------------------------------------------------------------------------------------

export interface VendorLicense {
  code: string;
  licenseId: string;
  customer: string;
  kind: Lease['kind'];
  status: Lease['status'];
  sectors: Sector[];
  deviceLimit: number;
  companyLimit: number;
  deviceIdleDays: number;
  validUntil: number;
  leaseDays: number;
  graceDays: number;
  maxActivations: number;
}

interface VendorActivation {
  licenseId: string;
  publicKey: string;
  fingerprint: string;
  lastTs: number;
  active: boolean;
  /** Son kalp atışında bildirilen kullanım sayıları. */
  stats?: { devices: number; companies: number };
}

/**
 * Satıcı sunucusunun bellek içi taklidi (gerçek sunucu apps/license-server testlerinde ve CI uçtan uca testinde sınanır):
 * imza/zarf/nonce/yeniden oynatma/saat kuralları aynıdır, böylece uygulama istemcisi gerçek sözleşmeye karşı sınanır.
 */
export class FakeVendor {
  readonly kid = 'k-test';
  readonly pair = generateKeyPair();
  readonly keyring: PublicKeyring = { keys: { [this.kid]: this.pair.publicKey } };
  readonly licenses = new Map<string, VendorLicense>();
  readonly activations = new Map<string, VendorActivation>();
  readonly calls = { activate: 0, heartbeat: 0, deactivate: 0 };
  /** Bir sonraki çağrıda verilecek hata (ağ kesintisi simülasyonu). */
  failNext: Error | null = null;
  /** Doğruysa tüm çağrılar ağa ulaşılamıyor gibi başarısız olur. */
  offline = false;
  /** Kalp atışı yanıtına eklenecek güncelleme teklifi (uzaktan güncelleme testleri). */
  update: unknown = undefined;
  /** Kalp atışlarında bildirilen platformlar. */
  readonly platforms: (string | undefined)[] = [];

  constructor(readonly clock: { t: number }) {}

  issue(partial: Partial<VendorLicense> = {}): VendorLicense {
    const license: VendorLicense = {
      code: `CODE-${randomUUID().slice(0, 8).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      licenseId: randomUUID(),
      customer: 'Deneme Müşterisi Ltd.',
      kind: 'commercial',
      status: 'active',
      sectors: ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'],
      // Genel testler her girişte yeni bir "tarayıcı" (cihaz) açar; cihaz koltuğu testleri sınırı açıkça verir.
      deviceLimit: 100,
      companyLimit: 5,
      deviceIdleDays: 30,
      validUntil: this.clock.t + 365 * DAY_MS,
      leaseDays: 7,
      graceDays: 14,
      maxActivations: 1,
      ...partial,
    };
    this.licenses.set(license.code, license);
    return license;
  }

  private sign(typ: Lease['typ'], license: VendorLicense, inst: { installationId: string; fingerprint: string }, nonce: string, leaseDays = license.leaseDays): string {
    const now = this.clock.t;
    const lease: Lease = {
      v: 1,
      typ,
      licenseId: license.licenseId,
      customer: license.customer,
      kind: license.kind,
      status: license.status,
      sectors: license.sectors,
      deviceLimit: license.deviceLimit,
      companyLimit: license.companyLimit,
      deviceIdleDays: license.deviceIdleDays,
      validUntil: license.validUntil,
      leaseUntil: Math.min(now + leaseDays * DAY_MS, license.validUntil),
      graceDays: license.graceDays,
      issuedAt: now,
      serverTime: now,
      installationId: inst.installationId,
      fingerprint: inst.fingerprint,
      nonce,
    };
    return signToken(typ, lease, { kid: this.kid, privateKey: loadPrivateKey(this.pair.privateKeyPem) });
  }

  /** Belirtecin imzasını başka bir anahtarla (sahte satıcı) atmak için. */
  forgeSigner() {
    const other = generateKeyPair();
    return { kid: this.kid, privateKey: loadPrivateKey(other.privateKeyPem) };
  }

  private gate(): void {
    if (this.offline) throw new LicenseUnreachableError('Lisans sunucusuna ulaşılamadı (test: ağ kesik)');
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  private skew(ts: number): void {
    if (Math.abs(this.clock.t - ts) > 10 * 60_000) throw new LicenseServerError(400, 'CLOCK_SKEW', 'Sunucu saatiniz doğru değil');
  }

  readonly transport: LicenseTransport = {
    activate: async (body) => {
      this.calls.activate++;
      this.gate();
      const payload = activateRequestSchema.parse(verifyEnvelope('activate', body, body.pub));
      this.skew(payload.ts);
      const license = this.licenses.get(payload.code);
      if (!license) throw new LicenseServerError(404, 'INVALID_CODE', 'Etkinleştirme kodu geçersiz');
      if (license.status === 'revoked') throw new LicenseServerError(403, 'LICENSE_REVOKED', 'Bu lisans iptal edilmiş');
      if (license.status === 'suspended') throw new LicenseServerError(403, 'LICENSE_SUSPENDED', 'Bu lisans askıya alınmış');
      if (license.validUntil < this.clock.t) throw new LicenseServerError(403, 'LICENSE_EXPIRED', 'Bu lisansın süresi dolmuş');
      const existing = this.activations.get(payload.installationId);
      if (existing && existing.publicKey !== body.pub) throw new LicenseServerError(409, 'INSTALLATION_KEY_MISMATCH', 'Kurulum anahtarı uyuşmuyor');
      const activeCount = [...this.activations.values()].filter((a) => a.licenseId === license.licenseId && a.active).length;
      if (!existing?.active && activeCount >= license.maxActivations) {
        throw new LicenseServerError(409, 'ACTIVATION_LIMIT', `Bu lisans en fazla ${license.maxActivations} sunucuda etkinleştirilebilir`);
      }
      this.activations.set(payload.installationId, { licenseId: license.licenseId, publicKey: body.pub, fingerprint: payload.fingerprint, lastTs: 0, active: true });
      return { lease: this.sign('lease', license, payload, payload.nonce) };
    },
    heartbeat: async (env: Envelope) => {
      this.calls.heartbeat++;
      this.gate();
      const claimed = heartbeatRequestSchema.parse(peekEnvelope(env));
      const act = this.activations.get(claimed.installationId);
      if (!act) throw new LicenseServerError(404, 'UNKNOWN_INSTALLATION', 'Bu kurulum tanınmıyor; yeniden etkinleştirin');
      const payload = heartbeatRequestSchema.parse(verifyEnvelope('heartbeat', env, act.publicKey));
      if (!act.active) throw new LicenseServerError(403, 'DEACTIVATED', 'Bu kurulum devre dışı bırakılmış');
      this.skew(payload.ts);
      if (payload.fingerprint !== act.fingerprint) throw new LicenseServerError(409, 'FINGERPRINT_CHANGED', 'Sunucu parmak izi değişti');
      if (payload.ts <= act.lastTs) throw new LicenseServerError(409, 'REPLAY', 'İstek yeniden oynatılmış ya da eski');
      act.lastTs = payload.ts;
      act.stats = payload.stats;
      this.platforms.push(payload.platform);
      const license = [...this.licenses.values()].find((l) => l.licenseId === act.licenseId)!;
      return { lease: this.sign('lease', license, payload, payload.nonce), ...(this.update !== undefined ? { update: this.update } : {}) };
    },
    deactivate: async (env: Envelope) => {
      this.calls.deactivate++;
      this.gate();
      const claimed = deactivateRequestSchema.parse(peekEnvelope(env));
      const act = this.activations.get(claimed.installationId);
      if (!act) throw new LicenseServerError(404, 'UNKNOWN_INSTALLATION', 'Bu kurulum tanınmıyor');
      verifyEnvelope('deactivate', env, act.publicKey);
      act.active = false;
      return { ok: true };
    },
  };

  /** Çevrimdışı istek kodunu satıcı olarak imzalar (yönetim panelindeki işlemin karşılığı). */
  signOffline(requestCode: string, license: VendorLicense, days = 365): string {
    const { payload } = decodeRequestCode(requestCode);
    const req = offlineRequestSchema.parse(payload);
    return this.sign('offline-lease', license, req, req.requestId, days);
  }

  /** Bir kurulum için doğrudan (taşımayı atlayarak) bir kira imzalar: saldırı/kenar durum testleri. */
  signLease(typ: Lease['typ'], license: VendorLicense, inst: { installationId: string; fingerprint: string }, nonce: string, leaseDays?: number): string {
    return this.sign(typ, license, inst, nonce, leaseDays);
  }

  /** Yetkisiz anahtarla imzalanmış (sahte) kira. */
  signForged(license: VendorLicense, inst: { installationId: string; fingerprint: string }, nonce: string): string {
    const now = this.clock.t;
    const lease: Lease = {
      v: 1,
      typ: 'lease',
      licenseId: license.licenseId,
      customer: license.customer,
      kind: license.kind,
      status: 'active',
      sectors: license.sectors,
      deviceLimit: license.deviceLimit,
      companyLimit: license.companyLimit,
      deviceIdleDays: license.deviceIdleDays,
      validUntil: now + 3650 * DAY_MS,
      leaseUntil: now + 3650 * DAY_MS,
      graceDays: 90,
      issuedAt: now,
      serverTime: now,
      installationId: inst.installationId,
      fingerprint: inst.fingerprint,
      nonce,
    };
    return signToken('lease', lease, this.forgeSigner());
  }
}

// ---- Lisans denetimi açık uygulama ---------------------------------------------------------------------------

export interface LicensedApp {
  app: FastifyInstance;
  handle: DbHandle;
  service: LicenseService;
  vendor: FakeVendor;
  clock: { t: number };
  /** Değiştirilebilir sunucu parmak izi (sunucu taşıma/klon simülasyonu). */
  fingerprint: { value: string; strength: 'strong' | 'weak' };
  config: Config;
}

export interface LicensedAppOptions {
  vendor?: FakeVendor;
  clock?: { t: number };
  configOverrides?: Partial<Config>;
  mailer?: Mailer;
  heartbeatIntervalMs?: number;
  noTransport?: boolean;
}

async function createLicensedApp(opts: LicensedAppOptions): Promise<LicensedApp> {
  // Şirketler ve kullanıcılar da lisans sınırlarına girdiği için her senaryo tamamen temiz bir veritabanıyla başlar.
  await resetSchema(OWNER_URL);
  await runMigrations(OWNER_URL);
  const clock = opts.clock ?? { t: Date.now() };
  const vendor = opts.vendor ?? new FakeVendor(clock);
  const fingerprint = { value: 'a'.repeat(64), strength: 'strong' as const };
  const config = { ...loadConfig({ ...process.env, DATABASE_URL: APP_URL, RATE_LIMIT_ENABLED: 'false' }), ...opts.configOverrides };
  const handle = createDb(config.DATABASE_URL, { max: 5 });
  const service = new LicenseService({
    db: handle.db,
    keyring: vendor.keyring,
    enforced: true,
    transport: opts.noTransport ? null : vendor.transport,
    appVersion: 'test',
    now: () => clock.t,
    reloadMs: 0,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    fingerprint: async () => ({ fingerprint: fingerprint.value, strength: fingerprint.strength }),
    platform: config.ERP_KIT_TARGET,
    onUpdateOffer: async (offer) => {
      await storeUpdateOffer(handle.db, vendor.keyring, offer, config.APP_VERSION);
    },
  });
  const app = await buildApp({ db: handle.db, config, logger: false, mailer: opts.mailer, license: { service } });
  await app.ready();
  return { app, handle, service, vendor, clock, fingerprint, config };
}

/**
 * Lisans denetimi AÇIK bir uygulama örneği (lisans test veritabanında, sahte satıcıyla, değiştirilebilir saatle).
 * Bulunduğu `describe` için (ya da `each` ise her test için) taze lisans durumuyla kurulur; `useLicenseDatabase()`
 * dosya başında çağrılmış olmalıdır. Testler `t.ctx` üzerinden erişir.
 */
export function useLicensedApp(opts: LicensedAppOptions & { each?: boolean } = {}): { ctx: LicensedApp } {
  const holder = {} as { ctx: LicensedApp };
  const setup = async () => {
    holder.ctx = await createLicensedApp(opts);
  };
  const teardown = async () => {
    if(holder.ctx){await holder.ctx.app.close();await holder.ctx.handle.close();}
  };
  if (opts.each) {
    beforeEach(setup);
    afterEach(teardown);
  } else {
    beforeAll(setup);
    afterAll(teardown);
  }
  return holder;
}

/**
 * Bir tarayıcı: kendi çerez kavanozu (yenileme + cihaz çerezi) ve kullanıcı aracısı vardır. Her yeni `Browser` yeni bir
 * cihazdır; aynı nesneyle yapılan girişler aynı cihazdır.
 */
export class Browser {
  readonly jar = new Map<string, string>();

  constructor(
    readonly app: FastifyInstance,
    readonly ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  ) {}

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies) {
      if (!c.value) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }

  async post(url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload: payload as object | undefined,
      headers: { 'user-agent': this.ua, ...(this.jar.size ? { cookie: this.cookieHeader() } : {}), ...headers },
    });
    this.absorb(res);
    return res;
  }

  login(email: string, password = 'Sifre-12345-xyz') {
    return this.post('/api/auth/login', { email, password });
  }

  register(name: string) {
    return this.post('/api/auth/register', {
      email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
      password: 'Sifre-12345-xyz',
      fullName: `${name} Kullanıcı`,
      organizationName: `${name} Holding`,
    });
  }

  refresh() {
    return this.post('/api/auth/refresh');
  }

  get deviceCookie(): string | undefined {
    return this.jar.get('erp_device');
  }

  get deviceId(): string | undefined {
    return this.deviceCookie?.split('.')[0];
  }
}
