import { z } from 'zod';
import { currencyCode, isoDate, rateString, uuid } from './common';
import { ITEM_UNITS, positiveQuantity, unitCostString } from './inventory';
import type { InvoiceSide, InvoiceType } from './invoices';

// --- İrsaliye türleri --------------------------------------------------------

/**
 * Satış (sevk) irsaliyesi stoktan çıkar, alış (mal kabul) irsaliyesi stoğa girer. İade irsaliyeleri (X2): satış iadesi müşteriden
 * mal geri alır (stoğa girer, orijinal satışın maliyetiyle), alış iadesi tedarikçiye mal geri gönderir (stoktan çıkar).
 */
export const DELIVERY_NOTE_TYPES = ['sales', 'purchase', 'sales_return', 'purchase_return'] as const;
export type DeliveryNoteType = (typeof DELIVERY_NOTE_TYPES)[number];

export const DELIVERY_NOTE_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type DeliveryNoteStatus = (typeof DELIVERY_NOTE_STATUSES)[number];

/** Faturalama durumu (yalnızca kaydedilmiş irsaliyede anlamlı): açık = hiç faturalanmamış. */
export const DELIVERY_INVOICING = ['open', 'partial', 'invoiced'] as const;
export type DeliveryInvoicing = (typeof DELIVERY_INVOICING)[number];

export interface DeliveryNoteTypeMeta {
  /** Boşluksuz numara öneki (SIR-2026-000001). */
  prefix: string;
  side: InvoiceSide;
  /** Cari türü: satışta müşteri, alışta tedarikçi. */
  partyKind: 'customer' | 'supplier';
  /** Stoğa giriş mi (alış) çıkış mı (satış)? */
  inbound: boolean;
  /** Bu irsaliyenin bağlanabileceği fatura türü (iade irsaliyesi iade faturasına bağlanır). */
  invoiceType: Extract<InvoiceType, 'sales' | 'purchase' | 'sales_return' | 'purchase_return'>;
  isReturn: boolean;
  /** İade irsaliyesinin bağlanabileceği orijinal irsaliye türü. */
  returnOf?: 'sales' | 'purchase';
  /** Orijinal irsaliyenin iade türü. */
  returnType?: Extract<DeliveryNoteType, 'sales_return' | 'purchase_return'>;
}

export const DELIVERY_NOTE_TYPE_META: Record<DeliveryNoteType, DeliveryNoteTypeMeta> = {
  sales: { prefix: 'SIR', side: 'sales', partyKind: 'customer', inbound: false, invoiceType: 'sales', isReturn: false, returnType: 'sales_return' },
  purchase: { prefix: 'AIR', side: 'purchases', partyKind: 'supplier', inbound: true, invoiceType: 'purchase', isReturn: false, returnType: 'purchase_return' },
  sales_return: { prefix: 'SIRI', side: 'sales', partyKind: 'customer', inbound: true, invoiceType: 'sales_return', isReturn: true, returnOf: 'sales' },
  purchase_return: { prefix: 'AIRI', side: 'purchases', partyKind: 'supplier', inbound: false, invoiceType: 'purchase_return', isReturn: true, returnOf: 'purchase' },
};

/** Tedarikçi (dış) numarası girilebilen irsaliye türleri. */
export const DELIVERY_EXTERNAL_NO_TYPES: readonly DeliveryNoteType[] = ['purchase', 'purchase_return'];

/** Faturanın bağlanabileceği irsaliye türü (fatura türü → irsaliye türü). */
export const deliveryTypeForInvoice = (type: InvoiceType): DeliveryNoteType | null =>
  type === 'expense' ? null : (type as DeliveryNoteType);

// --- Giriş -------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

export const deliveryLineSchema = z.object({
  itemId: uuid,
  /** Boşsa kartın adı kullanılır. */
  description: optionalText(300),
  quantity: positiveQuantity,
  unit: z.enum(ITEM_UNITS).nullable().optional(),
  /** Yalnızca alış irsaliyesinde, isteğe bağlı: bilinmiyorsa boş bırakılır (değer 0), fatura gelince düzeltilir. */
  unitCost: unitCostString.optional(),
  currency: currencyCode.optional(),
  /** Verilmezse irsaliye tarihindeki kayıtlı kur kullanılır. */
  fxRate: rateString.optional(),
  /** İade irsaliyesinde, iade edilen orijinal irsaliye satırı (isteğe bağlı; verilirse iade miktarı sınırlanır). */
  sourceLineId: uuid.nullable().optional(),
  /** Satış irsaliyesinde, karşılanan satış siparişi satırı (X2). */
  salesOrderLineId: uuid.nullable().optional(),
});
export type DeliveryLineInput = z.infer<typeof deliveryLineSchema>;

