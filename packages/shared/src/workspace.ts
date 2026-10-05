import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';

export const recordKindSchema = z.enum(['party', 'invoice', 'project', 'subcontract', 'sales_contract', 'employee', 'transaction', 'site_report', 'defect']);
export type RecordKind = z.infer<typeof recordKindSchema>;
export const recordRefSchema = z.object({ kind: recordKindSchema, id: uuid });
export const workItemSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4000).default(''),
  dueDate: isoDate,
  ownerId: uuid.optional(),
  priority: z.enum(['normal', 'high']).default('normal'),
  record: recordRefSchema.optional(),
});
export type WorkItemInput = z.infer<typeof workItemSchema>;
export const workItemUpdateSchema = workItemSchema.partial().extend({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  version: z.number().int().positive(),
});
const hasInvalidFilenameChar = (value: string) =>
  [...value].some((char) => char === '/' || char === '\\' || char.charCodeAt(0) <= 0x1f);

export const documentUploadSchema = z.object({
  record: recordRefSchema,
  filename: z.string().trim().min(1).max(180).refine((v) => !hasInvalidFilenameChar(v), 'Geçersiz dosya adı'),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  base64: z.string().min(4).max(7_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  previousId: uuid.optional(),
});
export interface SearchHit { id: string; kind: RecordKind; label: string; path: string }
export type WorkItem = {
  id: string; title: string; description: string; dueDate: string; ownerId: string;
  ownerName: string; priority: 'normal' | 'high'; status: 'open' | 'done' | 'cancelled';
  version: number; recordKind: RecordKind | null; recordId: string | null; createdBy: string;
}
