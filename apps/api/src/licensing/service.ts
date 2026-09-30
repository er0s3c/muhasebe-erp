import { randomBytes } from 'node:crypto';
import {
  CLOCK_SKEW_MS,
  DAY_MS,
  LicenseTokenError,
  encodeRequestCode,
  evaluateLease,
  loadPrivateKey,
  nextHighWater,
  parseLeaseToken,
  signEnvelope,
  type Lease,
  type LeaseEvaluation,
  type LicenseState,
  type PublicKeyring,
  type RestrictedReason,
} from '@erp/license-core';
import type { Sector } from '@erp/shared';
import type { Db } from '../db/client';
import { AppError } from '../http/errors';
import { serverFingerprint, type ServerFingerprint } from './fingerprint';
import { LicenseServerError, LicenseUnreachableError, type LicenseTransport } from './transport';
import { LicenseStore, type LicenseRow } from './store';

/** `evaluateLease` nedenlerine ek olarak: veritabanındaki kira imzası/biçimi doğrulanamadı (kurcalanmış ya da bozuk). */
export type LicenseReason = RestrictedReason | 'invalid_lease';

export interface LicenseSnapshot {
  /** Bu süreçte lisans denetimi açık mı (üretim paketinde her zaman true). */
  enforced: boolean;
  state: LicenseState;
  reason?: LicenseReason;
  lease: Lease | null;
  activeUntil?: number;
  graceUntil?: number;
  daysUntilExpiry?: number;
  expiresSoon: boolean;
  installationId: string;
  fingerprintStrength: ServerFingerprint['strength'];
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastError: { code: string; message: string } | null;
  pendingOfflineRequest: boolean;
  serverConfigured: boolean;
}

export interface LicenseLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface LicenseServiceOptions {
  db: Db;
  keyring: PublicKeyring;
  enforced: boolean;
  /** Satıcı sunucusu; null ise yalnızca çevrimdışı etkinleştirme mümkündür. */
  transport: LicenseTransport | null;
  appVersion: string;
  hostIdFile?: string;
  now?: () => number;
  log?: LicenseLogger;
  /** Veritabanı durumunun bellekteki kopyasının en çok ne kadar eski kalabileceği (ms). */
  reloadMs?: number;
  /** Kalp atışı aralığı (ms); varsayılan 12 saat ± %10. */
  heartbeatIntervalMs?: number;
  /** Testler: parmak izini belirler. */
  fingerprint?: () => Promise<ServerFingerprint>;
  /** Kalp atışında satıcıya giden kullanım sayıları (yalnızca sayı). */
  stats?: () => Promise<{ devices: number; companies: number }>;
}

const HEARTBEAT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RETRY_AFTER_CHECK_MS = 30 * 60 * 1000;
const HIGH_WATER_PERSIST_MS = 60_000;
const SCHEDULER_TICK_MS = 10 * 60 * 1000;

const newNonce = () => randomBytes(16).toString('base64url');

const consoleLog: LicenseLogger = {
  warn: (o, m) => console.warn(m ?? '', o),
  error: (o, m) => console.error(m ?? '', o),
  info: (o, m) => console.info(m ?? '', o),
};

/**
 * Kuruluma ait lisans durumu ve satıcıyla iletişim. Bellekteki görüntü, veritabanındaki imzalı kiradan türetilir;
 * her okunuşta (en geç `reloadMs` aralıkla) imza yeniden doğrulanır, bu yüzden veritabanında kira düzenlemek işe yaramaz.
 */
export class LicenseService {
  readonly enforced: boolean;
  private readonly store: LicenseStore;
  private readonly keyring: PublicKeyring;
  private readonly transport: LicenseTransport | null;
  private readonly now: () => number;
  private readonly log: LicenseLogger;
  private readonly reloadMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly appVersion: string;
  private readonly fingerprintProvider: () => Promise<ServerFingerprint>;
  private readonly statsProvider: () => Promise<{ devices: number; companies: number }>;

