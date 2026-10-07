import { sql } from 'drizzle-orm';
import { type Permission, type RecordKind, type SearchHit } from '@erp/shared';
import type { TenantCtx } from '../../http/context';
import { forbidden, notFound } from '../../http/errors';
import { trContains } from '../../db/search';
import { isModuleDenied } from '../access/effective';
import { posSaleScope } from '../pos/scope';
import { productionOrderScope } from '../leather/visibility';

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
  manufacturing_model: {
    table: 'leather_models',
    label: "code || ' · ' || name",
    columns: ['code', 'name'],
    path: '/manufacturing/catalog?open=',
    module: 'manufacturing.catalog',
    read: 'manufacturing.catalog.read',
    write: 'manufacturing.catalog.manage',
  },
  manufacturing_production: {
    table: 'leather_production_orders',
    label: 'code',
    columns: ['code'],
    path: '/manufacturing/production?open=',
    module: 'manufacturing.production',
    read: 'manufacturing.production.read',
    write: 'manufacturing.production.manage',
  },
  manufacturing_subcontract: {
    table: 'leather_subcontract_jobs',
    label:
      "operation_key || ' · ' || coalesce((select p.name from parties p where p.id=r.party_id),'Fason')",
    columns: ['operation_key', '(select p.name from parties p where p.id=r.party_id)'],
    path: '/manufacturing/subcontracting?open=',
    module: 'manufacturing.subcontracting',
    read: 'manufacturing.subcontracting.read',
    write: 'manufacturing.subcontracting.manage',
  },
  manufacturing_resource: {
    table: 'manufacturing_records',
    label: 'code',
    columns: ['code'],
    path: '/manufacturing/planning?open=',
    module: 'manufacturing.planning',
    read: 'manufacturing.planning.read',
    write: 'manufacturing.planning.manage',
    filter: "r.kind='resource'",
  },
  manufacturing_maintenance: {
    table: 'manufacturing_records',
    label: 'code',
    columns: ['code'],
    path: '/manufacturing/maintenance?open=',
    module: 'manufacturing.maintenance',
    read: 'manufacturing.maintenance.read',
    write: 'manufacturing.maintenance.manage',
    filter: "r.kind='maintenance'",
  },
  wms_lot: {
    table: 'manufacturing_records',
    label: 'code',
    columns: ['code'],
    path: '/wms?open=',
    module: 'inventory.wms',
    read: 'inventory.wms.read',
    write: 'inventory.wms.manage',
    filter: "r.kind='lot'",
  },
  logistics_shipment: {
    table: 'manufacturing_records',
    label: 'code',
    columns: ['code'],
    path: '/logistics?open=',
    module: 'sales.logistics',
    read: 'sales.logistics.read',
    write: 'sales.logistics.manage',
    filter: "r.kind='shipment'",
  },
  leather_model: {
    table: 'leather_models',
    label: "code || ' · ' || name",
    columns: ['code', 'name'],
    path: '/leather/models?open=',
    module: 'leather.catalog',
    read: 'leather.catalog.read',
    write: 'leather.catalog.manage',
  },
  leather_piece: {
    table: 'leather_pieces',
    label: "code || ' · ' || status",
    columns: ['code'],
    path: '/leather/materials?piece=',
    module: 'leather.materials',
    read: 'leather.materials.read',
    write: 'leather.materials.manage',
  },
  leather_production: {
    table: 'leather_production_orders',
    label: "code || ' · ' || status",
    columns: ['code'],
    path: '/leather/production?open=',
    module: 'leather.production',
    read: 'leather.production.read',
    write: 'leather.production.manage',
  },
  leather_subcontract: {
    table: 'leather_subcontract_jobs',
    label:
      "operation_key || ' · ' || coalesce((select p.name from parties p where p.id=r.party_id),'Fason')",
    columns: ['operation_key', '(select p.name from parties p where p.id=r.party_id)'],
    path: '/leather/subcontracts?open=',
    module: 'leather.subcontracting',
    read: 'leather.subcontracting.read',
    write: 'leather.subcontracting.manage',
  },
  leather_custom_order: {
    table: 'leather_custom_orders',
    label:
      "'Özel sipariş · ' || coalesce((select p.name from parties p where p.id=r.party_id),'Müşteri') || ' · ' || due_date::text",
    columns: [
      'id::text',
      '(select p.name from parties p where p.id=r.party_id)',
      "config->>'customerNotes'",
      "config->>'monogram'",
    ],
    path: '/leather/custom-orders?open=',
    module: 'leather.catalog',
    read: 'leather.catalog.read',
    write: 'leather.catalog.manage',
  },
  leather_service: {
    table: 'leather_service_cases',
    label:
      "'Servis · ' || coalesce((select p.name from parties p where p.id=r.party_id),'Müşteri') || ' · ' || date::text",
    columns: [
      'id::text',
      '(select p.name from parties p where p.id=r.party_id)',
      "config->>'complaint'",
    ],
    path: '/leather/service?open=',
    module: 'leather.service',
    read: 'leather.service.read',
    write: 'leather.service.manage',
  },
  pos_sale: {
    table: 'pos_sales',
    label:
      "case when kind='return' then 'POS iade' else 'POS satış' end || ' · ' || coalesce((select i.invoice_no from invoices i where i.id=r.invoice_id),left(id::text,8))",
    columns: [
      'id::text',
      'invoice_id::text',
      '(select i.invoice_no from invoices i where i.id=r.invoice_id)',
    ],
    path: '/pos/sales/',
    module: 'sales.pos',
    read: 'pos.read',
    write: 'pos.sell',
  },
  foreign_worker_doc: {
    table: 'foreign_worker_docs',
    label: "coalesce(number_last4,'Belge') || ' · ' || coalesce(expiry_date::text,'Süresiz')",
    columns: ['number_last4', 'reference_note'],
    path: '/hr/foreign-workers?document=',
    module: 'hr.foreign',
    read: 'hr.sensitive',
    write: 'hr.sensitive',
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
  return (
    ctx.enabledModules.has(def.module) &&
    !isModuleDenied(ctx.access, def.module) &&
    ctx.can(write ? def.write : def.read)
  );
}
/** All shared lists must apply the same row scope as the source API. */
export function recordScope(ctx: TenantCtx, kind: RecordKind, alias = 'r') {
  const def = RECORDS[kind];
  return sql`${def.filter ? sql.raw(def.filter) : sql`true`}
    ${kind === 'pos_sale' ? sql`and ${posSaleScope(ctx.user.id, ctx.can('pos.manage'), alias)}` : sql``}
    ${['leather_production', 'manufacturing_production'].includes(kind) ? sql`and ${productionOrderScope(ctx.role, ctx.user.id, alias)}` : sql``}`;
}
export function recordLinkVisibility(ctx: TenantCtx, kindColumn: string, idColumn: string) {
  const visible = (Object.keys(RECORDS) as RecordKind[])
    .filter((k) => canAccessRecord(ctx, k))
    .map(
      (k) =>
        sql`(${sql.raw(kindColumn)}=${k} and exists(select 1 from ${sql.identifier(RECORDS[k].table)} r
      where r.id=${sql.raw(idColumn)} and ${recordScope(ctx, k)}))`,
    );
  return sql`(${sql.raw(kindColumn)} is null ${visible.length ? sql`or ${sql.join(visible, sql` or `)}` : sql``})`;
}
export async function requireRecord(ctx: TenantCtx, kind: RecordKind, id: string, write = false) {
  if (!canAccessRecord(ctx, kind, write)) throw forbidden();
  const def = RECORDS[kind];
  const result = await ctx.tx.execute(
    sql`select id from ${sql.identifier(def.table)} r where id = ${id}::uuid and ${recordScope(ctx, kind)}`,
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
      select id, ${sql.raw(def.label)} as label from ${sql.identifier(def.table)} r
      where ${trContains(def.columns, query)} and ${recordScope(ctx, kind)} order by ${sql.raw(def.label)}, id limit 6`);
    hits.push(...result.rows.map((r) => ({ ...r, kind, path: def.path + r.id })));
  }
  return { items: hits };
}
