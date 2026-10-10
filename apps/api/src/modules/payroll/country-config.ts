import { and, desc, eq, sql } from 'drizzle-orm';
import {
  COUNTRY_PAYROLL_ENGINE_VERSION, countryPayrollConfigSchema, payrollTaxProfileSchema, dec, monthBounds,
  type CountryPayrollConfig, type PayrollTaxProfile, type createCountryPayrollConfigSchema, type createPayrollTaxProfileSchema,
} from '@erp/shared';
import type { z } from 'zod';
import type { Tx } from '../../db/client';
import { employeePayrollTaxProfiles, employees, payrollCountryConfigs, payrollRuns, users } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import type { PayrollCtx } from './config';
import { logPayrollAccess } from './config';

export async function listCountryConfigs(tx: Tx) {
  return tx.select().from(payrollCountryConfigs).orderBy(desc(payrollCountryConfigs.effectiveFrom));
}

export async function createCountryConfig(tx: Tx, ctx: PayrollCtx, input: z.infer<typeof createCountryPayrollConfigSchema>) {
  if (!input.effectiveFrom.endsWith('-01')) throw unprocessable('Bordro kuralı ayın ilk gününden başlamalı; ay içi rejim değişimi desteklenmiyor', 'PAYROLL_COUNTRY_PARTIAL_RULE');
  const [posted] = await tx.select({ id: payrollRuns.id }).from(payrollRuns).where(sql`${payrollRuns.jurisdiction}=${input.config.jurisdiction} and ${payrollRuns.month}>=${input.effectiveFrom.slice(0, 7)} and ${payrollRuns.month} like ${`${input.config.taxYear}-%`} and ${payrollRuns.status} in ('approved','paid')`).limit(1);
  if (posted) throw conflict('Kesinleşmiş bordro dönemine yeni kural eklenemez; sonraki dönem için tarihli sürüm oluşturun', 'PAYROLL_COUNTRY_POSTED_HISTORY');
  const [duplicate] = await tx.select({ id: payrollCountryConfigs.id }).from(payrollCountryConfigs).where(eq(payrollCountryConfigs.effectiveFrom, input.effectiveFrom));
  if (duplicate) throw conflict('Bu tarihte bordro kuralı var', 'PAYROLL_COUNTRY_CONFIG_EXISTS');
  const [row] = await tx.insert(payrollCountryConfigs).values({ companyId: ctx.companyId, jurisdiction: input.config.jurisdiction, effectiveFrom: input.effectiveFrom, config: input.config, sourceNote: input.sourceNote, createdBy: ctx.userId }).returning();
  return row!;
}

export async function verifyCountryConfig(tx: Tx, id: string, userId: string) {
  const [row] = await tx.select().from(payrollCountryConfigs).where(eq(payrollCountryConfigs.id, id)).for('update');
  if (!row) throw notFound('Ülke bordro kuralı');
  countryPayrollConfigSchema.parse(row.config);
  const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [updated] = await tx.update(payrollCountryConfigs).set({ verifiedAt: new Date(), verifiedBy: user?.email ?? userId }).where(eq(payrollCountryConfigs.id, id)).returning();
  return updated!;
}

export async function enableCountryConfig(tx: Tx, id: string, enabled: boolean) {
  const [row] = await tx.select().from(payrollCountryConfigs).where(eq(payrollCountryConfigs.id, id)).for('update');
  if (!row) throw notFound('Ülke bordro kuralı');
  if (enabled && !row.verifiedAt) throw unprocessable('Ülke bordro kuralı etkinleştirilmeden önce kaynağı ve çalışan rejimi doğrulanmalı', 'PAYROLL_COUNTRY_UNVERIFIED');
  const [updated] = await tx.update(payrollCountryConfigs).set({ enabled }).where(eq(payrollCountryConfigs.id, id)).returning();
  return updated!;
}

/** Son tarihli sürüm kapalıysa eski sürüme sessizce dönülmez. */
export async function resolveCountryConfig(tx: Tx, jurisdiction: 'TR' | 'KKTC', month: string) {
  const { start } = monthBounds(month);
  const [row] = await tx.select().from(payrollCountryConfigs).where(and(eq(payrollCountryConfigs.jurisdiction, jurisdiction), sql`${payrollCountryConfigs.effectiveFrom}<=${start}::date`)).orderBy(desc(payrollCountryConfigs.effectiveFrom)).limit(1);
  if (!row?.enabled || !row.verifiedAt) throw unprocessable('Bu ay için etkin ve doğrulanmış ülke bordro kuralı bulunamadı; Bordro ayarlarını tamamlayın', 'PAYROLL_COUNTRY_CONFIG_REQUIRED');
  const config = countryPayrollConfigSchema.parse(row.config);
  if (config.taxYear !== Number(month.slice(0, 4))) throw unprocessable('Bu vergi yılı için ayrı bordro kuralı gerekiyor', 'PAYROLL_COUNTRY_YEAR_REQUIRED');
  return { row, config };
}

export async function listTaxProfiles(tx: Tx) {
  const rows = await tx.select({ id: employeePayrollTaxProfiles.id, employeeId: employeePayrollTaxProfiles.employeeId, employeeCode: employees.code, employeeName: employees.fullName, effectiveFrom: employeePayrollTaxProfiles.effectiveFrom, profile: employeePayrollTaxProfiles.profile }).from(employeePayrollTaxProfiles).innerJoin(employees, eq(employees.id, employeePayrollTaxProfiles.employeeId)).orderBy(employees.code, desc(employeePayrollTaxProfiles.effectiveFrom));
  await logPayrollAccess(tx, rows.map((r) => r.employeeId), 'Bordro vergi profilleri görüntüleme');
  return rows;
}

