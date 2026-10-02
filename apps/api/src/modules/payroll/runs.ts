import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  allocateByHours,
  computePayroll,
  dec,
  isoYear,
  monthBounds,
  todayIso,
  toDbAmount,
  type PayBasis,
  type PayrollAdjustmentInput,
  type PayrollItemInput,
  type PayrollWarning,
  ADVANCE_DEDUCTION_ITEM_CODE,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { costCodes, employees, journalEntries, payrollAdjustments, payrollItems, payrollLineAllocations, payrollLineItems, payrollLines, payrollRuns } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { getMonthLock } from '../hr/attendance';
import { createJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { logPayrollAccess, resolveParams, termsAtMonthEnd, type PayrollCtx } from './config';
import { buildPayrollJournal } from './journal';
import { advanceItemTotal, deleteRunAdvanceDeductions, recordRunAdvanceSettlements, validateRunAdvanceDeductions } from '../employee-ledger/hooks';

const ledgerCtx = (c: PayrollCtx): LedgerCtx => ({ companyId: c.companyId, userId: c.userId, baseCurrency: c.baseCurrency, reportingCurrency: c.reportingCurrency });
const chunks = <T>(xs: readonly T[], n = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

type Run = typeof payrollRuns.$inferSelect;

async function lockRun(tx: Tx, id: string): Promise<Run> {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id)).for('update');
  if (!run) throw notFound('Bordro');
  return run;
}

const requireDraft = (run: Run) => {
  if (run.status !== 'draft') throw unprocessable('Yalnızca taslak bordro değiştirilir', 'PAYROLL_NOT_DRAFT');
};

// --- Puantaj girdisi -------------------------------------------------------------------------------------

interface AttendanceRow {
  id: string;
  code: string;
  fullName: string;
  normal: string;
  overtime: string;
  hourDays: number;
  annual: number;
  sick: number;
  unpaid: number;
  absent: number;
  entryDays: number;
  employedDays: number;
}

