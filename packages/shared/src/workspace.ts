import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';

export const recordKindSchema = z.enum([
  'party',
  'invoice',
  'project',
  'subcontract',
  'sales_contract',
  'employee',
  'foreign_worker_doc',
  'transaction',
  'site_report',
  'defect',
  'rfi',
  'site_instruction',
  'quality_check',
  'safety',
]);
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
  record: recordRefSchema.nullable().optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  version: z.number().int().positive(),
});
export const documentUploadSchema = z.object({
  record: recordRefSchema,
  filename: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine(
      (v) => !/[\\/]/.test(v) && !Array.from(v).some((char) => char.charCodeAt(0) < 32),
      'Geçersiz dosya adı',
    ),
  mime: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  base64: z
    .string()
    .min(4)
    .max(140_000_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  previousId: uuid.optional(),
});
export interface SearchHit {
  id: string;
  kind: RecordKind;
  label: string;
  path: string;
}
export type WorkItem = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  ownerId: string;
  ownerName: string;
  priority: 'normal' | 'high';
  status: 'open' | 'done' | 'cancelled';
  version: number;
  recordKind: RecordKind | null;
  recordId: string | null;
  createdBy: string;
};
