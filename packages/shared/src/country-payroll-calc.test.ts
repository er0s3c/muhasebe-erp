import { describe, expect, it } from 'vitest';
import { computePayroll } from './payroll-calc';
import { computeCountryPayroll, progressiveIncomeTax, turkeyPayroll2026, type CountryPayrollInput } from './country-payroll-calc';
import { countryPayrollConfigSchema, createPayrollTaxProfileSchema, type CountryPayrollConfig } from './schemas/country-payroll';

const input = (overrides: Partial<CountryPayrollInput> = {}): CountryPayrollInput => ({
  basis: 'monthly', rate: '33030', attendance: { normalHours: '225', overtimeHours: '0', hourDays: 30, annualLeaveDays: 0, sickLeaveDays: 0, unpaidLeaveDays: 0, absentDays: 0 },
  params: { days_per_month: { value: '30', verified: true }, hours_per_day: { value: '7.5', verified: true } }, items: [],
  config: turkeyPayroll2026(), profile: { jurisdiction: 'TR', regime: 'standard_4a', openingBalancesAsOf: '2026-01', openingTaxBase: '0', openingExemptionBase: '0', minimumWageExemption: true, additionalAnnualAllowance: '0', taxCreditPct: '0' },
  month: '2026-01', socialDays: 30, cumulativeTaxBase: '0', cumulativeExemptionBase: '0', ...overrides,
});
// KKTC sosyal oranları örnek/test verisidir; genel yasal varsayılan olarak sunulmaz.
const kktc: CountryPayrollConfig = {
  jurisdiction: 'KKTC', regime: 'test-configured', taxYear: 2026, rulePackVersion: 'KKTC-TAX-2026-test', sourceRefs: ['https://www.vergi.gov.ct.tr/'],
  incomeTaxBands: [{ upTo: '45000', ratePct: '10' }, { upTo: '90000', ratePct: '20' }, { upTo: '210000', ratePct: '25' }, { upTo: '400000', ratePct: '30' }, { upTo: null, ratePct: '37' }],
  salaryPeriods: 12, personalAnnualAllowance: '655000', specialAllowancePct: '10', employeeDeductibleLimitPct: '13', employeeInsurancePct: '9', employerInsurancePct: '11', occupationalRiskPct: '1', employeeProvidentPct: '4', employerProvidentPct: '4', employerLocalEmploymentPct: '0', socialFloorMonthly: '0', socialCapMonthly: null,
};
const kkInput = (overrides: Partial<CountryPayrollInput> = {}) => input({ config: kktc, profile: { ...input().profile, jurisdiction: 'KKTC', regime: 'test-configured', minimumWageExemption: false }, ...overrides });

