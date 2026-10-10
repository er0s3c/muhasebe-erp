import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  resolveEnabledModules,
  areaOfPermission,
  type Permission,
  type Role,
  type Sector,
  type Jurisdiction,
  type TaxSetupStatus,
  type ResourceOperation,
  type BranchContext,
} from '@erp/shared';
import type { Config } from '../config';
import { setContext, withContext, type Db, type Tx } from '../db/client';
import { appUpdates, companies, companyModules, memberships, users } from '../db/schema';
import { AppError, forbidden, unauthorized, badRequest } from './errors';
import { denialFor, isModuleDenied, loadMemberAccess, moduleAccessDenied, requirePermission, requireResourceOperation, type MemberAccess } from '../modules/access/effective';
import { inferResourceOperation } from './resource-operation';
import type { Semaphore } from './limits';
import type { RateLimiter } from './postgres-limiter';
import type { Mailer } from '../modules/mail/mailer';
import { assertLicensed } from '../licensing/gate';
import type { DeviceService } from '../licensing/devices';
import type { LicenseService } from '../licensing/service';
import { withCompanyTimeZone } from './company-time';
import { loadBranchContext } from '../modules/tenancy/branches';

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
  /** Oturum ailesi (refresh_tokens.family_id): ailede geçerli yenileme belirteci kalmadıysa (çıkış, parola değişimi) erişim de biter. */
  sid?: string;
  /** 'mfa': yalnızca ikinci adım için verilen kısa ömürlü belirteç; hiçbir korumalı uçta geçmez. */
  purpose?: 'mfa';
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Merkez Bankası kur XML'ini indirir; testlerde değiştirilebilir. */
    rateFetcher: (isoDate?: string) => Promise<string>;
    fxRateFetcher: (provider: 'tcmb' | 'kktcmb', isoDate?: string) => Promise<string>;
    /** Bellek içi oran sınırlayıcı (RATE_LIMIT_ENABLED kapalıyken hiçbir şeyi engellemez). */
    limiter: RateLimiter;
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
  sessionId?: string;
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
  jurisdiction: Jurisdiction | null;
  profileMode: 'legacy_manual' | 'country';
  profileVersionId: string | null;
  timeZone: string;
  fxProvider: 'tcmb' | 'kktcmb' | null;
  taxSetupStatus: TaxSetupStatus;
}

export interface TenantCtx extends AuthCtx {
  branch:BranchContext;
  company: CompanyInfo;
  /** Üyeliğin rolü (şablon). İzin kararı için ROL DEĞİL `access`/`can`/`require` kullanılır: kullanıcı bazlı modül erişimi rolü değiştirir. */
  role: Role;
  enabledModules: Set<string>;
  /** Etkin erişim: rol şablonu + kullanıcı bazlı modül erişimi (istek başına, işlem içinde okunur; önbellek yok). */
  access: MemberAccess;
  /** Etkin izin var mı. */
  can: (permission: Permission) => boolean;
  /** Etkin izin yoksa nedene uygun 403 atar (istisnadan kaynaklanıyorsa MODULE_ACCESS_DENIED / MODULE_READ_ONLY). */
  require: (permission: Permission) => void;
}

const passwordChangeRequired = () =>
  forbidden('Devam etmeden önce şifrenizi değiştirmelisiniz', 'PASSWORD_CHANGE_REQUIRED');

