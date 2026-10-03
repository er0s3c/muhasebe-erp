import { describe, expect, it } from 'vitest';
import {
  aggregateConsolidation,
  buildStatements,
  comparePeriod,
  computeFxPosition,
  computeKpis,
  convertRowNet,
  daysInclusive,
  mapCode,
  parseRateList,
  pctChange,
  summarizeIncome,
  type ConsolidationCompanyInput,
} from './consolidation-calc';
import { createEliminationSchema, consolidationReportQuerySchema } from './schemas/consolidation';

const A: ConsolidationCompanyInput = {
  companyId: 'a',
  name: 'A (TRY)',
  baseCurrency: 'TRY',
  rates: { closing: '1', pl: '1' },
  rows: [
    { code: '100', name: 'Kasa', opening: '0', debit: '1000', credit: '200' },
    { code: '500', name: 'Sermaye', opening: '0', debit: '0', credit: '1000' },
    { code: '600', name: 'Yurt İçi Satışlar', opening: '0', debit: '0', credit: '900' },
    { code: '632', name: 'Genel Yönetim', opening: '0', debit: '200', credit: '0' },
    { code: '136', name: 'Diğer Çeşitli Alacaklar', opening: '0', debit: '300', credit: '0' },
    { code: '102', name: 'Bankalar', opening: '0', debit: '600', credit: '0' },
  ],
  chart: [{ code: '100', name: 'Kasa' }, { code: '500', name: 'Sermaye' }, { code: '600', name: 'Satış' }, { code: '632', name: 'GY' }, { code: '136', name: 'DÇA' }, { code: '102', name: 'Bankalar' }, { code: '630.001', name: 'Ar-Ge' }],
};
const B: ConsolidationCompanyInput = {
  companyId: 'b',
  name: 'B (GBP)',
  baseCurrency: 'GBP',
  rates: { closing: '40', pl: '38' },
  rows: [
    { code: '100', name: 'Kasa', opening: '0', debit: '500', credit: '50' },
    { code: '500', name: 'Sermaye', opening: '0', debit: '0', credit: '500' },
    { code: '632', name: 'Genel Yönetim', opening: '0', debit: '57.5', credit: '0' },
    { code: '336', name: 'Diğer Çeşitli Borçlar', opening: '0', debit: '0', credit: '7.5' },
  ],
  chart: [{ code: '100', name: 'Kasa' }, { code: '500', name: 'Sermaye' }, { code: '632', name: 'GY' }, { code: '336', name: 'DÇB' }, { code: '600', name: 'Satış' }, { code: '136', name: 'DÇA' }, { code: '102', name: 'Bankalar' }],
};

describe('parseRateList / mapCode', () => {
  it('kur listesini ayrıştırır, bozuk girişi reddeder', () => {
    expect([...parseRateList('TRY:0.0245, EUR:1.08')]).toEqual([['TRY', '0.0245'], ['EUR', '1.08']]);
    expect(parseRateList('').size).toBe(0);
    expect(() => parseRateList('TRY=1')).toThrow();
    expect(() => parseRateList('TRY:0')).toThrow();
    expect(() => parseRateList('TRY:1,TRY:2')).toThrow();
  });
  it('hesap kodunu seviyeye göre eşler', () => {
    expect(mapCode('120.001', '3')).toBe('120');
    expect(mapCode('120.001', 'full')).toBe('120.001');
    expect(mapCode('120.001', '2')).toBe('12');
    expect(mapCode('12', '3')).toBe('12');
    expect(mapCode('7701', '3')).toBe('770');
  });
});

describe('convertRowNet', () => {
  it('bilanço hesabı kapanış kuruyla, sonuç hesabı dönem başı kapanış + hareket dönem kuruyla çevrilir', () => {
    const rates = { closing: '40', pl: '38' };
    expect(convertRowNet({ code: '100', name: '', opening: '10', debit: '5', credit: '0' }, rates).toFixed(2)).toBe('600.00');
    expect(convertRowNet({ code: '632', name: '', opening: '10', debit: '5', credit: '0' }, rates).toFixed(2)).toBe('590.00'); // 10×40 + 5×38
  });
});

