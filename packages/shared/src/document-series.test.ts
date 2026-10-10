import { describe, expect, it } from 'vitest';
import { DOCUMENT_SERIES, documentNumberPreview, documentSeriesOption, documentSeriesSchema } from './document-series';
import { operationsSettingsSchema } from './administration';
import { INVOICE_TYPE_META } from './schemas/invoices';
import { DELIVERY_NOTE_TYPE_META } from './schemas/deliveries';
import { TREASURY_TXN_PREFIX } from './schemas/treasury';

describe('Belge numara serileri', () => {
  it('eski şirket ayarları varsayılan gösterimi ve ayrıntılı çıktıyı korur', () => {
    const settings = operationsSettingsSchema.parse({}); expect(settings.documentSeries).toEqual({}); expect(settings.invoicePrintTemplate).toBe('detailed');
    expect(documentNumberPreview(documentSeriesOption(settings.documentSeries, 'INV:sales', 'SF'), 2026, 42)).toBe('SF-2026-000042');
  });
  it('tüm fatura, irsaliye ve kasa/banka varsayılan önekleri mevcut kayıtla aynıdır', () => {
    for (const [type, meta] of Object.entries(INVOICE_TYPE_META)) expect(DOCUMENT_SERIES.find(row => row.key === `INV:${type}`)?.prefix).toBe(meta.prefix);
    for (const [type, meta] of Object.entries(DELIVERY_NOTE_TYPE_META)) expect(DOCUMENT_SERIES.find(row => row.key === `DLV:${type}`)?.prefix).toBe(meta.prefix);
    for (const [type, prefix] of Object.entries(TREASURY_TXN_PREFIX)) expect(DOCUMENT_SERIES.find(row => row.key === `TRS:${type}`)?.prefix).toBe(prefix);
  });
  it('önek normalize edilir ve basamak aşımında numara kesilmez', () => {
    const settings = documentSeriesSchema.parse({ 'INV:sales': { prefix: ' abc-01 ', padding: 3 } });
    const option = documentSeriesOption(settings, 'INV:sales', 'SF');
    expect(documentNumberPreview(option, 2026, 2)).toBe('ABC-01-2026-002'); expect(documentNumberPreview(option, 2026, 123456)).toBe('ABC-01-2026-123456');
  });
  it('aynı tablo türleri varsayılan veya özel önekle çakışamaz', () => {
    expect(documentSeriesSchema.safeParse({ 'INV:sales': { prefix: 'AF', padding: 3 } }).success).toBe(false);
    expect(documentSeriesSchema.safeParse({ 'INV:sales': { prefix: 'ABC', padding: 3 }, 'INV:purchase': { prefix: 'abc', padding: 6 } }).success).toBe(false);
    expect(documentSeriesSchema.safeParse({ 'INV:sales': { prefix: 'ABC', padding: 3 }, 'DLV:sales': { prefix: 'ABC', padding: 6 } }).success).toBe(true);
  });
  it.each([{ key: 'unknown', prefix: 'ABC', padding: 3 }, { key: 'INV:sales', prefix: '<img>', padding: 3 }, { key: 'INV:sales', prefix: 'ABC', padding: 0 }, { key: 'INV:sales', prefix: 'ABC', padding: 11 }])('geçersiz ayar reddedilir: %j', row => {
    expect(documentSeriesSchema.safeParse({ [row.key]: { prefix: row.prefix, padding: row.padding } }).success).toBe(false);
  });
});