async function maintenanceWriteGuard(tx: Tx, req: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.routeOptions.url?.startsWith('/api/auth/') || req.routeOptions.url === '/api/settings/backups' || req.routeOptions.url === '/api/companies/:companyId/feedback') return;
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('erp-maintenance-write'))`);
  const [running] = await tx.select({ id: appUpdates.id }).from(appUpdates).where(eq(appUpdates.status, 'applying')).limit(1);
  if (running) throw new AppError(503, 'UPDATE_MAINTENANCE', 'Güncelleme ve yedekleme sürüyor; kayıtlar görüntülenebilir. Yazma işlemini güncelleme bitince tekrar deneyin.');
}

async function authenticate(app: FastifyInstance, req: FastifyRequest): Promise<AuthUser> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
  if (req.user.purpose) throw unauthorized();
  if (app.license.enforced) {
    // Lisans denetimi açıkken her erişim belirteci kayıtlı bir cihaza aittir; cihaz kaldırıldıysa belirteç geçersizdir.
    // (Cihaz bilgisi olmayan eski belirteç yeniden girişle/yenilemeyle cihaz kazanır.)
    const did = req.user.did;
    if (!did) throw unauthorized();
    if (!(await app.devices.isActive(did))) throw new AppError(401, 'DEVICE_REVOKED', 'Bu cihazın erişimi kaldırıldı; yeniden giriş yapın');
  }
  return { id: req.user.sub, orgId: req.user.org, deviceId: req.user.did, sessionId: req.user.sid };
}

/**
 * Erişim belirtecinin oturum ailesi hâlâ açık mı (iptal edilmemiş, süresi dolmamış bir yenileme belirteci var mı)?
 * Çıkış ve parola değişimi aileyi kapatır; böylece erişim belirteci 15 dakikalık ömrünü beklemeden geçersiz olur.
 * Oturum bilgisi olmayan (bu sürümden önce verilmiş) belirteçler kısa ömürleri boyunca geçerli kalır.
 */
const sessionOpen = (user: AuthUser) =>
  user.sessionId
    ? sql<boolean>`exists (select 1 from refresh_tokens r where r.family_id = ${user.sessionId}::uuid and r.revoked_at is null and r.expires_at > now())`
    : sql<boolean>`true`;

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
        .select({ isActive: users.isActive, mustChangePassword: users.mustChangePassword, sessionOpen: sessionOpen(user) })
        .from(users)
        .where(eq(users.id, user.id));
      if (!row?.isActive || !row.sessionOpen) throw unauthorized();
      if (row.mustChangePassword && !opts.allowMustChange) throw passwordChangeRequired();
      await maintenanceWriteGuard(tx, req);
      return handler({ tx, user, req, reply });
    });
  };
  return Object.assign(route, { [GUARD]: { kind: 'authed' } satisfies GuardMeta });
}

export interface TenantRouteOptions {
  permission?: Permission;
  /** Modül kayıt anahtarı; şirketin sektöründe açık değilse 403. */
  module?: string;
  /** Kayıt işlem kapısı; iş akışında gerektiğinde HTTP varsayımını açıkça değiştirir. */
  operation?: ResourceOperation | 'read';
  /** Reader may maintain their own agenda; service still checks ownership. Explicit read-only/operation overrides win. */
  personalAgenda?: boolean;
  /** Kullanıcı başına oran sınırı (ağır uçlar: dışa/içe aktarma, kur indirme). Sınır aşılırsa 429. */
  limit?: { name: string; max: number; windowMs: number };
}

/** Şirket toplamı üzerinden karar veren işlemler dar şube verisiyle hesaplanamaz. */
function requiresAllBranches(path:string,method:string):boolean {
  if(/^\/api\/(company\/profile|payroll|social-security|employee-ledger|bank-statements|bank-statement-lines|fiscal-years)(\/|$)/.test(path)) return true;
  if(/^\/api\/treasury\/accounts\/:id\/reconciliation(\/|$)/.test(path)||/^\/api\/imports\/bank_statement(\/|$)/.test(path)) return true;
  if(/^\/api\/reports\/(fx-position|executive-summary)(\/|$)/.test(path)) return true;
  if(/^\/api\/exports\/(full-data|payroll-register|payroll-cost|social-declaration|social-premium-summary|employee-balances|employee-advances|employee-statement|bank-reconciliation|year-end-closing|executive-summary|fx-position)(\/|$)/.test(path)) return true;
  return !['GET','HEAD','OPTIONS'].includes(method)&&/^\/api\/periods(\/|$)/.test(path);
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
      const r = await app.limiter.consume(`${options.limit.name}:${user.id}`, options.limit.max, options.limit.windowMs);
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
          sessionOpen: sessionOpen(user),
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, user.id)));
      if (member && !member.sessionOpen) throw unauthorized();
      if (!member || !member.isActive) throw forbidden('Bu şirkete erişiminiz yok', 'NOT_A_MEMBER');
      if (member.mustChangePassword) throw passwordChangeRequired();
      await maintenanceWriteGuard(tx, req);

      await setContext(tx, { userId: user.id, orgId: user.orgId, companyId, ip: req.ip });
      // Aynı şirkette ülke geçişi ve mali belge kesinleştirme eşzamanlı olamaz.
      const profileActivation = req.routeOptions.url === '/api/company/profile/activate';
      if (profileActivation) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'company-profile:' + companyId},0))`);
      else if (!['GET','HEAD','OPTIONS'].includes(req.method)) await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'company-profile:' + companyId},0))`);
      const securityPolicy = (await tx.execute<{ required: boolean; enabled: boolean }>(sql`select coalesce((select (settings->>'requireMfa')::boolean from company_operations_settings),false) as required,exists(select 1 from user_mfa where user_id=${user.id}::uuid and enabled_at is not null) as enabled`)).rows[0];
      if(securityPolicy?.required && !securityPolicy.enabled) throw forbidden('Bu şirket iki adımlı doğrulama gerektiriyor. Hesap güvenliği ekranından MFA kurulumunu tamamlayın.','MFA_SETUP_REQUIRED');

      const [company] = await tx
        .select({
          id: companies.id,
          name: companies.name,
          sector: companies.sector,
          baseCurrency: companies.baseCurrency,
          reportingCurrency: companies.reportingCurrency,
          allowNegativeStock: companies.allowNegativeStock,
          jurisdiction: companies.jurisdiction,
          profileMode: companies.profileMode,
          profileVersionId: companies.profileVersionId,
          timeZone: companies.timeZone,
          fxProvider: companies.fxProvider,
          taxSetupStatus: companies.taxSetupStatus,
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
      const branch=await loadBranchContext(tx,companyId,user.id,req);
      if((branch.mode==='restricted'||branch.selection!=='all')&&requiresAllBranches(req.routeOptions.url??'',req.method)) throw forbidden('Bu şirket geneli işlem tüm şubelere erişim ve tüm şubeler görünümü gerektirir','BRANCH_COMPANY_WIDE_DENIED');
      if (options.module && !enabledModules.has(options.module)) {
        throw forbidden('Bu modül şirketinizde etkin değil', 'MODULE_DISABLED');
      }
      // Kullanıcı bazlı modül erişimi: şirket düzeyindeki modül anahtarından SONRA, izinden ÖNCE uygulanır
      const access = await loadMemberAccess(tx, companyId, user.id, role);
      if (options.module && isModuleDenied(access, options.module)) throw moduleAccessDenied();
      if (options.permission && !access.permissions.has(options.permission)) throw denialFor(access, options.permission);
      const operation = options.operation ?? inferResourceOperation(req.method, req.routeOptions.url ?? req.url.split('?')[0]!);
      const operationModule = options.module ?? (options.permission ? areaOfPermission(options.permission) : null);
      if (operation !== 'read' && operationModule) {
        const ownAgenda = options.personalAgenda && options.module === 'core.directory' &&
          access.permissions.has('directory.read') && access.overrides['core.directory'] !== 'read' &&
          access.overrides[`operation.core.directory.${operation}`] !== 'none';
        if (!ownAgenda) requireResourceOperation(access, operationModule, operation);
      }
      // Dönüşüm mevcut kaydı değiştirirken yeni belge de açar; oluşturma yasağı aşılmaz.
      if (operationModule && req.method === 'POST' && req.routeOptions.url?.endsWith('/convert')) requireResourceOperation(access, operationModule, 'create');

      // Serialize cost provenance before document, item and treasury row locks.
      if (['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.routeOptions.url !== '/api/companies/:companyId/feedback') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'leather-costs:' + companyId}, 0))`);
      }

      return withCompanyTimeZone(company.timeZone, () => handler({
        tx,
        user,
        req,
        reply,
        role,
        branch,
        enabledModules,
        access,
        can: (permission) => access.permissions.has(permission),
        require: (permission) => requirePermission(access, permission),
        company: { ...company, sector: company.sector as Sector },
      }));
    });
  };
  return Object.assign(route, {
    [GUARD]: { kind: 'tenant', permission: options.permission, module: options.module } satisfies GuardMeta,
  });
}
