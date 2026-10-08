import { z } from 'zod';
import { dec, decCheck, roundMoney, tryDec, type MoneyValue } from './money';
import { currencyCode, isoDate, uuid } from './schemas/common';
import { positiveQuantity, quantityString, unitCostString } from './schemas/inventory';

export const LEATHER_FAMILIES = [
  'wallet',
  'card_holder',
  'bag',
  'suitcase',
  'belt',
  'accessory',
] as const;
export const LEATHER_OPERATIONS = [
  'selection',
  'cutting',
  'splitting',
  'skiving',
  'punching',
  'embossing',
  'gluing',
  'stitching',
  'edge_finishing',
  'assembly',
  'final_quality',
  'packing',
] as const;
const text = (n: number) => z.string().trim().min(1).max(n);
const note = z.string().trim().max(2000).default('');
export const leatherModelSchema = z.object({
  code: text(40),
  name: text(160),
  family: z.enum(LEATHER_FAMILIES),
  description: note,
});
export type LeatherModelInput = z.infer<typeof leatherModelSchema>;
export const leatherBomLineSchema = z.object({
  itemId: uuid,
  quantity: positiveQuantity,
  wastePct: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,4})?$/)
    .refine(decCheck((d) => d.lte(100)))
    .default('0'),
  note: z.string().trim().max(300).default(''),
});
export const leatherRevisionSchema = z.object({
  name: text(100),
  materials: z.array(leatherBomLineSchema).min(1).max(100),
  operations: z
    .array(
      z.object({
        key: text(50),
        name: text(100),
        station: z.string().trim().max(100).default(''),
        plannedMinutes: quantityString.default('0'),
        resources: z
          .array(
            z.object({
              resourceId: uuid,
              minutesPerUnit: positiveQuantity,
              priority: z.number().int().min(0).max(100).default(50),
            }),
          )
          .max(50)
          .default([]),
        outsourced: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(40),
  specifications: z.record(z.string(), z.string().max(1000)).default({}),
  attachments: z.array(uuid).max(30).default([]),
  sampleNotes: note,
  sampleApproved: z.boolean().default(false),
});
export type LeatherRevisionInput = z.infer<typeof leatherRevisionSchema>;
export const leatherVariantSchema = z.object({
  modelId: uuid,
  revisionId: uuid,
  itemId: uuid,
  color: text(80),
  size: z.string().trim().max(80).default(''),
  hardwareColor: z.string().trim().max(80).default(''),
  beltLength: quantityString.nullable().optional(),
  allowsPersonalization: z.boolean().default(false),
});
export type LeatherVariantInput = z.infer<typeof leatherVariantSchema>;
export const leatherPieceInputSchema = z.object({
  code: text(60),
  area: positiveQuantity,
  areaUnit: z.enum(['m2', 'dm2', 'ft2']).default('m2'),
  usableArea: quantityString.optional(),
  grade: z.enum(['A', 'B', 'C']).default('A'),
  tone: z.string().trim().max(80).default(''),
  thicknessMin: quantityString.default('0'),
  thicknessMax: quantityString.default('0'),
  shape: z.string().trim().max(80).default('hide'),
  note,
});
export const leatherReceiptSchema = z.object({
  partyId: uuid,
  itemId: uuid,
  warehouseId: uuid,
  date: isoDate,
  externalNo: text(40),
  provisionalUnitCost: unitCostString.refine(
    decCheck((d) => d.gt(0)),
    'Geçici kabul maliyeti gerekli',
  ),
  currency: currencyCode.default('TRY'),
  fxRate: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/)
    .optional(),
  tanning: z.enum(['vegetable', 'chrome', 'combined', 'other']).default('vegetable'),
  tannery: z.string().trim().max(160).default(''),
  country: z.string().trim().max(80).default(''),
  certificateDocumentId: uuid.nullable().optional(),
  pieces: z.array(leatherPieceInputSchema).min(1).max(500),
  note,
});
export type LeatherReceiptInput = z.infer<typeof leatherReceiptSchema>;
export const leatherPieceAcceptanceSchema = z.object({
  decision: z.enum(['accept', 'reject', 'second']),
  note,
});
export const leatherReservationSchema = z.object({
  itemId: uuid,
  quantity: positiveQuantity,
  pieceId: uuid.nullable().optional(),
});
export const leatherProductionSchema = z.object({
  variantId: uuid,
  revisionId: uuid,
  warehouseId: uuid,
  outputWarehouseId: uuid,
  quantity: positiveQuantity.refine(
    decCheck((d) => d.isInteger()),
    'Üretim adedi tam sayı olmalı',
  ),
  dueDate: isoDate.optional(),
  customOrderId: uuid.nullable().optional(),
  salesOrderLineId: uuid.optional(),
  assignedUserId: uuid.optional(),
  reservations: z.array(leatherReservationSchema).max(200).default([]),
  materialAlternatives: z
    .array(z.object({ itemId: uuid, alternativeId: uuid }))
    .max(100)
    .default([]),
  note,
});
export const leatherProductionFromSalesSchema = z.object({
  salesOrderId: uuid,
  warehouseId: uuid,
  outputWarehouseId: uuid,
  assignedUserId: uuid.optional(),
  dueDate: isoDate.optional(),
  requestKey: uuid,
  note,
});
export type LeatherProductionInput = z.infer<typeof leatherProductionSchema>;
export const leatherDatedActionSchema = z.object({ date: isoDate, requestKey: uuid, note });
export const leatherIssueSchema = leatherDatedActionSchema.extend({
  batchId: uuid.optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        quantity: positiveQuantity,
        pieces: z
          .array(z.object({ pieceId: uuid, quantity: positiveQuantity }))
          .max(200)
          .default([]),
        lotAllocations: z
          .array(z.object({ lotId: uuid, quantity: positiveQuantity }))
          .max(200)
          .optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type LeatherIssueInput = z.infer<typeof leatherIssueSchema>;
export const leatherCutSchema = leatherDatedActionSchema
  .extend({
    planId: uuid.optional(),
    orderId: uuid,
    pieceId: uuid,
    usedArea: quantityString,
    wasteArea: quantityString,
    setsProduced: z.number().int().min(0).max(100000).default(0),
    remnants: z.array(leatherPieceInputSchema).max(50).default([]),
  })
  .refine((v) => {
    const a = tryDec(v.usedArea),
      b = tryDec(v.wasteArea);
    return a !== null && b !== null && a.plus(b).gt(0);
  }, 'Kesimde tüketim gerekli');
export type LeatherCutInput = z.infer<typeof leatherCutSchema>;
export const leatherMaterialReturnSchema = leatherDatedActionSchema.extend({
  issueId: uuid,
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        quantity: positiveQuantity,
        pieces: z
          .array(z.object({ pieceId: uuid, quantity: positiveQuantity }))
          .max(200)
          .default([]),
      }),
    )
    .min(1)
    .max(200),
});
export type LeatherMaterialReturnInput = z.infer<typeof leatherMaterialReturnSchema>;
export const leatherCompletionSchema = leatherDatedActionSchema.extend({
  batchId: uuid.optional(),
  quantity: positiveQuantity.refine(decCheck((d) => d.isInteger())),
  qualityCheckId: uuid,
  final: z.boolean().default(false),
  serials: z.array(text(60)).max(1000).default([]),
});
export type LeatherCompletionInput = z.infer<typeof leatherCompletionSchema>;
export const leatherOperationSchema = leatherDatedActionSchema
  .extend({
    resourceId: uuid.optional(),
    batchId: uuid.optional(),
    key: text(50),
    status: z.enum(['started', 'completed', 'rework']),
    quantity: quantityString.default('0'),
    minutes: quantityString.default('0'),
    goodQty: quantityString.default('0'),
    reworkQty: quantityString.default('0'),
    scrapQty: quantityString.default('0'),
  })
  .refine((v) => {
    const a = [v.quantity, v.goodQty, v.reworkQty, v.scrapQty].map(tryDec);
    return (
      a.every((x) => x !== null) &&
      (a.slice(1).every((x) => x!.isZero()) ||
        a
          .slice(1)
          .reduce((s, x) => s.plus(x!), dec(0))
          .eq(a[0]!))
    );
  }, 'Operasyon sonuçları işlem adedine eşit olmalı');
export const leatherQualitySchema = z
  .object({
    batchId: uuid.optional(),
    scope: z.enum(['material', 'production', 'service']),
    sourceId: uuid,
    stage: z.enum(['incoming', 'cutting', 'intermediate', 'final']),
    inspectedQty: positiveQuantity,
    passedQty: quantityString,
    reworkQty: quantityString.default('0'),
    secondQty: quantityString.default('0'),
    scrapQty: quantityString.default('0'),
    checks: z
      .array(
        z.object({ label: text(160), passed: z.boolean(), note: z.string().max(300).default('') }),
      )
      .min(1)
      .max(50),
    note,
  })
  .refine((v) => {
    const a = [v.passedQty, v.reworkQty, v.secondQty, v.scrapQty, v.inspectedQty].map(tryDec);
    return (
      a.every((x) => x !== null) &&
      a
        .slice(0, 4)
        .reduce((s, x) => s.plus(x!), dec(0))
        .eq(a[4]!)
    );
  }, 'Kalite sonuç toplamı incelenen miktarına eşit olmalı');
export type LeatherQualityInput = z.infer<typeof leatherQualitySchema>;
export const leatherQualityDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note,
});
export const leatherCostAllocationSchema = leatherDatedActionSchema
  .extend({
    orderId: uuid.optional(),
    receiptLineId: uuid.optional(),
    sourceJournalLineId: uuid,
    amount: unitCostString.refine(decCheck((d) => d.gt(0))),
    kind: z.enum(['labor', 'subcontract', 'overhead', 'freight', 'acquisition']),
  })
  .refine((v) => !!v.orderId !== !!v.receiptLineId, 'Üretim emri veya edinim satırı seçin');
