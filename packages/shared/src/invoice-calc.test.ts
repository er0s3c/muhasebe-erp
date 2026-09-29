import { describe, expect, it } from 'vitest';
import { calcInvoice, calcLine } from './invoice-calc';
import { createInvoiceSchema, defaultMappingCodes, ACCOUNT_MAPPING_KEYS } from './schemas/invoices';
import { hasPermission } from './permissions';

const line = (quantity: string, unitPrice: string, vatRate: string, discountPct = '0') => ({ quantity, unitPrice, vatRate, discountPct });

describe('fatura hesabı: KDV hariç', () => {
  it('net, KDV ve brüt', () => {
    const c = calcLine(line('3', '100', '16'), false);
    expect(c.net.toFixed(2)).toBe('300.00');
    expect(c.vat.toFixed(2)).toBe('48.00');
    expect(c.gross.toFixed(2)).toBe('348.00');
  });

  it('iskonto netten düşer, KDV iskontolu net üzerinden hesaplanır', () => {
    const c = calcLine(line('10', '9.99', '16', '12.5'), false);
    // 99,90 × 0,875 = 87,4125 → 87,41; KDV 13,9856 → 13,99
    expect(c.net.toFixed(2)).toBe('87.41');
    expect(c.vat.toFixed(2)).toBe('13.99');
    expect(c.gross.toFixed(2)).toBe('101.40');
  });

  it('KDV satır başına yuvarlanır, toplam satırların toplamıdır', () => {
    // 3 satır × 0,03 net × %16 = 0,0048 → her satırda 0,00; başlıkta toplayıp yuvarlasak 0,01 çıkardı
    const t = calcInvoice([line('1', '0.03', '16'), line('1', '0.03', '16'), line('1', '0.03', '16')], false);
    expect(t.vat.toFixed(2)).toBe('0.00');
    expect(t.net.toFixed(2)).toBe('0.09');
    expect(t.gross.toFixed(2)).toBe('0.09');
  });

  it('miktar 4, birim fiyat 6 ondalıkla tek seferde yuvarlanır', () => {
    const c = calcLine(line('2.5', '0.333333', '0'), false);
    expect(c.net.toFixed(2)).toBe('0.83');
    expect(c.vat.toFixed(2)).toBe('0.00');
  });

  it('%0 KDV: brüt = net', () => {
    const c = calcLine(line('1', '250', '0'), false);
    expect(c.gross.toFixed(2)).toBe('250.00');
  });
});

describe('fatura hesabı: KDV dahil', () => {
  it('brütten net ve KDV türetir; net + KDV = brüt', () => {
    const c = calcLine(line('1', '116', '16'), true);
    expect(c.gross.toFixed(2)).toBe('116.00');
    expect(c.net.toFixed(2)).toBe('100.00');
    expect(c.vat.toFixed(2)).toBe('16.00');
  });

  it('yuvarlama farkı KDV\'ye yazılır, brüt korunur', () => {
    const c = calcLine(line('1', '10.00', '16'), true);
    // 10 / 1,16 = 8,6207 → 8,62; KDV = 1,38
    expect(c.net.toFixed(2)).toBe('8.62');
    expect(c.vat.toFixed(2)).toBe('1.38');
    expect(c.net.plus(c.vat).toFixed(2)).toBe('10.00');
  });

  it('iskonto brüt tutara uygulanır', () => {
    const c = calcLine(line('2', '58', '16', '50'), true);
    expect(c.gross.toFixed(2)).toBe('58.00');
    expect(c.net.toFixed(2)).toBe('50.00');
  });
});

describe('fatura toplamları', () => {
  it('KDV oranı bazında gruplar', () => {
    const t = calcInvoice([line('1', '100', '16'), line('2', '50', '5'), line('1', '20', '16')], false);
    expect(t.net.toFixed(2)).toBe('220.00');
    expect(t.vat.toFixed(2)).toBe('24.20'); // 16,00 + 3,20 (%16) + 5,00 (%5)
    expect(t.byRate.map((g) => [g.rate, g.net.toFixed(2), g.vat.toFixed(2)])).toEqual([
      ['5.0000', '100.00', '5.00'],
      ['16.0000', '120.00', '19.20'],
    ]);
    expect(t.gross.toFixed(2)).toBe('244.20');
  });
});

describe('fatura şeması', () => {
  const base = {
    type: 'sales' as const,
    partyId: '0198f3a0-0000-7000-8000-000000000001',
    invoiceDate: '2026-03-01',
    lines: [{ description: 'Mal', quantity: '1', unitPrice: '10' }],
  };

  it('geçerli girdiyi varsayılanlarla kabul eder', () => {
    const r = createInvoiceSchema.parse(base);
    expect(r.vatIncluded).toBe(false);
    expect(r.post).toBe(false);
    expect(r.lines[0]!.discountPct).toBe('0');
  });

  it('vade fatura tarihinden önce olamaz', () => {
    expect(createInvoiceSchema.safeParse({ ...base, dueDate: '2026-02-28' }).success).toBe(false);
  });

  it('orijinal fatura ve satır bağı yalnızca iadede', () => {
    const id = '0198f3a0-0000-7000-8000-000000000002';
    expect(createInvoiceSchema.safeParse({ ...base, returnOfId: id }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ ...base, type: 'sales_return', returnOfId: id }).success).toBe(true);
    const withLink = { ...base, lines: [{ ...base.lines[0]!, sourceLineId: id }] };
    expect(createInvoiceSchema.safeParse(withLink).success).toBe(false); // satış faturasında bağ yok
    expect(createInvoiceSchema.safeParse({ ...withLink, type: 'sales_return' }).success).toBe(false); // orijinal seçilmemiş
    expect(createInvoiceSchema.safeParse({ ...withLink, type: 'sales_return', returnOfId: id }).success).toBe(true);
  });

  it('miktar sıfır ve iskonto 100 üstü reddedilir', () => {
    expect(createInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0]!, quantity: '0' }] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ ...base, lines: [{ ...base.lines[0]!, discountPct: '101' }] }).success).toBe(false);
  });
});

describe('hesap eşlemesi varsayılanları', () => {
  it('her anahtarın varsayılan kodu var; stok hesabı sektöre göre', () => {
    const c = defaultMappingCodes('CONSTRUCTION');
    for (const k of ACCOUNT_MAPPING_KEYS) expect(c[k]).toMatch(/^\d{3}$/);
    expect(c.stock).toBe('150');
    expect(defaultMappingCodes('RETAIL_MARKET').stock).toBe('153');
    expect(defaultMappingCodes('COMMERCE').stock).toBe('153');
  });
});

describe('fatura izinleri', () => {
  it('satış temsilcisi taslak hazırlar ama muhasebeleştiremez', () => {
    expect(hasPermission('sales', 'invoices.manage')).toBe(true);
    expect(hasPermission('sales', 'invoices.post')).toBe(false);
    expect(hasPermission('accountant', 'invoices.post')).toBe(true);
    expect(hasPermission('viewer', 'invoices.read')).toBe(true);
    expect(hasPermission('viewer', 'invoices.manage')).toBe(false);
    expect(hasPermission('site_manager', 'invoices.read')).toBe(false);
  });
});
