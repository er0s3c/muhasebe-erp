import { dec, roundMoney, type MoneyValue } from './money';
import { computePayroll, type PayrollCalcInput, type PayrollCalcResult, type PayrollComponent } from './payroll-calc';
import { countryPayrollConfigSchema, payrollTaxProfileSchema, type CountryPayrollConfig, type PayrollTaxProfile, type TaxBand } from './schemas/country-payroll';

export const COUNTRY_PAYROLL_ENGINE_VERSION = 'country-payroll-v1';
const money = (v: MoneyValue | string) => roundMoney(v).toFixed(2);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const positive = (v: MoneyValue) => v.isNegative() ? dec(0) : v;
const min = (a: MoneyValue, b: MoneyValue) => a.lt(b) ? a : b;
const max = (a: MoneyValue, b: MoneyValue) => a.gt(b) ? a : b;
const percentage = (v: MoneyValue, pct: string) => roundMoney(v.times(pct).div(100));

/** Sıralı, sonu sınırsız tarife. Kuruş yuvarlama toplam vergi hesaplandıktan sonra yapılır. */
export function progressiveIncomeTax(base: string | MoneyValue, bands: readonly TaxBand[]): MoneyValue {
  let remaining = positive(dec(base));
  let previous = dec(0);
  let total = dec(0);
  for (const band of bands) {
    const portion = band.upTo === null ? remaining : min(remaining, positive(dec(band.upTo).minus(previous)));
    total = total.plus(portion.times(band.ratePct).div(100));
    remaining = remaining.minus(portion);
    if (remaining.isZero()) break;
    if (band.upTo !== null) previous = dec(band.upTo);
  }
  return roundMoney(total);
}

export interface CountryPayrollSnapshot {
  engineVersion: typeof COUNTRY_PAYROLL_ENGINE_VERSION;
  jurisdiction: 'TR' | 'KKTC';
  month: string;
  rulePackVersion: string;
  config: CountryPayrollConfig;
  profile: PayrollTaxProfile;
  socialDays: number;
  cumulativeTaxBaseBefore: string;
  cumulativeTaxBaseAfter: string;
  cumulativeExemptionBaseBefore: string;
  cumulativeExemptionBaseAfter: string;
  incomeTaxBeforeExemption: string;
  incomeTaxExemption: string;
  stampBase: string;
  stampTaxBeforeExemption: string;
  stampTaxExemption: string;
  stampTax: string;
  personalAllowance: string;
  specialAllowance: string;
  employeeInsurance: string;
  employeeUnemployment: string;
  employeeProvident: string;
  employerInsurance: string;
  employerUnemployment: string;
  employerProvident: string;
  employerLocalEmployment: string;
  employerFloorTopUp: string;
}

export interface CountryPayrollInput extends PayrollCalcInput {
  config: CountryPayrollConfig;
  profile: PayrollTaxProfile;
  month: string;
  socialDays: number;
  cumulativeTaxBase: string;
  cumulativeExemptionBase: string;
}
export interface CountryPayrollResult extends PayrollCalcResult { legalSnapshot: CountryPayrollSnapshot }

