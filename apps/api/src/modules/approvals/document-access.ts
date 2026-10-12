import { and, eq, sql } from 'drizzle-orm';
import { resolveEnabledModules, type Permission, type Role, type Sector } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, companyModules, memberships, users } from '../../db/schema';
import type { TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import {
  isModuleDenied,
  loadMemberAccess,
  moduleAccessDenied,
  requirePermission,
  requireResourceOperation,
} from '../access/effective';
import {
  approvalManagePermission,
  approvalModule,
  approvalPermission,
  approvalReadPermission,
  type GeneralApprovalType,
} from './document-policy';
import type { ApprovalCtx } from './service';

export function requireDocumentAccess(
  c: TenantCtx,
  type: GeneralApprovalType,
  action: 'read' | 'manage' | 'approve',
  operation: 'create' | 'update' = 'update',
) {
  const module = approvalModule(type);
  if (!c.enabledModules.has(module))
    throw forbidden('Bu modül şirketinizde etkin değil', 'MODULE_DISABLED');
  if (isModuleDenied(c.access, module)) throw moduleAccessDenied();
  c.require(approvalReadPermission(type));
  if (action !== 'read') {
    c.require(action === 'manage' ? approvalManagePermission(type) : approvalPermission(type));
    requireResourceOperation(c.access, module, operation);
  }
}

/** Karar anında rol, tekil izin, özel rol, modül ve şube kapsamı yeniden okunur. */
export async function requireLiveDecision(
  tx: Tx,
  ctx: ApprovalCtx,
  type: GeneralApprovalType,
  branchId: string | null,
  employeeExpense = false,
) {
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.companyId, ctx.companyId),
        eq(memberships.userId, ctx.userId),
        eq(users.isActive, true),
      ),
    );
  if (!member) throw forbidden();
  const access = await loadMemberAccess(tx, ctx.companyId, ctx.userId, member.role as Role);
  const [company] = await tx
    .select({ sector: companies.sector })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const enabled = resolveEnabledModules(
    company!.sector as Sector,
    await tx
      .select({ module: companyModules.module, enabled: companyModules.enabled })
      .from(companyModules),
  );
  const module = approvalModule(type);
  if (!enabled.has(module)) throw forbidden('Bu modül şirketinizde etkin değil', 'MODULE_DISABLED');
  if (isModuleDenied(access, module)) throw moduleAccessDenied();
  for (const permission of [approvalReadPermission(type), approvalPermission(type)] as Permission[])
    requirePermission(access, permission);
  requireResourceOperation(access, module, 'update');
  if (employeeExpense) {
    requirePermission(access, 'hr.payroll_manage');
    if (!enabled.has('hr.employee_ledger') || isModuleDenied(access, 'hr.employee_ledger'))
      throw moduleAccessDenied();
  }
  const rows = await tx.execute<{ allowed: boolean }>(
    sql`select app_branch_has_access(${ctx.companyId}::uuid,${branchId}::uuid) as allowed`,
  );
  if (!rows.rows[0]?.allowed)
    throw forbidden('Bu şubedeki belgeyi onaylayamazsınız', 'BRANCH_ACCESS_DENIED');
}

export async function withDocumentBranch<T>(
  tx: Tx,
  branchId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const old = await tx.execute<{ id: string; selection: string }>(
    sql`select current_setting('app.branch_id',true) as id,current_setting('app.branch_selection',true) as selection`,
  );
  await tx.execute(
    sql`select set_config('app.branch_id',${branchId ?? ''},true),set_config('app.branch_selection',${branchId ? 'branch' : 'unassigned'},true)`,
  );
  try {
    return await fn();
  } finally {
    await tx.execute(
      sql`select set_config('app.branch_id',${old.rows[0]?.id ?? ''},true),set_config('app.branch_selection',${old.rows[0]?.selection ?? 'all'},true)`,
    );
  }
}