export type LeatherCostAllocationInput = z.infer<typeof leatherCostAllocationSchema>;
export const leatherSubcontractSchema = z.object({
  orderId: uuid,
  partyId: uuid,
  operationKey: text(50),
  quantity: positiveQuantity,
  externalWarehouseId: uuid.optional(),
  dueDate: isoDate.optional(),
  note,
});
export const leatherSubcontractActionSchema = leatherDatedActionSchema.extend({
  action: z.enum(['dispatch', 'return', 'consume', 'waste', 'cancel']),
  quantity: positiveQuantity.optional(),
  materials: leatherIssueSchema.shape.lines.optional(),
  sourceJournalLineId: uuid.optional(),
  cost: unitCostString.optional(),
});
export const leatherCustomOrderSchema = z.object({
  partyId: uuid,
  variantId: uuid,
  quantity: positiveQuantity.refine(decCheck((d) => d.isInteger())),
  dueDate: isoDate,
  currency: currencyCode.default('TRY'),
  unitPrice: unitCostString,
  monogram: z.string().trim().max(20).default(''),
  placement: z.string().trim().max(100).default(''),
  customerNotes: note,
});
export const leatherCustomOrderActionSchema = z.object({
  action: z.enum(['confirm', 'cancel', 'ready', 'deliver']),
  treasuryTransactionId: uuid.optional(),
  invoiceId: uuid.optional(),
  note,
});
export const leatherServiceSchema = z
  .object({
    partyId: uuid,
    itemId: uuid,
    invoiceLineId: uuid.optional(),
    serialId: uuid.optional(),
    date: isoDate,
    complaint: text(2000),
    warranty: z.boolean().default(false),
  })
  .refine(
    (v) => !!v.invoiceLineId || !!v.serialId,
    'Kendi ürününüzün satış satırını veya seri numarasını seçin',
  );
