import { describe, expect, it } from 'vitest';
import { allocateByHours, computePayroll, type PayrollAttendanceInput, type PayrollCalcInput, type PayrollItemInput, type PayrollParamSet } from './payroll-calc';
import { createPayrollParamSchema, createPayTermSchema, paramValueError, PAYROLL_PARAM_KEYS, PAYROLL_PARAM_META } from './schemas/payroll';

/**
 * Bu dosyadaki oranlar YALNIZCA TEST DEĞERİDİR (yasal değer değildir, kodda hiçbir yerde varsayılan değildir).
 */
const att = (o: Partial<PayrollAttendanceInput> = {}): PayrollAttendanceInput => ({ normalHours: '0', overtimeHours: '0', hourDays: 0, annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, absentDays: 0, ...o });
const pv = (value: string, verified = false) => ({ value, verified });
const input = (o: Partial<PayrollCalcInput> = {}): PayrollCalcInput => ({ basis: 'monthly', rate: '3000', attendance: att(), params: {}, items: [], ...o });
const item = (o: Partial<PayrollItemInput> = {}): PayrollItemInput => ({ itemId: 'i1', code: 'YMK', name: 'Yemek', kind: 'earning', amount: '100', affectsSocialBase: false, affectsTaxBase: false, liability: 'other', ...o });

describe('bordro hesabı: parametresiz motor yalnızca yazılanı yapar', () => {
  it('aylık ücret: brüt = tutar, yasal kesinti ve işveren yükü yok, fazla mesai ücretlendirilmez ve uyarılır', () => {
    const r = computePayroll(input({ attendance: att({ overtimeHours: '10', unpaidLeaveDays: 2, absentDays: 1 }) }));
    expect(r).toMatchObject({ gross: '3000.00', net: '3000.00', employeeSocial: '0.00', incomeTax: '0.00', employerTotal: '0.00', overtimePay: '0.00', absenceDeduction: '0.00' });
    expect(r.usedParams).toEqual([]);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['absence_no_divisor', 'overtime_no_multiplier']);
    expect(r.components).toEqual([]);
  });

  it('elle ek ödeme ve kesinti: brüt/net yazıldığı gibi; parametre kullanılmaz', () => {
    const r = computePayroll(input({ items: [item({ amount: '250.50' }), item({ itemId: 'i2', code: 'AVS', name: 'Avans', kind: 'deduction', amount: '400', liability: 'other' })] }));
    expect(r).toMatchObject({ earnings: '250.50', gross: '3250.50', otherDeductions: '400.00', deductionsTotal: '400.00', net: '2850.50' });
    expect(r.components.map((c) => [c.kind, c.source, c.code, c.amount, c.liability])).toEqual([
      ['earning', 'manual', 'YMK', '250.50', null],
      ['deduction', 'manual', 'AVS', '400.00', 'other'],
    ]);
  });

  it('günlük ve saatlik ücret: parametresiz saatli gün / normal saat çarpılır', () => {
    expect(computePayroll(input({ basis: 'daily', rate: '120', attendance: att({ hourDays: 22, sickLeaveDays: 2, annualLeaveDays: 1 }) })).gross).toBe('2640.00'); // izin günleri parametre yoksa ödenmez
    expect(computePayroll(input({ basis: 'hourly', rate: '12.50', attendance: att({ normalHours: '170.5' }) })).gross).toBe('2131.25');
  });
});

