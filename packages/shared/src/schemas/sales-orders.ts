import { z } from 'zod';
import { currencyCode, isoDate, moneyString, uuid } from './common';
import { percentString } from './invoices';
import { ITEM_UNITS, positiveQuantity, unitCostString } from './inventory';
import { BATCH_GROUPINGS, SALES_DOC_KINDS, SALES_DOC_STATUSES } from '../sales-order-calc';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

// --- Teklif / sipariş ----------------------------------------------------------

export const salesOrderLineSchema = z.object({
  /** Boşsa serbest metin satırı (hizmet, işçilik…). */
  itemId: uuid.nullable().optional(),
  /** Boşsa kartın adı kullanılır (kartsız satırda zorunlu). */
  description: optionalText(300),
  quantity: positiveQuantity,
  unit: z.enum(ITEM_UNITS).nullable().optional(),
  /** Belge para biriminde birim fiyat; boşsa kartın satış fiyatı (fiyat listesi kancası, X3). */
  unitPrice: unitCostString.optional(),
  discountPct: percentString.optional(),
  vatCode: z.string().trim().max(20).nullable().optional(),
});
export type SalesOrderLineInput = z.infer<typeof salesOrderLineSchema>;

const salesDocBase = z.object({
  partyId: uuid,
  docDate: isoDate,
  /** Teklifin geçerlilik tarihi. */
  validUntil: isoDate.nullable().optional(),
  /** Siparişte sözlenen teslim tarihi. */
  deliveryDate: isoDate.nullable().optional(),
  /** Boşsa carinin para birimi. */
  currency: currencyCode.optional(),
  vatIncluded: z.boolean().default(false),
  /** Teslimatın çıkacağı depo; boşsa varsayılan depo. */
  warehouseId: uuid.nullable().optional(),
  /** Çıktıda görünen koşullar/açıklama. */
  notes: optionalText(1000),
  /** Satış sorumlusu (öneri 13); verilmezse carinin sorumlusu. */
  salesRepId: uuid.nullable().optional(),
  lines: z.array(salesOrderLineSchema).min(1, 'En az bir satır gerekli').max(300),
});

export const createSalesDocSchema = salesDocBase.extend({ kind: z.enum(SALES_DOC_KINDS) });
export type CreateSalesDocInput = z.infer<typeof createSalesDocSchema>;
export const updateSalesDocSchema = salesDocBase;
export type UpdateSalesDocInput = z.infer<typeof updateSalesDocSchema>;

export const listSalesDocsQuerySchema = z.object({
  kind: z.enum(SALES_DOC_KINDS).optional(),
  status: z.enum(SALES_DOC_STATUSES).optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  query: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSalesDocsQuery = z.infer<typeof listSalesDocsQuerySchema>;

export const salesDocActionSchema = z.object({
  /** İptal/ret/kapatma gerekçesi. */
  reason: z.string().trim().max(300).optional(),
  /** Katkı/kredi kontrolü engellediğinde onay yetkilisinin gerekçesi (öneri 35, 38). */
  overrideReason: z.string().trim().min(5, 'Gerekçe en az 5 karakter').max(300).optional(),
});
export type SalesDocActionInput = z.infer<typeof salesDocActionSchema>;

/** Siparişten irsaliye taslağı: satır başına miktar verilmezse kalan teslim edilebilir miktar. */
export const orderToDeliverySchema = z.object({
  noteDate: isoDate.optional(),
  warehouseId: uuid.nullable().optional(),
  lines: z.array(z.object({ lineId: uuid, quantity: positiveQuantity })).max(300).optional(),
});
export type OrderToDeliveryInput = z.infer<typeof orderToDeliverySchema>;

/** Siparişten fatura taslağı: teslim edilip faturalanmamış irsaliye satırları + kalan hizmet satırları. */
export const orderToInvoiceSchema = z.object({
  invoiceDate: isoDate.optional(),
  /** true: hiç teslim edilmemiş mal satırları da faturaya (stok faturada hareket eder) alınır. */
  includeUndelivered: z.boolean().default(false),
});
export type OrderToInvoiceInput = z.infer<typeof orderToInvoiceSchema>;

// --- Toplu faturalama -----------------------------------------------------------

export const batchPreviewQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  partyId: uuid.optional(),
  grouping: z.enum(['party', 'note']).default('party'),
});
export type BatchPreviewQuery = z.infer<typeof batchPreviewQuerySchema>;