export const leatherServiceActionSchema = leatherDatedActionSchema.extend({
  action: z.enum(['diagnose', 'approve_repair', 'repair', 'ready', 'deliver', 'cancel']),
  assessment: note,
  fee: unitCostString.default('0'),
  invoiceId: uuid.optional(),
  approvalReference: z.string().trim().max(300).optional(),
  warehouseId: uuid.optional(),
  parts: leatherIssueSchema.shape.lines.optional(),
});

export interface LeatherModel {
  id: string;
  code: string;
  name: string;
  family: string;
  description: string;
  createdAt: string;
}
export interface LeatherRevision extends LeatherRevisionInput {
  id: string;
  modelId: string;
  revision: number;
  status: string;
  approvedAt: string | null;
}
export interface LeatherVariant extends LeatherVariantInput {
  id: string;
  itemCode: string;
  itemName: string;
  modelName: string;
  revision: number;
}
export interface LeatherLot {
  id: string;
  code: string;
  itemId: string;
  itemName: string;
  warehouseId: string;
  partyId: string;
  deliveryNoteId: string;
  deliveryLineId: string;
  date: string;
  tanning: string;
  tannery: string;
  country: string;
  totalArea: string;
  remainingArea: string;
  provisionalValue: string | null;
}
export interface LeatherPiece {
  id: string;
  lotId: string;
  itemId: string;
  warehouseId: string;
  parentId: string | null;
  code: string;
  area: string;
  remainingArea: string;
  usableArea: string;
  grade: string;
  tone: string;
  thicknessMin: string;
  thicknessMax: string;
  status: string;
}
export interface LeatherReservation {
  id: string;
  itemId: string;
  itemName: string;
  pieceId: string | null;
  quantity: string;
  consumedQty: string;
  status: string;
}
export interface LeatherOperation {
  key: string;
  name: string;
  station: string;
  outsourced: boolean;
  plannedMinutes: string;
  status?: string;
  actualMinutes?: string;
  completedQty?: string;
}
export interface LeatherProductionOrder {
  id: string;
  code: string;
  variantId: string;
  revisionId: string;
  revision: number;
  itemId: string;
  itemName: string;
  quantity: string;
  completedQty: string;
  wipValue: string | null;
  status: string;
  dueDate: string | null;
  warehouseId: string;
  outputWarehouseId: string;
  assignedUserId?: string;
  reservations: LeatherReservation[];
  operations: LeatherOperation[];
}
export interface LeatherDocument {
  id: string;
  orderId: string;
  kind: string;
  date: string;
  quantity: string;
  value: string | null;
  stockDocumentId: string | null;
  journalEntryId: string | null;
  requestKey: string;
}
export interface LeatherQualityCheck extends LeatherQualityInput {
  id: string;
  status: string;
  createdAt: string;
}
export interface LeatherCostAllocation {
  id: string;
  kind: string;
  amount: string;
  orderId: string | null;
  receiptLineId: string | null;
  sourceJournalLineId: string;
  date: string;
  destinations: { target: string; amount: string }[];
}
export interface LeatherSubcontractJob {
  id: string;
  orderId: string;
  partyId: string;
  partyName: string;
  operationKey: string;
  quantity: string;
  returnedQty: string;
  status: string;
  dueDate: string | null;
}
export interface LeatherCustomOrder {
  id: string;
  partyId: string;
  partyName: string;
  variantId: string;
  itemName: string;
  quantity: string;
  dueDate: string;
  currency: string;
  unitPrice: string;
  monogram: string;
  placement: string;
  customerNotes: string;
  status: string;
  depositTransactionId: string | null;
  invoiceId: string | null;
}
export interface LeatherServiceCase {
  id: string;
  partyId: string;
  partyName: string;
  itemId: string;
  itemName: string;
  invoiceLineId: string | null;
  serialId: string | null;
  date: string;
  complaint: string;
  warranty: boolean;
  status: string;
  assessment: string;
  fee: string;
  invoiceId: string | null;
}
export interface LeatherOverview {
  models: number;
  activeOrders: number;
  dueOrders: number;
  quarantinePieces: number;
  openQuality: number;
  openSubcontracts: number;
  customOrders: number;
  serviceCases: number;
  wipValue: string | null;
  provisionalReceipts: number;
}