describe('bordro hesabı: parametreler (test değerleri)', () => {
  const params: PayrollParamSet = {
    days_per_month: pv('30'),
    hours_per_day: pv('7.5', true),
    overtime_multiplier: pv('1.5'),
    employee_social_pct: pv('10'),
    income_tax_pct: pv('20'),
    employer_social_pct: pv('12'),
    employer_other_pct: pv('1.5'),
  };

  it('aylık: devamsızlık/ücretsiz izin kesintisi, fazla mesai çarpanı, işçi/işveren yükü ve net', () => {
    // saat ücreti = 3000/30/7.5 = 13.3333; mesai = 13.3333 × 6 × 1.5 = 120.00; gün ücreti = 100; kesinti = 3 gün = 300
    const r = computePayroll(input({ params, attendance: att({ overtimeHours: '6', unpaidLeaveDays: 2, absentDays: 1 }) }));
    expect(r).toMatchObject({ scheduledPay: '3000.00', absenceDeduction: '300.00', basePay: '2700.00', overtimePay: '120.00', gross: '2820.00', socialBase: '2820.00' });
    expect(r).toMatchObject({ employeeSocial: '282.00', taxBase: '2820.00', incomeTax: '564.00', deductionsTotal: '846.00', net: '1974.00' });
    expect(r).toMatchObject({ employerSocial: '338.40', employerOther: '42.30', employerTotal: '380.70' });
    expect(r.usedParams.map((u) => [u.key, u.verified])).toEqual([['days_per_month', false], ['hours_per_day', true], ['overtime_multiplier', false], ['employee_social_pct', false], ['income_tax_pct', false], ['employer_social_pct', false], ['employer_other_pct', false]]);
    expect(r.components.filter((c) => c.source === 'param').map((c) => [c.kind, c.paramKey, c.amount, c.liability])).toEqual([
      ['deduction', 'employee_social_pct', '282.00', 'social'],
      ['deduction', 'income_tax_pct', '564.00', 'tax'],
      ['employer', 'employer_social_pct', '338.40', 'social'],
      ['employer', 'employer_other_pct', '42.30', 'tax'],
    ]);
  });

  it('prim/vergi esası işaretli kalemlerle; tavan; vergi esasından işçi primi düşme bayrağı', () => {
    const p: PayrollParamSet = { ...params, social_base_cap: pv('3200'), tax_base_deducts_social: pv('1') };
    const items = [item({ amount: '500', affectsSocialBase: true, affectsTaxBase: false }), item({ itemId: 'i2', code: 'PRM', name: 'Prim', amount: '200', affectsSocialBase: false, affectsTaxBase: true }), item({ itemId: 'i3', code: 'ARF', name: 'Arife', amount: '50' })];
    const r = computePayroll(input({ params: p, items }));
    // brüt = 3000+500+200+50 = 3750; prim esası = 3000+500 = 3500 → tavan 3200; işçi primi 320; vergi esası = 3000+200−320 = 2880; vergi = 576
    expect(r).toMatchObject({ gross: '3750.00', socialBase: '3200.00', employeeSocial: '320.00', taxBase: '2880.00', incomeTax: '576.00', net: '2854.00', employerSocial: '384.00' });
    // bayrak 0 ise düşülmez
    const r0 = computePayroll(input({ params: { ...p, tax_base_deducts_social: pv('0') }, items }));
    expect(r0.taxBase).toBe('3200.00');
  });

  it('hastalık/yıllık izin ödeme yüzdesi: aylıkta kesinti, günlükte ödeme (yalnızca parametre varsa)', () => {
    const p: PayrollParamSet = { days_per_month: pv('30'), sick_leave_pay_pct: pv('50'), annual_leave_pay_pct: pv('100') };
    const m = computePayroll(input({ params: p, attendance: att({ sickLeaveDays: 4, annualLeaveDays: 3 }) }));
    expect(m).toMatchObject({ absenceDeduction: '200.00', gross: '2800.00' }); // 4 × 100 × %50 kesilir; yıllık izin tam ödenir
    const d = computePayroll(input({ basis: 'daily', rate: '100', params: p, attendance: att({ hourDays: 20, sickLeaveDays: 4, annualLeaveDays: 3 }) }));
    expect(d.gross).toBe('2500.00'); // 2000 + 4×100×%50 + 3×100×%100
  });

  it('günlük ve saatlik ücrette fazla mesai: bölen yoksa uyarı, varsa çarpanla', () => {
    const noDiv = computePayroll(input({ basis: 'daily', rate: '150', params: { overtime_multiplier: pv('2') }, attendance: att({ hourDays: 1, overtimeHours: '3' }) }));
    expect(noDiv.overtimePay).toBe('0.00');
    expect(noDiv.warnings).toEqual([{ code: 'overtime_no_rate', keys: ['hours_per_day'] }]);
    const d = computePayroll(input({ basis: 'daily', rate: '150', params: { overtime_multiplier: pv('2'), hours_per_day: pv('7.5') }, attendance: att({ hourDays: 1, overtimeHours: '3' }) }));
    expect(d.overtimePay).toBe('120.00'); // 150/7.5 = 20 × 3 × 2
    const h = computePayroll(input({ basis: 'hourly', rate: '20', params: { overtime_multiplier: pv('1.25') }, attendance: att({ normalHours: '100', overtimeHours: '4' }) }));
    expect(h).toMatchObject({ basePay: '2000.00', overtimePay: '100.00', gross: '2100.00' });
  });

  it('asgari ücret yalnızca uyarıdır (hesabı değiştirmez); negatif net uyarılır; kesinti ücreti aşamaz değil, yalnızca uyarı', () => {
    const w = computePayroll(input({ rate: '2000', params: { minimum_wage_monthly: pv('2500') } }));
    expect(w.gross).toBe('2000.00');
    expect(w.warnings).toEqual([{ code: 'below_minimum_wage', keys: ['minimum_wage_monthly'] }]);
    const n = computePayroll(input({ items: [item({ kind: 'deduction', amount: '3500', code: 'ICR', name: 'İcra' })] }));
    expect(n.net).toBe('-500.00');
    expect(n.warnings.map((x) => x.code)).toContain('negative_net');
  });

  it('devamsızlık kesintisi aylık ücreti aşamaz; yuvarlama yarıya yukarı', () => {
    expect(computePayroll(input({ rate: '100', params: { days_per_month: pv('3') }, attendance: att({ absentDays: 10 }) })).basePay).toBe('0.00');
    expect(computePayroll(input({ basis: 'hourly', rate: '10.005', attendance: att({ normalHours: '1' }) })).gross).toBe('10.01');
  });
});

