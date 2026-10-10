import type { ApprovalDocType, Permission } from '@erp/shared';

export const GENERAL_APPROVAL_TYPES = ['invoice', 'sales_quote', 'payment', 'expense'] as const;
export type GeneralApprovalType = (typeof GENERAL_APPROVAL_TYPES)[number];
export const isGeneralApprovalType = (type: string): type is GeneralApprovalType =>
  (GENERAL_APPROVAL_TYPES as readonly string[]).includes(type);
export const DOCUMENT_APPROVAL_LABELS: Record<GeneralApprovalType, string> = {
  invoice: 'Fatura',
  sales_quote: 'Satış teklifi',
  payment: 'Ödeme',
  expense: 'Gider',
};
export const approvalPermission = (type: string): Permission =>
  type === 'purchase_request'
    ? 'procurement.approve'
    : type === 'invoice' || type === 'sales_quote'
      ? 'invoices.post'
      : type === 'payment' || type === 'expense'
        ? 'treasury.post'
        : 'subcontracts.approve';
export const approvalReadPermission = (type: string): Permission =>
  type === 'invoice' || type === 'sales_quote'
    ? 'invoices.read'
    : type === 'payment' || type === 'expense'
      ? 'treasury.read'
      : 'subcontracts.read';
export const approvalManagePermission = (type: string): Permission =>
  type === 'purchase_request'
    ? 'procurement.manage'
    : type === 'invoice' || type === 'sales_quote'
      ? 'invoices.manage'
      : type === 'payment' || type === 'expense'
        ? 'treasury.manage'
        : 'subcontracts.manage';
export const approvalModule = (type: string) =>
  type === 'invoice'
    ? 'core.invoices'
    : type === 'sales_quote'
      ? 'invoices.orders'
      : type === 'expense'
        ? 'treasury.expenses'
        : type === 'payment'
          ? 'core.treasury'
          : type === 'purchase_request'
            ? 'core.procurement'
            : 'construction.subcontracts';
export const asApprovalType = (type: string) => type as ApprovalDocType;
