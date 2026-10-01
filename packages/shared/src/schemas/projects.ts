import { z } from 'zod';
import { isoDate, uuid } from './common';

// --- Proje -------------------------------------------------------------------

/** `own`: kendi arsasında/adına yapılan iş (satış B3'te); `contract`: işverene yapılan iş (alınan hakediş B2'de). */
export const PROJECT_KINDS = ['own', 'contract'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'completed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Yeni maliyet/gelir satırı alabilen durumlar (ters kayıt fişleri her durumda yazılabilir). */
export const PROJECT_OPEN_STATUSES: readonly ProjectStatus[] = ['planned', 'active', 'on_hold'];

export const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  planned: ['active', 'cancelled'],
  active: ['on_hold', 'completed', 'cancelled'],
  on_hold: ['active', 'completed', 'cancelled'],
  completed: ['active'],
  cancelled: ['planned'],
};

const codeText = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Kod harf, rakam, nokta, tire ve alt çizgi içerebilir');

const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

/** En çok 2 ondalıklı, eksi olmayan tutar (bütçe, ETC). */
export const projectAmount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'Geçersiz tutar (en çok 2 ondalık)');

/** 0–100 arası yüzde, en çok 2 ondalık. */
export const projectPercentString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Geçersiz yüzde')
  .refine((v) => Number(v) <= 100, 'Yüzde 100’ü aşamaz');

export const createProjectSchema = z
  .object({
    /** Boşsa otomatik (PRJ-0001). */
    code: codeText.optional(),
    name: z.string().trim().min(2).max(160),
    kind: z.enum(PROJECT_KINDS).default('own'),
    /** `contract` projede işveren (müşteri carisi) zorunlu; `own` projede verilemez. */
    clientPartyId: uuid.nullable().optional(),
    startDate: isoDate.nullable().optional(),
    endDate: isoDate.nullable().optional(),
    location: clearableText(300),
    description: clearableText(2000),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'contract' && !p.clientPartyId) {
      ctx.addIssue({ code: 'custom', path: ['clientPartyId'], message: 'İşverene yapılan işte işveren (cari) seçilmeli' });
    }
    if (p.kind === 'own' && p.clientPartyId) {
      ctx.addIssue({ code: 'custom', path: ['clientPartyId'], message: 'Kendi projenizde işveren olmaz' });
    }
    if (p.startDate && p.endDate && p.endDate < p.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Bitiş tarihi başlangıçtan önce olamaz' });
    }
  });
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/** Tür (own/contract) oluşturulduktan sonra değişmez. */
export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  clientPartyId: uuid.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  location: clearableText(300),
  description: clearableText(2000),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectStatusSchema = z.object({ status: z.enum(PROJECT_STATUSES) });
export type ProjectStatusInput = z.infer<typeof projectStatusSchema>;

export const projectListQuerySchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  kind: z.enum(PROJECT_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

// --- İş kırılımı (WBS) -------------------------------------------------------

export const WBS_MAX_DEPTH = 6;

export const createWbsSchema = z.object({
  parentId: uuid.nullable().optional(),
  code: codeText,
  name: z.string().trim().min(1).max(160),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
export type CreateWbsInput = z.infer<typeof createWbsSchema>;

export const updateWbsSchema = z.object({
  /** Verilirse düğüm taşınır (null = köke). */
  parentId: uuid.nullable().optional(),
  code: codeText.optional(),
  name: z.string().trim().min(1).max(160).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWbsInput = z.infer<typeof updateWbsSchema>;

// --- Bütçe -------------------------------------------------------------------

export const createBudgetSchema = z.object({
  title: z.string().trim().max(120).optional(),
  /** true: yürürlükteki onaylı revizyonun satırları taslağa kopyalanır. */
  copyFromCurrent: z.boolean().default(false),
});
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const putBudgetLinesSchema = z.object({
  lines: z
    .array(z.object({ wbsId: uuid, amount: projectAmount }))
    .max(2000)
    .refine((l) => new Set(l.map((x) => x.wbsId)).size === l.length, 'Bir iş kalemi birden çok kez girilemez'),
});
export type PutBudgetLinesInput = z.infer<typeof putBudgetLinesSchema>;

// --- İlerleme ----------------------------------------------------------------

export const createProgressSchema = z.object({
  asOfDate: isoDate,
  items: z
    .array(
      z.object({
        wbsId: uuid,
        percent: projectPercentString,
        /** Elle tamamlanmaya kalan maliyet tahmini; boşsa formülle hesaplanır. */
        etcOverride: projectAmount.nullable().optional(),
        note: clearableText(300),
      }),
    )
    .min(1)
    .max(500)
    .refine((l) => new Set(l.map((x) => x.wbsId)).size === l.length, 'Bir iş kalemi birden çok kez girilemez'),
});
export type CreateProgressInput = z.infer<typeof createProgressSchema>;

// --- Raporlar ----------------------------------------------------------------

export const projectCostReportQuerySchema = z.object({ asOf: isoDate.optional() });
export type ProjectCostReportQuery = z.infer<typeof projectCostReportQuerySchema>;

export const projectTransactionsQuerySchema = z.object({
  wbsId: uuid.optional(),
  /** true: iş kalemi atanmamış satırlar. */
  unassigned: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ProjectTransactionsQuery = z.infer<typeof projectTransactionsQuerySchema>;

export const projectsSummaryQuerySchema = z.object({ asOf: isoDate.optional() });
export type ProjectsSummaryQuery = z.infer<typeof projectsSummaryQuerySchema>;

// --- Maliyet kodu (maliyet türü) -----------------------------------------------

export const COST_CODE_KINDS = ['material', 'labor', 'subcontract', 'equipment', 'transport', 'overhead', 'other'] as const;
export type CostCodeKind = (typeof COST_CODE_KINDS)[number];

/** Yeni şirkete tohumlanan maliyet kodları (şirket düzenleyebilir; hukuki parametre değildir). */
export const DEFAULT_COST_CODES: readonly { code: string; name: string; kind: CostCodeKind }[] = [
  { code: 'MLZ', name: 'Malzeme', kind: 'material' },
  { code: 'ISC', name: 'İşçilik', kind: 'labor' },
  { code: 'TSR', name: 'Taşeron', kind: 'subcontract' },
  { code: 'EKP', name: 'Ekipman', kind: 'equipment' },
  { code: 'NKL', name: 'Nakliye', kind: 'transport' },
  { code: 'GNL', name: 'Genel gider', kind: 'overhead' },
];

export const createCostCodeSchema = z.object({
  code: codeText,
  name: z.string().trim().min(1).max(100),
  kind: z.enum(COST_CODE_KINDS).default('other'),
});
export type CreateCostCodeInput = z.infer<typeof createCostCodeSchema>;

export const updateCostCodeSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(COST_CODE_KINDS),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'En az bir alan verilmeli');
export type UpdateCostCodeInput = z.infer<typeof updateCostCodeSchema>;
