import { z } from 'zod';
import { dec } from '../money';
import type { Sector } from '../module-registry';
import { currencyCode, isoDate, rateString, uuid } from './common';
import { ITEM_UNITS, positiveQuantity, unitCostString } from './inventory';

// --- Fatura türleri ----------------------------------------------------------

export const INVOICE_TYPES = ['sales', 'purchase', 'expense', 'sales_return', 'purchase_return'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const INVOICE_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceSide = 'sales' | 'purchases';

export interface InvoiceTypeMeta {
  /** Boşluksuz numara öneki (SF-2026-000001). */
  prefix: string;
  side: InvoiceSide;
  /** Cari satırın kontrol hesabı türü. */
  control: 'receivable' | 'payable';
  /** Stoklu (mal) satır taşıyabilir mi? Gider faturası taşıyamaz. */
  stock: boolean;
  isReturn: boolean;
  /** İade türünde bağlanabileceği orijinal fatura türü. */
  returnOf?: InvoiceType;
}

export const INVOICE_TYPE_META: Record<InvoiceType, InvoiceTypeMeta> = {
  sales: { prefix: 'SF', side: 'sales', control: 'receivable', stock: true, isReturn: false },
  sales_return: { prefix: 'SIF', side: 'sales', control: 'receivable', stock: true, isReturn: true, returnOf: 'sales' },
  purchase: { prefix: 'AF', side: 'purchases', control: 'payable', stock: true, isReturn: false },
  expense: { prefix: 'GF', side: 'purchases', control: 'payable', stock: false, isReturn: false },
  purchase_return: { prefix: 'AIF', side: 'purchases', control: 'payable', stock: true, isReturn: true, returnOf: 'purchase' },
};

/** Tedarikçi fatura numarası gerektiren türler (mükerrer girişi de bununla yakalarız). */
export const EXTERNAL_NO_REQUIRED: readonly InvoiceType[] = ['purchase', 'expense', 'purchase_return'];

export const invoiceTypesOf = (side: InvoiceSide): InvoiceType[] =>
  INVOICE_TYPES.filter((t) => INVOICE_TYPE_META[t].side === side);

// --- Hesap eşlemesi ----------------------------------------------------------

/**
 * Otomatik yevmiyede kullanılan hesaplar. Şirket kurulurken varsayılanlar yüklenir; Ayarlar'dan
 * değiştirilir. Varsayılanlar genel Tekdüzen yapıya dayanır ve mali müşavirce DOĞRULANMAMIŞTIR.
 */
export const ACCOUNT_MAPPING_KEYS = [
  'receivable',
  'payable',
  'sales_revenue',
  'sales_return',
  'cogs',
  'stock',
  'vat_output',
  'vat_input',
  'default_expense',
  'stock_gain',
  'stock_loss',
  'consumption',
  'opening_offset',
  'fx_gain',
  'fx_loss',
  // Taşeron hakedişi (B2c); varsayılanlar doğrulanmamıştır
  'subcontract_cost',
  'retention_payable',
  'withholding_payable',
  'subcontract_advance',
  // İşveren hakedişi (B2e)
  'claim_revenue',
  'retention_receivable',
  'advance_received',
  'withholding_receivable',
  // Gayrimenkul satışı (B3); varsayılanlar doğrulanmamıştır
  'deferred_revenue',
  'property_revenue',
  'termination_income',
  'fee_payable',
  // KDV tevkifatı (Faz B kapanışı); varsayılanlar doğrulanmamıştır
  'vat_withholding_payable',
  'vat_withholding_receivable',
  // Bordro (Faz D3); varsayılanlar doğrulanmamıştır
  'payroll_labor_cost',
  'payroll_employer_cost',
  'payroll_payable',
  'payroll_social_payable',
  'payroll_tax_payable',
  'payroll_other_payable',
] as const;
export type AccountMappingKey = (typeof ACCOUNT_MAPPING_KEYS)[number];

export function defaultMappingCodes(sector: Sector): Record<AccountMappingKey, string> {
  return {
    receivable: '120',
    payable: '320',
    sales_revenue: '600',
    sales_return: '610',
    cogs: '621',
    // İnşaatta stok ağırlıkla ilk madde ve malzemedir; ticaret/perakendede ticari mal.
    stock: sector === 'CONSTRUCTION' ? '150' : '153',
    vat_output: '391',
    vat_input: '191',
    default_expense: '632',
    stock_gain: '649',
    stock_loss: '659',
    consumption: '710',
    opening_offset: '500',
    // Kambiyo kârı/zararı (gerçekleşen kur farkı). Varsayılanlar doğrulanmamıştır.
    fx_gain: '646',
    fx_loss: '656',
    // Taşeron hakedişi: hizmet üretim maliyeti, alınan depozito/teminat, ödenecek vergi, verilen sipariş avansı
    subcontract_cost: '740',
    retention_payable: '326',
    withholding_payable: '360',
    subcontract_advance: '159',
    // İşveren hakedişi: hakediş geliri, verilen depozito/teminat, alınan sipariş avansı, peşin ödenen vergi
    claim_revenue: '600',
    retention_receivable: '126',
    advance_received: '340',
    withholding_receivable: '193',
    // Gayrimenkul satışı: ertelenmiş gelir (teslime kadar), taşınmaz satış geliri, fesih kesintisi geliri
    deferred_revenue: '380',
    property_revenue: '600',
    termination_income: '679',
    // Alıcıdan tahsil edilen altyapı fonu/harç (yükümlülük): diğer ticari borçlar
    fee_payable: '329',
    // KDV tevkifatı: taşeronda idareye ödenecek tevkifat borcu, işverende işverence tevkif edilen KDV alacağı
    vat_withholding_payable: '360',
    vat_withholding_receivable: '136',
    // Bordro: direkt işçilik gideri (brüt ücret), işveren yükü gideri, ödenecek net ücret (personele borçlar),
    // ödenecek sosyal güvenlik (361), ödenecek vergi ve fonlar (360), diğer kesintiler/çeşitli borçlar (336)
    payroll_labor_cost: '720',
    payroll_employer_cost: '720',
    payroll_payable: '335',
    payroll_social_payable: '361',
    payroll_tax_payable: '360',
    payroll_other_payable: '336',
  };
}

export const updateAccountMappingsSchema = z.object({
  // Kısmi güncelleme: yalnızca gönderilen anahtarlar değişir
  mappings: z.partialRecord(z.enum(ACCOUNT_MAPPING_KEYS), uuid),
});
export type UpdateAccountMappingsInput = z.infer<typeof updateAccountMappingsSchema>;

// --- Fatura girişi -----------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

/** Yüzde: 0–100, en çok 4 ondalık. */
export const percentString = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran')
  .refine((v) => dec(v).lte(100), 'Oran 100\'ü aşamaz');

export const invoiceLineSchema = z.object({
  /** Boşsa serbest satır (hizmet, gider…): açıklama ve hesap ile girilir. */
  itemId: uuid.nullable().optional(),
  description: z.string().trim().min(1, 'Açıklama gerekli').max(300),
  quantity: positiveQuantity,
  unit: z.enum(ITEM_UNITS).nullable().optional(),
  /** Fatura para biriminde birim fiyat (KDV dahil faturada KDV dahil). */
  unitPrice: unitCostString,
  discountPct: percentString.default('0'),
  /** Şirketin KDV oranı kodu; boşsa KDV yok (%0). */
  vatCode: z.string().trim().max(20).nullable().optional(),
  /** Serbest satırda gelir/gider hesabı; boşsa eşlemedeki varsayılan kullanılır. */
  accountId: uuid.nullable().optional(),
  /** İade faturasında, iade edilen orijinal fatura satırı. */
  sourceLineId: uuid.nullable().optional(),
  /**
   * Satış/alış faturasında, faturalanan irsaliye satırı. Bağlı satır stok hareketi yapmaz
   * (mal irsaliyede zaten çıktı/girdi); yalnızca fatura ve yevmiye oluşur.
   */
  deliveryLineId: uuid.nullable().optional(),
  /**
   * Proje boyutu (inşaat): yalnızca alış, gider ve alış iadesi faturasının stoksuz (hizmet/serbest) satırında.
   * Stoklu kalem projeye doğrudan değil, stoktan proje sarfı anında yazılır.
   */
  projectId: uuid.nullable().optional(),
  /** Projenin yaprak iş kalemi; projesiz verilemez. */
  wbsId: uuid.nullable().optional(),
  /** Alış faturasında, faturalanan sipariş satırı (üçlü eşleştirme: sipariş – mal kabul – fatura). */
  orderLineId: uuid.nullable().optional(),
});
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

const invoiceBase = z.object({
  partyId: uuid,
  invoiceDate: isoDate,
  /** Boşsa fatura tarihi + carinin vade günü. */
  dueDate: isoDate.nullable().optional(),
  /** Tedarikçinin fatura numarası (alış/gider/alış iadesi için zorunlu). */
  externalNo: optionalText(40),
  /** Boşsa carinin para birimi. */
  currency: currencyCode.optional(),
  /** Verilmezse fatura tarihindeki kayıtlı kur kullanılır. */
  fxRate: rateString.optional(),
  /** Birim fiyatlar KDV dahil mi? */
  vatIncluded: z.boolean().default(false),
  /** Stoklu satır varsa zorunlu; boşsa varsayılan depo. */
  warehouseId: uuid.nullable().optional(),
  /** İade faturası: bağlı orijinal fatura (isteğe bağlı). */
  returnOfId: uuid.nullable().optional(),
  description: optionalText(300),
  lines: z.array(invoiceLineSchema).min(1, 'En az bir satır gerekli').max(300),
  /** Üçlü eşleştirme tolerans dışıyken kaydı geçirme gerekçesi (`procurement.approve` yetkisi gerekir). */
  matchOverrideReason: z.string().trim().min(3, 'Gerekçe en az 3 karakter').max(500).nullable().optional(),
  /** true ise taslak beklemeden kaydedilir ve muhasebeleştirilir. */
  post: z.boolean().default(false),
});

type InvoiceBase = z.infer<typeof invoiceBase>;

function refine(doc: InvoiceBase & { type?: InvoiceType }, ctx: z.RefinementCtx) {
  if (doc.dueDate && doc.dueDate < doc.invoiceDate) {
    ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Vade tarihi fatura tarihinden önce olamaz' });
  }
  doc.lines.forEach((l, i) => {
    if (l.wbsId && !l.projectId) {
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'wbsId'], message: 'İş kalemi için proje seçilmeli' });
    }
  });
  if (doc.type) {
    const meta = INVOICE_TYPE_META[doc.type];
    if (doc.returnOfId && !meta.isReturn) {
      ctx.addIssue({ code: 'custom', path: ['returnOfId'], message: 'Orijinal fatura yalnızca iade faturasında seçilir' });
    }
    doc.lines.forEach((l, i) => {
      if (l.sourceLineId && !meta.isReturn) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'sourceLineId'], message: 'Satır bağı yalnızca iade faturasında kullanılır' });
      }
      if (l.sourceLineId && !doc.returnOfId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'sourceLineId'], message: 'Satır bağı için orijinal fatura seçilmeli' });
      }
      if (l.deliveryLineId && doc.type !== 'sales' && doc.type !== 'purchase') {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'deliveryLineId'], message: 'İrsaliye bağı yalnızca satış ve alış faturasında kullanılır' });
      }
      if (l.orderLineId && doc.type !== 'purchase') {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'orderLineId'], message: 'Sipariş bağı yalnızca alış faturasında kullanılır' });
      }
      if (l.deliveryLineId && l.sourceLineId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'deliveryLineId'], message: 'Satır hem iadeye hem irsaliyeye bağlanamaz' });
      }
      if (l.deliveryLineId && !l.itemId) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'itemId'], message: 'İrsaliyeye bağlı satırda stok kartı gerekli' });
      }
      if (l.projectId && doc.type !== 'purchase' && doc.type !== 'expense' && doc.type !== 'purchase_return') {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'projectId'], message: 'Proje şimdilik yalnızca alış, gider ve alış iadesi faturası kalemlerine yazılır' });
      }
    });
  }
}

export const createInvoiceSchema = invoiceBase.extend({ type: z.enum(INVOICE_TYPES) }).superRefine(refine);
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

/** Taslağı tümüyle değiştirir; tür değiştirilemez. */
export const updateInvoiceSchema = invoiceBase.superRefine((doc, ctx) => refine(doc, ctx));
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const cancelInvoiceSchema = z.object({
  /** İptal (ters kayıt) tarihi; boşsa bugün. */
  date: isoDate.optional(),
  reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300),
});
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

export const listInvoicesQuerySchema = z.object({
  side: z.enum(['sales', 'purchases']).optional(),
  type: z.enum(INVOICE_TYPES).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Fatura no, tedarikçi fatura no, cari adı/kodu. */
  query: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const vatSummaryQuerySchema = z.object({ from: isoDate, to: isoDate });
export type VatSummaryQuery = z.infer<typeof vatSummaryQuerySchema>;
