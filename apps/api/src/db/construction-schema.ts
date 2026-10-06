import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  doublePrecision,
  date,
  boolean,
  unique,
  foreignKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { companies, projects, users, projectWbs } from './schema';
const base = () => ({
  id: uuid().primaryKey(),
  companyId: uuid()
    .notNull()
    .references(() => companies.id),
  projectId: uuid().notNull(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
export const constructionLocations = pgTable(
  'construction_locations',
  { ...base(), parentId: uuid(), kind: text().notNull(), name: text().notNull() },
  (t) => [
    unique('cl_id_company').on(t.id, t.companyId),
    foreignKey({
      name: 'construction_locations_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('cl_project').on(t.companyId, t.projectId),
    check('cl_kind', sql`${t.kind} in ('building','level','zone')`),
  ],
);
export const constructionAssets = pgTable(
  'construction_assets',
  {
    ...base(),
    filename: text().notNull(),
    mime: text().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
  },
  (t) => [
    unique('ca_id_company').on(t.id, t.companyId),
    foreignKey({
      name: 'construction_assets_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    index('ca_project').on(t.companyId, t.projectId),
    check('ca_size', sql`${t.size} between 1 and 26214400`),
  ],
);
export const constructionDrawings = pgTable(
  'construction_drawings',
  {
    ...base(),
    assetId: uuid().notNull(),
    code: text().notNull(),
    title: text().notNull(),
    discipline: text().notNull(),
    revision: text().notNull(),
    previousId: uuid(),
    status: text().notNull().default('draft'),
    version: integer().notNull().default(1),
    decisionNote: text(),
  },
  (t) => [
    unique('cd_id_company').on(t.id, t.companyId),
    unique('cd_code_revision').on(t.companyId, t.projectId, t.code, t.revision),
    unique('cd_previous').on(t.previousId),
    foreignKey({
      name: 'construction_drawings_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'construction_drawings_f2',
      columns: [t.assetId, t.companyId],
      foreignColumns: [constructionAssets.id, constructionAssets.companyId],
    }),
    index('cd_project').on(t.companyId, t.projectId),
    check('cd_status', sql`${t.status} in ('draft','approved','obsolete')`),
  ],
);
export const constructionPins = pgTable(
  'construction_pins',
  {
    ...base(),
    drawingId: uuid().notNull(),
    locationId: uuid(),
    page: integer().notNull(),
    x: doublePrecision().notNull(),
    y: doublePrecision().notNull(),
    label: text().notNull(),
    recordKind: text().notNull(),
    recordId: uuid().notNull(),
    clientId: uuid().notNull(),
  },
  (t) => [
    unique('cp_client').on(t.companyId, t.clientId),
    foreignKey({
      name: 'construction_pins_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'construction_pins_f2',
      columns: [t.drawingId, t.companyId],
      foreignColumns: [constructionDrawings.id, constructionDrawings.companyId],
    }),
    foreignKey({
      name: 'construction_pins_f3',
      columns: [t.locationId, t.companyId],
      foreignColumns: [constructionLocations.id, constructionLocations.companyId],
    }),
    index('cp_drawing').on(t.companyId, t.drawingId),
    check('cp_xy', sql`${t.x} between 0 and 1 and ${t.y} between 0 and 1 and ${t.page}>0`),
  ],
);
export const constructionPhotos = pgTable(
  'construction_photos',
  {
    ...base(),
    locationId: uuid().notNull(),
    assetId: uuid().notNull(),
    date: date({ mode: 'string' }).notNull(),
    caption: text().notNull(),
    panorama: boolean().notNull().default(false),
    operationId: uuid(),
    clientId: uuid(),
  },
  (t) => [
    unique('cphoto_client').on(t.companyId, t.clientId),
    foreignKey({
      name: 'construction_photos_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'construction_photos_f2',
      columns: [t.locationId, t.companyId],
      foreignColumns: [constructionLocations.id, constructionLocations.companyId],
    }),
    foreignKey({
      name: 'construction_photos_f3',
      columns: [t.assetId, t.companyId],
      foreignColumns: [constructionAssets.id, constructionAssets.companyId],
    }),
    index('cph_location').on(t.companyId, t.locationId, t.date),
  ],
);
export const constructionSnapshots = pgTable(
  'construction_snapshots',
  { ...base(), date: date({ mode: 'string' }).notNull(), payload: jsonb().notNull() },
  (t) => [
    unique('cs_project_day').on(t.companyId, t.projectId, t.date),
    foreignKey({
      name: 'construction_snapshots_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
  ],
);

/** Discriminated, validated domain records share versioning and an append-only decision history. */
export const constructionWorkflows = pgTable(
  'construction_workflows',
  {
    ...base(),
    kind: text().notNull(),
    title: text().notNull(),
    locationId: uuid(),
    wbsId: uuid(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    status: text().notNull().default('draft'),
    payload: jsonb().notNull(),
    computed: jsonb().notNull().default({}),
    version: integer().notNull().default(1),
    linkedKind: text(),
    linkedId: uuid(),
  },
  (t) => [
    unique('cw_id_company').on(t.id, t.companyId),
    foreignKey({
      name: 'construction_workflows_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'construction_workflows_f2',
      columns: [t.locationId, t.companyId],
      foreignColumns: [constructionLocations.id, constructionLocations.companyId],
    }),
    foreignKey({
      name: 'construction_workflows_f3',
      columns: [t.wbsId, t.companyId],
      foreignColumns: [projectWbs.id, projectWbs.companyId],
    }),
    index('cw_project').on(t.companyId, t.projectId, t.kind, t.status),
  ],
);
export const constructionWorkflowEvents = pgTable(
  'construction_workflow_events',
  {
    id: uuid().primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    workflowId: uuid().notNull(),
    action: text().notNull(),
    note: text().notNull(),
    data: jsonb().notNull().default({}),
    by: uuid()
      .notNull()
      .references(() => users.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'construction_workflow_events_f1',
      columns: [t.workflowId, t.companyId],
      foreignColumns: [constructionWorkflows.id, constructionWorkflows.companyId],
    }),
    index('cwe_workflow').on(t.companyId, t.workflowId, t.at),
  ],
);
export const constructionProductionAllocations = pgTable(
  'construction_production_allocations',
  {
    id: uuid().primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    productionId: uuid().notNull(),
    paymentId: uuid().notNull(),
    quantity: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'construction_production_allocations_f1',
      columns: [t.productionId, t.companyId],
      foreignColumns: [constructionWorkflows.id, constructionWorkflows.companyId],
    }),
    index('cpa_production').on(t.companyId, t.productionId),
  ],
);
export const constructionJobs = pgTable(
  'construction_jobs',
  {
    ...base(),
    assetId: uuid().notNull(),
    kind: text().notNull(),
    status: text().notNull().default('queued'),
    attempts: integer().notNull().default(0),
    progress: integer().notNull().default(0),
    error: text(),
    resultHash: text(),
    summary: jsonb().notNull().default({}),
    leaseUntil: timestamp({ withTimezone: true }),
    version: integer().notNull().default(1),
    reviewedRecordKind: text(),
    reviewedRecordId: uuid(),
  },
  (t) => [
    unique('cj_id_company').on(t.id, t.companyId),
    foreignKey({
      name: 'construction_jobs_f1',
      columns: [t.projectId, t.companyId],
      foreignColumns: [projects.id, projects.companyId],
    }),
    foreignKey({
      name: 'construction_jobs_f2',
      columns: [t.assetId, t.companyId],
      foreignColumns: [constructionAssets.id, constructionAssets.companyId],
    }),
    check('cj_kind', sql`${t.kind} in ('ifc','ocr')`),
    check('cj_status', sql`${t.status} in ('queued','running','completed','failed')`),
    index('cj_queue').on(t.companyId, t.status, t.createdAt),
  ],
);
export const constructionModelLinks = pgTable(
  'construction_model_links',
  {
    id: uuid().primaryKey(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id),
    jobId: uuid().notNull(),
    guid: text().notNull(),
    wbsId: uuid(),
    operationId: uuid(),
    version: integer().notNull().default(1),
  },
  (t) => [
    unique('cml_element').on(t.companyId, t.jobId, t.guid),
    foreignKey({
      name: 'construction_model_links_f1',
      columns: [t.jobId, t.companyId],
      foreignColumns: [constructionJobs.id, constructionJobs.companyId],
    }),
    foreignKey({
      name: 'construction_model_links_f2',
      columns: [t.wbsId, t.companyId],
      foreignColumns: [projectWbs.id, projectWbs.companyId],
    }),
  ],
);
