import { describe, expect, it } from 'vitest';
import { computeSupport, periodOverlaps, splitByProject, sumDeclaration } from './social-calc';
import { createEligibilitySchema, createSocialProfileSchema, createSupportRuleSchema, premiumSummaryQuerySchema } from './schemas/socialsecurity';

/** Bu dosyadaki oran/tutar/kodlar YALNIZCA TEST DEĞERİDİR (yasal değer değildir, kodda hiçbir yerde varsayılan değildir). */
const rule = (o: Partial<Parameters<typeof computeSupport>[1][number]> = {}) => ({ code: 'A', target: 'employer' as const, mode: 'percent_of_premium' as const, value: '50', ...o });

describe('prim desteği hesabı: kural yoksa destek yoktur', () => {
  it('kuralsız: sıfır', () => {
    expect(computeSupport({ employee: '300', employer: '360' }, [])).toEqual({ employee: '0.00', employer: '0.00', applied: [] });
  });

  it('yüzde: hedef primin yüzdesi, kuruşa yuvarlanır; hedef dışı prim etkilenmez', () => {
    const r = computeSupport({ employee: '300', employer: '360.01' }, [rule({ value: '33.333333' })]);
    expect(r.employer).toBe('120.00'); // 360.01 * 0.33333333 = 120.0033 -> 120.00
    expect(r.employee).toBe('0.00');
    expect(r.applied).toEqual([{ code: 'A', target: 'employer', amount: '120.00' }]);
  });

  it('sabit tutar prim ile sınırlanır; birden çok kural kod sırasıyla uygulanır ve toplamı primi aşamaz', () => {
    expect(computeSupport({ employee: '100', employer: '50' }, [rule({ mode: 'fixed_amount', value: '80' })]).employer).toBe('50.00');
    const r = computeSupport({ employee: '100', employer: '200' }, [
      rule({ code: 'B', mode: 'fixed_amount', value: '150' }),
      rule({ code: 'A', mode: 'percent_of_premium', value: '50' }),
    ]);
    // A önce (200*50%=100), sonra B (150, kalan 100 ile sınırlı)
    expect(r.applied.map((a) => [a.code, a.amount])).toEqual([['A', '100.00'], ['B', '100.00']]);
    expect(r.employer).toBe('200.00');
  });

  it('yüzde kuralları orijinal primin yüzdesidir (kalanın değil); hedefler ayrı sayılır', () => {
    const r = computeSupport({ employee: '100', employer: '100' }, [rule({ code: 'A', value: '30' }), rule({ code: 'B', value: '30' }), rule({ code: 'C', target: 'employee', value: '10' })]);
    expect(r.employer).toBe('60.00');
    expect(r.employee).toBe('10.00');
  });

  it('sıfır prim / sıfır değer destek üretmez', () => {
    expect(computeSupport({ employee: '0', employer: '0' }, [rule(), rule({ code: 'B', mode: 'fixed_amount', value: '5' })]).applied).toEqual([]);
    expect(computeSupport({ employee: '10', employer: '10' }, [rule({ value: '0' })]).applied).toEqual([]);
  });
});

describe('dönem çakışması', () => {
  it('ay içinde (kısmen de olsa) geçerli mi', () => {
    expect(periodOverlaps('2026-01-01', null, '2026-03-01', '2026-03-31')).toBe(true);
    expect(periodOverlaps('2026-03-31', null, '2026-03-01', '2026-03-31')).toBe(true);
    expect(periodOverlaps('2026-04-01', null, '2026-03-01', '2026-03-31')).toBe(false);
    expect(periodOverlaps('2026-01-01', '2026-02-28', '2026-03-01', '2026-03-31')).toBe(false);
    expect(periodOverlaps('2026-01-01', '2026-03-01', '2026-03-01', '2026-03-31')).toBe(true);
  });
});

