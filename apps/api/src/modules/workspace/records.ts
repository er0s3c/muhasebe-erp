import { sql } from 'drizzle-orm';
import { type Permission, type RecordKind, type SearchHit } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { forbidden, notFound } from '../../http/errors';
import { trContains } from '../../db/search';
import { isModuleDenied } from '../access/effective';

export const RECORDS: Record<
  RecordKind,
  {
    table: string;
    label: string;
    columns: string[];
    path: string;
    module: string;
    read: Permission;
    write: Permission;
    filter?: string;
  }
> = {
  foreign_worker_doc: {
    table:'foreign_worker_docs',label:"coalesce(number_last4,'Belge') || ' · ' || coalesce(expiry_date::text,'Süresiz')",
    columns:['number_last4','reference_note'],path:'/hr/foreign-workers?document=',module:'hr.foreign',read:'hr.sensitive',write:'hr.sensitive',
  },
  employee: {
    table: 'employees',
    label: "code || ' · ' || full_name",
    columns: ['code', 'full_name'],
    path: '/hr/employees/',
    module: 'hr.core',
    read: 'hr.sensitive',
    write: 'hr.sensitive',
  },
  transaction: {
    table: 'treasury_transactions',
    label: "txn_no || ' · ' || txn_date::text",
    columns: ['txn_no', 'description'],
    path: '/treasury/transactions?open=',
    module: 'core.treasury',
    read: 'treasury.read',
    write: 'treasury.manage',
  },
  site_report: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=site_report&open=',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
    filter: "kind='site_report'",
  },
  defect: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=defect&open=',
    module: 'construction.realestate',
    read: 'realestate.read',
    write: 'realestate.manage',
    filter: "kind='defect'",
  },
  rfi: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=rfi&open=',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
    filter: "kind='rfi'",
  },
  site_instruction: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=site_instruction&open=',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
    filter: "kind='site_instruction'",
  },
  quality_check: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=quality_check&open=',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
    filter: "kind='quality_check'",
  },
  safety: {
    table: 'operation_entries',
    label: 'title',
    columns: ['title'],
    path: '/workspace/operations?kind=safety&open=',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
    filter: "kind='safety'",
  },
  party: {
    table: 'parties',
    label: "code || ' · ' || name",
    columns: ['code', 'name'],
    path: '/parties/',
    module: 'core.parties',
    read: 'parties.read',
    write: 'parties.manage',
  },
  invoice: {
    table: 'invoices',
    label: "coalesce(invoice_no, external_no, 'Taslak fatura') || ' · ' || invoice_date::text",
    columns: ['invoice_no', 'external_no'],
    path: '/invoices/',
    module: 'core.invoices',
    read: 'invoices.read',
    write: 'invoices.manage',
  },
  project: {
    table: 'projects',
    label: "code || ' · ' || name",
    columns: ['code', 'name'],
    path: '/projects/',
    module: 'construction.projects',
    read: 'projects.read',
    write: 'projects.manage',
  },
  subcontract: {
    table: 'subcontracts',
    label: "code || ' · ' || title",
    columns: ['code', 'title'],
    path: '/subcontracts/',
    module: 'construction.subcontracts',
    read: 'subcontracts.read',
    write: 'subcontracts.manage',
  },
  sales_contract: {
    table: 'sales_contracts',
    label: 'code',
    columns: ['code'],
    path: '/real-estate/contracts/',
    module: 'construction.realestate',
    read: 'realestate.read',
    write: 'realestate.manage',
  },
};
export function canAccessRecord(ctx: TenantCtx, kind: RecordKind, write = false) {
  const def = RECORDS[kind];
  return ctx.enabledModules.has(def.module) && !isModuleDenied(ctx.access,def.module) && ctx.can(write ? def.write : def.read);
}
export async function requireRecord(ctx: TenantCtx, kind: RecordKind, id: string, write = false) {
  if (!canAccessRecord(ctx, kind, write)) throw forbidden();
  const def = RECORDS[kind];
  const result = await ctx.tx.execute(
    sql`select id from ${sql.identifier(def.table)} where id = ${id}::uuid ${def.filter ? sql`and ${sql.raw(def.filter)}` : sql``}`,
  );
  if (!result.rows.length) throw notFound();
  return def;
}
export async function searchRecords(ctx: TenantCtx, query: string, onlyKind?: RecordKind) {
  const hits: SearchHit[] = [];
  for (const kind of Object.keys(RECORDS) as RecordKind[]) {
    if (onlyKind && kind !== onlyKind) continue;
    if (!canAccessRecord(ctx, kind)) continue;
    const def = RECORDS[kind];
    const result = await ctx.tx.execute<{ id: string; label: string }>(sql`
      select id, ${sql.raw(def.label)} as label from ${sql.identifier(def.table)}
      where ${trContains(def.columns, query)} ${def.filter ? sql`and ${sql.raw(def.filter)}` : sql``} order by ${sql.raw(def.label)}, id limit 6`);
    hits.push(...result.rows.map((r) => ({ ...r, kind, path: def.path + r.id })));
  }
  return { items: hits };
}
