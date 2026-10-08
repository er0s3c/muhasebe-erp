import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  unique,
  foreignKey,
  check,
  numeric,
  integer,
} from 'drizzle-orm/pg-core';
import { companies, users, items, warehouses, salesOrderLines } from './schema';
import { leatherProductionOrders } from './leather-schema';

export const manufacturingRecords = pgTable(
  'manufacturing_records',
  {
    id: uuid().primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: text().notNull(),
    code: text().notNull(),
    status: text().notNull().default('draft'),
    orderId: uuid(),
    itemId: uuid(),
    warehouseId: uuid(),
    sourceDocumentId: uuid(),
    requestKey: uuid(),
    config: jsonb().notNull().default({}),
  },
  (t) => [
    unique('manufacturing_records_id_company_id_key').on(t.id, t.companyId),
    unique('manufacturing_records_company_id_kind_code_key').on(t.companyId, t.kind, t.code),
    unique('manufacturing_records_company_id_kind_request_key_key').on(
      t.companyId,
      t.kind,
      t.requestKey,
    ),
    foreignKey({
      columns: [t.orderId, t.companyId],
      foreignColumns: [leatherProductionOrders.id, leatherProductionOrders.companyId],
    }),
    foreignKey({ columns: [t.itemId, t.companyId], foreignColumns: [items.id, items.companyId] }),
    foreignKey({
      columns: [t.warehouseId, t.companyId],
      foreignColumns: [warehouses.id, warehouses.companyId],
    }),
    check(
      'manufacturing_records_kind_check',
      sql`${t.kind} in ('resource','calendar','maintenance','schedule','transfer','bin','lot','lot_event','placement','shipment','connection','integration_event','demo_dataset','department','custom_field','attendance','supplier_profile','demand_policy','batch','work_session','rework','pattern','cut_plan','exception','cost_close','channel_mapping','inventory_outbox','command_event','service_time','material_handoff')`,
    ),
  ],
);

export const manufacturingSalesAllocations = pgTable('manufacturing_sales_allocations', {
  id: uuid().primaryKey(), companyId: uuid().notNull().references(()=>companies.id), createdBy: uuid().notNull().references(()=>users.id),
  salesOrderLineId: uuid().notNull(), itemId: uuid().notNull(), warehouseId: uuid().notNull(),
  quantity: numeric({precision:20,scale:4}).notNull(), fulfilledQty: numeric({precision:20,scale:4}).notNull().default('0'),
  priority: integer().notNull().default(50), reason: text().notNull(), status: text().notNull().default('active'),
  createdAt: timestamp({withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp({withTimezone:true}).notNull().defaultNow(),
}, t=>[
  unique('manufacturing_sales_allocations_id_company_id_key').on(t.id,t.companyId),
  unique('manufacturing_sales_allocations_company_id_sales_order_line_id_warehouse_id_key').on(t.companyId,t.salesOrderLineId,t.warehouseId),
  foreignKey({columns:[t.salesOrderLineId,t.companyId],foreignColumns:[salesOrderLines.id,salesOrderLines.companyId]}),
  foreignKey({columns:[t.itemId,t.companyId],foreignColumns:[items.id,items.companyId]}),
  foreignKey({columns:[t.warehouseId,t.companyId],foreignColumns:[warehouses.id,warehouses.companyId]}),
  check('manufacturing_sales_allocations_quantity_check',sql`${t.quantity}>=0`),
  check('manufacturing_sales_allocations_fulfilled_qty_check',sql`${t.fulfilledQty}>=0`),
  check('manufacturing_sales_allocations_priority_check',sql`${t.priority} between 0 and 100`),
  check('manufacturing_sales_allocations_status_check',sql`${t.status} in ('active','released')`),
]);
