import { z } from 'zod';
import { currencyCode, isoDate, rateString, uuid } from './common';
import { ITEM_UNITS, positiveQuantity, unitCostString } from './inventory';
import type { InvoiceSide, InvoiceType } from './invoices';

// --- İrsaliye türleri --------------------------------------------------------

/** Satış (sevk) irsaliyesi stoktan çıkar, alış (mal kabul) irsaliyesi stoğa girer. İade irsaliyesi yok. */
export const DELIVERY_NOTE_TYPES = ['sales', 'purchase'] as const;
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
  /** Bu irsaliyenin bağlanabileceği fatura türü. */
  invoiceType: Extract<InvoiceType, 'sales' | 'purchase'>;
}

export const DELIVERY_NOTE_TYPE_META: Record<DeliveryNoteType, DeliveryNoteTypeMeta> = {
  sales: { prefix: 'SIR', side: 'sales', partyKind: 'customer', inbound: false, invoiceType: 'sales' },
  purchase: { prefix: 'AIR', side: 'purchases', partyKind: 'supplier', inbound: true, invoiceType: 'purchase' },
};

/** Faturanın bağlanabileceği irsaliye türü (fatura türü → irsaliye türü). */
export const deliveryTypeForInvoice = (type: InvoiceType): DeliveryNoteType | null =>
  type === 'sales' ? 'sales' : type === 'purchase' ? 'purchase' : null;

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
});
export type DeliveryLineInput = z.infer<typeof deliveryLineSchema>;

const deliveryBase = z.object({
  partyId: uuid,
  noteDate: isoDate,
  /** Alış irsaliyesinde tedarikçinin irsaliye numarası (kaydetmede zorunlu). */
  externalNo: optionalText(40),
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

/** Tür bilindiğinde satır biçimi: satışta maliyet/dış numara girilmez. */
export function refineDelivery(doc: DeliveryBase & { type?: DeliveryNoteType }, ctx: z.RefinementCtx) {
  if (doc.type !== 'sales') return;
  if (doc.externalNo) {
    ctx.addIssue({ code: 'custom', path: ['externalNo'], message: 'Dış numara yalnızca alış irsaliyesinde girilir' });
  }
  doc.lines.forEach((l, i) => {
    if (l.unitCost !== undefined || l.currency !== undefined || l.fxRate !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', i, 'unitCost'],
        message: 'Satış irsaliyesinde maliyet girilmez; ortalama maliyet kullanılır',
      });
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
