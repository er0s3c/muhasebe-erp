import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';
import { documentSeriesSchema, INVOICE_PRINT_TEMPLATES } from './document-series';

export const operationsSettingsSchema = z.object({
  documentLimitMb: z.number().int().min(1).max(100).default(5),
  fieldLimitMb: z.number().int().min(1).max(25).default(25),
  requireMfa: z.boolean().default(false),
  automaticRates: z.boolean().default(false),
  rateHour: z.number().int().min(0).max(23).default(10),
  automaticBackup: z.boolean().default(false),
  backupHour: z.number().int().min(0).max(23).default(2),
  backupKeepCount: z.number().int().min(1).max(365).default(30),
  documentSeries: documentSeriesSchema,
  invoicePrintTemplate: z.enum(INVOICE_PRINT_TEMPLATES).default('detailed'),
});
export type OperationsSettings = z.infer<typeof operationsSettingsSchema>;
export const administrationQuerySchema = z.object({
  from: isoDate, to: isoDate, userId: uuid.optional(), table: z.string().regex(/^[a-z_]+$/).max(80).optional(),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).refine(v => v.to >= v.from && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 366, 'Rapor aralığı en fazla 367 gün olabilir.');
export type TimeSession = { id: string; taskId: string; title: string; userId: string; userName: string; startedAt: string; stoppedAt: string | null; seconds: number; note: string };
export type ActivityEvent = { id: string; at: string; userId: string | null; userName: string | null; table: string; rowId: string | null; action: string; changedFields: string[]; title: string | null; before: Record<string, unknown>; after: Record<string, unknown> };
export type ActivityReport = {
  summary: { events: number; people: number; seconds: number; completedTasks: number };
  daily: { date: string; events: number; seconds: number }[];
  users: { id: string; name: string; events: number; seconds: number; completedTasks: number }[];
  tables: { table: string; events: number }[];
  events: ActivityEvent[]; hasMore: boolean; sessions: TimeSession[];
  attendance: { employeeId: string; name: string; projectId: string | null; projectName: string | null; normalHours: string; overtimeHours: string; days: number }[];
};
