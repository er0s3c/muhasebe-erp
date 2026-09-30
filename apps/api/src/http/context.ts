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
import { forbidden, unauthorized, badRequest } from './errors';

export interface AccessTokenPayload {
  sub: string;
  org: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** Merkez Bankası kur XML'ini indirir; testlerde değiştirilebilir. */
    rateFetcher: (isoDate?: string) => Promise<string>;
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

async function authenticate(req: FastifyRequest): Promise<AuthUser> {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
  return { id: req.user.sub, orgId: req.user.org };
}

/** Yalnızca giriş yapmış kullanıcı gerektiren rota (şirket seçimi gerekmez). */
export function authedRoute<T>(
  app: FastifyInstance,
  handler: (ctx: AuthCtx) => Promise<T>,
): RouteHandlerMethod {
  return async (req, reply) => {
    const user = await authenticate(req);
    return withContext(app.db, { userId: user.id, orgId: user.orgId, ip: req.ip }, async (tx) => {
      // Token geçerli olsa da kullanıcı pasifleştirilmiş olabilir.
      const [row] = await tx
        .select({ isActive: users.isActive })
        .from(users)
        .where(eq(users.id, user.id));
      if (!row?.isActive) throw unauthorized();
      return handler({ tx, user, req, reply });
    });
  };
}

export interface TenantRouteOptions {
  permission?: Permission;
  /** Modül kayıt anahtarı; şirketin sektöründe açık değilse 403. */
  module?: string;
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
  return async (req, reply) => {
    const user = await authenticate(req);
    const companyId = req.headers['x-company-id'];
    if (typeof companyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
      throw badRequest('X-Company-Id başlığı gerekli', 'COMPANY_REQUIRED');
    }

    return withContext(app.db, { userId: user.id, orgId: user.orgId, ip: req.ip }, async (tx) => {
      const [member] = await tx
        .select({
          role: memberships.role,
          isActive: users.isActive,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, user.id)));
      if (!member || !member.isActive) throw forbidden('Bu şirkete erişiminiz yok', 'NOT_A_MEMBER');

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

      const overrides = await tx
        .select({ module: companyModules.module, enabled: companyModules.enabled })
        .from(companyModules);
      const enabledModules = resolveEnabledModules(company.sector as Sector, overrides);

      const role = member.role as Role;
      if (options.module && !enabledModules.has(options.module)) {
        throw forbidden('Bu modül şirketinizin sektöründe etkin değil', 'MODULE_DISABLED');
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
}
