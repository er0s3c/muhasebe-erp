import { areaOfModule, resourceOperationAllowed, type Permission } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { isModuleDenied } from '../access/effective';
import { approvalModule, approvalReadPermission } from '../approvals/document-policy';

// Tool results leave the ERP, so both reading and exporting must be allowed.
export function aiToolAccess(c: Pick<TenantCtx, 'access' | 'enabledModules'>) {
  const canExport = (module: string, permission: Permission) => {
    const area = areaOfModule(module);
    return c.enabledModules.has(module) && !isModuleDenied(c.access, module) &&
      c.access.permissions.has(permission) && area !== null &&
      resourceOperationAllowed(c.access.permissions, c.access.overrides, area, 'export');
  };
  const allowedTools = new Set<string>();
  const parties = canExport('core.parties', 'parties.read');
  const projects = canExport('construction.projects', 'projects.read');
  if (canExport('core.inventory', 'inventory.read')) allowedTools.add('list_critical_stock');
  if (canExport('core.treasury', 'treasury.read')) allowedTools.add('get_cash_and_bank_balances');
  if (parties) allowedTools.add('get_overdue_receivables');
  if (parties && canExport('core.invoices', 'invoices.read')) allowedTools.add('get_recent_invoices');
  if (parties && projects) allowedTools.add('list_projects');
  if (parties && projects && canExport('construction.subcontracts', 'subcontracts.read')) allowedTools.add('get_subcontracts');
  const pendingApprovalTypes = ['invoice', 'sales_quote', 'payment', 'expense', 'purchase_request', 'progress_payment']
    .filter((type) => canExport(approvalModule(type), type === 'purchase_request' ? 'procurement.read' : approvalReadPermission(type)));
  if (pendingApprovalTypes.length) allowedTools.add('get_pending_approvals');
  return { allowedTools, pendingApprovalTypes };
}
