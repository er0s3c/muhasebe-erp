import { dec, roundMoney, type MoneyValue } from './money';
import { allocateProportional } from './progress-calc';
import { PAYROLL_PARAM_KEYS, type PayBasis, type PayrollLiability, type PayrollParamKey } from './schemas/payroll';

/**
 * Bordro hesabı (saf). API (hesaplama) ve web (açıklama) aynı fonksiyonu kullanır.
 *
 * KURAL: kodda yasal oran/çarpan/dilim yoktur. Her yasal hesap yalnızca ilgili parametre (`params`) VARSA yapılır; parametre
 * yoksa motor yalnızca kullanıcının yazdığını yapar (ücret şartı, elle ek ödeme/kesinti). Eksik parametre yüzünden atlanan
 * hesap sessiz kalmaz: `warnings` içinde bildirilir.
 *
 * Aylık ücret : brüt ücret = tutar; ücretsiz izin + devamsızlık günü başına günlük ücret kesilir (gün ücreti = tutar / days_per_month;
 *               parametre yoksa kesinti yapılmaz); hastalık/yıllık izin günleri `sick_leave_pay_pct` / `annual_leave_pay_pct` varsa
 *               günlük ücretin (100 − %)'i kesilir, yoksa kesinti yoktur.
 * Günlük ücret: ücret = tutar × saatli gün sayısı; hastalık/yıllık izin günü yalnızca ilgili % parametresi varsa ödenir.
 * Saatlik     : ücret = tutar × normal saat.
 * Fazla mesai : saat ücreti × fazla mesai saati × overtime_multiplier (saat ücreti: saatlikte tutar; günlükte tutar / hours_per_day;
 *               aylıkta tutar / days_per_month / hours_per_day). Çarpan ya da gereken bölen yoksa fazla mesai ücretlendirilmez (uyarı).
 * Esaslar     : prim esası = ücret + fazla mesai + "prime esas" işaretli ek ödemeler (social_base_cap varsa tavanla sınırlanır);
 *               vergi esası = ücret + fazla mesai + "vergiye esas" işaretli ek ödemeler (tax_base_deducts_social = 1 ise − işçi primi).
 * Kesintiler  : işçi primi = prim esası × employee_social_pct; gelir vergisi = vergi esası × income_tax_pct (düz oran: dilimli
 *               vergi modellenmemiştir, elle kesinti kalemi kullanılır); elle kesintiler yazıldığı gibi.
 * Net         : brüt − kesintiler. İşveren yükü: prim esası × employer_social_pct / employer_other_pct.
 * Tüm tutarlar 2 basamağa (yarıya yukarı) yuvarlanır.
 */
export interface PayrollAttendanceInput {
  normalHours: string;
  overtimeHours: string;
  /** Saatli gün sayısı (çalışılan gün + tatil/hafta tatilinde çalışılan gün). */
  hourDays: number;
  annualLeaveDays: number;
  sickLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
}

export interface PayrollParamValue {
  value: string;
  verified: boolean;
}
/** Yalnızca AÇIK parametreler verilir (kapalı satır = yok). */
export type PayrollParamSet = Partial<Record<PayrollParamKey, PayrollParamValue>>;

export interface PayrollItemInput {
  itemId: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  amount: string;
  affectsSocialBase: boolean;
  affectsTaxBase: boolean;
  liability: PayrollLiability;
}

export interface PayrollCalcInput {
  basis: PayBasis;
  /** Ücret tutarı: aylıkta aylık, günlükte günlük, saatlikte saatlik. */
  rate: string;
  attendance: PayrollAttendanceInput;
  params: PayrollParamSet;
  items: readonly PayrollItemInput[];
}

export type PayrollWarningCode =
  | 'overtime_no_multiplier'
  | 'overtime_no_rate'
  | 'absence_no_divisor'
  | 'below_minimum_wage'
  | 'negative_net'
  // Hesaplamayı çağıran (servis) ekler: ay içinde kısmi istihdam, puantajı eksik gün
  | 'partial_month'
  | 'missing_attendance';

export interface PayrollWarning {
  code: PayrollWarningCode;
  /** Eksik/ilgili parametre anahtarları. */
  keys?: PayrollParamKey[];
  /** Gün sayısı gibi ek bilgi (kısmi ay, eksik puantaj). */
  count?: number;
}

/** Hesabın slipte/kayıtta görünen kalemi (parametreden gelen kesinti/işveren yükü ve elle girilenler). */
export interface PayrollComponent {
  kind: 'earning' | 'deduction' | 'employer';
  source: 'param' | 'manual';
  /** Parametre kalemlerinde parametre anahtarı; elle kalemde kalem kodu. */
  code: string;
  label: string;
  amount: string;
  liability: PayrollLiability | null;
  itemId: string | null;
  paramKey: PayrollParamKey | null;
  /** Uygulanan yüzde/çarpan (bilgi). */
  rate: string | null;
}

