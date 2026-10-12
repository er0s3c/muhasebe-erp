import { and, eq } from 'drizzle-orm';
import { memberBranchAccess, memberships } from '../../db/schema';
import type { TenantCtx } from '../../http/context';
import { forbidden, notFound } from '../../http/errors';

/** Modül/rol yetkisi de şube kapsamını kullanır; başka bir üye üzerinden kapsam genişletilmez. */
export async function assertMemberScopeWithinGranter(c: TenantCtx, targetId: string) {
  if (c.branch.mode === 'all') return;
  const [target] = await c.tx.select({ mode: memberships.branchScopeMode, allowUnassigned: memberships.branchAllowUnassigned }).from(memberships).where(and(eq(memberships.companyId, c.company.id), eq(memberships.userId, targetId)));
  if (!target) throw notFound('Üye');
  const ids = (await c.tx.select({ id: memberBranchAccess.branchId }).from(memberBranchAccess).where(and(eq(memberBranchAccess.companyId, c.company.id), eq(memberBranchAccess.userId, targetId)))).map(row => row.id);
  if (target.mode === 'all' || (target.allowUnassigned && !c.branch.allowUnassigned) || ids.some(id => !c.branch.branchIds.includes(id))) throw forbidden('Bu üyenin şube kapsamı kendi erişiminizden geniş; yetkiyi şirket sahibi düzenlemelidir', 'BRANCH_ACCESS_EXCEEDS_OWN');
}