describe('bildirim toplamları ve proje dağılımı', () => {
  it('toplam = satır toplamı; ödenecek = prim - destek; yeniden üretilebilir', () => {
    const lines = [
      { premiumBase: '3000', employeePremium: '300', employerPremium: '360', supportEmployee: '0', supportEmployer: '180' },
      { premiumBase: '1500.50', employeePremium: '150.05', employerPremium: '180.06', supportEmployee: '10', supportEmployer: '0' },
    ];
    const t = sumDeclaration(lines);
    expect(t).toEqual({ count: 2, premiumBase: '4500.50', employeePremium: '450.05', employerPremium: '540.06', supportEmployee: '10.00', supportEmployer: '180.00', supportTotal: '190.00', employeeDue: '440.05', employerDue: '360.06' });
    expect(sumDeclaration(lines)).toEqual(t);
    expect(sumDeclaration([]).count).toBe(0);
  });

  it('proje dağılımı ağırlıkla bölünür ve her tutarın toplamı bozulmaz; dağılım yoksa etiketsiz', () => {
    const parts = splitByProject({ a: '100', b: '10.01' }, [{ key: 'p1', weight: '1' }, { key: 'p2', weight: '1' }, { key: 'p3', weight: '1' }]);
    expect(parts.map((p) => p.key)).toEqual(['p1', 'p2', 'p3']);
    expect(parts.reduce((s, p) => s + Number(p.amounts.a), 0)).toBeCloseTo(100, 2);
    expect(parts.reduce((s, p) => s + Number(p.amounts.b), 0)).toBeCloseTo(10.01, 2);
    const none = splitByProject({ a: '12.345' }, []);
    expect(none).toHaveLength(1);
    expect(none[0]!.key).toBe('');
    expect(none[0]!.amounts.a.toFixed(2)).toBe('12.35');
    expect(splitByProject({ a: '10' }, [{ key: 'x', weight: '0' }])[0]!.key).toBe('');
  });
});

describe('şemalar', () => {
  const emp = '0198f2c4-7b1a-7000-8000-000000000001';
  it('profil: bordro tipi serbest metin, sigorta bitişi başlangıçtan önce olamaz', () => {
    expect(createSocialProfileSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', payrollTypeCode: 'SERBEST-KOD' }).success).toBe(true);
    expect(createSocialProfileSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', insuranceStart: '2026-03-01', insuranceEnd: '2026-02-01' }).success).toBe(false);
    expect(createSocialProfileSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', socialSecurityNo: '12' }).success).toBe(false);
  });
  it('destek kuralı varsayılan KAPALI; yüzde 100\'ü aşamaz; bitiş başlangıçtan önce olamaz', () => {
    const ok = createSupportRuleSchema.parse({ code: 'T', name: 'Test', effectiveFrom: '2026-01-01', target: 'employer', mode: 'percent_of_premium', value: '50' });
    expect(ok.enabled).toBe(false);
    expect(createSupportRuleSchema.safeParse({ code: 'T', name: 'Test', effectiveFrom: '2026-01-01', target: 'employer', mode: 'percent_of_premium', value: '101' }).success).toBe(false);
    expect(createSupportRuleSchema.safeParse({ code: 'T', name: 'Test', effectiveFrom: '2026-01-01', effectiveTo: '2025-01-01', target: 'employer', mode: 'fixed_amount', value: '5' }).success).toBe(false);
    expect(createSupportRuleSchema.safeParse({ code: 'T', name: 'Test', effectiveFrom: '2026-01-01', target: 'kurum', mode: 'fixed_amount', value: '5' }).success).toBe(false);
  });
  it('uygunluk ve rapor sorgusu', () => {
    expect(createEligibilitySchema.safeParse({ employeeId: emp, ruleCode: 'T', validFrom: '2026-02-01', validTo: '2026-01-01' }).success).toBe(false);
    expect(premiumSummaryQuerySchema.safeParse({ from: '2026-05', to: '2026-04' }).success).toBe(false);
    expect(premiumSummaryQuerySchema.safeParse({ from: '2026-04', to: '2026-05' }).success).toBe(true);
  });
});