describe('saat etiketine dağıtım', () => {
  it('maliyet saat oranında dağıtılır ve toplamı tutar; saat yoksa etiketsiz', () => {
    const out = allocateByHours('1000.01', '100.00', [{ key: 'A', hours: '8' }, { key: 'B', hours: '16' }, { key: 'C', hours: '0' }]);
    expect(out.map((o) => o.key)).toEqual(['A', 'B']);
    expect(out.reduce((s, o) => s.plus(o.gross), out[0]!.gross.minus(out[0]!.gross)).toFixed(2)).toBe('1000.01');
    expect(out.reduce((s, o) => s.plus(o.employer), out[0]!.employer.minus(out[0]!.employer)).toFixed(2)).toBe('100.00');
    expect(allocateByHours('500', '40', [])).toMatchObject([{ key: '' }]);
    expect(allocateByHours('500', '40', [])[0]!.gross.toFixed(2)).toBe('500.00');
  });
});

describe('bordro şemaları', () => {
  it('parametre: anahtar listesi, birim aralığı ve varsayılan KAPALI', () => {
    const base = { key: 'income_tax_pct', value: '15', effectiveFrom: '2026-01-01' };
    const ok = createPayrollParamSchema.parse(base);
    expect(ok.enabled).toBe(false);
    expect(createPayrollParamSchema.safeParse({ ...base, key: 'uydurma' }).success).toBe(false);
    expect(createPayrollParamSchema.safeParse({ ...base, value: '101' }).success).toBe(false);
    expect(createPayrollParamSchema.safeParse({ ...base, key: 'overtime_multiplier', value: '0' }).success).toBe(false);
    expect(createPayrollParamSchema.safeParse({ ...base, key: 'tax_base_deducts_social', value: '2' }).success).toBe(false);
    expect(createPayrollParamSchema.safeParse({ ...base, key: 'days_per_month', value: '32' }).success).toBe(false);
    expect(paramValueError('hours_per_day', '25')).not.toBeNull();
    expect(PAYROLL_PARAM_KEYS.every((k) => PAYROLL_PARAM_META[k])).toBe(true);
  });

  it('ücret şartı: biçim ve temel', () => {
    const emp = '0198f2c4-7b1a-7000-8000-000000000001';
    expect(createPayTermSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', payBasis: 'monthly', amount: '3000' }).success).toBe(true);
    expect(createPayTermSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', payBasis: 'weekly', amount: '3000' }).success).toBe(false);
    expect(createPayTermSchema.safeParse({ employeeId: emp, effectiveFrom: '2026-01-01', payBasis: 'daily', amount: '-5' }).success).toBe(false);
  });
});