export interface PayrollCalcResult {
  scheduledPay: string;
  absenceDeduction: string;
  basePay: string;
  overtimePay: string;
  earnings: string;
  gross: string;
  socialBase: string;
  taxBase: string;
  employeeSocial: string;
  incomeTax: string;
  otherDeductions: string;
  deductionsTotal: string;
  net: string;
  employerSocial: string;
  employerOther: string;
  employerTotal: string;
  components: PayrollComponent[];
  warnings: PayrollWarning[];
  /** Hesapta kullanılan parametreler: biri doğrulanmamışsa belge/ekran "doğrulanmadı" gösterir. */
  usedParams: { key: PayrollParamKey; value: string; verified: boolean }[];
}

const num = (p: PayrollParamValue | undefined) => (p ? dec(p.value) : null);
const pct = (base: MoneyValue, p: MoneyValue) => roundMoney(base.times(p).div(100));
const str = (v: MoneyValue) => roundMoney(v).toFixed(2);

export function computePayroll(i: PayrollCalcInput): PayrollCalcResult {
  const P = i.params;
  const used = new Set<PayrollParamKey>();
  const use = (k: PayrollParamKey) => {
    used.add(k);
    return num(P[k])!;
  };
  const warnings: PayrollWarning[] = [];
  const a = i.attendance;
  const rate = dec(i.rate);
  const dpm = P.days_per_month ? use('days_per_month') : null;
  const hpd = P.hours_per_day ? use('hours_per_day') : null;

  // Günlük ve saatlik ücret (bölen parametre yoksa null)
  const daily = i.basis === 'daily' ? rate : i.basis === 'monthly' && dpm ? rate.div(dpm) : null;
  const hourly = i.basis === 'hourly' ? rate : i.basis === 'daily' && hpd ? rate.div(hpd) : i.basis === 'monthly' && dpm && hpd ? rate.div(dpm).div(hpd) : null;

  // Ücret
  let scheduled: MoneyValue;
  let absence = dec(0);
  if (i.basis === 'monthly') {
    scheduled = roundMoney(rate);
    const lost = a.unpaidLeaveDays + a.absentDays;
    if (lost > 0 && !daily) warnings.push({ code: 'absence_no_divisor', keys: ['days_per_month'] });
    if (daily) {
      absence = absence.plus(daily.times(lost));
      if (P.sick_leave_pay_pct && a.sickLeaveDays > 0) absence = absence.plus(daily.times(a.sickLeaveDays).times(dec(100).minus(use('sick_leave_pay_pct'))).div(100));
      if (P.annual_leave_pay_pct && a.annualLeaveDays > 0) absence = absence.plus(daily.times(a.annualLeaveDays).times(dec(100).minus(use('annual_leave_pay_pct'))).div(100));
    }
    absence = roundMoney(absence);
    if (absence.gt(scheduled)) absence = scheduled;
  } else if (i.basis === 'daily') {
    scheduled = rate.times(a.hourDays);
    if (P.sick_leave_pay_pct && a.sickLeaveDays > 0) scheduled = scheduled.plus(rate.times(a.sickLeaveDays).times(use('sick_leave_pay_pct')).div(100));
    if (P.annual_leave_pay_pct && a.annualLeaveDays > 0) scheduled = scheduled.plus(rate.times(a.annualLeaveDays).times(use('annual_leave_pay_pct')).div(100));
    scheduled = roundMoney(scheduled);
  } else {
    scheduled = roundMoney(rate.times(a.normalHours));
  }
  const basePay = scheduled.minus(absence);

  // Fazla mesai
  let overtimePay = dec(0);
  if (dec(a.overtimeHours).gt(0)) {
    if (!P.overtime_multiplier) warnings.push({ code: 'overtime_no_multiplier', keys: ['overtime_multiplier'] });
    else if (!hourly) warnings.push({ code: 'overtime_no_rate', keys: i.basis === 'monthly' ? ['days_per_month', 'hours_per_day'] : ['hours_per_day'] });
    else overtimePay = roundMoney(hourly.times(a.overtimeHours).times(use('overtime_multiplier')));
  }

  // Ek ödemeler / kesintiler (elle)
  const earningItems = i.items.filter((x) => x.kind === 'earning');
  const deductionItems = i.items.filter((x) => x.kind === 'deduction');
  const earnings = earningItems.reduce((s, x) => s.plus(roundMoney(x.amount)), dec(0));
  const gross = basePay.plus(overtimePay).plus(earnings);

  // Esaslar
  const flagged = (f: 'affectsSocialBase' | 'affectsTaxBase') => earningItems.filter((x) => x[f]).reduce((s, x) => s.plus(roundMoney(x.amount)), dec(0));
  let socialBase = basePay.plus(overtimePay).plus(flagged('affectsSocialBase'));
  if (P.social_base_cap && socialBase.gt(use('social_base_cap'))) socialBase = roundMoney(use('social_base_cap'));

  const components: PayrollComponent[] = [];
  for (const x of earningItems) components.push({ kind: 'earning', source: 'manual', code: x.code, label: x.name, amount: str(dec(x.amount)), liability: null, itemId: x.itemId, paramKey: null, rate: null });

  // Parametreli kesintiler
  let employeeSocial = dec(0);
  if (P.employee_social_pct) {
    const p = use('employee_social_pct');
    employeeSocial = pct(socialBase, p);
    components.push({ kind: 'deduction', source: 'param', code: 'employee_social_pct', label: 'employee_social_pct', amount: str(employeeSocial), liability: 'social', itemId: null, paramKey: 'employee_social_pct', rate: p.toString() });
  }
  let taxBase = basePay.plus(overtimePay).plus(flagged('affectsTaxBase'));
  if (P.tax_base_deducts_social && !use('tax_base_deducts_social').isZero()) taxBase = taxBase.minus(employeeSocial);
  if (taxBase.isNegative()) taxBase = dec(0);
  let incomeTax = dec(0);
  if (P.income_tax_pct) {
    const p = use('income_tax_pct');
    incomeTax = pct(taxBase, p);
    components.push({ kind: 'deduction', source: 'param', code: 'income_tax_pct', label: 'income_tax_pct', amount: str(incomeTax), liability: 'tax', itemId: null, paramKey: 'income_tax_pct', rate: p.toString() });
  }
  let otherDeductions = dec(0);
  for (const x of deductionItems) {
    const amt = roundMoney(x.amount);
    otherDeductions = otherDeductions.plus(amt);
    components.push({ kind: 'deduction', source: 'manual', code: x.code, label: x.name, amount: str(amt), liability: x.liability, itemId: x.itemId, paramKey: null, rate: null });
  }
  const deductionsTotal = employeeSocial.plus(incomeTax).plus(otherDeductions);
  const net = gross.minus(deductionsTotal);

  // İşveren yükü
  let employerSocial = dec(0);
  let employerOther = dec(0);
  if (P.employer_social_pct) {
    const p = use('employer_social_pct');
    employerSocial = pct(socialBase, p);
    components.push({ kind: 'employer', source: 'param', code: 'employer_social_pct', label: 'employer_social_pct', amount: str(employerSocial), liability: 'social', itemId: null, paramKey: 'employer_social_pct', rate: p.toString() });
  }
  if (P.employer_other_pct) {
    const p = use('employer_other_pct');
    employerOther = pct(socialBase, p);
    components.push({ kind: 'employer', source: 'param', code: 'employer_other_pct', label: 'employer_other_pct', amount: str(employerOther), liability: 'tax', itemId: null, paramKey: 'employer_other_pct', rate: p.toString() });
  }

  // Denetimler (hesabı değiştirmez)
  if (P.minimum_wage_monthly && i.basis === 'monthly' && rate.lt(use('minimum_wage_monthly'))) warnings.push({ code: 'below_minimum_wage', keys: ['minimum_wage_monthly'] });
  if (net.isNegative()) warnings.push({ code: 'negative_net' });

  return {
    scheduledPay: str(scheduled),
    absenceDeduction: str(absence),
    basePay: str(basePay),
    overtimePay: str(overtimePay),
    earnings: str(earnings),
    gross: str(gross),
    socialBase: str(socialBase),
    taxBase: str(taxBase),
    employeeSocial: str(employeeSocial),
    incomeTax: str(incomeTax),
    otherDeductions: str(otherDeductions),
    deductionsTotal: str(deductionsTotal),
    net: str(net),
    employerSocial: str(employerSocial),
    employerOther: str(employerOther),
    employerTotal: str(employerSocial.plus(employerOther)),
    components,
    warnings,
    usedParams: PAYROLL_PARAM_KEYS.filter((k) => used.has(k)).map((k) => ({ key: k, value: P[k]!.value, verified: P[k]!.verified })),
  };
}

export interface HourGroup {
  /** Etiket anahtarı (proje|iş kalemi|maliyet kodu); etiketsiz için boş string. */
  key: string;
  hours: string;
}

/**
 * Bir personelin maliyetini (brüt ve işveren yükü ayrı) etiketli saat gruplarına saat oranında dağıtır (kuruş artığı kalmaz).
 * Saat yoksa (izinli aylık ücretli) tamamı etiketsiz gruba yazılır.
 */
export function allocateByHours(gross: string, employer: string, groups: readonly HourGroup[]): { key: string; gross: MoneyValue; employer: MoneyValue }[] {
  const g = groups.filter((x) => dec(x.hours).gt(0));
  if (g.length === 0) return [{ key: '', gross: roundMoney(gross), employer: roundMoney(employer) }];
  const weights = g.map((x) => x.hours);
  const gs = allocateProportional(gross, weights);
  const es = allocateProportional(employer, weights);
  return g.map((x, idx) => ({ key: x.key, gross: gs[idx]!, employer: es[idx]! }));
}