export const batchRunSchema = z.object({
  /** Faturalanacak (kaydedilmiş, kalan miktarı olan) satış irsaliyeleri; cari başına gruplanır. */
  noteIds: z.array(uuid).min(1, 'En az bir irsaliye seçin').max(500),
  invoiceDate: isoDate,
  /** `party`: cari başına tek fatura; `note`: irsaliye başına bir fatura. */
  grouping: z.enum(['party', 'note']).default('party'),
  /** true: faturalar hemen kaydedilir (yevmiye); false: taslak bırakılır (invoices.post gerekmez). */
  post: z.boolean().default(true),
});
export type BatchRunInput = z.infer<typeof batchRunSchema>;
export { BATCH_GROUPINGS };

// --- Ticari kontroller (F6) ----------------------------------------------------

export const SALES_CHECK_MODES = ['off', 'warn', 'block'] as const;
export type SalesCheckMode = (typeof SALES_CHECK_MODES)[number];

/** Katkı yüzdesi: −100 ile 100 arası, en çok 2 ondalık. */
const marginPct = z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Geçersiz yüzde').refine((v) => Math.abs(Number(v)) <= 100, 'Yüzde ±100 aralığında olmalı');

export const salesPolicySchema = z.object({
  minMarginPct: marginPct.nullable(),
  marginMode: z.enum(SALES_CHECK_MODES),
  creditMode: z.enum(SALES_CHECK_MODES),
});
export type SalesPolicyInput = z.infer<typeof salesPolicySchema>;

export const partySalesRepSchema = z.object({
  userId: uuid.nullable(),
  reason: optionalText(300),
});
export type PartySalesRepInput = z.infer<typeof partySalesRepSchema>;

export const salesRepTargetsSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  targets: z.array(z.object({ userId: uuid, month: z.number().int().min(1).max(12), amount: moneyString })).max(1200),
});
export type SalesRepTargetsInput = z.infer<typeof salesRepTargetsSchema>;

export const salesRepReportQuerySchema = z.object({ from: isoDate, to: isoDate });
export type SalesRepReportQuery = z.infer<typeof salesRepReportQuerySchema>;

// --- Ticari itiraz (öneri 39) ----------------------------------------------------

export const DISPUTE_CATEGORIES = ['price', 'quantity', 'quality', 'delivery', 'payment', 'other'] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];
export const DISPUTE_STATUSES = ['open', 'in_review', 'resolved', 'rejected'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_SOURCES = ['invoice', 'delivery_note', 'sales_order'] as const;
export type DisputeSource = (typeof DISPUTE_SOURCES)[number];

export const createDisputeSchema = z
  .object({
    partyId: uuid,
    sourceType: z.enum(DISPUTE_SOURCES).optional(),
    sourceId: uuid.optional(),
    category: z.enum(DISPUTE_CATEGORIES),
    subject: z.string().trim().min(3, 'Konu gerekli').max(300),
    amount: moneyString.optional(),
    currency: currencyCode.optional(),
    ownerId: uuid.nullable().optional(),
    dueDate: isoDate.optional(),
    note: optionalText(2000),
  })
  .refine((v) => !v.sourceType === !v.sourceId, { path: ['sourceId'], message: 'Kaynak belge türü ve kaydı birlikte verilir' })
  .refine((v) => !v.currency || !!v.amount, { path: ['amount'], message: 'Para birimi için tutar gerekli' });
export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;

export const disputeActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('note'), note: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal('assign'), ownerId: uuid.nullable(), note: optionalText(2000) }),
  z.object({ action: z.literal('review'), note: optionalText(2000) }),
  z.object({ action: z.literal('resolve'), resolution: z.string().trim().min(3, 'Çözüm açıklaması gerekli').max(2000) }),
  z.object({ action: z.literal('reject'), resolution: z.string().trim().min(3, 'Ret gerekçesi gerekli').max(2000) }),
]);
export type DisputeActionInput = z.infer<typeof disputeActionSchema>;

export const listDisputesQuerySchema = z.object({
  partyId: uuid.optional(),
  status: z.enum(['open', 'closed', 'all']).default('open'),
  sourceType: z.enum(DISPUTE_SOURCES).optional(),
  sourceId: uuid.optional(),
});
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;
