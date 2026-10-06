import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer, jsonb, index, check, foreignKey, uniqueIndex,unique,date,boolean } from 'drizzle-orm/pg-core';
import { companies, users, workItems,invoices,journalEntries } from './schema';

export const companyOperationsSettings = pgTable('company_operations_settings', {
  companyId: uuid().primaryKey().references(() => companies.id),
  settings: jsonb().notNull().default({}),
  version: integer().notNull().default(1),
  updatedBy: uuid().notNull().references(() => users.id),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const workTimeSessions = pgTable('work_time_sessions', {
  id: uuid().primaryKey(), companyId: uuid().notNull().references(() => companies.id),
  taskId: uuid().notNull(), userId: uuid().notNull().references(() => users.id),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp({ withTimezone: true }), note: text().notNull().default(''),
}, t => [
  foreignKey({ name: 'work_time_task_fk', columns: [t.taskId, t.companyId], foreignColumns: [workItems.id, workItems.companyId] }),
  index('work_time_company_user').on(t.companyId, t.userId, t.startedAt),
  uniqueIndex('work_time_one_active').on(t.companyId, t.userId).where(sql`${t.stoppedAt} is null`),
  check('work_time_bounds', sql`${t.stoppedAt} is null or (${t.stoppedAt} >= ${t.startedAt} and ${t.stoppedAt} <= ${t.startedAt} + interval '24 hours')`),
]);
export const administrationRuns = pgTable('administration_runs', {
  id: uuid().primaryKey(), companyId: uuid().notNull().references(() => companies.id),
  kind: text().notNull(), status: text().notNull(), requestedBy: uuid().notNull().references(() => users.id),
  startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp({ withTimezone: true }),
  result: jsonb().notNull().default({}), error: text(),
},t=>[index('administration_runs_company').on(t.companyId,t.kind,t.startedAt)]);
export const rateLimitBuckets=pgTable('rate_limit_buckets',{
  key:text().primaryKey(),count:integer().notNull(),expiresAt:timestamp({withTimezone:true}).notNull(),
},t=>[index('rate_limit_expiry').on(t.expiresAt)]);
export const recurringTemplates=pgTable('recurring_templates',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),kind:text().notNull(),title:text().notNull(),
  recurrence:jsonb().notNull(),payload:jsonb().notNull(),status:text().notNull().default('active'),nextDate:date({mode:'string'}),
  generated:integer().notNull().default(0),version:integer().notNull().default(1),createdBy:uuid().notNull().references(()=>users.id),
  createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),error:text(),
},t=>[unique('recurring_templates_id_company').on(t.id,t.companyId),index('recurring_templates_due').on(t.companyId,t.status,t.nextDate),check('recurring_template_kind',sql`${t.kind} in ('agenda','invoice')`),check('recurring_template_status',sql`${t.status} in ('active','paused','finished')`)]);
export const recurringOccurrences=pgTable('recurring_occurrences',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),templateId:uuid().notNull(),date:date({mode:'string'}).notNull(),
  targetId:uuid().notNull(),createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[foreignKey({name:'recurring_occurrence_template',columns:[t.templateId,t.companyId],foreignColumns:[recurringTemplates.id,recurringTemplates.companyId]}),unique('recurring_occurrence_unique').on(t.templateId,t.date)]);
export const savedInsights=pgTable('saved_insights',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),createdBy:uuid().notNull().references(()=>users.id),
  config:jsonb().notNull(),version:integer().notNull().default(1),archived:boolean().notNull().default(false),
  createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[index('saved_insights_company_owner').on(t.companyId,t.createdBy)]);
export const salesCampaigns=pgTable('sales_campaigns',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),code:text().notNull(),
  config:jsonb().notNull(),version:integer().notNull().default(1),createdBy:uuid().notNull().references(()=>users.id),
  createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('sales_campaign_code').on(t.companyId,t.code),unique('sales_campaign_id_company').on(t.id,t.companyId)]);
export const campaignApplications=pgTable('campaign_applications',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),campaignId:uuid().notNull(),invoiceId:uuid().notNull(),
  snapshot:jsonb().notNull(),createdBy:uuid().notNull().references(()=>users.id),createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('campaign_invoice_once').on(t.invoiceId),foreignKey({name:'campaign_application_campaign',columns:[t.campaignId,t.companyId],foreignColumns:[salesCampaigns.id,salesCampaigns.companyId]}),foreignKey({name:'campaign_application_invoice',columns:[t.invoiceId,t.companyId],foreignColumns:[invoices.id,invoices.companyId]})]);

export const fixedAssets=pgTable('fixed_assets',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),code:text().notNull(),config:jsonb().notNull(),
  version:integer().notNull().default(1),active:boolean().notNull().default(true),createdBy:uuid().notNull().references(()=>users.id),
  createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[unique('fixed_asset_code').on(t.companyId,t.code),unique('fixed_asset_id_company').on(t.id,t.companyId)]);
export const assetDepreciation=pgTable('asset_depreciation',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),assetId:uuid().notNull(),month:text().notNull(),
  amount:text().notNull(),snapshot:jsonb().notNull(),journalEntryId:uuid().notNull(),reversalEntryId:uuid(),
  cancelledAt:timestamp({withTimezone:true}),cancelReason:text(),createdBy:uuid().notNull().references(()=>users.id),createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),
},t=>[foreignKey({name:'asset_depreciation_asset',columns:[t.assetId,t.companyId],foreignColumns:[fixedAssets.id,fixedAssets.companyId]}),foreignKey({name:'asset_depreciation_journal',columns:[t.journalEntryId,t.companyId],foreignColumns:[journalEntries.id,journalEntries.companyId]}),foreignKey({name:'asset_depreciation_reversal',columns:[t.reversalEntryId,t.companyId],foreignColumns:[journalEntries.id,journalEntries.companyId]}),uniqueIndex('asset_depreciation_period').on(t.assetId,t.month).where(sql`${t.cancelledAt} is null`),check('asset_depreciation_month',sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),check('asset_depreciation_amount',sql`${t.amount}::numeric>0`)]);

export const companyBudgets=pgTable('company_budgets',{
  id:uuid().primaryKey(),companyId:uuid().notNull().references(()=>companies.id),seriesId:uuid().notNull(),
  revision:integer().notNull(),version:integer().notNull().default(1),status:text().notNull().default('draft'),config:jsonb().notNull(),
  createdBy:uuid().notNull().references(()=>users.id),createdAt:timestamp({withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp({withTimezone:true}).notNull().defaultNow(),
  approvedBy:uuid().references(()=>users.id),approvedAt:timestamp({withTimezone:true}),
},t=>[unique('company_budget_revision').on(t.companyId,t.seriesId,t.revision),uniqueIndex('company_budget_draft').on(t.companyId,t.seriesId).where(sql`${t.status}='draft'`),uniqueIndex('company_budget_approved').on(t.companyId,t.seriesId).where(sql`${t.status}='approved'`),check('company_budget_status',sql`${t.status} in ('draft','approved','superseded')`),check('company_budget_revision_positive',sql`${t.revision}>0 and ${t.version}>0`),check('company_budget_approval',sql`(${t.status}='draft' and ${t.approvedBy} is null and ${t.approvedAt} is null) or (${t.status}<>'draft' and ${t.approvedBy} is not null and ${t.approvedAt} is not null)`)]);