  private row: LicenseRow | null = null;
  private lease: Lease | null = null;
  private leaseInvalid = false;
  private fp: ServerFingerprint | null = null;
  private highWater = 0;
  private persistedHighWater = 0;
  private loadedAtReal = 0;
  private initPromise: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: LicenseServiceOptions) {
    this.enforced = opts.enforced;
    this.store = new LicenseStore(opts.db);
    this.keyring = opts.keyring;
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? consoleLog;
    this.reloadMs = opts.reloadMs ?? 60_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? Math.round(HEARTBEAT_INTERVAL_MS * (0.9 + Math.random() * 0.2));
    this.appVersion = opts.appVersion.slice(0, 40);
    this.fingerprintProvider = opts.fingerprint ?? (() => serverFingerprint(opts.db, opts.hostIdFile));
    this.statsProvider =
      opts.stats ??
      (async () => ({
        devices: await this.store.activeDeviceCount(this.now() - (this.lease?.deviceIdleDays ?? 30) * DAY_MS),
        companies: await this.store.companyCount(),
      }));
  }

  // ---- Durum ----------------------------------------------------------------------------------------------

  /** Hizmetin saati (testlerde enjekte edilir); cihaz koltuğu boşta hesabı da bunu kullanır. */
  clock(): number {
    return this.now();
  }

  /** Başlangıçta bir kez çağrılır (idempotent): kurulum kimliğini oluşturur, kirayı yükler. */
  init(): Promise<void> {
    this.initPromise ??= this.reload().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** Veritabanı durumunu yeniden okur ve kira imzasını yeniden doğrular. */
  async reload(): Promise<void> {
    const row = await this.store.loadOrCreate();
    const fp = await this.fingerprintProvider();
    if (this.fp === null && fp.strength === 'weak') {
      this.log.warn({}, 'Ana makine kimliği okunamadı: sunucu parmak izi yalnızca veritabanı kümesine bağlı (klon koruması zayıf). LICENSE_HOST_ID_FILE ile /etc/machine-id bağlayın');
    }
    let lease: Lease | null = null;
    let invalid = false;
    if (row.leaseToken) {
      try {
        lease = parseLeaseToken(row.leaseToken, this.keyring);
      } catch (err) {
        if (!(err instanceof LicenseTokenError)) throw err;
        invalid = true;
        if (!this.leaseInvalid) this.log.warn({ code: err.code }, 'Veritabanındaki lisans kirası doğrulanamadı; salt-okunur moda geçildi');
      }
    }
    this.row = row;
    this.fp = fp;
    this.lease = lease;
    this.leaseInvalid = invalid;
    this.highWater = Math.max(this.highWater, row.highWater, lease?.serverTime ?? 0);
    this.persistedHighWater = Math.max(this.persistedHighWater, row.highWater);
    this.loadedAtReal = Date.now();
  }

  /** Güncel durum; bellekteki kopya eskiyse önce veritabanından tazelenir. */
  async current(): Promise<LicenseSnapshot> {
    await this.init();
    if (Date.now() - this.loadedAtReal >= this.reloadMs) {
      // Süre dolunca eşzamanlı isteklerin hepsi ayrı okuma yapmasın (yazmadan sonraki açık `reload()` çağrıları paylaşılmaz)
      this.refreshing ??= this.reload().finally(() => {
        this.refreshing = null;
      });
      await this.refreshing;
    }
    return this.snapshot();
  }

  private snapshot(): LicenseSnapshot {
    const row = this.row!;
    const fp = this.fp!;
    const now = this.now();
    const ev: Omit<LeaseEvaluation, 'reason'> & { reason?: LicenseReason } = this.leaseInvalid
      ? { state: 'restricted', reason: 'invalid_lease', expiresSoon: false }
      : evaluateLease(this.lease, { now, highWater: this.highWater, installationId: row.installationId, fingerprint: fp.fingerprint });

    // En yüksek görülen zaman yalnızca ileri gider; belirli aralıklarla kalıcı hale getirilir (yeniden başlatmada sıfırlanmasın).
    this.highWater = nextHighWater(this.highWater, now, this.lease?.serverTime);
    if (this.highWater - this.persistedHighWater >= HIGH_WATER_PERSIST_MS) {
      const hw = this.highWater;
      this.persistedHighWater = hw;
      void this.store.bumpHighWater(hw).catch((err) => this.log.warn({ err }, 'saat işareti kaydedilemedi'));
    }

    return {
      enforced: this.enforced,
      state: ev.state,
      reason: ev.reason,
      lease: this.lease,
      activeUntil: ev.activeUntil,
      graceUntil: ev.graceUntil,
      daysUntilExpiry: ev.daysUntilExpiry,
      expiresSoon: ev.expiresSoon,
      installationId: row.installationId,
      fingerprintStrength: fp.strength,
      lastCheckAt: row.lastCheckAt?.getTime() ?? null,
      lastSuccessAt: row.lastSuccessAt?.getTime() ?? null,
      lastError: row.lastErrorCode ? { code: row.lastErrorCode, message: row.lastError ?? '' } : null,
      pendingOfflineRequest: Boolean(row.pendingRequestId),
      serverConfigured: this.transport !== null,
    };
  }

  /** Satıcıya raporlanan ve yönetici ekranında gösterilen kullanım sayıları (yalnızca sayı). */
  async usage(): Promise<{ companies: number; devices: number }> {
    return this.statsProvider();
  }

  /**
   * Yeni şirket açarken geçerli kurallar (lisansın sektörleri ve şirket sınırı). Denetim kapalıyken null.
   * Lisans yoksa 402 verir.
   */
  async companyRules(): Promise<{ sectors: readonly Sector[]; companyLimit: number } | null> {
    if (!this.enforced) return null;
    const snap = await this.current();
    if (!snap.lease) throw new AppError(402, 'LICENSE_REQUIRED', 'Bu kurulumun lisansı etkinleştirilmemiş', { state: snap.state, reason: snap.reason });
    return { sectors: snap.lease.sectors, companyLimit: snap.lease.companyLimit };
  }

  /** Kurulumda şirket sektörü lisansın kapsamında mı? (Denetim kapalıyken ya da geçerli kira yokken true.) */
  sectorAllowed(snap: LicenseSnapshot, sector: string): boolean {
    if (!snap.enforced || !snap.lease) return true;
    return (snap.lease.sectors as readonly string[]).includes(sector);
  }

  // ---- Etkinleştirme ve yenileme ---------------------------------------------------------------------------

  /** Seri çalıştırır: etkinleştirme, kalp atışı ve devre dışı bırakma aynı anda çakışmasın. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireTransport(): LicenseTransport {
    if (!this.transport) {
      throw new AppError(409, 'LICENSE_SERVER_NOT_CONFIGURED', 'Lisans sunucusu adresi tanımlı değil; çevrimdışı etkinleştirmeyi kullanın ya da LICENSE_SERVER_URL ayarlayın');
    }
    return this.transport;
  }

  private async fresh(): Promise<{ row: LicenseRow; fp: ServerFingerprint; key: ReturnType<typeof loadPrivateKey> }> {
    await this.init();
    await this.reload();
    return { row: this.row!, fp: this.fp!, key: loadPrivateKey(this.row!.privateKeyPem) };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LicenseServerError) {
        await this.recordFailure(err.code, err.message);
        throw new AppError(err.status === 429 ? 429 : 422, err.code, err.message);
      }
      if (err instanceof LicenseUnreachableError) {
        await this.recordFailure('LICENSE_SERVER_UNREACHABLE', err.message);
        throw new AppError(502, 'LICENSE_SERVER_UNREACHABLE', err.message);
      }
      throw err;
    }
  }

  private async recordFailure(code: string, message: string): Promise<void> {
    try {
      await this.store.recordFailure(code, message, this.now());
      await this.reload();
    } catch (err) {
      this.log.warn({ err }, 'lisans denetim hatası kaydedilemedi');
    }
  }

  /**
   * Satıcıdan gelen ya da yapıştırılan kirayı doğrular ve kaydeder: imza, tür, bu kuruluma ve bu sunucuya bağlılık,
   * isteğe ait nonce, saat uyumu ve (daha eski bir kiranın yenisinin yerine geçmemesi) kontrol edilir.
   */
  private async accept(token: string, expect: { typ: Lease['typ']; nonce: string }): Promise<void> {
    const row = this.row!;
    const fp = this.fp!;
    let lease: Lease;
    try {
      lease = parseLeaseToken(token, this.keyring);
    } catch (err) {
      if (err instanceof LicenseTokenError) {
        const hint = Object.keys(this.keyring.keys).length === 0 ? 'Bu derlemede güvenilir satıcı anahtarı yok' : 'İmza doğrulanamadı';
        throw new AppError(422, 'LICENSE_INVALID', `Lisans geçersiz: ${hint}`);
      }
      throw err;
    }
    if (lease.typ !== expect.typ || lease.nonce !== expect.nonce) {
      throw new AppError(422, 'LICENSE_INVALID', 'Lisans bu isteğe ait değil (yeniden oynatılmış ya da yanlış tür)');
    }
    if (lease.installationId !== row.installationId || lease.fingerprint !== fp.fingerprint) {
      throw new AppError(422, 'LICENSE_NOT_FOR_THIS_SERVER', 'Bu lisans bu sunucu için verilmemiş');
    }
    const now = this.now();
    const skewMsg = 'Sunucu saatiniz lisans sunucusunun saatinden çok farklı; saati düzeltip yeniden deneyin';
    if (lease.serverTime > now + CLOCK_SKEW_MS) throw new AppError(422, 'CLOCK_SKEW', skewMsg);
    if (expect.typ === 'lease' && lease.serverTime < now - CLOCK_SKEW_MS) throw new AppError(422, 'CLOCK_SKEW', skewMsg);
    if (this.lease && lease.issuedAt < this.lease.issuedAt) {
      throw new AppError(422, 'LICENSE_STALE', 'Bu lisans, sunucudaki mevcut lisanstan daha eski');
    }
    await this.store.saveLease(token, nextHighWater(this.highWater, now, lease.serverTime), now);
    await this.reload();
  }

  /** Etkinleştirme kodunu satıcıya gönderir; dönen imzalı kirayı kaydeder. */
  activate(code: string): Promise<LicenseSnapshot> {
    return this.exclusive(async () => {
      const transport = this.requireTransport();
      const { row, fp, key } = await this.fresh();
      const nonce = newNonce();
      const env = signEnvelope(
        'activate',
        { installationId: row.installationId, fingerprint: fp.fingerprint, appVersion: this.appVersion, code, nonce, ts: this.now() },
        key,
      );
      const res = await this.call(() => transport.activate({ ...env, pub: row.publicKey }));
      await this.accept(res.lease, { typ: 'lease', nonce });
      return this.snapshot();
    });
  }

  /** Kalp atışı: satıcıdan yeni kira (ya da imzalı iptal/askı bildirimi) alır. */
  heartbeat(): Promise<LicenseSnapshot> {
    return this.exclusive(async () => {
      const transport = this.requireTransport();
      const { row, fp, key } = await this.fresh();
      if (!row.leaseToken) throw new AppError(409, 'NOT_ACTIVATED', 'Bu kurulum henüz etkinleştirilmemiş');
      const nonce = newNonce();
      const stats = await this.statsProvider();
      const env = signEnvelope(
        'heartbeat',
        { installationId: row.installationId, fingerprint: fp.fingerprint, appVersion: this.appVersion, nonce, ts: this.now(), stats },
        key,
      );
      const res = await this.call(() => transport.heartbeat(env));
      await this.accept(res.lease, { typ: 'lease', nonce });
      return this.snapshot();
    });
  }

  /** Çevrimdışı etkinleştirme: satıcıya iletilecek istek kodunu üretir ve isteği kaydeder. */
  offlineRequest(): Promise<{ requestCode: string }> {
    return this.exclusive(async () => {
      const { row, fp } = await this.fresh();
      const requestId = newNonce();
      const requestCode = encodeRequestCode(
        { installationId: row.installationId, fingerprint: fp.fingerprint, appVersion: this.appVersion, requestId, ts: this.now() },
        row.privateKeyPem,
      );
      await this.store.setPendingRequest(requestId, this.now());
      await this.reload();
      return { requestCode };
    });
  }

  /** Satıcının çevrimdışı imzaladığı kirayı uygular (yalnızca bekleyen istek kimliğiyle eşleşirse). */
  offlineActivate(token: string): Promise<LicenseSnapshot> {
    return this.exclusive(async () => {
      const { row } = await this.fresh();
      if (!row.pendingRequestId) throw new AppError(409, 'NO_PENDING_REQUEST', 'Önce bir istek kodu oluşturun');
      await this.accept(token.trim(), { typ: 'offline-lease', nonce: row.pendingRequestId });
      return this.snapshot();
    });
  }

  /** Bu sunucunun lisans bağını kaldırır (sunucu taşıma): satıcıya bildirilir, yerel kira silinir. */
  deactivate(): Promise<LicenseSnapshot> {
    return this.exclusive(async () => {
      const transport = this.requireTransport();
      const { row, key } = await this.fresh();
      if (!row.leaseToken) throw new AppError(409, 'NOT_ACTIVATED', 'Bu kurulum etkinleştirilmemiş');
      const env = signEnvelope('deactivate', { installationId: row.installationId, nonce: newNonce(), ts: this.now() }, key);
      try {
        await this.call(() => transport.deactivate(env));
      } catch (err) {
        // Satıcı bu kurulumu zaten tanımıyor/devre dışı bırakmışsa yerel bağı kaldırmak doğrudur.
        const gone = err instanceof AppError && (err.code === 'UNKNOWN_INSTALLATION' || err.code === 'DEACTIVATED');
        if (!gone) throw err;
      }
      await this.store.clearLease(this.now());
      await this.reload();
      return this.snapshot();
    });
  }

  // ---- Kalp atışı zamanlayıcısı -----------------------------------------------------------------------------

  /** Şimdi kalp atışı gerekli mi? (Son başarıdan beri aralık doldu ya da kira bozuk; son denemeden sonra 30 dk beklenir.) */
  async shouldHeartbeat(): Promise<boolean> {
    if (!this.transport) return false;
    await this.init();
    await this.reload();
    const row = this.row!;
    if (!row.leaseToken) return false;
    const now = this.now();
    if (now - (row.lastCheckAt?.getTime() ?? 0) < RETRY_AFTER_CHECK_MS) return false;
    if (this.leaseInvalid) return true;
    return now - (row.lastSuccessAt?.getTime() ?? 0) >= this.heartbeatIntervalMs;
  }

  /** Arka planda düzenli kalp atışı (kapatmayı engellemez). Dönen işlev zamanlayıcıyı durdurur. */
  startScheduler(): () => void {
    const tick = async () => {
      try {
        if (await this.shouldHeartbeat()) {
          const snap = await this.heartbeat();
          this.log.info({ state: snap.state }, 'lisans kalp atışı tamam');
        }
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : err }, 'lisans kalp atışı başarısız (mevcut kira geçerli olduğu sürece çalışmaya devam eder)');
      }
    };
    const first = setTimeout(() => void tick(), 5_000 + Math.random() * 25_000);
    const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