export async function createTaxProfile(tx: Tx, ctx: PayrollCtx, input: z.infer<typeof createPayrollTaxProfileSchema>) {
  const [employee] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
  if (!employee) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  const [posted] = await tx.execute<{ id: string }>(sql`select r.id from payroll_runs r join payroll_lines l on l.run_id=r.id where l.employee_id=${input.employeeId}::uuid and r.status in ('approved','paid') and r.month>=${input.effectiveFrom.slice(0, 7)} and r.engine_version=${COUNTRY_PAYROLL_ENGINE_VERSION} limit 1`).then((r) => r.rows);
  if (posted) throw conflict('Kesinleşmiş bordro dönemine personel vergi profili eklenemez', 'PAYROLL_TAX_PROFILE_POSTED_HISTORY');
  const [duplicate] = await tx.select({ id: employeePayrollTaxProfiles.id }).from(employeePayrollTaxProfiles).where(and(eq(employeePayrollTaxProfiles.employeeId, input.employeeId), eq(employeePayrollTaxProfiles.effectiveFrom, input.effectiveFrom)));
  if (duplicate) throw conflict('Personelin bu tarihte vergi profili var', 'PAYROLL_TAX_PROFILE_EXISTS');
  const [row] = await tx.insert(employeePayrollTaxProfiles).values({ companyId: ctx.companyId, employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, profile: input.profile, createdBy: ctx.userId }).returning();
  return row!;
}

export async function taxProfilesAt(tx: Tx, month: string) {
  const { end } = monthBounds(month);
  const rows = await tx.execute<{ id: string; employee_id: string; effective_from: string; profile: unknown }>(sql`select distinct on (employee_id) id,employee_id,effective_from::text,profile from employee_payroll_tax_profiles where effective_from<=${end}::date order by employee_id,effective_from desc`);
  return new Map(rows.rows.map((r) => [r.employee_id, { id: r.id, effectiveFrom: r.effective_from, profile: payrollTaxProfileSchema.parse(r.profile) }]));
}

/** Şirket/yıl kilidi onay ve iptallerin kümülatif matrahı aynı anda değiştirmesini engeller. */
export async function lockPayrollYear(tx: Tx, companyId: string, month: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:country-payroll:${month.slice(0, 4)}`},0))`);
}

export async function requireNoLaterPostedCountryRun(tx: Tx, run: { id: string; month: string; jurisdiction: 'TR' | 'KKTC' | null }) {
  if (!run.jurisdiction) return;
  const [later] = await tx.select({ number: payrollRuns.number }).from(payrollRuns).where(sql`${payrollRuns.id}<>${run.id}::uuid and ${payrollRuns.month}>${run.month} and ${payrollRuns.month} like ${`${run.month.slice(0, 4)}-%`} and ${payrollRuns.status} in ('approved','paid') and ${payrollRuns.jurisdiction}=${run.jurisdiction}`).limit(1);
  if (later) throw conflict(`Sonraki bordro kesinleşmiş (${later.number}); önce sonraki dönemleri geri alın`, 'PAYROLL_COUNTRY_LATER_POSTED');
}

export async function cumulativeBases(tx: Tx, employeeId: string, month: string, profile: PayrollTaxProfile, config: CountryPayrollConfig) {
  if (profile.openingBalancesAsOf > month) throw unprocessable('Personelin açılış matrahı bordro ayından sonra', 'PAYROLL_OPENING_MONTH');
  const year = month.slice(0, 4);
  const openingYear = profile.openingBalancesAsOf.slice(0, 4);
  const openingMonth = openingYear === year ? profile.openingBalancesAsOf : `${year}-01`;
  const rows = await tx.execute<{ month: string; tax_base: string; legal: Record<string, unknown> | null }>(sql`
    select r.month,l.tax_base::text,l.legal_calculation_snapshot as legal from payroll_lines l join payroll_runs r on r.id=l.run_id
     where l.employee_id=${employeeId}::uuid and r.status in ('approved','paid') and r.month>=${openingMonth} and r.month<${month} and r.month like ${`${year}-%`} order by r.month`);
  if (config.jurisdiction === 'TR' && rows.rows.some((r) => !r.legal || r.legal.jurisdiction !== 'TR')) throw unprocessable('Eski bordrolar için açılış matrahını ülke hesabının başlangıç ayında açıkça girin', 'PAYROLL_LEGACY_OPENING_REQUIRED');
  let taxBase = dec(openingYear === year ? profile.openingTaxBase : '0');
  let exemptionBase = dec(openingYear === year ? profile.openingExemptionBase : '0');
  for (const row of rows.rows) {
    taxBase = taxBase.plus(row.tax_base);
    if (row.legal) exemptionBase = exemptionBase.plus(dec(String(row.legal.cumulativeExemptionBaseAfter ?? '0')).minus(String(row.legal.cumulativeExemptionBaseBefore ?? '0')));
  }
  // Bir ayın taslağı diğer ayın matrahı sayılamaz; sessiz vergi eksilmesi önlenir.
  const [draft] = await tx.select({ number: payrollRuns.number }).from(payrollRuns).where(sql`${payrollRuns.month}>=${openingMonth} and ${payrollRuns.month}<${month} and ${payrollRuns.month} like ${`${year}-%`} and ${payrollRuns.status}='draft' and ${payrollRuns.jurisdiction}=${config.jurisdiction}`).limit(1);
  if (config.jurisdiction === 'TR' && draft) throw conflict(`Önceki bordro (${draft.number}) taslak; önce onu kesinleştirin`, 'PAYROLL_PRIOR_DRAFT');
  return { cumulativeTaxBase: taxBase.toFixed(2), cumulativeExemptionBase: exemptionBase.toFixed(2), priorRunMonths: rows.rows.map((r) => r.month) };
}
