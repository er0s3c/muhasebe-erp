import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { DAY_MS } from '@erp/license-core';
import type { Db, Tx } from '../db/client';
import { devices, refreshTokens, users } from '../db/schema';
import { AppError } from '../http/errors';
import { recordSecurityEvent } from '../modules/auth/events';
import type { LicenseService } from './service';

/** Cihaz çerezi (`<kimlik>.<gizli değer>`); yalnızca oturum uçlarına gider. */
export const DEVICE_COOKIE = 'erp_device';
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60; // tarayıcıların üst sınırı
const COOKIE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Kullanıcı aracısından insan okur bir ad ("Chrome · Windows"). */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Bilinmeyen cihaz';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Tarayıcı';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

const limitError = (limit: number) =>
  new AppError(
    403,
    'DEVICE_LIMIT_REACHED',
    `Lisansınız en fazla ${limit} cihaza izin veriyor. Bu cihazı eklemek için yöneticinizden (Ayarlar › Cihazlar) kullanılmayan bir cihazı kaldırmasını isteyin.`,
    { limit },
  );

export type DeviceStatus = 'active' | 'idle' | 'revoked';

export interface DeviceView {
  id: string;
  name: string;
  userAgent: string | null;
  ip: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUser: { email: string; fullName: string } | null;
  status: DeviceStatus;
  current: boolean;
  revokedAt: string | null;
}

export interface DeviceServiceOptions {
  db: Db;
  license: LicenseService;
  log: FastifyBaseLogger;
  cookieSecure: boolean;
  /** İptal edilmiş cihaz denetiminin bellek önbelleği süresi (ms); varsayılan 30 sn. */
  cacheMs?: number;
}

/**
 * Cihaz koltukları. Bir "cihaz", sunucunun ilk girişte kaydettiği bir tarayıcı/bilgisayardır (çerez). Koltuk sayılan cihazlar:
 * iptal edilmemiş ve son `deviceIdleDays` içinde görülmüş olanlar. Yeni cihaz, koltuk boşsa kaydolur; koltuklar
 * bir danışma kilidiyle seri sayıldığından son koltuk için eşzamanlı girişlerde yalnızca biri kazanır.
 */
export class DeviceService {
  private readonly cache = new Map<string, { ok: boolean; exp: number }>();
  private readonly cacheMs: number;

  constructor(private readonly opts: DeviceServiceOptions) {
    this.cacheMs = opts.cacheMs ?? 30_000;
  }

  private get license() {
    return this.opts.license;
  }

  private parseCookie(req: FastifyRequest): { id: string; secret: string } | null {
    const m = COOKIE_RE.exec(req.cookies?.[DEVICE_COOKIE] ?? '');
    return m ? { id: m[1]!, secret: m[2]! } : null;
  }

