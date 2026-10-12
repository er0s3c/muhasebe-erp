import { z } from 'zod';

/** Mevcut sayaç anahtarları korunur; şirket ayarı yalnız yeni belgenin gösterimini değiştirir. */
export const DOCUMENT_SERIES = [
  { key: 'INV:sales', label: 'Satış faturası', prefix: 'SF', group: 'invoices' },
  { key: 'INV:sales_return', label: 'Satış iade faturası', prefix: 'SIF', group: 'invoices' },
  { key: 'INV:purchase', label: 'Alış faturası', prefix: 'AF', group: 'invoices' },
  { key: 'INV:expense', label: 'Gider faturası', prefix: 'GF', group: 'invoices' },
  { key: 'INV:purchase_return', label: 'Alış iade faturası', prefix: 'AIF', group: 'invoices' },
  { key: 'DLV:sales', label: 'Satış irsaliyesi', prefix: 'SIR', group: 'deliveries' },
  { key: 'DLV:purchase', label: 'Alış irsaliyesi', prefix: 'AIR', group: 'deliveries' },
  { key: 'DLV:sales_return', label: 'Satış iade irsaliyesi', prefix: 'SIRI', group: 'deliveries' },
  { key: 'DLV:purchase_return', label: 'Alış iade irsaliyesi', prefix: 'AIRI', group: 'deliveries' },
  { key: 'TRS:receipt', label: 'Tahsilat', prefix: 'TAH', group: 'treasury' },
  { key: 'TRS:payment', label: 'Ödeme', prefix: 'ODE', group: 'treasury' },
  { key: 'TRS:transfer', label: 'Hesaplar arası virman', prefix: 'VRM', group: 'treasury' },
  { key: 'TRS:exchange', label: 'Döviz alım / satım', prefix: 'DVZ', group: 'treasury' },
  { key: 'TRS:other_receipt', label: 'Diğer tahsilat', prefix: 'DTH', group: 'treasury' },
  { key: 'TRS:other_payment', label: 'Diğer ödeme', prefix: 'DOD', group: 'treasury' },
  { key: 'SALES:quote', label: 'Satış teklifi', prefix: 'TKL', group: 'sales' },
  { key: 'SALES:order', label: 'Satış siparişi', prefix: 'SSP', group: 'sales' },
  { key: 'JE', label: 'Yevmiye fişi', prefix: 'YV', group: 'journal' },
  { key: 'STK', label: 'Stok belgesi', prefix: 'SH', group: 'stock' },
  { key: 'CNT', label: 'Stok sayımı', prefix: 'SY', group: 'counts' },
  { key: 'EXP', label: 'Gider fişi', prefix: 'GDF', group: 'expenses' },
  { key: 'CHQB', label: 'Çek / senet toplu işlem', prefix: 'CTK', group: 'cheques' },
  { key: 'EMPLOYEE_ADVANCE', label: 'Personel avansı', prefix: 'AVN', group: 'advances' },
  { key: 'PAYROLL', label: 'Bordro', prefix: 'BRD', group: 'payroll' },
  { key: 'SOCIAL_DECLARATION', label: 'Sosyal güvenlik bildirimi', prefix: 'SGB', group: 'social' },
  { key: 'PO_RECEIPT', label: 'Mal kabul', prefix: 'MK', group: 'receipts' },
  { key: 'SALES_CONTRACT', label: 'Gayrimenkul satış sözleşmesi', prefix: 'SSZ', group: 'contracts' },
  { key: 'PRG', label: 'Taşeron hakedişi', prefix: 'HKD', group: 'progress' },
  { key: 'PRG:in', label: 'İşveren hakedişi', prefix: 'AHK', group: 'progress' },
  { key: 'IMP', label: 'İthalat dosyası', prefix: 'ITH', group: 'imports' },
] as const;
export type DocumentSeriesKey = typeof DOCUMENT_SERIES[number]['key'];
const keys = DOCUMENT_SERIES.map(row => row.key) as [DocumentSeriesKey, ...DocumentSeriesKey[]];
export const documentSeriesOptionSchema = z.object({
  prefix: z.string().trim().toUpperCase().min(1).max(16).regex(/^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/, 'Önek A–Z ve 0–9 içerebilir; gruplar tire veya alt çizgiyle ayrılabilir.'),
  padding: z.number().int().min(1).max(10),
});
export type DocumentSeriesOption = z.infer<typeof documentSeriesOptionSchema>;
export const documentSeriesSchema = z.partialRecord(z.enum(keys), documentSeriesOptionSchema).default({}).superRefine((settings, ctx) => {
  const used = new Map<string, string>();
  for (const definition of DOCUMENT_SERIES) {
    const prefix = settings[definition.key]?.prefix ?? definition.prefix;
    const key = `${definition.group}:${prefix}`;
    const previous = used.get(key);
    if (previous) ctx.addIssue({ code: 'custom', path: [definition.key, 'prefix'], message: `${definition.label} öneki ${previous} ile aynı olamaz.` });
    used.set(key, definition.label);
  }
});
export type DocumentSeriesSettings = z.infer<typeof documentSeriesSchema>;
export const INVOICE_PRINT_TEMPLATES = ['simple', 'detailed'] as const;
export type InvoicePrintTemplate = typeof INVOICE_PRINT_TEMPLATES[number];
export const INVOICE_PRINT_TEMPLATE_LABELS: Record<InvoicePrintTemplate, string> = { simple: 'Basit', detailed: 'Ayrıntılı' };

export function documentSeriesOption(settings: DocumentSeriesSettings, key: string, fallbackPrefix: string): DocumentSeriesOption {
  return settings[key as DocumentSeriesKey] ?? { prefix: fallbackPrefix, padding: 6 };
}
export function documentNumberPreview(option: DocumentSeriesOption, year: number, value = 1): string {
  return `${option.prefix}-${year}-${String(value).padStart(option.padding, '0')}`;
}