/** Ülke hesapları yalnız açıkça seçilmiş rejim ve matrahla çalışır. Doğrulama/yürürlük seçimi API'ye aittir. */
export function computeCountryPayroll(input: CountryPayrollInput): CountryPayrollResult {
  const config = countryPayrollConfigSchema.parse(input.config);
  const profile = payrollTaxProfileSchema.parse(input.profile);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month) || Number(input.month.slice(0, 4)) !== config.taxYear) throw new Error('Bordro ayı kural paketinin vergi yılı dışında');
  if (profile.jurisdiction !== config.jurisdiction || profile.regime !== config.regime) throw new Error('Personel rejimi ile ülke bordro paketi uyuşmuyor');
  if (!Number.isInteger(input.socialDays) || input.socialDays < 0 || input.socialDays > 30) throw new Error('Prim günü 0 ile 30 arasında olmalı');
  const before = dec(input.cumulativeTaxBase);
  const exemptBefore = dec(input.cumulativeExemptionBase);
  if (before.isNegative() || exemptBefore.isNegative()) throw new Error('Kümülatif açılış matrahı negatif olamaz');

  // Yalnız ücret/puantaj parametreleri eski motora verilir; düz vergi ve prim iki kez uygulanmaz.
  const params = { ...input.params };
  for (const key of ['employee_social_pct', 'income_tax_pct', 'tax_base_deducts_social', 'social_base_cap', 'employer_social_pct', 'employer_other_pct', 'minimum_wage_monthly'] as const) delete params[key];
  const base = computePayroll({ ...input, params });
  const rawSocialBase = positive(dec(base.socialBase));
  if (config.jurisdiction === 'TR' && (dec(profile.additionalAnnualAllowance).gt(0) || dec(profile.taxCreditPct).gt(0))) throw new Error('Standart Türkiye paketi ek kişisel indirim rejimini desteklemiyor');
  if (input.socialDays === 0 && rawSocialBase.gt(0)) throw new Error('Prime esas ödeme için prim günü gerekli; işten ayrılma sonrası ödeme rejimi desteklenmiyor');
  let socialBase: MoneyValue, employeeInsurance: MoneyValue, employeeUnemployment = dec(0), employeeProvident = dec(0);
  let employerInsurance: MoneyValue, employerUnemployment = dec(0), employerProvident = dec(0), employerLocalEmployment = dec(0), employerFloorTopUp = dec(0);
  let taxBase: MoneyValue, incomeTaxBeforeExemption: MoneyValue, incomeTaxExemption = dec(0), incomeTax: MoneyValue;
  let stampBase = dec(0), stampBefore = dec(0), stampExemption = dec(0), stampTax = dec(0);
  let personalAllowance = dec(0), specialAllowance = dec(0), after: MoneyValue, exemptAfter = exemptBefore;
  const components: PayrollComponent[] = [...base.components];
  const component = (code: string, label: string, kind: 'deduction' | 'employer', value: MoneyValue, liability: 'social' | 'tax', rate: string | null = null) => {
    components.push({ source: 'country', code, label, kind, amount: money(value), liability, rate, itemId: null, paramKey: null });
  };
  if (config.jurisdiction === 'TR') {
    const cap = dec(config.socialCapDaily).times(input.socialDays);
    const floor = dec(config.socialFloorDaily).times(input.socialDays);
    const employeeBase = min(rawSocialBase, cap);
    socialBase = max(employeeBase, floor);
    employeeInsurance = percentage(employeeBase, config.employeeSocialPct);
    employeeUnemployment = percentage(employeeBase, config.employeeUnemploymentPct);
    employerInsurance = percentage(socialBase, config.employerSocialPct);
    employerUnemployment = percentage(socialBase, config.employerUnemploymentPct);
    // 5510/82: tabanın altında ücrette aradaki işçi primi farkını işveren karşılar.
    const floorGap = positive(floor.minus(employeeBase));
    employerFloorTopUp = percentage(floorGap, config.employeeSocialPct).plus(percentage(floorGap, config.employeeUnemploymentPct));
    taxBase = positive(dec(base.taxBase).minus(employeeInsurance).minus(employeeUnemployment));
    after = before.plus(taxBase);
    incomeTaxBeforeExemption = positive(progressiveIncomeTax(after, config.incomeTaxBands).minus(progressiveIncomeTax(before, config.incomeTaxBands)));
    if (profile.minimumWageExemption && dec(base.gross).gt(0)) {
      const minimum = dec(config.minimumGrossMonthly);
      const exemptionBase = minimum.minus(percentage(minimum, config.employeeSocialPct)).minus(percentage(minimum, config.employeeUnemploymentPct));
      exemptAfter = exemptBefore.plus(exemptionBase);
      incomeTaxExemption = min(incomeTaxBeforeExemption, positive(progressiveIncomeTax(exemptAfter, config.incomeTaxBands).minus(progressiveIncomeTax(exemptBefore, config.incomeTaxBands))));
      stampExemption = percentage(minimum, config.stampPct);
    }
    for (const item of input.items.filter((x) => x.kind === 'earning')) if (item.affectsStampBase == null) throw new Error(`Ek ödemenin damga esası belirlenmeli: ${item.code}`);
    stampBase = dec(base.basePay).plus(base.overtimePay).plus(input.items.filter((x) => x.kind === 'earning' && x.affectsStampBase).reduce((s, x) => s.plus(roundMoney(x.amount)), dec(0)));
    stampBefore = percentage(stampBase, config.stampPct);
    stampExemption = min(stampBefore, stampExemption);
    stampTax = positive(stampBefore.minus(stampExemption));
    incomeTax = positive(incomeTaxBeforeExemption.minus(incomeTaxExemption));
    component('TR_SGK_EMPLOYEE', 'SGK işçi primi', 'deduction', employeeInsurance, 'social', config.employeeSocialPct);
    component('TR_UNEMPLOYMENT_EMPLOYEE', 'İşsizlik işçi primi', 'deduction', employeeUnemployment, 'social', config.employeeUnemploymentPct);
    component('TR_INCOME_TAX', 'Kümülatif gelir vergisi (istisna sonrası)', 'deduction', incomeTax, 'tax');
    component('TR_STAMP', 'Damga vergisi (istisna sonrası)', 'deduction', stampTax, 'tax', config.stampPct);
    component('TR_SGK_EMPLOYER', 'SGK işveren primi', 'employer', employerInsurance, 'social', config.employerSocialPct);
    component('TR_UNEMPLOYMENT_EMPLOYER', 'İşsizlik işveren primi', 'employer', employerUnemployment, 'social', config.employerUnemploymentPct);
    if (employerFloorTopUp.gt(0)) component('TR_FLOOR_TOP_UP', 'Prim tabanı farkı (işveren)', 'employer', employerFloorTopUp, 'social');
  } else {
    const floor = dec(config.socialFloorMonthly).times(input.socialDays).div(30);
    socialBase = max(rawSocialBase, floor);
    if (config.socialCapMonthly !== null) socialBase = min(socialBase, dec(config.socialCapMonthly).times(input.socialDays).div(30));
    employeeInsurance = percentage(socialBase, config.employeeInsurancePct);
    employerInsurance = percentage(socialBase, dec(config.employerInsurancePct).plus(config.occupationalRiskPct).toString());
    // İhtiyat ve istihdam katkısı, sigorta tavanına değil ücretin ilgili brüt esasına uygulanır.
    employeeProvident = percentage(rawSocialBase, config.employeeProvidentPct);
    employerProvident = percentage(rawSocialBase, config.employerProvidentPct);
    employerLocalEmployment = percentage(rawSocialBase, config.employerLocalEmploymentPct);
    const deductible = min(employeeInsurance.plus(employeeProvident), percentage(dec(base.taxBase), config.employeeDeductibleLimitPct));
    personalAllowance = roundMoney(dec(config.personalAnnualAllowance).plus(profile.additionalAnnualAllowance).div(config.salaryPeriods));
    const remainder = positive(dec(base.taxBase).minus(deductible).minus(personalAllowance));
    specialAllowance = percentage(remainder, config.specialAllowancePct);
    taxBase = positive(remainder.minus(specialAllowance));
    const periodBands = config.incomeTaxBands.map((band) => ({ ...band, upTo: band.upTo === null ? null : money(dec(band.upTo).div(config.salaryPeriods)) }));
    incomeTaxBeforeExemption = progressiveIncomeTax(taxBase, periodBands);
    incomeTaxExemption = percentage(incomeTaxBeforeExemption, profile.taxCreditPct);
    incomeTax = positive(incomeTaxBeforeExemption.minus(incomeTaxExemption));
    after = before.plus(taxBase);
    component('KKTC_INSURANCE_EMPLOYEE', 'Sosyal sigorta işçi primi', 'deduction', employeeInsurance, 'social', config.employeeInsurancePct);
    component('KKTC_PROVIDENT_EMPLOYEE', 'İhtiyat Sandığı işçi primi', 'deduction', employeeProvident, 'social', config.employeeProvidentPct);
    component('KKTC_INCOME_TAX', 'Gelir vergisi (indirim sonrası)', 'deduction', incomeTax, 'tax');
    component('KKTC_INSURANCE_EMPLOYER', 'Sosyal sigorta işveren primi ve risk', 'employer', employerInsurance, 'social');
    component('KKTC_PROVIDENT_EMPLOYER', 'İhtiyat Sandığı işveren depoziti', 'employer', employerProvident, 'social', config.employerProvidentPct);
    component('KKTC_LOCAL_EMPLOYMENT', 'Yerel işgücü istihdam katkısı', 'employer', employerLocalEmployment, 'tax', config.employerLocalEmploymentPct);
  }
  const employeeSocial = employeeInsurance.plus(employeeUnemployment).plus(employeeProvident);
  const otherDeductions = dec(base.otherDeductions).plus(stampTax);
  const deductionsTotal = employeeSocial.plus(incomeTax).plus(otherDeductions);
  const net = dec(base.gross).minus(deductionsTotal);
  const employerSocial = employerInsurance.plus(employerUnemployment).plus(employerProvident).plus(employerFloorTopUp);
  const employerOther = employerLocalEmployment;
  const warnings = base.warnings.filter((x) => x.code !== 'negative_net');
  if (net.isNegative()) warnings.push({ code: 'negative_net' });
  if (config.jurisdiction === 'TR' && input.basis === 'monthly' && dec(input.rate).lt(config.minimumGrossMonthly)) warnings.push({ code: 'below_minimum_wage' });
  return {
    ...base, socialBase: money(socialBase), taxBase: money(taxBase), employeeSocial: money(employeeSocial), incomeTax: money(incomeTax),
    otherDeductions: money(otherDeductions), deductionsTotal: money(deductionsTotal), net: money(net), employerSocial: money(employerSocial),
    employerOther: money(employerOther), employerTotal: money(employerSocial.plus(employerOther)), components, warnings,
    legalSnapshot: {
      engineVersion: COUNTRY_PAYROLL_ENGINE_VERSION, jurisdiction: config.jurisdiction, month: input.month, rulePackVersion: config.rulePackVersion,
      config: clone(config), profile: clone(profile), socialDays: input.socialDays,
      cumulativeTaxBaseBefore: money(before), cumulativeTaxBaseAfter: money(after), cumulativeExemptionBaseBefore: money(exemptBefore), cumulativeExemptionBaseAfter: money(exemptAfter),
      incomeTaxBeforeExemption: money(incomeTaxBeforeExemption), incomeTaxExemption: money(incomeTaxExemption), stampBase: money(stampBase),
      stampTaxBeforeExemption: money(stampBefore), stampTaxExemption: money(stampExemption), stampTax: money(stampTax),
      personalAllowance: money(personalAllowance), specialAllowance: money(specialAllowance), employeeInsurance: money(employeeInsurance),
      employeeUnemployment: money(employeeUnemployment), employeeProvident: money(employeeProvident), employerInsurance: money(employerInsurance),
      employerUnemployment: money(employerUnemployment), employerProvident: money(employerProvident), employerLocalEmployment: money(employerLocalEmployment), employerFloorTopUp: money(employerFloorTopUp),
    },
  };
}

