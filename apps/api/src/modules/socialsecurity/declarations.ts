import { and, eq, sql } from 'drizzle-orm';
import { computeSupport, dec, isoYear, monthBounds, periodOverlaps, sumDeclaration, toDbAmount, type SupportRuleInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { payrollRuns, socialDeclarationLines, socialDeclarations } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { getMonthLock } from '../hr/attendance';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { logSocialAccess, profilesAtMonthEnd, type SocialCtx } from './config';

type Decl = typeof socialDeclarations.$inferSelect;

async function lockDeclaration(tx: Tx, id: string): Promise<Decl> {
  const [d] = await tx.select().from(socialDeclarations).where(eq(socialDeclarations.id, id)).for('update');
  if (!d) throw notFound('Sosyal güvenlik bildirimi');
  return d;
}

const requireDraft = (d: Decl) => {
  if (d.status !== 'draft') throw unprocessable('Kesinleşmiş bildirim değiştirilemez; önce yeniden açın', 'SOCIAL_NOT_DRAFT');
};

export interface DeclarationLineView {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  payrollTypeCode: string | null;
  insuranceStart: string | null;
  insuranceEnd: string | null;
  ssnMasked: string | null;
  daysWorked: number;
  annualLeaveDays: number;
  sickLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  premiumBase: string;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
  employeeDue: string;
  employerDue: string;
  supportCodes: string | null;
  warnings: DeclarationWarning[];
}

/** Satır uyarı kodları (web çevirir). */
export type DeclarationWarning = 'no_profile' | 'no_ssn' | 'no_payroll_type' | 'insurance_outside_month' | 'zero_base' | 'support_rule_off' | 'no_days';

interface RuleVersion {
  id: string;
  code: string;
  name: string;
  target: string;
  mode: string;
  value: string;
  enabled: boolean;
  verified: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Her kod için ayın son gününe kadar başlamış en yeni sürüm (yeni sürüm eskiyi kapatabilir). */
async function ruleVersionsAt(tx: Tx, monthEnd: string): Promise<Map<string, RuleVersion>> {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select distinct on (code) id, code, name, target, mode, value::text as value, enabled, verified_at is not null as verified,
           effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
      from social_support_rules where effective_from <= ${monthEnd}::date
     order by code, effective_from desc`);
  return new Map((res.rows as unknown as RuleVersion[]).map((r) => [r.code, { ...r, value: String(Number(r.value)) }]));
}

/**
 * Taslak bildirimi (yoksa oluşturarak) AYIN onaylı/ödenmiş bordrosundan yeniden üretir. Prim tutarları bordrodan aynen alınır
 * (D3 parametreleri; burada yeniden hesaplanmaz). Destek YALNIZCA kullanıcının girdiği, ayla çakışan, AÇIK kuralın ve personelin
 * tarihli uygunluk beyanının birlikte bulunduğu satırlarda uygulanır. Aynı girdi aynı çıktıyı verir.
 */
export async function buildDeclaration(tx: Tx, ctx: SocialCtx, month: string) {
  const { start, end } = monthBounds(month);
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.month, month), sql`${payrollRuns.status} in ('approved','paid')`));
  if (!run) throw unprocessable(`${month} ayı için onaylı ya da ödenmiş bordro yok; bildirim bordrodan üretilir`, 'SOCIAL_NO_PAYROLL');

  let [decl] = await tx.select().from(socialDeclarations).where(eq(socialDeclarations.month, month)).for('update');
  if (decl && decl.status !== 'draft') throw conflict(`${month} bildirimi kesinleşmiş (${decl.number}); önce yeniden açın`, 'SOCIAL_FINALIZED');
  if (!decl) {
    const number = formatDocumentNumber('SGB', isoYear(`${month}-01`), await nextNumber(tx, ctx.companyId, 'SOCIAL_DECLARATION', isoYear(`${month}-01`)));
    [decl] = await tx
      .insert(socialDeclarations)
      .values({ companyId: ctx.companyId, number, month, payrollRunId: run.id, payrollRunNumber: run.number, createdBy: ctx.userId })
      .returning();
  }
  const id = decl!.id;
  await tx.delete(socialDeclarationLines).where(eq(socialDeclarationLines.declarationId, id));

  const lines = await tx.execute<Record<string, unknown>>(sql`
    select id, employee_id as "employeeId", hour_days as "daysWorked", annual_leave_days as "annual", sick_leave_days as "sick",
           unpaid_leave_days as "unpaid", absent_days as "absent", social_base::text as base, employee_social::text as "employeeSocial",
           employer_social::text as "employerSocial"
      from payroll_lines where run_id = ${run.id} order by id`);
  const profiles = await profilesAtMonthEnd(tx, end);
  const rules = await ruleVersionsAt(tx, end);
  const elig = await tx.execute<{ employee_id: string; rule_code: string }>(sql`
    select employee_id, rule_code from employee_support_eligibility
     where valid_from <= ${end}::date and (valid_to is null or valid_to >= ${start}::date)`);
  const eligByEmp = new Map<string, string[]>();
  for (const e of elig.rows) eligByEmp.set(e.employee_id, [...(eligByEmp.get(e.employee_id) ?? []), e.rule_code]);

  const snapshot = new Map<string, { code: string; ruleId: string; name: string; target: string; mode: string; value: string; verified: boolean }>();
  const built: (typeof socialDeclarationLines.$inferInsert)[] = [];
  for (const l of lines.rows) {
    const empId = l.employeeId as string;
    const profile = profiles.get(empId);
    const warnings: DeclarationWarning[] = [];
    if (!profile) warnings.push('no_profile');
    else {
      if (!profile.has_ssn) warnings.push('no_ssn');
      if (!profile.payroll_type_code) warnings.push('no_payroll_type');
      if ((profile.insurance_start && profile.insurance_start > end) || (profile.insurance_end && profile.insurance_end < start)) warnings.push('insurance_outside_month');
    }
    const days = Number(l.daysWorked);
    if (days === 0) warnings.push('no_days');
    if (Number(l.base) === 0) warnings.push('zero_base');

    const applicable: SupportRuleInput[] = [];
    for (const code of eligByEmp.get(empId) ?? []) {
      const r = rules.get(code);
      if (!r || !r.enabled || !periodOverlaps(r.effectiveFrom, r.effectiveTo, start, end)) {
        if (!warnings.includes('support_rule_off')) warnings.push('support_rule_off');
        continue;
      }
      applicable.push({ code: r.code, target: r.target as 'employer' | 'employee', mode: r.mode as 'percent_of_premium' | 'fixed_amount', value: r.value });
    }
    const sup = computeSupport({ employee: l.employeeSocial as string, employer: l.employerSocial as string }, applicable);
    for (const a of sup.applied) {
      const r = rules.get(a.code)!;
      snapshot.set(a.code, { code: r.code, ruleId: r.id, name: r.name, target: r.target, mode: r.mode, value: r.value, verified: r.verified });
    }
    built.push({
      companyId: ctx.companyId,
      declarationId: id,
      employeeId: empId,
      payrollLineId: l.id as string,
      payrollTypeCode: profile?.payroll_type_code ?? null,
      insuranceStart: profile?.insurance_start ?? null,
      insuranceEnd: profile?.insurance_end ?? null,
      ssnLast4: profile?.ssn_last4 ?? null,
      daysWorked: days,
      annualLeaveDays: Number(l.annual),
      sickLeaveDays: Number(l.sick),
      unpaidLeaveDays: Number(l.unpaid),
      absentDays: Number(l.absent),
      premiumBase: toDbAmount(l.base as string),
      employeePremium: toDbAmount(l.employeeSocial as string),
      employerPremium: toDbAmount(l.employerSocial as string),
      supportEmployee: toDbAmount(sup.employee),
      supportEmployer: toDbAmount(sup.employer),
      supportCodes: sup.applied.length ? sup.applied.map((a) => a.code).join(',') : null,
      warnings,
    });
  }
  for (let i = 0; i < built.length; i += 200) await tx.insert(socialDeclarationLines).values(built.slice(i, i + 200));

  const totals = sumDeclaration(built.map((b) => ({ premiumBase: b.premiumBase as string, employeePremium: b.employeePremium as string, employerPremium: b.employerPremium as string, supportEmployee: b.supportEmployee as string, supportEmployer: b.supportEmployer as string })));
  const snap = [...snapshot.values()].sort((a, b) => a.code.localeCompare(b.code));
  await tx
    .update(socialDeclarations)
    .set({
      payrollRunId: run.id,
      payrollRunNumber: run.number,
      employeeCount: totals.count,
      premiumBaseTotal: toDbAmount(totals.premiumBase),
      employeePremiumTotal: toDbAmount(totals.employeePremium),
      employerPremiumTotal: toDbAmount(totals.employerPremium),
      supportEmployeeTotal: toDbAmount(totals.supportEmployee),
      supportEmployerTotal: toDbAmount(totals.supportEmployer),
      supportSnapshot: snap,
      hasUnverifiedParams: run.hasUnverifiedParams || snap.some((s) => !s.verified),
      builtAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(socialDeclarations.id, id));
  return getDeclaration(tx, id, { log: false });
}

export async function listDeclarations(tx: Tx, q: { year?: number; status?: string }) {
  const rows = await tx
    .select()
    .from(socialDeclarations)
    .where(and(q.status ? eq(socialDeclarations.status, q.status) : undefined, q.year ? sql`${socialDeclarations.month} like ${`${q.year}-%`}` : undefined))
    .orderBy(sql`${socialDeclarations.month} desc`);
  return { declarations: rows };
}

/** Bildirim + satırlar. Numara yalnızca maskeli (son 4 hane) görünür; okuma erişim günlüğüne yazılır. */
export async function getDeclaration(tx: Tx, id: string, opts: { log?: boolean } = {}) {
  const [declaration] = await tx.select().from(socialDeclarations).where(eq(socialDeclarations.id, id));
  if (!declaration) throw notFound('Sosyal güvenlik bildirimi');
  const res = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", l.payroll_type_code as "payrollTypeCode",
           l.insurance_start::text as "insuranceStart", l.insurance_end::text as "insuranceEnd", l.ssn_last4 as "ssnLast4",
           l.days_worked as "daysWorked", l.annual_leave_days as "annualLeaveDays", l.sick_leave_days as "sickLeaveDays",
           l.unpaid_leave_days as "unpaidLeaveDays", l.absent_days as "absentDays", l.premium_base::text as "premiumBase",
           l.employee_premium::text as "employeePremium", l.employer_premium::text as "employerPremium",
           l.support_employee::text as "supportEmployee", l.support_employer::text as "supportEmployer",
           l.support_codes as "supportCodes", l.warnings
      from social_declaration_lines l join employees e on e.id = l.employee_id
     where l.declaration_id = ${id} order by e.code`);
  const lines = res.rows.map((r): DeclarationLineView => ({
    ...(r as unknown as DeclarationLineView),
    ssnMasked: r.ssnLast4 ? `••••${r.ssnLast4 as string}` : null,
    employeeDue: dec(r.employeePremium as string).minus(r.supportEmployee as string).toFixed(4),
    employerDue: dec(r.employerPremium as string).minus(r.supportEmployer as string).toFixed(4),
  }));
  if (opts.log !== false) await logSocialAccess(tx, res.rows.map((r) => r.employeeId as string), 'Sosyal güvenlik bildirimi görüntüleme');
  const totals = sumDeclaration(
    res.rows.map((r) => ({ premiumBase: r.premiumBase as string, employeePremium: r.employeePremium as string, employerPremium: r.employerPremium as string, supportEmployee: r.supportEmployee as string, supportEmployer: r.supportEmployer as string })),
  );
  const [run] = await tx.select({ status: payrollRuns.status }).from(payrollRuns).where(eq(payrollRuns.id, declaration.payrollRunId));
  return { declaration: { ...declaration, payrollRunStatus: run?.status ?? null }, lines, totals, lock: await getMonthLock(tx, declaration.month) };
}

/** Kesinleştirme: önce güncel veriyle yeniden üretilir (kayda giren güncel durumdur), sonra kilitlenir. */
export async function finalizeDeclaration(tx: Tx, ctx: SocialCtx, id: string, note: string | null | undefined) {
  const d = await lockDeclaration(tx, id);
  requireDraft(d);
  await buildDeclaration(tx, ctx, d.month);
  const [fresh] = await tx.select().from(socialDeclarations).where(eq(socialDeclarations.id, id));
  if (fresh!.employeeCount === 0) throw unprocessable('Bildirimde satır yok', 'SOCIAL_EMPTY');
  await tx
    .update(socialDeclarations)
    .set({ status: 'finalized', finalizedAt: new Date(), finalizedBy: ctx.userId, finalizeNote: note?.trim() || null, updatedAt: new Date() })
    .where(eq(socialDeclarations.id, id));
  return getDeclaration(tx, id, { log: false });
}

export async function reopenDeclaration(tx: Tx, ctx: SocialCtx, id: string, reason: string) {
  const d = await lockDeclaration(tx, id);
  if (d.status !== 'finalized') throw unprocessable('Yalnızca kesinleşmiş bildirim yeniden açılır', 'SOCIAL_NOT_FINALIZED');
  await tx
    .update(socialDeclarations)
    .set({ status: 'draft', finalizedAt: null, finalizedBy: null, finalizeNote: null, reopenedAt: new Date(), reopenedBy: ctx.userId, reopenReason: reason.trim(), reopenCount: d.reopenCount + 1, updatedAt: new Date() })
    .where(eq(socialDeclarations.id, id));
  return getDeclaration(tx, id, { log: false });
}

export async function deleteDeclaration(tx: Tx, id: string) {
  const d = await lockDeclaration(tx, id);
  requireDraft(d);
  await tx.delete(socialDeclarationLines).where(eq(socialDeclarationLines.declarationId, id));
  await tx.delete(socialDeclarations).where(eq(socialDeclarations.id, id));
}
