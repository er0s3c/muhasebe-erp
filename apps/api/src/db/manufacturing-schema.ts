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
} from 'drizzle-orm/pg-core';
import { companies, users, items, warehouses } from './schema';
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
      sql`${t.kind} in ('resource','calendar','maintenance','schedule','transfer','bin','lot','lot_event','placement','shipment','connection','integration_event','demo_dataset','department','custom_field','attendance')`,
    ),
  ],
);
