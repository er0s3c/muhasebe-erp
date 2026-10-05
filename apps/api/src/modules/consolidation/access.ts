import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hasPermission, resolveEnabledModules, type PermissionSet, type Role, type Sector } from '@erp/shared';
import { setContext, type Tx } from '../../db/client';
import { companies, companyModules, consolidationGroups, consolidationMembers, memberships } from '../../db/schema';
import type { AuthCtx } from '../../http/context';
import { AppError, notFound } from '../../http/errors';
import { assertLicensed } from '../../licensing/gate';
import { loadMemberAccess } from '../access/effective';

/**
 * ÇOKLU ŞİRKET ERİŞİM KATMANI (Faz X7). Konsolidasyonun tek güvenlik kapısıdır.
 *
 * Kurallar:
 *  1. İstemci şirket kimliği GÖNDERMEZ (yalnız grup kimliği); grup RLS ile yalnızca sahibine görünür, üye şirketler sunucuda gruptan okunur.
 *  2. HER istekte, HER üye şirket için üyelik + rol (`reports.consolidation`) + modül (`reports.consolidation` açık) + lisans sektörü
 *     o şirketin kendi RLS bağlamında yeniden doğrulanır; geçmişte eklenmiş olması hiçbir şey kazandırmaz.
 *  3. Doğrulamayı geçmeyen şirket rapordan DÜŞER ve `excluded` içinde nedenle bildirilir (rapor `complete = false` olur); sessizce dahil edilmez.
 *  4. Şirket verisi yalnızca o şirketin `app.company_id` bağlamında, şirket şirket SIRAYLA okunur; bağlam her şirketten sonra temizlenir.
 *     Çapraz kiracı RLS atlatması, SECURITY DEFINER işlevi ya da geniş yetki YOKTUR; toplama uygulama belleğinde yapılır.
 */

export type DenyReason = 'NOT_A_MEMBER' | 'ROLE_INSUFFICIENT' | 'MODULE_DISABLED' | 'LICENSE_SECTOR_MISMATCH';

export interface MemberScope {
  companyId: string;
  name: string;
  sector: Sector;
  baseCurrency: string;
  reportingCurrency: string | null;
  taxNumber: string | null;
  role: Role;
  /** Etkin izinler (rol + kullanıcı bazlı modül erişimi) — o şirketin kendi bağlamında hesaplanır. */
  permissions: PermissionSet;
  enabledModules: Set<string>;
}

export interface ExcludedMember {
  companyId: string;
  reason: DenyReason;
}

export const CONSOLIDATION_PERMISSION = 'reports.consolidation' as const;
export const CONSOLIDATION_MODULE = 'reports.consolidation';

interface UserCtx {
  userId: string;
  orgId: string;
  ip?: string;
}

const userOnly = (u: UserCtx) => ({ userId: u.userId, orgId: u.orgId, ip: u.ip });

/** Şirket bağlamını kurar, bir iş çalıştırır, bağlamı (şirketsiz) geri alır. Her zaman sırayla çağrılır. */
export async function inCompany<T>(tx: Tx, u: UserCtx, companyId: string, fn: () => Promise<T>): Promise<T> {
  await setContext(tx, { ...userOnly(u), companyId });
  try {
    return await fn();
  } finally {
    await setContext(tx, userOnly(u));
  }
}

