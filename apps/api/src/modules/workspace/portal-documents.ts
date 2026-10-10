import { sql, type SQL } from 'drizzle-orm';
import { areaOfModule, resourceOperationAllowed, portalScopeOf, type PortalDocumentKind, type PortalDocumentScopes, type PortalDocumentList, type PortalDocumentDetail } from '@erp/shared';
import type { Tx } from '../../db/client';
import { notFound } from '../../http/errors';
import { isModuleDenied, type MemberAccess } from '../access/effective';

export function portalModuleReadable(access: MemberAccess, modules: Set<string>, module: string, permission: 'parties.read' | 'invoices.read' | 'realestate.read' | 'subcontracts.read') {
  const area = areaOfModule(module);
  return modules.has(module) && access.permissions.has(permission) && !isModuleDenied(access, module) && !!area && resourceOperationAllowed(access.permissions, access.overrides, area, 'export');
}
export function availablePortalScopes(access: MemberAccess, modules: Set<string>): PortalDocumentScopes {
  const invoices = portalModuleReadable(access, modules, 'core.invoices', 'invoices.read');
  const orders = portalModuleReadable(access, modules, 'invoices.orders', 'invoices.read');
  return { invoices, quotes: orders, orders };
}
export function effectivePortalScopes(selected: PortalDocumentScopes, available: PortalDocumentScopes): PortalDocumentScopes {
  return { invoices: selected.invoices && available.invoices, quotes: selected.quotes && available.quotes, orders: selected.orders && available.orders };
}

// These explicit projections are the public contract. Staff IDs, costs, accounts, tax IDs,
// internal notes, legal snapshots and unrelated customer data never enter a response.
const summary = (kind: PortalDocumentKind) => kind === 'invoice'
  ? sql`id,'invoice' as kind,invoice_no as number,status,invoice_date::text as date,currency_code as currency,gross_total as "grossTotal",type`
  : sql`id,kind,doc_no as number,status,doc_date::text as date,currency_code as currency,gross_total as "grossTotal"`;
const publicPredicate = (partyId: string, kind: PortalDocumentKind): SQL => kind === 'invoice'
  ? sql`party_id=${partyId}::uuid and type in ('sales','sales_return') and status='posted'`
  : sql`party_id=${partyId}::uuid and kind=${kind} and ${kind === 'quote' ? sql`status in ('sent','accepted','converted')` : sql`status in ('confirmed','closed')`}`;

export async function listPortalDocuments(tx: Tx, partyId: string, kind: PortalDocumentKind, offset: number, limit: number): Promise<PortalDocumentList> {
  const table = kind === 'invoice' ? sql`invoices` : sql`sales_orders`;
  const predicate = publicPredicate(partyId, kind);
  const items = (await tx.execute<PortalDocumentList['items'][number] & Record<string, unknown>>(sql`select ${summary(kind)} from ${table} where ${predicate} order by ${kind === 'invoice' ? sql`invoice_date` : sql`doc_date`} desc,id desc limit ${limit} offset ${offset}`)).rows;
  const count = (await tx.execute<{ total: string }>(sql`select count(*) as total from ${table} where ${predicate}`)).rows[0];
  return { items, total: Number(count?.total ?? 0), offset, limit };
}
export async function getPortalDocument(tx: Tx, partyId: string, kind: PortalDocumentKind, id: string): Promise<PortalDocumentDetail> {
  const table = kind === 'invoice' ? sql`invoices` : sql`sales_orders`;
  const extra = kind === 'invoice'
    ? sql`due_date::text as "dueDate",null::text as "validUntil",null::text as "deliveryDate",coalesce(tax_totals_snapshot->>'vatWithheld','0.00') as "vatWithheld",coalesce(tax_totals_snapshot->>'incomeWithheld','0.00') as "incomeWithheld",coalesce(tax_totals_snapshot->>'stamp','0.00') as stamp,coalesce(tax_totals_snapshot->>'payableToSeller',gross_total::text) as "payableToSeller"`
    : sql`null::text as "dueDate",valid_until::text as "validUntil",delivery_date::text as "deliveryDate",'0.00' as "vatWithheld",'0.00' as "incomeWithheld",'0.00' as stamp,gross_total as "payableToSeller"`;
  const header = (await tx.execute<Omit<PortalDocumentDetail, 'lines'>>(sql`select ${summary(kind)},${extra},vat_included as "vatIncluded",net_total as "netTotal",vat_total as "vatTotal" from ${table} where id=${id}::uuid and ${publicPredicate(partyId, kind)}`)).rows[0];
  if (!header) throw notFound('Paylaşılan belge');
  const lines = (await tx.execute<PortalDocumentDetail['lines'][number] & Record<string, unknown>>(sql`select line_no as "lineNo",description,quantity,unit,unit_price as "unitPrice",discount_pct as "discountPct",vat_rate as "vatRate",net,vat,gross from ${kind === 'invoice' ? sql`invoice_lines` : sql`sales_order_lines`} where ${kind === 'invoice' ? sql`invoice_id` : sql`order_id`}=${id}::uuid order by line_no`)).rows;
  return { ...header, lines };
}
export function requirePortalDocumentScope(scopes: PortalDocumentScopes, kind: PortalDocumentKind) {
  if (!scopes[portalScopeOf(kind)]) throw notFound('Paylaşılan belge');
}
