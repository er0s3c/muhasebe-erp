import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, numeric, timestamp, jsonb, boolean, unique, uniqueIndex, foreignKey, check, index } from 'drizzle-orm/pg-core';
import { companies, users, warehouses, treasuryAccounts, parties, invoices } from './schema';

export const posTills = pgTable('pos_tills', {
  id: uuid().primaryKey(), companyId: uuid().notNull().references(() => companies.id),
  name: text().notNull(), warehouseId: uuid().notNull(), cashAccountId: uuid().notNull(), cardAccountId: uuid(),
  walkInPartyId: uuid().notNull(), currencyCode: text().notNull(), maxDiscountPct: numeric({precision:7,scale:4}).notNull().default('0'),
  assignedUserIds: jsonb().$type<string[]>().notNull().default([]), isActive: boolean().notNull().default(true),
  createdBy: uuid().notNull().references(() => users.id), createdAt: timestamp({withTimezone:true}).notNull().defaultNow(),
}, t => [unique('pos_tills_company_id_uq').on(t.id,t.companyId), unique('pos_tills_name_uq').on(t.companyId,t.name), unique('pos_tills_cash_uq').on(t.companyId,t.cashAccountId),
  foreignKey({name:'pos_tills_warehouse_fk',columns:[t.warehouseId,t.companyId],foreignColumns:[warehouses.id,warehouses.companyId]}),
  foreignKey({name:'pos_tills_cash_fk',columns:[t.cashAccountId,t.companyId],foreignColumns:[treasuryAccounts.id,treasuryAccounts.companyId]}),
  foreignKey({name:'pos_tills_card_fk',columns:[t.cardAccountId,t.companyId],foreignColumns:[treasuryAccounts.id,treasuryAccounts.companyId]}),
  foreignKey({name:'pos_tills_party_fk',columns:[t.walkInPartyId,t.companyId],foreignColumns:[parties.id,parties.companyId]}),
  check('pos_tills_discount_ck',sql`${t.maxDiscountPct} between 0 and 100`),check('pos_tills_accounts_ck',sql`${t.cardAccountId} is null or ${t.cashAccountId} <> ${t.cardAccountId}`)]);

export const posSessions = pgTable('pos_sessions', {
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),tillId:uuid().notNull(),userId:uuid().notNull().references(()=>users.id),
  status:text().notNull().default('open'),openingCash:numeric({precision:19,scale:2}).notNull(),expectedCash:numeric({precision:19,scale:2}),
  countedCash:numeric({precision:19,scale:2}),variance:numeric({precision:19,scale:2}),closeReason:text(),openedAt:timestamp({withTimezone:true}).notNull().defaultNow(),closedAt:timestamp({withTimezone:true}),
},t=>[unique('pos_sessions_company_id_uq').on(t.id,t.companyId),foreignKey({name:'pos_sessions_till_fk',columns:[t.tillId,t.companyId],foreignColumns:[posTills.id,posTills.companyId]}),
  uniqueIndex('pos_sessions_open_till_uq').on(t.tillId).where(sql`${t.status}='open'`),uniqueIndex('pos_sessions_open_user_uq').on(t.companyId,t.userId).where(sql`${t.status}='open'`),
  check('pos_sessions_status_ck',sql`${t.status} in ('open','closed')`),check('pos_sessions_cash_ck',sql`${t.openingCash}>=0 and (${t.countedCash} is null or ${t.countedCash}>=0)`),
  check('pos_sessions_closed_ck',sql`(${t.status}='open' and ${t.closedAt} is null) or (${t.status}='closed' and ${t.closedAt} is not null and ${t.countedCash} is not null and ${t.expectedCash} is not null and ${t.variance}=${t.countedCash}-${t.expectedCash})`)]);

export interface PosPayment { method:'cash'|'card'; amount:string; transactionId?:string; journalEntryId?:string }
export const posSales = pgTable('pos_sales',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),sessionId:uuid().notNull(),requestId:uuid().notNull(),
  invoiceId:uuid().notNull(),sourceSaleId:uuid(),kind:text().notNull(),total:numeric({precision:19,scale:2}).notNull(),
  payments:jsonb().$type<PosPayment[]>().notNull(),requestHash:text().notNull(),createdBy:uuid().notNull().references(()=>users.id),createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('pos_sales_company_id_uq').on(t.id,t.companyId),unique('pos_sales_request_uq').on(t.companyId,t.requestId),unique('pos_sales_invoice_uq').on(t.invoiceId),
  foreignKey({name:'pos_sales_session_fk',columns:[t.sessionId,t.companyId],foreignColumns:[posSessions.id,posSessions.companyId]}),foreignKey({name:'pos_sales_invoice_fk',columns:[t.invoiceId,t.companyId],foreignColumns:[invoices.id,invoices.companyId]}),
  foreignKey({name:'pos_sales_source_fk',columns:[t.sourceSaleId,t.companyId],foreignColumns:[t.id,t.companyId]}),index('pos_sales_session_idx').on(t.companyId,t.sessionId),
  check('pos_sales_kind_ck',sql`(${t.kind}='sale' and ${t.sourceSaleId} is null) or (${t.kind}='return' and ${t.sourceSaleId} is not null)`),check('pos_sales_total_ck',sql`${t.total} > 0`)]);