/** Tek şirket için üyelik, rol, modül ve lisans doğrulaması (şirket bağlamında). */
export async function evaluateMember(
  app: FastifyInstance,
  tx: Tx,
  u: UserCtx,
  companyId: string,
  license: Awaited<ReturnType<typeof assertLicensed>>,
): Promise<{ scope: MemberScope } | { excluded: ExcludedMember }> {
  const deny = (reason: DenyReason) => ({ excluded: { companyId, reason } as ExcludedMember });
  return inCompany(tx, u, companyId, async () => {
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, u.userId)));
    if (!member) return deny('NOT_A_MEMBER');
    const [company] = await tx
      .select({
        id: companies.id,
        name: companies.name,
        sector: companies.sector,
        baseCurrency: companies.baseCurrency,
        reportingCurrency: companies.reportingCurrency,
        taxNumber: companies.taxNumber,
      })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return deny('NOT_A_MEMBER');
    if (license && !app.license.sectorAllowed(license, company.sector)) return deny('LICENSE_SECTOR_MISMATCH');
    const role = member.role as Role;
    const { permissions } = await loadMemberAccess(tx, companyId, u.userId, role);
    if (!hasPermission(permissions, CONSOLIDATION_PERMISSION) || !hasPermission(permissions, 'reports.read')) return deny('ROLE_INSUFFICIENT');
    const overrides = await tx.select({ module: companyModules.module, enabled: companyModules.enabled }).from(companyModules);
    const enabledModules = resolveEnabledModules(company.sector as Sector, overrides);
    if (!enabledModules.has(CONSOLIDATION_MODULE)) return deny('MODULE_DISABLED');
    return {
      scope: {
        companyId,
        name: company.name,
        sector: company.sector as Sector,
        baseCurrency: company.baseCurrency,
        reportingCurrency: company.reportingCurrency,
        taxNumber: company.taxNumber,
        role,
        permissions,
        enabledModules,
      },
    };
  });
}

export interface GroupAccess {
  group: { id: string; name: string; reportingCurrency: string; isArchived: boolean };
  scopes: MemberScope[];
  excluded: ExcludedMember[];
  user: UserCtx;
}

/**
 * Grubu (yalnızca sahibine; aksi 404) yükler ve üyelerini yeniden doğrular. Erişilebilir üye yoksa 403.
 * `requireAll`: bir üye bile düşerse reddeder (varsayılan kapalı: düşen şirket bildirilerek rapordan çıkar).
 */
export async function resolveGroupAccess(app: FastifyInstance, ctx: AuthCtx, groupId: string, opts: { requireAll?: boolean } = {}): Promise<GroupAccess> {
  const license = await assertLicensed(app.license, ctx.req);
  const { tx, user } = ctx;
  const u: UserCtx = { userId: user.id, orgId: user.orgId, ip: ctx.req.ip };
  await setContext(tx, userOnly(u));
  const [group] = await tx
    .select({ id: consolidationGroups.id, name: consolidationGroups.name, reportingCurrency: consolidationGroups.reportingCurrency, isArchived: consolidationGroups.isArchived })
    .from(consolidationGroups)
    .where(and(eq(consolidationGroups.id, groupId), eq(consolidationGroups.ownerUserId, user.id)));
  if (!group) throw notFound('Konsolidasyon grubu');
  const members = await tx
    .select({ companyId: consolidationMembers.memberCompanyId })
    .from(consolidationMembers)
    .where(eq(consolidationMembers.groupId, groupId))
    .orderBy(consolidationMembers.addedAt);

  const scopes: MemberScope[] = [];
  const excluded: ExcludedMember[] = [];
  for (const m of members) {
    const r = await evaluateMember(app, tx, u, m.companyId, license);
    if ('scope' in r) scopes.push(r.scope);
    else excluded.push(r.excluded);
  }
  if (opts.requireAll && excluded.length > 0) {
    throw new AppError(403, 'GROUP_MEMBER_ACCESS_LOST', 'Grubun bazı şirketlerine erişiminiz yok', { excluded });
  }
  if (scopes.length === 0) {
    throw new AppError(403, 'GROUP_NO_ACCESS', 'Grubun hiçbir şirketine konsolidasyon erişiminiz yok', { excluded });
  }
  return { group, scopes, excluded, user: u };
}

/** Üye şirketleri sırayla, her biri kendi RLS bağlamında gezer. */
export async function forEachScope<T>(tx: Tx, access: GroupAccess, fn: (scope: MemberScope) => Promise<T>): Promise<{ scope: MemberScope; value: T }[]> {
  const out: { scope: MemberScope; value: T }[] = [];
  for (const scope of access.scopes) {
    out.push({ scope, value: await inCompany(tx, access.user, scope.companyId, () => fn(scope)) });
  }
  return out;
}
