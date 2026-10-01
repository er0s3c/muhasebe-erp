import { z } from 'zod';
import { isoDate, uuid } from './common';
import { ROLES } from '../permissions';

// --- İnşaat parametreleri (tarihli, kaynak notlu, doğrulama alanlı) ---------------

export const CONSTRUCTION_PARAM_KINDS = ['retention_pct', 'withholding_pct', 'advance_recoup_pct'] as const;
export type ConstructionParamKind = (typeof CONSTRUCTION_PARAM_KINDS)[number];

const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => Number(v) <= 100, 'Oran en çok %100 olabilir');

export const createConstructionParamSchema = z
  .object({
    kind: z.enum(CONSTRUCTION_PARAM_KINDS),
    value: percent,
    validFrom: isoDate,
    validTo: isoDate.nullable().optional(),
    sourceNote: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => !v.validTo || v.validTo >= v.validFrom, { message: 'Bitiş tarihi başlangıçtan önce olamaz', path: ['validTo'] });
export type CreateConstructionParamInput = z.infer<typeof createConstructionParamSchema>;

export const verifyConstructionParamSchema = z.object({
  verifiedBy: z.string().trim().min(2).max(120),
  sourceNote: z.string().trim().max(500).optional(),
});

// --- Onay motoru ---------------------------------------------------------------------

export const APPROVAL_DOC_TYPES = ['progress_payment'] as const;
export type ApprovalDocType = (typeof APPROVAL_DOC_TYPES)[number];

const approvalAmount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Geçersiz tutar');

export const approvalStepInputSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    userId: uuid.optional(),
    label: z.string().trim().max(60).optional(),
  })
  .refine((s) => !!s.role !== !!s.userId, { message: 'Adım için rol veya kullanıcıdan yalnızca biri seçilmeli' });

export const createApprovalRuleSchema = z
  .object({
    docType: z.enum(APPROVAL_DOC_TYPES),
    projectId: uuid.nullable().optional(),
    minAmount: approvalAmount.default('0'),
    maxAmount: approvalAmount.nullable().optional(),
    separateRequester: z.boolean().default(true),
    steps: z.array(approvalStepInputSchema).min(1, 'En az bir onay adımı gerekir').max(8),
  })
  .refine((r) => r.maxAmount == null || Number(r.maxAmount) > Number(r.minAmount), {
    message: 'Üst sınır alt sınırdan büyük olmalı',
    path: ['maxAmount'],
  });
export type CreateApprovalRuleInput = z.infer<typeof createApprovalRuleSchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