describe('ülke bordro hesapları', () => {
  it('2026 TR asgari ücretinde resmi net ve teşviksiz işveren maliyetini üretir', () => {
    const r = computeCountryPayroll(input());
    expect(r).toMatchObject({ gross: '33030.00', employeeSocial: '4954.50', incomeTax: '0.00', otherDeductions: '0.00', net: '28075.50', employerTotal: '7844.63' });
    expect(r.legalSnapshot).toMatchObject({ incomeTaxBeforeExemption: '4211.33', incomeTaxExemption: '4211.33', stampTax: '0.00', employeeInsurance: '4624.20', employeeUnemployment: '330.30', cumulativeTaxBaseAfter: '28075.50' });
  });
  it('TR dilim sınırını geçen matrahın iki oranını ve ayrı istisna kümülatifini kullanır', () => {
    const r = computeCountryPayroll(input({ rate: '50000', cumulativeTaxBase: '180000', cumulativeExemptionBase: '0' }));
    expect(r.taxBase).toBe('42500.00');
    expect(r.legalSnapshot.incomeTaxBeforeExemption).toBe('8000.00');
    expect(r.incomeTax).toBe('3788.67');
    expect(r.legalSnapshot.stampTax).toBe('128.80');
    expect(r.legalSnapshot.cumulativeTaxBaseAfter).toBe('222500.00');
  });
  it('TR SGK tavanı gün sayısına göre azalır; gelir vergisinin matrahını tavana kırpmaz', () => {
    const r = computeCountryPayroll(input({ rate: '400000', socialDays: 15 }));
    expect(r.socialBase).toBe('148635.00');
    expect(r.employeeSocial).toBe('22295.25');
    expect(r.taxBase).toBe('377704.75');
  });
  it('prim tabanının altındaki ücrette işçi farkını işverene yükler', () => {
    const r = computeCountryPayroll(input({ rate: '30000' }));
    expect(r.employeeSocial).toBe('4500.00');
    expect(r.legalSnapshot.employerFloorTopUp).toBe('454.50');
    expect(r.socialBase).toBe('33030.00');
    expect(r.net).toBe('25500.00');
  });
  it('eski düz yüzdeleri ülke hesabında ikinci kez kesmez; eski motora dokunmaz', () => {
    const i = input({ params: { employee_social_pct: { value: '50', verified: true }, income_tax_pct: { value: '50', verified: true } } });
    expect(computeCountryPayroll(i).net).toBe('28075.50');
    expect(computePayroll(i).net).toBe('0.00');
  });
  it('damga esası bilinmeyen ek ödemenin hesabını durdurur; ayrı işaretle hesaplar', () => {
    const item = { itemId: 'x', code: 'BONUS', name: 'Prim', kind: 'earning' as const, amount: '1000', affectsSocialBase: true, affectsTaxBase: true, liability: 'other' as const };
    expect(() => computeCountryPayroll(input({ items: [item] }))).toThrow('damga');
    const r = computeCountryPayroll(input({ items: [{ ...item, affectsStampBase: false }] }));
    expect(r.legalSnapshot.stampBase).toBe('33030.00');
  });
  it('KKTC indirim/prim/ihtiyat ve dönemsel tarife birbirinden ayrıdır', () => {
    const r = computeCountryPayroll(kkInput({ rate: '100000', cumulativeTaxBase: '5000000' }));
    expect(r).toMatchObject({ employeeSocial: '13000.00', employerTotal: '16000.00', taxBase: '29175.00', incomeTax: '7127.50', net: '79872.50' });
    expect(r.legalSnapshot).toMatchObject({ personalAllowance: '54583.33', specialAllowance: '3241.67', employeeInsurance: '9000.00', employeeProvident: '4000.00', employerInsurance: '12000.00', employerProvident: '4000.00' });
    // Türkiye gibi önceki kümülatif dilimi kullanmaz.
    expect(computeCountryPayroll(kkInput({ rate: '100000' })).incomeTax).toBe(r.incomeTax);
  });
  it('KKTC 13 maaş kişisel indirimi ve tarifesi farklıdır; sosyal tavan ihtiyatı sınırlamaz', () => {
    const r = computeCountryPayroll(kkInput({ rate: '100000', config: { ...kktc, jurisdiction: 'KKTC', salaryPeriods: 13, socialCapMonthly: '50000' } }));
    expect(r.legalSnapshot.personalAllowance).toBe('50384.62');
    expect(r.legalSnapshot.employeeInsurance).toBe('4500.00');
    expect(r.legalSnapshot.employeeProvident).toBe('4000.00');
    expect(r.incomeTax).not.toBe('7127.50');
  });
  it('ülke/yıl/rejim uyuşmazlığı ile geçersiz tarife ve profilleri reddeder', () => {
    expect(() => computeCountryPayroll(input({ month: '2027-01' }))).toThrow('yılı');
    expect(() => computeCountryPayroll(input({ profile: { ...input().profile, regime: 'retired' } }))).toThrow('rejimi');
    expect(countryPayrollConfigSchema.safeParse({ ...turkeyPayroll2026(), incomeTaxBands: [{ upTo: '100', ratePct: '10' }] }).success).toBe(false);
    expect(createPayrollTaxProfileSchema.safeParse({ employeeId: '00000000-0000-4000-8000-000000000001', effectiveFrom: '2026-02-01', profile: input().profile }).success).toBe(false);
  });
  it('tarifenin bütün sınırları ve yüksek ücret dilimi doğru hesaplanır', () => {
    const bands = turkeyPayroll2026().incomeTaxBands;
    expect(['190000', '400000', '1500000', '5300000', '5400000'].map((v) => progressiveIncomeTax(v, bands).toFixed(2))).toEqual(['28500.00', '70500.00', '367500.00', '1697500.00', '1737500.00']);
  });
});
