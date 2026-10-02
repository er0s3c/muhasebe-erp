import { dec, roundMoney, type MoneyValue } from './money';
import { allocateProportional } from './progress-calc';
import type { SupportMode, SupportTarget } from './schemas/socialsecurity';

/**
 * Sosyal güvenlik bildirimi hesabı (Faz D4). Prim tutarları D3 bordrosundan AYNEN alınır (yeniden hesaplanmaz); burada yalnızca
 * kullanıcının girdiği tarihli destek kuralları uygulanır. Hiçbir oran/koşul kodda yoktur; kural yoksa destek sıfırdır.
 */
export interface SupportRuleInput {
  code: string;
  target: SupportTarget;
  mode: SupportMode;
  value: string;
}

export interface SupportApplied {
  code: string;
  target: SupportTarget;
  amount: string;
}

export interface SupportResult {
  employee: string;
  employer: string;
  applied: SupportApplied[];
}

/**
 * Kuralları kod sırasıyla uygular. Her kural kendi hedef priminin KALANI ile sınırlanır (destek primi aşamaz, eksiye düşürmez).
 * percent_of_premium: hedef primin yüzdesi (kuruşa yuvarlanır); fixed_amount: sabit tutar.
 */
export function computeSupport(premium: { employee: string; employer: string }, rules: readonly SupportRuleInput[]): SupportResult {
  const remaining: Record<SupportTarget, MoneyValue> = { employee: roundMoney(premium.employee), employer: roundMoney(premium.employer) };
  const base: Record<SupportTarget, MoneyValue> = { ...remaining };
  const given: Record<SupportTarget, MoneyValue> = { employee: dec(0), employer: dec(0) };
  const applied: SupportApplied[] = [];
  for (const r of [...rules].sort((a, b) => a.code.localeCompare(b.code))) {
    const want = r.mode === 'percent_of_premium' ? roundMoney(base[r.target].times(r.value).div(100)) : roundMoney(r.value);
    const amt = MoneyMin(want, remaining[r.target]);
    if (amt.lte(0)) continue;
    remaining[r.target] = remaining[r.target].minus(amt);
    given[r.target] = given[r.target].plus(amt);
    applied.push({ code: r.code, target: r.target, amount: amt.toFixed(2) });
  }
  return { employee: given.employee.toFixed(2), employer: given.employer.toFixed(2), applied };
}

const MoneyMin = (a: MoneyValue, b: MoneyValue) => (a.lte(b) ? a : b);

/** Kuralın ayla çakışması: ay içinde (kısmen de olsa) geçerli mi? Bitiş tarihi boşsa süresizdir. */
export function periodOverlaps(from: string, to: string | null | undefined, monthStart: string, monthEnd: string): boolean {
  return from <= monthEnd && (!to || to >= monthStart);
}

export interface DeclarationLineAmounts {
  premiumBase: string;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
}

export interface DeclarationTotals {
  count: number;
  premiumBase: string;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
  supportTotal: string;
  employeeDue: string;
  employerDue: string;
}

/** Bildirim toplamları: satırların toplamıdır; ödenecek = prim - destek (yeniden üretilebilir). */
export function sumDeclaration(lines: readonly DeclarationLineAmounts[]): DeclarationTotals {
  const s = (k: keyof DeclarationLineAmounts) => lines.reduce((acc, l) => acc.plus(l[k]), dec(0));
  const supportEmployee = s('supportEmployee');
  const supportEmployer = s('supportEmployer');
  const employeePremium = s('employeePremium');
  const employerPremium = s('employerPremium');
  return {
    count: lines.length,
    premiumBase: s('premiumBase').toFixed(2),
    employeePremium: employeePremium.toFixed(2),
    employerPremium: employerPremium.toFixed(2),
    supportEmployee: supportEmployee.toFixed(2),
    supportEmployer: supportEmployer.toFixed(2),
    supportTotal: supportEmployee.plus(supportEmployer).toFixed(2),
    employeeDue: employeePremium.minus(supportEmployee).toFixed(2),
    employerDue: employerPremium.minus(supportEmployer).toFixed(2),
  };
}

export interface ProjectShareGroup {
  key: string;
  /** Dağıtım ağırlığı (bordro etiket dağılımındaki brüt tutar). */
  weight: string;
}

/**
 * Bir personelin prim/destek tutarlarını bordro etiket dağılımının brüt ağırlığına göre projelere böler (en büyük kalan
 * yöntemi; her tutarın toplamı bozulmaz). Dağılım yoksa tek "etiketsiz" grup ('' anahtarı) döner.
 */
export function splitByProject<K extends string>(amounts: Record<K, string>, groups: readonly ProjectShareGroup[]): { key: string; amounts: Record<K, MoneyValue> }[] {
  const keys = Object.keys(amounts) as K[];
  const g = groups.filter((x) => dec(x.weight).gt(0));
  if (g.length === 0) return [{ key: '', amounts: Object.fromEntries(keys.map((k) => [k, roundMoney(amounts[k])])) as Record<K, MoneyValue> }];
  const w = g.map((x) => x.weight);
  const parts = Object.fromEntries(keys.map((k) => [k, allocateProportional(amounts[k], w)])) as Record<K, MoneyValue[]>;
  return g.map((x, i) => ({ key: x.key, amounts: Object.fromEntries(keys.map((k) => [k, parts[k][i]!])) as Record<K, MoneyValue> }));
}