/** Ayda çalışma aralığı olan (ya da kaydı olan) personelin puantaj toplamları. */
async function attendanceByEmployee(tx: Tx, month: string): Promise<AttendanceRow[]> {
  const { start, end } = monthBounds(month);
  const res = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.code, e.full_name as "fullName",
           coalesce(sum(a.normal_hours), 0)::text as normal, coalesce(sum(a.overtime_hours), 0)::text as overtime,
           count(a.id) filter (where a.normal_hours + a.overtime_hours > 0)::int as "hourDays",
           count(a.id) filter (where a.day_type = 'annual_leave')::int as annual,
           count(a.id) filter (where a.day_type = 'sick_leave')::int as sick,
           count(a.id) filter (where a.day_type = 'unpaid_leave')::int as unpaid,
           count(a.id) filter (where a.day_type = 'absent')::int as absent,
           count(a.id)::int as "entryDays",
           case when e.hire_date is null then 0
                else greatest(0, least(${end}::date, coalesce(e.leave_date, ${end}::date)) - greatest(${start}::date, e.hire_date) + 1) end as "employedDays"
      from employees e
      left join attendance_entries a on a.employee_id = e.id and a.work_date between ${start}::date and ${end}::date
     where (e.hire_date is not null and e.hire_date <= ${end}::date and (e.leave_date is null or e.leave_date >= ${start}::date))
        or exists (select 1 from attendance_entries x where x.employee_id = e.id and x.work_date between ${start}::date and ${end}::date)
     group by e.id
     order by e.code`);
  return res.rows.map((r) => ({
    id: r.id as string,
    code: r.code as string,
    fullName: r.fullName as string,
    normal: r.normal as string,
    overtime: r.overtime as string,
    hourDays: Number(r.hourDays),
    annual: Number(r.annual),
    sick: Number(r.sick),
    unpaid: Number(r.unpaid),
    absent: Number(r.absent),
    entryDays: Number(r.entryDays),
    employedDays: Number(r.employedDays),
  }));
}

/** Saatli günlerin etiket gruplarına göre saatleri (etiketsiz saatler de bir gruptur: maliyet saat oranında dağılır). */
async function hourGroups(tx: Tx, month: string) {
  const { start, end } = monthBounds(month);
  const res = await tx.execute<{ employee_id: string; project_id: string | null; wbs_id: string | null; cost_code_id: string | null; hours: string }>(sql`
    select employee_id, project_id, wbs_id, cost_code_id, sum(normal_hours + overtime_hours)::text as hours
      from attendance_entries
     where work_date between ${start}::date and ${end}::date and normal_hours + overtime_hours > 0
     group by employee_id, project_id, wbs_id, cost_code_id`);
  const map = new Map<string, { projectId: string | null; wbsId: string | null; costCodeId: string | null; hours: string }[]>();
  for (const r of res.rows) {
    const list = map.get(r.employee_id) ?? [];
    list.push({ projectId: r.project_id, wbsId: r.wbs_id, costCodeId: r.cost_code_id, hours: r.hours });
    map.set(r.employee_id, list);
  }
  return map;
}

// --- Oluşturma / hesaplama -------------------------------------------------------------------------------

export async function createRun(tx: Tx, ctx: PayrollCtx, input: { month: string; description?: string | null }) {
  const [existing] = await tx
    .select({ number: payrollRuns.number })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.month, input.month), sql`${payrollRuns.status} <> 'cancelled'`));
  if (existing) throw conflict(`${input.month} ayı için bordro zaten var (${existing.number})`, 'PAYROLL_RUN_EXISTS');
  const year = isoYear(`${input.month}-01`);
  const number = formatDocumentNumber('BRD', year, await nextNumber(tx, ctx.companyId, 'PAYROLL', year));
  const [run] = await tx
    .insert(payrollRuns)
    .values({ companyId: ctx.companyId, number, month: input.month, description: input.description?.trim() || null, createdBy: ctx.userId })
    .returning();
  await calculateRun(tx, ctx, run!.id);
  return getRun(tx, run!.id);
}

async function clearLines(tx: Tx, runId: string) {
  const lineIds = (await tx.select({ id: payrollLines.id }).from(payrollLines).where(eq(payrollLines.runId, runId))).map((l) => l.id);
  for (const part of chunks(lineIds)) {
    await tx.delete(payrollLineAllocations).where(inArray(payrollLineAllocations.lineId, part));
    await tx.delete(payrollLineItems).where(inArray(payrollLineItems.lineId, part));
  }
  await tx.delete(payrollLines).where(eq(payrollLines.runId, runId));
}

/**
 * Taslak bordroyu puantajdan, ücret şartlarından, açık parametrelerden ve elle girilen kalemlerden yeniden üretir
 * (önceki satırlar silinir; elle girilen kalemler korunur). Ücret şartı ve parametreler AYIN SON GÜNÜNDEKİ durumla uygulanır.
 */
export async function calculateRun(tx: Tx, _ctx: PayrollCtx, id: string) {
  const run = await lockRun(tx, id);
  requireDraft(run);
  const { end, days } = monthBounds(run.month);
  const { set: params, ids: paramIds } = await resolveParams(tx, end);
  const terms = await termsAtMonthEnd(tx, run.month);
  const att = await attendanceByEmployee(tx, run.month);
  const tags = await hourGroups(tx, run.month);

  const adjRows = await tx
    .select({ employeeId: payrollAdjustments.employeeId, amount: payrollAdjustments.amount, item: payrollItems })
    .from(payrollAdjustments)
    .innerJoin(payrollItems, eq(payrollItems.id, payrollAdjustments.itemId))
    .where(eq(payrollAdjustments.runId, id));
  const adjByEmp = new Map<string, PayrollItemInput[]>();
  for (const a of adjRows) {
    const list = adjByEmp.get(a.employeeId) ?? [];
    list.push({
      itemId: a.item.id,
      code: a.item.code,
      name: a.item.name,
      kind: a.item.kind as 'earning' | 'deduction',
      amount: a.amount,
      affectsSocialBase: a.item.affectsSocialBase,
      affectsTaxBase: a.item.affectsTaxBase,
      liability: a.item.liability as 'tax' | 'social' | 'other',
    });
    adjByEmp.set(a.employeeId, list);
  }
  const [labor] = await tx.select({ id: costCodes.id }).from(costCodes).where(and(eq(costCodes.kind, 'labor'), eq(costCodes.isActive, true))).orderBy(asc(costCodes.code)).limit(1);

  await clearLines(tx, id);

  const usedKeys = new Map<string, { value: string; verified: boolean }>();
  let gross = dec(0);
  let deductions = dec(0);
  let employer = dec(0);
  let count = 0;

  for (const e of att) {
    const term = terms.get(e.id);
    if (!term) continue;
    const r = computePayroll({
      basis: term.pay_basis as PayBasis,
      rate: term.amount,
      attendance: { normalHours: e.normal, overtimeHours: e.overtime, hourDays: e.hourDays, annualLeaveDays: e.annual, sickLeaveDays: e.sick, unpaidLeaveDays: e.unpaid, absentDays: e.absent },
      params,
      items: adjByEmp.get(e.id) ?? [],
    });
    const warnings: PayrollWarning[] = [...r.warnings];
    if (e.employedDays < days) warnings.push({ code: 'partial_month', count: e.employedDays });
    if (e.employedDays > e.entryDays) warnings.push({ code: 'missing_attendance', count: e.employedDays - e.entryDays });

    const [line] = await tx
      .insert(payrollLines)
      .values({
        companyId: run.companyId,
        runId: id,
        employeeId: e.id,
        payBasis: term.pay_basis,
        rate: toDbAmount(term.amount),
        normalHours: e.normal,
        overtimeHours: e.overtime,
        hourDays: e.hourDays,
        annualLeaveDays: e.annual,
        sickLeaveDays: e.sick,
        unpaidLeaveDays: e.unpaid,
        absentDays: e.absent,
        scheduledPay: toDbAmount(r.scheduledPay),
        absenceDeduction: toDbAmount(r.absenceDeduction),
        basePay: toDbAmount(r.basePay),
        overtimePay: toDbAmount(r.overtimePay),
        earningsTotal: toDbAmount(r.earnings),
        gross: toDbAmount(r.gross),
        socialBase: toDbAmount(r.socialBase),
        taxBase: toDbAmount(r.taxBase),
        employeeSocial: toDbAmount(r.employeeSocial),
        incomeTax: toDbAmount(r.incomeTax),
        otherDeductions: toDbAmount(r.otherDeductions),
        deductionsTotal: toDbAmount(r.deductionsTotal),
        net: toDbAmount(r.net),
        employerSocial: toDbAmount(r.employerSocial),
        employerOther: toDbAmount(r.employerOther),
        employerTotal: toDbAmount(r.employerTotal),
        warnings,
      })
      .returning({ id: payrollLines.id });
    if (r.components.length > 0) {
      await tx.insert(payrollLineItems).values(
        r.components.map((c) => ({
          companyId: run.companyId,
          lineId: line!.id,
          kind: c.kind,
          source: c.source,
          code: c.code,
          label: c.label,
          amount: toDbAmount(c.amount),
          liability: c.liability,
          itemId: c.itemId,
          paramKey: c.paramKey,
          rate: c.rate,
        })),
      );
    }

    // Maliyetin proje/iş kalemi/maliyet koduna dağılımı (saat oranında); etiketli ama kodsuz saatler varsayılan işçilik koduna yazılır
    const groups = (tags.get(e.id) ?? []).map((g) => ({ ...g, costCodeId: g.projectId ? (g.costCodeId ?? labor?.id ?? null) : null }));
    const merged = new Map<string, { projectId: string | null; wbsId: string | null; costCodeId: string | null; hours: ReturnType<typeof dec> }>();
    for (const g of groups) {
      const k = `${g.projectId ?? ''}|${g.wbsId ?? ''}|${g.costCodeId ?? ''}`;
      const cur = merged.get(k);
      if (cur) cur.hours = cur.hours.plus(g.hours);
      else merged.set(k, { projectId: g.projectId, wbsId: g.wbsId, costCodeId: g.costCodeId, hours: dec(g.hours) });
    }
    const alloc = allocateByHours(r.gross, r.employerTotal, [...merged.entries()].map(([key, v]) => ({ key, hours: v.hours.toFixed(2) })));
    await tx.insert(payrollLineAllocations).values(
      alloc.map((a) => {
        const g = merged.get(a.key);
        return {
          companyId: run.companyId,
          lineId: line!.id,
          projectId: g?.projectId ?? null,
          wbsId: g?.wbsId ?? null,
          costCodeId: g?.costCodeId ?? null,
          hours: g ? g.hours.toFixed(2) : '0',
          grossAmount: toDbAmount(a.gross),
          employerAmount: toDbAmount(a.employer),
        };
      }),
    );

    for (const u of r.usedParams) usedKeys.set(u.key, { value: u.value, verified: u.verified });
    gross = gross.plus(r.gross);
    deductions = deductions.plus(r.deductionsTotal);
    employer = employer.plus(r.employerTotal);
    count++;
  }

  const snapshot = [...usedKeys.entries()].map(([key, v]) => ({ key, value: v.value, verified: v.verified, paramId: paramIds[key]! }));
  await tx
    .update(payrollRuns)
    .set({
      employeeCount: count,
      grossTotal: toDbAmount(gross),
      deductionsTotal: toDbAmount(deductions),
      netTotal: toDbAmount(gross.minus(deductions)),
      employerTotal: toDbAmount(employer),
      paramsSnapshot: snapshot,
      hasUnverifiedParams: snapshot.some((s) => !s.verified),
      calculatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(payrollRuns.id, id));
  return getRun(tx, id);
}

// --- Elle girilen kalemler -------------------------------------------------------------------------------

export async function setAdjustment(tx: Tx, ctx: PayrollCtx, runId: string, input: PayrollAdjustmentInput) {
  const run = await lockRun(tx, runId);
  requireDraft(run);
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  const [item] = await tx.select().from(payrollItems).where(eq(payrollItems.id, input.itemId));
  if (!item || !item.isActive) throw unprocessable('Bordro kalemi bulunamadı ya da pasif', 'PAYROLL_ITEM_NOT_FOUND');
  if (item.code === ADVANCE_DEDUCTION_ITEM_CODE) throw unprocessable('Avans kesintisi Personel cari ekranından (avanslardan seçilerek) girilir', 'PAYROLL_ITEM_RESERVED');
  if (dec(input.amount).lte(0)) throw unprocessable('Tutar sıfırdan büyük olmalı', 'PAYROLL_AMOUNT');
  await tx
    .insert(payrollAdjustments)
    .values({ companyId: ctx.companyId, runId, employeeId: input.employeeId, itemId: input.itemId, amount: toDbAmount(input.amount), note: input.note?.trim() || null, createdBy: ctx.userId })
    .onConflictDoUpdate({
      target: [payrollAdjustments.runId, payrollAdjustments.employeeId, payrollAdjustments.itemId],
      set: { amount: toDbAmount(input.amount), note: input.note?.trim() || null },
    });
  return calculateRun(tx, ctx, runId);
}

export async function removeAdjustment(tx: Tx, ctx: PayrollCtx, runId: string, adjustmentId: string) {
  const run = await lockRun(tx, runId);
  requireDraft(run);
  const [adj] = await tx
    .select({ code: payrollItems.code })
    .from(payrollAdjustments)
    .innerJoin(payrollItems, eq(payrollItems.id, payrollAdjustments.itemId))
    .where(and(eq(payrollAdjustments.id, adjustmentId), eq(payrollAdjustments.runId, runId)));
  if (adj?.code === ADVANCE_DEDUCTION_ITEM_CODE) throw unprocessable('Avans kesintisi Personel cari ekranından kaldırılır', 'PAYROLL_ITEM_RESERVED');
  const rows = await tx.delete(payrollAdjustments).where(and(eq(payrollAdjustments.id, adjustmentId), eq(payrollAdjustments.runId, runId))).returning({ id: payrollAdjustments.id });
  if (rows.length === 0) throw notFound('Bordro kalemi girişi');
  return calculateRun(tx, ctx, runId);
}

export async function deleteRun(tx: Tx, id: string) {
  const run = await lockRun(tx, id);
  requireDraft(run);
  await clearLines(tx, id);
  await deleteRunAdvanceDeductions(tx, id);
  await tx.delete(payrollAdjustments).where(eq(payrollAdjustments.runId, id));
  await tx.delete(payrollRuns).where(eq(payrollRuns.id, id));
}

// --- Okuma -----------------------------------------------------------------------------------------------

export async function listRuns(tx: Tx, q: { status?: string; year?: number }) {
  const rows = await tx
    .select()
    .from(payrollRuns)
    .where(and(q.status ? eq(payrollRuns.status, q.status) : undefined, q.year ? sql`${payrollRuns.month} like ${`${q.year}-%`}` : undefined))
    .orderBy(sql`${payrollRuns.month} desc`, sql`${payrollRuns.createdAt} desc`);
  return { runs: rows };
}

export async function getRun(tx: Tx, id: string) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, id));
  if (!run) throw notFound('Bordro');
  const lineRows = await tx.execute<Record<string, unknown>>(sql`
    select l.*, l.id as line_id, e.code as employee_code, e.full_name as employee_name, e.department, e.job_title as "jobTitle", e.iban_last4
      from payroll_lines l join employees e on e.id = l.employee_id
     where l.run_id = ${id} order by e.code`);
  const lineIds = lineRows.rows.map((l) => l.id as string);
  const items = lineIds.length ? await tx.select().from(payrollLineItems).where(inArray(payrollLineItems.lineId, lineIds)) : [];
  const allocs = lineIds.length
    ? await tx.execute<Record<string, unknown>>(sql`
        select a.line_id as "lineId", a.hours::text as hours, a.gross_amount::text as "grossAmount", a.employer_amount::text as "employerAmount",
               p.code as "projectCode", w.code as "wbsCode", c.code as "costCode"
          from payroll_line_allocations a
          left join projects p on p.id = a.project_id
          left join project_wbs w on w.id = a.wbs_id
          left join cost_codes c on c.id = a.cost_code_id
         where a.line_id in (${sql.join(lineIds.map((x) => sql`${x}::uuid`), sql`, `)})`)
    : { rows: [] as Record<string, unknown>[] };
  const adjustments = await tx.execute<Record<string, unknown>>(sql`
    select a.id, a.employee_id as "employeeId", a.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.kind, a.amount::text as amount, a.note
      from payroll_adjustments a join payroll_items i on i.id = a.item_id where a.run_id = ${id} order by a.created_at`);

  const lines = lineRows.rows.map((l) => {
    const lid = l.id as string;
    return {
      id: lid,
      employeeId: l.employee_id as string,
      employeeCode: l.employee_code as string,
      employeeName: l.employee_name as string,
      department: (l.department as string | null) ?? null,
      jobTitle: (l.jobTitle as string | null) ?? null,
      ibanMasked: l.iban_last4 ? `•••• ${l.iban_last4 as string}` : null,
      payBasis: l.pay_basis as string,
      rate: l.rate as string,
      normalHours: l.normal_hours as string,
      overtimeHours: l.overtime_hours as string,
      hourDays: Number(l.hour_days),
      annualLeaveDays: Number(l.annual_leave_days),
      sickLeaveDays: Number(l.sick_leave_days),
      unpaidLeaveDays: Number(l.unpaid_leave_days),
      absentDays: Number(l.absent_days),
      scheduledPay: l.scheduled_pay as string,
      absenceDeduction: l.absence_deduction as string,
      basePay: l.base_pay as string,
      overtimePay: l.overtime_pay as string,
      earningsTotal: l.earnings_total as string,
      gross: l.gross as string,
      socialBase: l.social_base as string,
      taxBase: l.tax_base as string,
      employeeSocial: l.employee_social as string,
      incomeTax: l.income_tax as string,
      otherDeductions: l.other_deductions as string,
      deductionsTotal: l.deductions_total as string,
      net: l.net as string,
      employerSocial: l.employer_social as string,
      employerOther: l.employer_other as string,
      employerTotal: l.employer_total as string,
      warnings: l.warnings as PayrollWarning[],
      items: items.filter((i) => i.lineId === lid).map((i) => ({ kind: i.kind, source: i.source, code: i.code, label: i.label, amount: i.amount, liability: i.liability, paramKey: i.paramKey, rate: i.rate })),
      allocations: allocs.rows.filter((a) => a.lineId === lid),
    };
  });

  let missingTerms: { id: string; code: string; fullName: string }[] = [];
  if (run.status === 'draft') {
    const have = new Set(lines.map((l) => l.employeeId));
    missingTerms = (await attendanceByEmployee(tx, run.month)).filter((e) => !have.has(e.id)).map((e) => ({ id: e.id, code: e.code, fullName: e.fullName }));
  }
  const [entry] = run.entryId ? await tx.select({ no: journalEntries.entryNo }).from(journalEntries).where(eq(journalEntries.id, run.entryId)) : [];
  return { run: { ...run, entryNo: entry?.no ?? null }, lines, adjustments: adjustments.rows, missingTerms, lock: await getMonthLock(tx, run.month) };
}

/** Bordro pusulası verisi (tek personel). Ücret verisinin okunması erişim günlüğüne yazılır. */
export async function getSlip(tx: Tx, runId: string, employeeId: string) {
  const data = await getRun(tx, runId);
  const line = data.lines.find((l) => l.employeeId === employeeId);
  if (!line) throw notFound('Bordro satırı');
  await logPayrollAccess(tx, [employeeId], 'Bordro pusulası görüntüleme');
  const [emp] = await tx.select({ hireDate: employees.hireDate }).from(employees).where(eq(employees.id, employeeId));
  const { lines: _l, adjustments: _a, missingTerms: _m, ...rest } = data;
  return { ...rest, line, hireDate: emp?.hireDate ?? null };
}

// --- Onay (yevmiye) ---------------------------------------------------------------------------------------

export async function approveRun(tx: Tx, ctx: PayrollCtx, id: string) {
  const run = await lockRun(tx, id);
  requireDraft(run);
  const lock = await getMonthLock(tx, run.month);
  if (!lock.closed) throw unprocessable(`Puantaj ayı (${run.month}) kapalı değil; bordro onaylanamaz. Önce puantajı kapatın`, 'ATTENDANCE_MONTH_NOT_CLOSED');
  // Onay anında yeniden hesaplanır: kayda giren, ekranda son görülen değil, güncel parametre/şart/puantaj durumudur
  await calculateRun(tx, ctx, id);
  const fresh = await lockRun(tx, id);
  const lines = await tx.select().from(payrollLines).where(eq(payrollLines.runId, id));
  if (lines.length === 0) throw unprocessable('Bordroda satır yok: ücret şartı girilmiş personel bulunamadı', 'PAYROLL_EMPTY');
  const negative = lines.filter((l) => dec(l.net).isNegative());
  if (negative.length > 0) throw unprocessable(`${negative.length} satırın net ücreti negatif; kesintileri düzeltin`, 'PAYROLL_NEGATIVE_NET');

  const { end } = monthBounds(run.month);
  const lineIds = lines.map((l) => l.id);
  const items = await tx.select().from(payrollLineItems).where(inArray(payrollLineItems.lineId, lineIds));
  const sumBy = (kind: string, liability: string) => items.filter((i) => i.kind === kind && i.liability === liability).reduce((s, i) => s.plus(i.amount), dec(0));
  const liab = (l: string) => sumBy('deduction', l).plus(sumBy('employer', l));
  const social = liab('social');
  const tax = liab('tax');
  // Personel avansından kesilen tutar "diğer kesinti borcu" değil, personel avansları alacağını kapatır (toplam değişmez, yalnız dağılım)
  const adv = await validateRunAdvanceDeductions(tx, id, lines, items);
  const advance = advanceItemTotal(items);
  const other = liab('other').minus(advance);
  const net = lines.reduce((s, l) => s.plus(l.net), dec(0));
  const employerTotal = lines.reduce((s, l) => s.plus(l.employerTotal), dec(0));

  const allocs = await tx.select().from(payrollLineAllocations).where(inArray(payrollLineAllocations.lineId, lineIds));
  const groupMap = new Map<string, { projectId: string | null; wbsId: string | null; costCodeId: string | null; gross: ReturnType<typeof dec>; employer: ReturnType<typeof dec> }>();
  for (const a of allocs) {
    const k = `${a.projectId ?? ''}|${a.wbsId ?? ''}|${a.costCodeId ?? ''}`;
    const g = groupMap.get(k) ?? { projectId: a.projectId, wbsId: a.wbsId, costCodeId: a.costCodeId, gross: dec(0), employer: dec(0) };
    g.gross = g.gross.plus(a.grossAmount);
    g.employer = g.employer.plus(a.employerAmount);
    groupMap.set(k, g);
  }

  const keys = ['payroll_labor_cost' as const, ...(employerTotal.gt(0) ? (['payroll_employer_cost'] as const) : []), ...(net.gt(0) ? (['payroll_payable'] as const) : []), ...(social.gt(0) ? (['payroll_social_payable'] as const) : []), ...(tax.gt(0) ? (['payroll_tax_payable'] as const) : []), ...(other.gt(0) ? (['payroll_other_payable'] as const) : []), ...(advance.gt(0) ? (['employee_advance'] as const) : [])];
  const acc = (await requireMappings(tx, keys)) as Partial<Record<(typeof keys)[number], string>>;

  const text = `Bordro ${run.number} — ${run.month} (${lines.length} personel)`.slice(0, 300);
  const journalLines = buildPayrollJournal({
    currency: ctx.baseCurrency,
    description: text,
    accounts: {
      labor: acc.payroll_labor_cost!,
      employer: acc.payroll_employer_cost ?? '',
      payable: acc.payroll_payable ?? '',
      social: acc.payroll_social_payable ?? '',
      tax: acc.payroll_tax_payable ?? '',
      other: acc.payroll_other_payable ?? '',
      advance: acc.employee_advance ?? '',
    },
    groups: [...groupMap.values()],
    net,
    social,
    tax,
    other,
    advance,
  });
  const entry = await createJournalEntry(tx, ledgerCtx(ctx), { entryDate: end, description: text, lines: journalLines, post: true }, { source: { type: 'payroll_run', id } });
  await tx.update(payrollRuns).set({ status: 'approved', entryId: entry.id, approvedAt: new Date(), approvedBy: ctx.userId, updatedAt: new Date() }).where(eq(payrollRuns.id, fresh.id));
  if (adv.rows.length > 0) await recordRunAdvanceSettlements(tx, ctx, id, run.number, end);
  return getRun(tx, id);
}

// --- Ödeme takibi ------------------------------------------------------------------------------------------

export async function payRun(tx: Tx, ctx: PayrollCtx, id: string, input: { paidAt: string; note?: string | null }) {
  const run = await lockRun(tx, id);
  if (run.status !== 'approved') throw unprocessable('Yalnızca onaylı bordro ödendi işaretlenir', 'PAYROLL_NOT_APPROVED');
  if (input.paidAt > todayIso()) throw unprocessable('Ödeme tarihi gelecekte olamaz', 'PAYROLL_PAID_FUTURE');
  await tx.update(payrollRuns).set({ status: 'paid', paidAt: input.paidAt, paidNote: input.note?.trim() || null, paidMarkedBy: ctx.userId, updatedAt: new Date() }).where(eq(payrollRuns.id, id));
  return getRun(tx, id);
}

export async function unpayRun(tx: Tx, id: string, reason: string) {
  const run = await lockRun(tx, id);
  if (run.status !== 'paid') throw unprocessable('Yalnızca ödendi işaretli bordro geri alınır', 'PAYROLL_NOT_PAID');
  await tx.update(payrollRuns).set({ status: 'approved', paidAt: null, paidNote: `Ödeme geri alındı: ${reason.trim()}`, paidMarkedBy: null, updatedAt: new Date() }).where(eq(payrollRuns.id, id));
  return getRun(tx, id);
}

/** Onaylı bordroyu iptal eder: yevmiye ters çevrilir (gerekçeli); ödenmiş bordro önce "ödenmedi"ye alınır. */
export async function cancelRun(tx: Tx, ctx: PayrollCtx, id: string, input: { reason: string; entryDate?: string }) {
  const run = await lockRun(tx, id);
  if (run.status === 'paid') throw unprocessable('Ödendi işaretli bordro iptal edilemez; önce ödemeyi geri alın', 'PAYROLL_PAID');
  if (run.status !== 'approved') throw unprocessable('Yalnızca onaylı bordro iptal edilir (taslak silinir)', 'PAYROLL_NOT_APPROVED');
  const reversal = await reverseJournalEntry(tx, ledgerCtx(ctx), run.entryId!, {
    entryDate: input.entryDate ?? todayIso(),
    description: `Bordro iptali ${run.number}: ${input.reason}`.slice(0, 300),
    source: { type: 'payroll_run', id },
  });
  await tx
    .update(payrollRuns)
    .set({ status: 'cancelled', reversalEntryId: reversal.id, cancelledAt: new Date(), cancelledBy: ctx.userId, cancelReason: input.reason.trim(), updatedAt: new Date() })
    .where(eq(payrollRuns.id, id));
  return getRun(tx, id);
}
