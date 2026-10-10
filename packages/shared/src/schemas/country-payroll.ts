import { z } from 'zod';
import { isoDate, moneyString, uuid } from './common';
import { yearMonth } from './attendance';

const amount = moneyString.refine((v) => Number(v) >= 0, 'Tutar negatif olamaz');
const percent = z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).refine((v) => Number(v) <= 100, 'Yüzde 0 ile 100 arasında olmalı');
export const taxBandSchema = z.object({ upTo: amount.nullable(), ratePct: percent });
const bands = z.array(taxBandSchema).min(1).max(20).superRefine((rows, ctx) => {
  let previous = 0;
  rows.forEach((row, index) => {
    if (row.upTo === null ? index !== rows.length - 1 : Number(row.upTo) <= previous || index === rows.length - 1) {
      ctx.addIssue({ code: 'custom', path: [index, 'upTo'], message: 'Dilim sınırları artmalı; son dilim sınırsız olmalı' });
    }
    if (row.upTo !== null) previous = Number(row.upTo);
  });
});
const common = {
  taxYear: z.number().int().min(2000).max(2100),
  rulePackVersion: z.string().trim().min(1).max(100),
  sourceRefs: z.array(z.url()).min(1).max(12),
  incomeTaxBands: bands,
};
export const countryPayrollConfigSchema = z.discriminatedUnion('jurisdiction', [
  z.object({
    ...common, jurisdiction: z.literal('TR'), regime: z.literal('standard_4a'),
    minimumGrossMonthly: amount, socialFloorDaily: amount, socialCapDaily: amount,
    employeeSocialPct: percent, employeeUnemploymentPct: percent,
    employerSocialPct: percent, employerUnemploymentPct: percent, stampPct: percent,
  }).superRefine((v, ctx) => {
    if (Number(v.socialFloorDaily) > Number(v.socialCapDaily)) ctx.addIssue({ code: 'custom', path: ['socialCapDaily'], message: 'Prim tavanı tabandan düşük olamaz' });
  }),
  z.object({
    ...common, jurisdiction: z.literal('KKTC'),
    regime: z.string().trim().min(1).max(80), salaryPeriods: z.union([z.literal(12), z.literal(13)]),
    personalAnnualAllowance: amount, specialAllowancePct: percent, employeeDeductibleLimitPct: percent,
    employeeInsurancePct: percent, employerInsurancePct: percent, occupationalRiskPct: percent,
    employeeProvidentPct: percent, employerProvidentPct: percent, employerLocalEmploymentPct: percent,
    socialFloorMonthly: amount, socialCapMonthly: amount.nullable(),
  }).superRefine((v, ctx) => {
    if (v.socialCapMonthly !== null && Number(v.socialFloorMonthly) > Number(v.socialCapMonthly)) ctx.addIssue({ code: 'custom', path: ['socialCapMonthly'], message: 'Prim tavanı tabandan düşük olamaz' });
  }),
]);
export type CountryPayrollConfig = z.infer<typeof countryPayrollConfigSchema>;
export type TaxBand = z.infer<typeof taxBandSchema>;

export const createCountryPayrollConfigSchema = z.object({
  effectiveFrom: isoDate,
  config: countryPayrollConfigSchema,
  sourceNote: z.string().trim().min(3).max(2000),
}).superRefine((v, ctx) => {
  if (Number(v.effectiveFrom.slice(0, 4)) !== v.config.taxYear) ctx.addIssue({ code: 'custom', path: ['effectiveFrom'], message: 'Yürürlük tarihi vergi yılı içinde olmalı' });
});
export const updateCountryPayrollConfigSchema = z.object({ enabled: z.boolean() });

export const payrollTaxProfileSchema = z.object({
  jurisdiction: z.enum(['TR', 'KKTC']), regime: z.string().trim().min(1).max(80),
  openingBalancesAsOf: yearMonth,
  openingTaxBase: amount,
  openingExemptionBase: amount,
  minimumWageExemption: z.boolean(),
  additionalAnnualAllowance: amount.default('0'),
  taxCreditPct: percent.default('0'),
});
export type PayrollTaxProfile = z.infer<typeof payrollTaxProfileSchema>;
export const createPayrollTaxProfileSchema = z.object({ employeeId: uuid, effectiveFrom: isoDate, profile: payrollTaxProfileSchema }).superRefine((v, ctx) => {
  if (v.profile.openingBalancesAsOf !== v.effectiveFrom.slice(0, 7)) ctx.addIssue({ code: 'custom', path: ['profile', 'openingBalancesAsOf'], message: 'Açılış matrahı profilin yürürlük ayına ait olmalı' });
  if (v.profile.jurisdiction === 'TR' && (v.profile.regime !== 'standard_4a' || Number(v.profile.additionalAnnualAllowance) !== 0 || Number(v.profile.taxCreditPct) !== 0)) ctx.addIssue({ code: 'custom', path: ['profile'], message: 'Türkiye paketi yalnız standart 4/a ücret bordrosunu destekler' });
});

export const countryPayrollPreviewSchema = z.object({
  config: countryPayrollConfigSchema, profile: payrollTaxProfileSchema,
  month: yearMonth, gross: amount, socialDays: z.number().int().min(0).max(30),
  cumulativeTaxBase: amount, cumulativeExemptionBase: amount,
});