describe('aggregateConsolidation', () => {
  it('tek kurda çevrim farkı sıfır, toplam dengeli; kod eşlemesi şirketleri birleştirir', () => {
    const b1 = { ...B, rates: { closing: '40', pl: '40' } };
    const r = aggregateConsolidation([A, b1], [], '3');
    const row = (c: string) => r.rows.find((x) => x.code === c)!;
    expect(row('100').consolidated).toBe('18800.0000'); // 800 + 450×40
    expect(row('100').perCompany).toEqual({ a: '800.0000', b: '18000.0000' });
    expect(row('632').consolidated).toBe('2500.0000');
    expect(r.translationDiff).toEqual({ a: '0.0000', b: '0.0000' });
    expect(r.totals.consolidated).toBe('0.0000');
  });
  it('kapanış ve dönem kuru farklıysa çevrim farkı mizanı dengeler', () => {
    const r = aggregateConsolidation([A, B], [], '3');
    // B: 450×40 − 500×40 + 57.5×38 − 7.5×40 = −115
    expect(r.rawSum.b).toBe('-115.0000');
    expect(r.translationDiff.b).toBe('115.0000');
    expect(r.totals.translationDiff).toBe('115.0000');
    expect(r.totals.consolidated).toBe('0.0000');
  });
  it('eliminasyon yalnızca konsolide sütunu değiştirir; dengeli eliminasyon toplamı bozmaz', () => {
    const b1 = { ...B, rates: { closing: '40', pl: '40' } };
    const r = aggregateConsolidation(
      [A, b1],
      [{ id: 'e1', description: 'Şirketler arası', kind: 'intercompany_balance', lines: [{ accountCode: '336', debit: '300', credit: '0' }, { accountCode: '136', debit: '0', credit: '300' }] }],
      '3',
    );
    const row = (c: string) => r.rows.find((x) => x.code === c)!;
    expect(row('136')).toMatchObject({ elimination: '-300.0000', consolidated: '0.0000' });
    expect(row('136').perCompany.a).toBe('300.0000');
    expect(row('336')).toMatchObject({ elimination: '300.0000', consolidated: '0.0000' });
    expect(r.totals.elimination).toBe('0.0000');
    expect(r.totals.consolidated).toBe('0.0000');
  });
  it('eşleşmeyen kod: yalnızca bazı şirketlerin hesap planında olan kod ayrı işaretlenir', () => {
    const a2: ConsolidationCompanyInput = { ...A, rows: [...A.rows, { code: '630.001', name: 'Ar-Ge', opening: '0', debit: '10', credit: '0' }, { code: '100', name: 'Kasa', opening: '0', debit: '0', credit: '10' }].slice(1) };
    const b1 = { ...B, rates: { closing: '40', pl: '40' } };
    const full = aggregateConsolidation([a2, b1], [], 'full');
    expect(full.rows.find((x) => x.code === '630.001')).toMatchObject({ unmapped: true, presentIn: ['a'] });
    expect(full.rows.find((x) => x.code === '100')!.unmapped).toBe(false);
  });
});

describe('buildStatements', () => {
  it('bilanço dengelenir (varlık = kaynak + dönem sonucu + çevrim farkı); gelir tablosu türetilmiş satırlar', () => {
    const r = aggregateConsolidation([A, B], [], '3');
    const cols = ['a', 'b'].map((id) => ({ id, rows: r.rows.map((x) => ({ code: x.code, name: x.name, net: x.perCompany[id]! })), translationDiff: r.translationDiff[id]! }));
    cols.push({ id: 'consolidated', rows: r.rows.map((x) => ({ code: x.code, name: x.name, net: x.consolidated })), translationDiff: r.totals.translationDiff });
    const s = buildStatements(cols);
    expect(s.difference).toEqual({ a: '0.0000', b: '0.0000', consolidated: '0.0000' });
    const is = (k: string) => s.incomeStatement.find((l) => l.key === k)!.values;
    expect(is('net_sales').a).toBe('900.0000');
    expect(is('gross_profit').a).toBe('900.0000');
    expect(is('operating_profit').a).toBe('700.0000');
    expect(is('net_profit').a).toBe('700.0000');
    expect(is('net_profit').b).toBe('-2185.0000'); // 57.5 × 38
    expect(is('net_profit').consolidated).toBe('-1485.0000');
    const bs = (k: string) => s.balanceSheet.find((l) => l.key === k)!.values;
    expect(bs('assets_total').a).toBe('1700.0000'); // 800 + 600 + 300
  });
});

describe('buildStatements — dönem (ACC-6)', () => {
  it('sonuç hesaplarının dönem başı bakiyesi gelir tablosuna girmez; bilançoda önceki dönemler sonucu olarak ayrılır', () => {
    const X: ConsolidationCompanyInput = {
      companyId: 'x',
      name: 'X',
      baseCurrency: 'TRY',
      rates: { closing: '1', pl: '1' },
      rows: [
        { code: '100', name: 'Kasa', opening: '1000', debit: '500', credit: '0' },
        { code: '600', name: 'Satış', opening: '-1000', debit: '0', credit: '500' },
      ],
      chart: [{ code: '100', name: 'Kasa' }, { code: '600', name: 'Satış' }],
    };
    const r = aggregateConsolidation([X], [], '3');
    const cols = [{ id: 'x', rows: r.rows.map((x) => ({ code: x.code, name: x.name, net: x.perCompany.x!, prior: x.perCompanyPrior.x! })), translationDiff: r.translationDiff.x! }];
    const s = buildStatements(cols);
    const is = (k: string) => s.incomeStatement.find((l) => l.key === k)!.values.x;
    const bs = (k: string) => s.balanceSheet.find((l) => l.key === k)!.values.x;
    expect(is('is60')).toBe('500.0000');
    expect(is('net_profit')).toBe('500.0000');
    expect(bs('period_result')).toBe('500.0000');
    expect(bs('prior_result')).toBe('1000.0000');
    expect(s.difference.x).toBe('0.0000');
  });
});

