import { describe, expect, it } from 'vitest';
import { combineMetrics, computeLeafMetrics, projectCostSide } from './project-cost';

const leaf = (budget: string, actual: string, percent: string | null = null, etcOverride: string | null = null) =>
  computeLeafMetrics({ budget, actual, percent, etcOverride });

describe('projectCostSide: hesap kodu ön ekiyle maliyet/gelir ayrımı', () => {
  it('60, 61, 64 gelir; diğerleri maliyet tarafıdır', () => {
    for (const c of ['600', '600.001', '601', '610', '611', '649', '64']) expect(projectCostSide(c), c).toBe('revenue');
    for (const c of ['621', '632', '659', '710', '720.001', '770', '653', '660', '8']) expect(projectCostSide(c), c).toBe('cost');
  });
});

describe('computeLeafMetrics', () => {
  it('ilerleme girilmiş: BAC 1.000, AC 400, %50 → EV 500, ETC 500, EAC 900, sapma +100, CPI 1,25', () => {
    const m = leaf('1000', '400', '50');
    expect(m.earnedValue.toString()).toBe('500');
    expect(m.etc.toString()).toBe('500');
    expect(m.eac.toString()).toBe('900');
    expect(m.variance.toString()).toBe('100');
    expect(m.cpi!.toString()).toBe('1.25');
    expect(m.remaining.toString()).toBe('600');
    expect(m.spentPct!.toString()).toBe('40');
    expect(m.percent!.toString()).toBe('50');
  });

  it('elle ETC öncelikli: ETC 700 → EAC 1.100, sapma −100', () => {
    const m = leaf('1000', '400', '50', '700');
    expect(m.etc.toString()).toBe('700');
    expect(m.eac.toString()).toBe('1100');
    expect(m.variance.toString()).toBe('-100');
  });

  it('ilerleme girilmemiş: ETC = kalan bütçe; bütçe aşıldıysa 0; CPI ve EV yok', () => {
    const a = leaf('1000', '400');
    expect(a.etc.toString()).toBe('600');
    expect(a.eac.toString()).toBe('1000');
    expect(a.variance.toString()).toBe('0');
    expect(a.cpi).toBeNull();
    expect(a.percent).toBeNull();
    expect(a.earnedValue.toString()).toBe('0');

    const b = leaf('1000', '1300');
    expect(b.etc.toString()).toBe('0');
    expect(b.eac.toString()).toBe('1300');
    expect(b.variance.toString()).toBe('-300');
    expect(b.remaining.toString()).toBe('-300');
  });

  it('bütçesiz (atanmamış) maliyet: EAC = AC, sapma = −AC, harcama yüzdesi yok', () => {
    const m = leaf('0', '250');
    expect(m.eac.toString()).toBe('250');
    expect(m.variance.toString()).toBe('-250');
    expect(m.spentPct).toBeNull();
  });

  it('%100 tamamlanmış iş kalemi: ETC 0, EAC = AC (bütçenin altında kalan tasarruf görünür)', () => {
    const m = leaf('1000', '850', '100');
    expect(m.etc.toString()).toBe('0');
    expect(m.eac.toString()).toBe('850');
    expect(m.variance.toString()).toBe('150');
    expect(m.cpi!.toString()).toBe('1.1765');
  });

  it('kuruş yuvarlama: BAC 100, %33,33 → EV 33,33, ETC 66,67', () => {
    const m = leaf('100', '0', '33.33');
    expect(m.earnedValue.toString()).toBe('33.33');
    expect(m.etc.toString()).toBe('66.67');
  });
});

describe('combineMetrics: üst düğüm toplamı', () => {
  it('toplanabilir ölçütler yaprakların toplamı; yüzde ve CPI yeniden hesaplanır', () => {
    const a = leaf('1000', '400', '50'); // EV 500, ETC 500, EAC 900
    const b = leaf('500', '100', '20'); // EV 100, ETC 400, EAC 500
    const c = combineMetrics([a, b]);
    expect(c.budget.toString()).toBe('1500');
    expect(c.actual.toString()).toBe('500');
    expect(c.earnedValue.toString()).toBe('600');
    expect(c.etc.toString()).toBe('900');
    expect(c.eac.toString()).toBe('1400');
    expect(c.variance.toString()).toBe('100');
    expect(c.percent!.toString()).toBe('40');
    expect(c.cpi!.toString()).toBe('1.2');
  });

  it('ilerlemesi girilmemiş yaprak %0 sayılır, CPI yalnızca ilerlemeli yaprakların AC’siyle hesaplanır', () => {
    const a = leaf('1000', '400', '50');
    const b = leaf('1000', '300'); // ilerleme yok
    const c = combineMetrics([a, b]);
    expect(c.percent!.toString()).toBe('25'); // EV 500 / BAC 2000
    expect(c.cpi!.toString()).toBe('1.25'); // 500 / 400
    expect(c.etc.toString()).toBe('1200'); // 500 + 700
  });

  it('hiç ilerleme yoksa yüzde ve CPI boş', () => {
    const c = combineMetrics([leaf('1000', '400'), leaf('0', '50')]);
    expect(c.percent).toBeNull();
    expect(c.cpi).toBeNull();
    expect(c.eac.toString()).toBe('1050');
  });
});