/** Physical area only: cost provenance uses the company's weighted average pool. */
export function leatherAreaToM2(value: string, unit: 'm2' | 'dm2' | 'ft2'): string {
  const area = dec(value);
  if (area.lt(0)) throw new Error('Alan negatif olamaz');
  const converted = (
    unit === 'm2' ? area : unit === 'dm2' ? area.div(100) : area.times('0.09290304')
  ).toDecimalPlaces(4);
  if (converted.gt('999999999999999.9999')) throw new Error('Alan ölçümü stok sınırını aşamaz');
  return converted.toFixed(4);
}
export function assertLeatherAreaConservation(
  original: string,
  used: string,
  waste: string,
  remnants: readonly string[],
): void {
  if (
    !dec(original).eq(
      dec(used)
        .plus(waste)
        .plus(remnants.reduce((s, a) => s.plus(a), dec(0))),
    )
  )
    throw new Error('Deri alanı korunmalı: kullanılan + fire + kalan = başlangıç alanı');
}
export function leatherCompletionShare(
  quantity: string,
  plannedRemaining: string,
  final = false,
): MoneyValue {
  const q = dec(quantity),
    left = dec(plannedRemaining);
  if (q.lte(0) || left.lte(0) || q.gt(left))
    throw new Error('Mamul kabulü kalan plan miktarını aşamaz');
  return final ? dec(1) : q.div(left);
}
export function splitLeatherCostDelta(
  delta: string | MoneyValue,
  targets: readonly { key: string; share: string }[],
): { key: string; amount: string }[] {
  if (!targets.length) throw new Error('Maliyet pay izi bulunamadı');
  const total = targets.reduce((s, t) => s.plus(t.share), dec(0));
  if (total.lte(0) || targets.some((t) => dec(t.share).lt(0)))
    throw new Error('Geçersiz maliyet payı');
  let remaining = roundMoney(delta);
  return targets.map((t, i) => {
    const amount =
      i === targets.length - 1 ? remaining : roundMoney(dec(delta).times(t.share).div(total));
    remaining = remaining.minus(amount);
    return { key: t.key, amount: amount.toFixed(2) };
  });
}