describe('summarizeIncome', () => {
  it('gelir, gider ve kâr sınıflaması', () => {
    const s = summarizeIncome([
      { code: '600', debit: '0', credit: '1000' },
      { code: '610', debit: '50', credit: '0' },
      { code: '621', debit: '400', credit: '0' },
      { code: '632', debit: '100', credit: '0' },
      { code: '646', debit: '0', credit: '20' },
      { code: '656', debit: '5', credit: '0' },
      { code: '770', debit: '10', credit: '0' },
      { code: '100', debit: '999', credit: '0' },
    ]);
    expect(s).toMatchObject({ netSales: '950.0000', costOfSales: '400.0000', grossProfit: '550.0000', operatingExpenses: '100.0000', otherIncome: '20.0000', otherExpenses: '5.0000', uncloseCosts: '10.0000', revenue: '970.0000', expenses: '515.0000', profit: '455.0000' });
  });
});

describe('dönem kaydırma ve KPI', () => {
  it('önceki dönem ve geçen yıl', () => {
    expect(daysInclusive('2026-01-01', '2026-03-31')).toBe(90);
    expect(comparePeriod('2026-04-01', '2026-06-30', 'previous')).toEqual({ from: '2025-12-31', to: '2026-03-31' }); // 91 gün
    expect(comparePeriod('2026-01-01', '2026-01-31', 'previous')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(comparePeriod('2024-02-29', '2024-03-31', 'last_year')).toEqual({ from: '2023-02-28', to: '2023-03-31' });
    expect(comparePeriod('2026-01-01', '2026-01-31', 'none')).toBeNull();
  });
  it('yüzde değişim ve KPI tanımları', () => {
    expect(pctChange('150', '100')).toBe('50.00');
    expect(pctChange('50', '-100')).toBe('150.00');
    expect(pctChange('5', '0')).toBeNull();
    const k = computeKpis({ netSales: '1000', costOfSales: '600', profit: '100', currentAssets: '300', shortLiabilities: '150', receivablesTotal: '200', receivablesOverdue: '50', days: 30 });
    expect(k).toEqual({ grossMarginPct: '40.00', netMarginPct: '10.00', currentRatio: '2.00', overdueReceivablesPct: '25.00', dsoDays: '6.0' });
    expect(computeKpis({ netSales: '0', costOfSales: '0', profit: '0', days: 30 })).toEqual({ grossMarginPct: null, netMarginPct: null, currentRatio: null, overdueReceivablesPct: null, dsoDays: null });
  });
});

describe('computeFxPosition', () => {
  it('net pozisyon, karşılık ve gerçekleşmemiş kur farkı tahmini', () => {
    const p = computeFxPosition(
      [
        { currency: 'USD', kind: 'cash', amount: '1000', book: '30000' },
        { currency: 'USD', kind: 'receivable', amount: '500', book: '16000' },
        { currency: 'USD', kind: 'payable', amount: '200', book: '6200' },
        { currency: 'EUR', kind: 'payable', amount: '100', book: '3500' },
      ],
      new Map([['USD', '35'], ['EUR', '38']]),
    );
    const usd = p.rows.find((r) => r.currency === 'USD')!;
    expect(usd).toMatchObject({ net: '1300.0000', bookNet: '39800.0000', equivalent: '45500.0000', unrealized: '5700.0000' });
    const eur = p.rows.find((r) => r.currency === 'EUR')!;
    expect(eur).toMatchObject({ net: '-100.0000', equivalent: '-3800.0000', unrealized: '-300.0000' });
    expect(p.totals).toEqual({ equivalent: '41700.0000', unrealized: '5400.0000' });
  });
  it('kur yoksa karşılık ve toplam null', () => {
    const p = computeFxPosition([{ currency: 'USD', kind: 'cash', amount: '10', book: '300' }], new Map([['USD', null]]));
    expect(p.rows[0]).toMatchObject({ equivalent: null, unrealized: null });
    expect(p.totals).toBeNull();
  });
});

describe('şemalar', () => {
  it('eliminasyon dengeli ve satır başına tek taraf olmalı', () => {
    const ok = { periodFrom: '2026-01-01', periodTo: '2026-12-31', description: 'Cari mahsup', lines: [{ accountCode: '336', debit: '300' }, { accountCode: '136', credit: '300' }] };
    expect(createEliminationSchema.safeParse(ok).success).toBe(true);
    expect(createEliminationSchema.safeParse({ ...ok, lines: [{ accountCode: '336', debit: '300' }, { accountCode: '136', credit: '299' }] }).success).toBe(false);
    expect(createEliminationSchema.safeParse({ ...ok, lines: [{ accountCode: '336', debit: '300', credit: '300' }, { accountCode: '136', credit: '300' }] }).success).toBe(false);
    expect(createEliminationSchema.safeParse({ ...ok, periodFrom: '2027-01-01' }).success).toBe(false);
  });
  it('rapor sorgusu varsayılanları ve geçersiz kur listesi', () => {
    const q = consolidationReportQuerySchema.parse({ from: '2026-01-01', to: '2026-12-31' });
    expect(q).toMatchObject({ plMethod: 'closing', mapLevel: '3' });
    expect(consolidationReportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31', closingRates: 'abc' }).success).toBe(false);
  });
});