/** Kaynaklı başlangıç önerisi. API bu öneriyi kendiliğinden etkinleştirmez veya doğrulamaz. */
export function turkeyPayroll2026(): CountryPayrollConfig {
  return {
    jurisdiction: 'TR', regime: 'standard_4a', taxYear: 2026, rulePackVersion: 'TR-WAGE-2026-v1',
    sourceRefs: [
      'https://gib.gov.tr/mevzuat/kanun/433/madde/6937',
      'https://www.sgk.gov.tr/Content/Post/c7812ea8-5087-413f-aeb5-d3c1d153e11a/Isveren-Prim-Oranlari-2026-01-13-04-52-38',
      'https://www.sgk.gov.tr/Content/Post/2e0c9e1a-2cfe-4456-af10-49d3de0c58ba/Prime-Esas-Kazanc-Miktarlari-2026-01-14-10-35-39',
      'https://gib.gov.tr/mevzuat/kanun/433/ozelge/21388',
    ],
    incomeTaxBands: [{ upTo: '190000', ratePct: '15' }, { upTo: '400000', ratePct: '20' }, { upTo: '1500000', ratePct: '27' }, { upTo: '5300000', ratePct: '35' }, { upTo: null, ratePct: '40' }],
    minimumGrossMonthly: '33030', socialFloorDaily: '1101', socialCapDaily: '9909', employeeSocialPct: '14', employeeUnemploymentPct: '1',
    employerSocialPct: '21.75', employerUnemploymentPct: '2', stampPct: '0.759',
  };
}