const deliveryBase = z.object({
  partyId: uuid,
  noteDate: isoDate,
  /** Alış irsaliyesinde tedarikçinin irsaliye numarası (kaydetmede zorunlu; alış iadesinde isteğe bağlı). */
  externalNo: optionalText(40),
  /** İade irsaliyesi: bağlı orijinal irsaliye (isteğe bağlı). */
  returnOfId: uuid.nullable().optional(),
  /** Boşsa varsayılan depo. */
  warehouseId: uuid.nullable().optional(),
  vehiclePlate: optionalText(20),
  driverName: optionalText(80),
  description: optionalText(300),
  lines: z.array(deliveryLineSchema).min(1, 'En az bir satır gerekli').max(300),
  /** true ise taslak beklemeden kaydedilir ve stok hareketi işlenir. */
  post: z.boolean().default(false),
});
type DeliveryBase = z.infer<typeof deliveryBase>;

/** Tür bilindiğinde satır biçimi: yalnızca alış irsaliyesinde maliyet girilir; dış numara yalnızca alış/alış iadesinde. */
export function refineDelivery(doc: DeliveryBase & { type?: DeliveryNoteType }, ctx: z.RefinementCtx) {
  if (!doc.type) return;
  const meta = DELIVERY_NOTE_TYPE_META[doc.type];
  if (doc.externalNo && !DELIVERY_EXTERNAL_NO_TYPES.includes(doc.type)) {
    ctx.addIssue({ code: 'custom', path: ['externalNo'], message: 'Dış numara yalnızca alış ve alış iade irsaliyesinde girilir' });
  }
  if (doc.returnOfId && !meta.isReturn) {
    ctx.addIssue({ code: 'custom', path: ['returnOfId'], message: 'Orijinal irsaliye yalnızca iade irsaliyesinde seçilir' });
  }
  doc.lines.forEach((l, i) => {
    if (doc.type !== 'purchase' && (l.unitCost !== undefined || l.currency !== undefined || l.fxRate !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', i, 'unitCost'],
        message: 'Bu irsaliye türünde maliyet girilmez; stok defteri maliyeti kullanılır',
      });
    }
    if (l.sourceLineId && !meta.isReturn) {
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'sourceLineId'], message: 'Satır bağı yalnızca iade irsaliyesinde kullanılır' });
    }
    if (l.sourceLineId && !doc.returnOfId) {
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'sourceLineId'], message: 'Satır bağı için orijinal irsaliye seçilmeli' });
    }
    if (l.salesOrderLineId && doc.type !== 'sales') {
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'salesOrderLineId'], message: 'Sipariş bağı yalnızca satış irsaliyesinde kullanılır' });
    }
  });
}

export const createDeliveryNoteSchema = deliveryBase.extend({ type: z.enum(DELIVERY_NOTE_TYPES) }).superRefine(refineDelivery);
export type CreateDeliveryNoteInput = z.infer<typeof createDeliveryNoteSchema>;

/** Taslağı tümüyle değiştirir; tür değiştirilemez (tür kurallarını servis denetler). */
export const updateDeliveryNoteSchema = deliveryBase;
export type UpdateDeliveryNoteInput = z.infer<typeof updateDeliveryNoteSchema>;

export const cancelDeliveryNoteSchema = z.object({
  /** İptal (ters stok belgesi) tarihi; boşsa bugün. */
  date: isoDate.optional(),
  reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300),
});
export type CancelDeliveryNoteInput = z.infer<typeof cancelDeliveryNoteSchema>;

export const listDeliveryNotesQuerySchema = z.object({
  type: z.enum(DELIVERY_NOTE_TYPES).optional(),
  status: z.enum(DELIVERY_NOTE_STATUSES).optional(),
  invoicing: z.enum(DELIVERY_INVOICING).optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** İrsaliye no, dış numara, cari adı/kodu. */
  query: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListDeliveryNotesQuery = z.infer<typeof listDeliveryNotesQuerySchema>;

/** Faturaya eklenebilecek (kalan miktarı olan) irsaliye satırları. */
export const openDeliveryLinesQuerySchema = z.object({
  type: z.enum(DELIVERY_NOTE_TYPES),
  partyId: uuid,
});
export type OpenDeliveryLinesQuery = z.infer<typeof openDeliveryLinesQuerySchema>;

/** İade edilebilecek orijinal irsaliye satırları (teslim edilen − önceki kaydedilmiş iadeler). */
export const returnableLinesQuerySchema = z.object({
  /** İade türü; orijinal irsaliye türü buradan çıkar. */
  type: z.enum(['sales_return', 'purchase_return']),
  partyId: uuid,
  noteId: uuid.optional(),
});
export type ReturnableLinesQuery = z.infer<typeof returnableLinesQuerySchema>;
