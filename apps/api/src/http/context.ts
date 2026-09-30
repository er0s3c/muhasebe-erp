import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  hasPermission,
  resolveEnabledModules,
  type Permission,
  type Role,
  type Sector,
} from '@erp/shared';
import type { Config } from '../config';
import { setContext, withContext, type Db, type Tx } from '../db/client';
import { companies, companyModules, memberships, users } from '../db/schema';
import { AppError, forbidden, unauthorized, badRequest } from './errors';
import type { MemoryLimiter, Semaphore } from './limits';
import type { Mailer } from '../modules/mail/mailer';
import { assertLicensed } from '../licensing/gate';
import type { DeviceService } from '../licensing/devices';
import type { LicenseService } from '../licensing/service';

/**
 * Kayıtlı bir işleyicinin hangi kapıdan geçtiğini gösterir; rota–izin sözleşme testi (test/security.test.ts)
 * her `/api/*` rotasının ya kamuya açık listede ya da bir kapıdan geçtiğini bunu okuyarak doğrular.
 */
export const GUARD = Symbol.for('erp.route.guard');
export interface GuardMeta {
  kind: 'authed' | 'tenant';
  permission?: Permission;
  module?: string;
}

export interface AccessTokenPayload {
  sub: string;
  org: string;
  /** Oturumun açıldığı kayıtlı cihaz (lisans denetimi açıkken her erişim belirtecinde bulunur). */
  did?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Merkez Bankası kur XML'ini indirir; testlerde değiştirilebilir. */
    rateFetcher: (isoDate?: string) => Promise<string>;
    /** Bellek içi oran sınırlayıcı (RATE_LIMIT_ENABLED kapalıyken hiçbir şeyi engellemez). */
    limiter: MemoryLimiter;
    /** Bellek içi dışa aktarmalar için eşzamanlılık kapısı. */
    exportGate: Semaphore;
    /** Giden posta (SMTP, günlük modu ya da kapalı). */
    mailer: Mailer;
    /** Kuruluma ait lisans durumu ve satıcıyla iletişim. */
    license: LicenseService;
    /** Lisans cihaz koltukları (kayıtlı tarayıcılar). */
    devices: DeviceService;
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

export interface AuthUser {
  id: string;
  orgId: string;
  deviceId?: string;
}

export interface AuthCtx {
  tx: Tx;
  user: AuthUser;
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface CompanyInfo {
  id: string;
  name: string;
  sector: Sector;
  baseCurrency: string;
  reportingCurrency: string | null;
  allowNegativeStock: boolean;
}

export interface TenantCtx extends AuthCtx {
  company: CompanyInfo;
  role: Role;
  enabledModules: Set<string>;
}

const passwordChangeRequired = () =>
  forbidden('Devam etmeden önce şifrenizi değiştirmelisiniz', 'PASSWORD_CHANGE_REQUIRED');

async function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<AuthUser> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
  if (app.license.enforced) {
    // Lisans denetimi açıkken her erişim belirteci kayıtlı bir cihaza aittir; cihaz kaldırıldıysa belirteç geçersizdir.
    // (Cihaz bilgisi olmayan eski belirteç yeniden girişle/yenilemeyle cihaz kazanır.)
    const did = req.user.did;
    if (!did) throw unauthorized();
    if (!(await app.devices.isActive(did))) throw new AppError(401, 'DEVICE_REVOKED', 'Bu cihazın erişimi kaldırıldı; yeniden giriş yapın');
  }
  return { id: req.user.sub, orgId: req.user.org, deviceId: req.user.did };
}

/** Yalnızca giriş yapmış kullanıcı gerektiren rota (şirket seçimi gerekmez). */
export function authedRoute<T>(
  app: FastifyInstance,
  handler: (ctx: AuthCtx) => Promise<T>,
  /** allowMustChange: parolasını değiştirmesi gereken kullanıcı bu uca yine de erişebilir (oturum bilgisi, parola değiştirme). */
  opts: { allowMustChange?: boolean } = {},
): RouteHandlerMethod {
  const route: RouteHandlerMethod = async (req, reply) => {
    await assertLicensed(app.license, req);
    const user = await authenticate(app, req);
    return withContext(app.db, { userId: user.id, orgId: user.orgId, ip: req.ip }, async (tx) => {
      // Token geçerli olsa da kullanıcı pasifleştirilmiş olabilir.
      const [row] = await tx
        .select({ isActive: users.isActive, mustChangePassword: users.mustChangePassword })
        .from(users)
        .where(eq(users.id, user.id));
      if (!row?.isActive) throw unauthorized();
      if (row.mustChangePassword && !opts.allowMustChange) throw passwordChangeRequired();
      return handler({ tx, user, req, reply });
    });
  };
  return Object.assign(route, { [GUARD]: { kind: 'authed' } satisfies GuardMeta });
}

export interface TenantRouteOptions {
  permission?: Permission;
  /** Modül kayıt anahtarı; şirketin sektöründe açık değilse 403. */
  module?: string;
  /** Kullanıcı başına oran sınırı (ağır uçlar: dışa/içe aktarma, kur indirme). Sınır aşılırsa 429. */
  limit?: { name: string; max: number; windowMs: number };
}

/**
 * Şirket bağlamlı rota: X-Company-Id başlığını doğrular, üyeliği ve rolü bulur,
 * RLS bağlamını (app.company_id) kurar, izin ve modül kontrolü yapar.
 * Tüm istek tek işlemde çalışır; hata olursa hepsi geri alınır.
 */
export function tenantRoute<T>(
  app: FastifyInstance,
  options: TenantRouteOptions,
  handler: (ctx: TenantCtx) => Promise<T>,
): RouteHandlerMethod {
  const route: RouteHandlerMethod = async (req, reply) => {
    const license = await assertLicensed(app.license, req);
    const user = await authenticate(app, req);
    if (options.limit) {
      const r = app.limiter.consume(`${options.limit.name}:${user.id}`, options.limit.max, options.limit.windowMs);
      if (!r.ok) {
        void reply.header('retry-after', String(r.retryAfterSec));
        throw new AppError(429, 'RATE_LIMITED', 'Çok fazla istek; lütfen biraz sonra tekrar deneyin');
      }
    }
    const companyId = req.headers['x-company-id'];
    if (typeof companyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
      throw badRequest('X-Company-Id başlığı gerekli', 'COMPANY_REQUIRED');
    }

    return withContext(app.db, { userId: user.id, orgId: user.orgId, ip: req.ip }, async (tx) => {
      const [member] = await tx
        .select({
          role: memberships.role,
          isActive: users.isActive,
          mustChangePassword: users.mustChangePassword,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, user.id)));
      if (!member || !member.isActive) throw forbidden('Bu şirkete erişiminiz yok', 'NOT_A_MEMBER');
      if (member.mustChangePassword) throw passwordChangeRequired();

      await setContext(tx, { userId: user.id, orgId: user.orgId, companyId, ip: req.ip });

      const [company] = await tx
        .select({
          id: companies.id,
          name: companies.name,
          sector: companies.sector,
          baseCurrency: companies.baseCurrency,
          reportingCurrency: companies.reportingCurrency,
          allowNegativeStock: companies.allowNegativeStock,
        })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) throw forbidden('Bu şirkete erişiminiz yok', 'NOT_A_MEMBER');
      // Şirketin sektörü lisansın kapsamında olmalı (veritabanında sektörü elle değiştirmek yetki kazandırmaz).
      if (license && !app.license.sectorAllowed(license, company.sector)) {
        throw forbidden('Lisansınız bu şirketin sektörünü kapsamıyor', 'LICENSE_SECTOR_MISMATCH');
      }

      const overrides = await tx
        .select({ module: companyModules.module, enabled: companyModules.enabled })
        .from(companyModules);
      const enabledModules = resolveEnabledModules(company.sector as Sector, overrides);

      const role = member.role as Role;
      if (options.module && !enabledModules.has(options.module)) {
        throw forbidden('Bu modül şirketinizde etkin değil', 'MODULE_DISABLED');
      }
      if (options.permission && !hasPermission(role, options.permission)) {
        throw forbidden();
      }

      return handler({
        tx,
        user,
        req,
        reply,
        role,
        enabledModules,
        company: { ...company, sector: company.sector as Sector },
      });
    });
  };
  return Object.assign(route, {
    [GUARD]: { kind: 'tenant', permission: options.permission, module: options.module } satisfies GuardMeta,
  });
}