  private setCookie(reply: FastifyReply, id: string, secret: string) {
    void reply.setCookie(DEVICE_COOKIE, `${id}.${secret}`, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.opts.cookieSecure,
      path: '/api/auth',
      maxAge: COOKIE_MAX_AGE_S,
    });
  }

  private async countActive(tx: Tx | Db, cutoff: Date, excludeId?: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(isNull(devices.revokedAt), gte(devices.lastSeenAt, cutoff), excludeId ? ne(devices.id, excludeId) : undefined));
    return Number(row?.n ?? 0);
  }

  /**
   * Oturum açan/yenileyen isteğin cihazını doğrular ya da kaydeder. Denetim kapalıyken null.
   * Bilinen ve koltuk sayan cihaz her zaman geçer; bilinmeyen ya da boşta kalmış cihaz boş koltuk ister (DEVICE_LIMIT_REACHED).
   */
  async ensureForRequest(req: FastifyRequest, reply: FastifyReply, userId?: string | null): Promise<{ id: string; created: boolean } | null> {
    if (!this.license.enforced) return null;
    const snap = await this.license.current();
    // Geçerli kira yoksa (bozuk kayıt) koltuk sınırı bilinmez: yeni cihaz alınmaz, bilinenler devam eder.
    const limit = snap.lease?.deviceLimit ?? 0;
    const idleDays = snap.lease?.deviceIdleDays ?? 30;
    const now = this.license.clock();
    const cutoff = new Date(now - idleDays * DAY_MS);
    const cookie = this.parseCookie(req);
    const ua = req.headers['user-agent']?.slice(0, 300) ?? null;

    let result: { id: string; created: boolean; secret: string };
    try {
      result = await this.opts.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('erp-license-device-seats'))`);
        let known: typeof devices.$inferSelect | undefined;
        if (cookie) {
          const [row] = await tx.select().from(devices).where(eq(devices.id, cookie.id));
          if (row && !row.revokedAt && safeEqual(row.secretHash, sha256(cookie.secret))) known = row;
        }
        const others = await this.countActive(tx, cutoff, known?.id);
        if (known) {
          // Koltuk sayan cihaz, sınır sonradan düşürülse bile çalışmaya devam eder; boşta kalmış cihaz dönerken boş koltuk ister.
          if (known.lastSeenAt < cutoff && others >= limit) throw limitError(limit);
          await tx
            .update(devices)
            .set({ lastSeenAt: new Date(now), ip: req.ip, userAgent: ua, ...(userId ? { lastUserId: userId } : {}) })
            .where(eq(devices.id, known.id));
          return { id: known.id, created: false, secret: cookie!.secret };
        }
        if (others >= limit) throw limitError(limit);
        const secret = randomBytes(32).toString('base64url');
        const [row] = await tx
          .insert(devices)
          .values({
            secretHash: sha256(secret),
            name: deviceLabel(ua),
            userAgent: ua,
            ip: req.ip,
            firstSeenAt: new Date(now),
            lastSeenAt: new Date(now),
            lastUserId: userId ?? null,
          })
          .returning({ id: devices.id });
        return { id: row!.id, created: true, secret };
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'DEVICE_LIMIT_REACHED') {
        await recordSecurityEvent(this.opts.db, this.opts.log, req, { event: 'device_limit_reached', userId: userId ?? null, meta: { limit } });
      }
      throw err;
    }
    this.setCookie(reply, result.id, result.secret);
    this.cache.set(result.id, { ok: true, exp: Date.now() + this.cacheMs });
    if (result.created) {
      await recordSecurityEvent(this.opts.db, this.opts.log, req, { event: 'device_registered', userId: userId ?? null, meta: { deviceId: result.id } });
    }
    return { id: result.id, created: result.created };
  }

  /** Kayıt sırasında (kullanıcı cihazdan sonra oluştuğu için) cihazın son kullanıcısını işler. */
  async setLastUser(deviceId: string, userId: string): Promise<void> {
    await this.opts.db.update(devices).set({ lastUserId: userId }).where(eq(devices.id, deviceId));
  }

  /** Erişim belirtecindeki cihaz hâlâ geçerli mi? (İptal edilmiş cihazın belirteci en geç önbellek süresi içinde ölür.) */
  async isActive(deviceId: string): Promise<boolean> {
    const hit = this.cache.get(deviceId);
    if (hit && hit.exp > Date.now()) return hit.ok;
    const [row] = await this.opts.db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId));
    const ok = Boolean(row) && !row!.revokedAt;
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(deviceId, { ok, exp: Date.now() + this.cacheMs });
    return ok;
  }

  private statusOf(row: { revokedAt: Date | null; lastSeenAt: Date }, cutoff: Date): DeviceStatus {
    return row.revokedAt ? 'revoked' : row.lastSeenAt >= cutoff ? 'active' : 'idle';
  }

  /** Bu kuruluşun kullanıcılarının (ya da henüz kimse girmemiş) cihazları. */
  async list(orgId: string, currentDeviceId?: string | null): Promise<{ limit: number | null; active: number; devices: DeviceView[] }> {
    const snap = await this.license.current();
    const cutoff = new Date(this.license.clock() - (snap.lease?.deviceIdleDays ?? 30) * DAY_MS);
    const rows = await this.opts.db
      .select({
        id: devices.id,
        name: devices.name,
        userAgent: devices.userAgent,
        ip: devices.ip,
        firstSeenAt: devices.firstSeenAt,
        lastSeenAt: devices.lastSeenAt,
        revokedAt: devices.revokedAt,
        email: users.email,
        fullName: users.fullName,
      })
      .from(devices)
      .leftJoin(users, eq(users.id, devices.lastUserId))
      .where(sql`(${users.organizationId} = ${orgId} or ${devices.lastUserId} is null)`)
      .orderBy(sql`(${devices.revokedAt} is not null)`, sql`${devices.lastSeenAt} desc`)
      .limit(500);
    const list: DeviceView[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      userAgent: r.userAgent,
      ip: r.ip,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      lastUser: r.email ? { email: r.email, fullName: r.fullName ?? r.email } : null,
      status: this.statusOf(r, cutoff),
      current: r.id === currentDeviceId,
      revokedAt: r.revokedAt?.toISOString() ?? null,
    }));
    return { limit: snap.lease?.deviceLimit ?? null, active: list.filter((d) => d.status === 'active').length, devices: list };
  }

  /** Cihaza (kuruluş içinde) erişimi doğrular; bulunamazsa null. */
  private async findInOrg(orgId: string, deviceId: string) {
    const [row] = await this.opts.db
      .select({ id: devices.id, name: devices.name, revokedAt: devices.revokedAt })
      .from(devices)
      .leftJoin(users, eq(users.id, devices.lastUserId))
      .where(and(eq(devices.id, deviceId), sql`(${users.organizationId} = ${orgId} or ${devices.lastUserId} is null)`));
    return row ?? null;
  }

  async rename(orgId: string, deviceId: string, name: string): Promise<boolean> {
    if (!(await this.findInOrg(orgId, deviceId))) return false;
    await this.opts.db.update(devices).set({ name }).where(eq(devices.id, deviceId));
    return true;
  }

  /**
   * Cihazı iptal eder: koltuk boşalır, bu cihazın oturumları (yenileme token'ları) kapanır, erişim belirteçleri
   * en geç önbellek süresi içinde geçersiz olur. Cihazı yeniden kullanmak için kullanıcı yeniden giriş yapmalıdır
   * (boş koltuk varsa yeni cihaz olarak kaydolur). false: bulunamadı ya da zaten iptal.
   */
  async revoke(orgId: string, deviceId: string, by: string): Promise<boolean> {
    const found = await this.findInOrg(orgId, deviceId);
    if (!found || found.revokedAt) return false;
    await this.revokeUnchecked(deviceId, by);
    return true;
  }

  async revokeUnchecked(deviceId: string, by: string): Promise<boolean> {
    const now = new Date(this.license.clock());
    const done = await this.opts.db.transaction(async (tx) => {
      const r = await tx
        .update(devices)
        .set({ revokedAt: now, revokedBy: by })
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
        .returning({ id: devices.id });
      if (r.length === 0) return false;
      await tx.update(refreshTokens).set({ revokedAt: now }).where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
      return true;
    });
    this.cache.set(deviceId, { ok: false, exp: Date.now() + this.cacheMs });
    return done;
  }
}
