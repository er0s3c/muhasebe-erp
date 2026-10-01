import { z } from 'zod';
import { currencyCode, isoDate, uuid } from './common';

// --- Birim ---------------------------------------------------------------------------------------

export const UNIT_TYPES = ['apartment', 'villa', 'shop', 'office', 'land', 'parking', 'storage', 'other'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];
export const UNIT_STATUSES = ['available', 'reserved', 'sold', 'handed_over'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

const area = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Geçersiz alan').refine((v) => Number(v) > 0, 'Alan sıfırdan büyük olmalı');
const price = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz tutar');
const positivePrice = price.refine((v) => Number(v) > 0, 'Tutar sıfırdan büyük olmalı');

const unitBody = {
  block: z.string().trim().max(40).default(''),
  floor: z.number().int().min(-5).max(200).nullable().optional(),
  unitNo: z.string().trim().min(1, 'Birim no gerekli').max(40),
  unitType: z.enum(UNIT_TYPES).default('apartment'),
  grossM2: area.nullable().optional(),
  netM2: area.nullable().optional(),
  rooms: z.string().trim().max(20).nullable().optional(),
  listPrice: price.nullable().optional(),
  listCurrency: currencyCode.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
};
const listPriceOk = (v: { listPrice?: string | null; listCurrency?: string | null }) => v.listPrice == null || !!v.listCurrency;
const listPriceMsg = { message: 'Liste fiyatı için para birimi seçin', path: ['listCurrency'] };

export const createUnitSchema = z.object({ projectId: uuid, ...unitBody }).refine(listPriceOk, listPriceMsg);
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export const updateUnitSchema = z.object(unitBody).refine(listPriceOk, listPriceMsg);
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;

/** Toplu üretim: blok × kat aralığı × kat başına adet; numara "kat + 2 haneli sıra" (3. kat 2. birim = 302). */
export const bulkUnitsSchema = z
  .object({
    projectId: uuid,
    block: z.string().trim().max(40).default(''),
    unitType: z.enum(UNIT_TYPES).default('apartment'),
    floorFrom: z.number().int().min(0).max(200),
    floorTo: z.number().int().min(0).max(200),
    perFloor: z.number().int().min(1).max(50),
    grossM2: area.nullable().optional(),
    netM2: area.nullable().optional(),
    rooms: z.string().trim().max(20).nullable().optional(),
    listPrice: price.nullable().optional(),
    listCurrency: currencyCode.nullable().optional(),
  })
  .refine((v) => v.floorTo >= v.floorFrom, { message: 'Son kat ilk kattan küçük olamaz', path: ['floorTo'] })
  .refine((v) => (v.floorTo - v.floorFrom + 1) * v.perFloor <= 500, { message: 'Tek seferde en çok 500 birim üretilir', path: ['perFloor'] })
  .refine(listPriceOk, listPriceMsg);
export type BulkUnitsInput = z.infer<typeof bulkUnitsSchema>;

export const unitListQuerySchema = z.object({
  projectId: uuid.optional(),
  status: z.enum(UNIT_STATUSES).optional(),
  block: z.string().trim().max(40).optional(),
});

// --- Satış sözleşmesi ----------------------------------------------------------------------------

export const SALES_CONTRACT_STATUSES = ['draft', 'active', 'handed_over', 'terminated', 'cancelled'] as const;
export type SalesContractStatus = (typeof SALES_CONTRACT_STATUSES)[number];
export const INSTALLMENT_KINDS = ['down_payment', 'installment', 'balloon'] as const;
export type InstallmentKind = (typeof INSTALLMENT_KINDS)[number];

export const installmentInputSchema = z.object({
  kind: z.enum(INSTALLMENT_KINDS).default('installment'),
  dueDate: isoDate,
  amount: positivePrice,
});
export type InstallmentInput = z.infer<typeof installmentInputSchema>;

const contractBody = {
  contractDate: isoDate,
  plannedHandover: isoDate.nullable().optional(),
  price: positivePrice,
  downPayment: price.default('0'),
  penaltyNote: z.string().trim().max(1000).nullable().optional(),
  installments: z.array(installmentInputSchema).min(1, 'En az bir taksit gerekli').max(240),
};
export const createSalesContractSchema = z.object({ unitId: uuid, partyId: uuid, currencyCode, ...contractBody });
export type CreateSalesContractInput = z.infer<typeof createSalesContractSchema>;
export const updateSalesContractSchema = z.object(contractBody);
export type UpdateSalesContractInput = z.infer<typeof updateSalesContractSchema>;

export const activateContractSchema = z.object({ date: isoDate.optional() });
export const handoverContractSchema = z.object({ date: isoDate.optional() });
export const cancelContractSchema = z.object({ reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300) });
export const terminateContractSchema = z.object({
  date: isoDate.optional(),
  reason: z.string().trim().min(3, 'Fesih nedeni gerekli').max(300),
  /** Alıcıdan kesilecek tutar (ceza şartı), sözleşme para biriminde; tahsil edilen tutarı aşamaz. */
  retained: price.default('0'),
  /** Tahsil edilen iade, bu kasa/banka hesabından ödenir (iade varsa). */
  refundAccountId: uuid.nullable().optional(),
});
export type TerminateContractInput = z.infer<typeof terminateContractSchema>;

export const salesContractListQuerySchema = z.object({
  projectId: uuid.optional(),
  partyId: uuid.optional(),
  status: z.enum(SALES_CONTRACT_STATUSES).optional(),
});

export const overdueQuerySchema = z.object({
  asOf: isoDate.optional(),
  projectId: uuid.optional(),
});
