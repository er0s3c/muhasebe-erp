import { describe, expect, it } from 'vitest';
import { allocateProportional, computeProgress } from './progress-calc';

const base = { vatRate: '0', retentionPct: '0', advancePct: '0', withholdingPct: '0', advanceBalance: '0', deductions: [] as string[] };

describe('computeProgress', () => {
  it('brifteki örnek: brüt 100.000, teminat %5, avans 8.000, kesinti 2.000 → net 85.000 (oranlar test verisidir)', () => {
    const r = computeProgress({
      ...base,
      lines: [{ thisQty: '1', unitPrice: '100000' }],
      retentionPct: '5',
      advancePct: '8',
      advanceBalance: '50000',
      deductions: ['2000'],
    });
    expect(r.gross.toFixed(2)).toBe('100000.00');
    expect(r.retention.toFixed(2)).toBe('5000.00');
    expect(r.advance.toFixed(2)).toBe('8000.00');
    expect(r.otherDeductions.toFixed(2)).toBe('2000.00');
    expect(r.net.toFixed(2)).toBe('85000.00');
  });

  it('BOQ örneği: 15.000 m × 3 + 30 adet × 500 + 1.000 × 8 = 68.000', () => {
    const r = computeProgress({
      ...base,
      lines: [
        { thisQty: '15000', unitPrice: '3' },
        { thisQty: '30', unitPrice: '500' },
        { thisQty: '1000', unitPrice: '8' },
      ],
    });
    expect(r.gross.toFixed(2)).toBe('68000.00');
    expect(r.net.toFixed(2)).toBe('68000.00');
  });

  it('avans mahsubu kalan bakiyeyle sınırlanır; bakiye yoksa mahsup yoktur', () => {
    const lines = [{ thisQty: '1', unitPrice: '1000' }];
    expect(computeProgress({ ...base, lines, advancePct: '10', advanceBalance: '40' }).advance.toFixed(2)).toBe('40.00');
    expect(computeProgress({ ...base, lines, advancePct: '10', advanceBalance: '0' }).advance.toFixed(2)).toBe('0.00');
    expect(computeProgress({ ...base, lines, advancePct: '10', advanceBalance: '-5' }).advance.toFixed(2)).toBe('0.00');
  });

  it('satır başına yuvarlama ve KDV/stopaj kuruşa yuvarlanır; net kimliği her zaman tutar', () => {
    const r = computeProgress({
      ...base,
      lines: [
        { thisQty: '3.3333', unitPrice: '1.01' },
        { thisQty: '7', unitPrice: '0.333' },
      ],
      vatRate: '16',
      retentionPct: '5',
      withholdingPct: '3.5',
      deductions: ['1.11'],
    });
    expect(r.lineAmounts.map((x) => x.toFixed(2))).toEqual(['3.37', '2.33']);
    expect(r.gross.toFixed(2)).toBe('5.70');
    expect(r.net.toFixed(2)).toBe(r.gross.plus(r.vat).minus(r.retention).minus(r.advance).minus(r.withholding).minus(r.otherDeductions).toFixed(2));
  });
});

describe('allocateProportional', () => {
  it('parçalar toplamı tam olarak toplamdır (kuruş artığı yok)', () => {
    const parts = allocateProportional('100.00', ['1', '1', '1']);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(parts.reduce((s, p) => s.plus(p), allocateProportional('0', ['1'])[0]!).toFixed(2)).toBe('100.00');
  });
  it('ağırlıkla orantılı; sıfır ağırlıkta ilk parça alır', () => {
    expect(allocateProportional('10', ['3', '1']).map((p) => p.toFixed(2))).toEqual(['7.50', '2.50']);
    expect(allocateProportional('10', ['0', '0']).map((p) => p.toFixed(2))).toEqual(['10.00', '0.00']);
    expect(allocateProportional('0', ['5', '5']).map((p) => p.toFixed(2))).toEqual(['0.00', '0.00']);
  });
});

describe('computeProgress: KDV tevkifatı ve malzeme mahsubu', () => {
  const lines = [{ thisQty: '1', unitPrice: '100000' }];
  it('tevkifat KDV\'nin yüzdesidir: brüt 100.000, KDV %20 = 20.000, %40 tevkifat = 8.000 → net 112.000', () => {
    const r = computeProgress({ ...base, lines, vatRate: '20', vatWithholdingPct: '40' });
    expect(r.vat.toFixed(2)).toBe('20000.00');
    expect(r.vatWithholding.toFixed(2)).toBe('8000.00');
    expect(r.net.toFixed(2)).toBe('112000.00');
  });
  it('tevkifat KDV yokken 0; verilmezse 0', () => {
    expect(computeProgress({ ...base, lines, vatWithholdingPct: '40' }).vatWithholding.toFixed(2)).toBe('0.00');
    expect(computeProgress({ ...base, lines, vatRate: '20' }).vatWithholding.toFixed(2)).toBe('0.00');
  });
  it('malzeme mahsubu net\'ten düşer; tümü bir arada net kimliği tutar', () => {
    const r = computeProgress({
      ...base,
      lines,
      vatRate: '20',
      vatWithholdingPct: '50',
      retentionPct: '5',
      advancePct: '10',
      advanceBalance: '50000',
      withholdingPct: '2',
      material: '15000.50',
      deductions: ['250'],
    });
    expect(r.material.toFixed(2)).toBe('15000.50');
    // 100.000 + 20.000 − 10.000 − 5.000 − 10.000 − 2.000 − 15.000,50 − 250
    expect(r.net.toFixed(2)).toBe('77749.50');
    expect(r.net.toFixed(2)).toBe(r.gross.plus(r.vat).minus(r.vatWithholding).minus(r.retention).minus(r.advance).minus(r.withholding).minus(r.material).minus(r.otherDeductions).toFixed(2));
  });
  it('tevkifat KDV tutarını aşamaz (yüzde ≤ 100) ve kuruşa yuvarlanır', () => {
    const r = computeProgress({ ...base, lines: [{ thisQty: '1', unitPrice: '333.33' }], vatRate: '16', vatWithholdingPct: '33.3333' });
    expect(r.vatWithholding.lte(r.vat)).toBe(true);
    expect(r.vatWithholding.toFixed(2)).toBe(r.vatWithholding.toDecimalPlaces(2).toFixed(2));
  });
});
