import { and, desc, eq, sql } from 'drizzle-orm';
import { todayIso, type AttendanceCorrectionInput, type EmployeeChecklistKind } from '@erp/shared';
import type { Tx } from '../../db/client';
import { attendanceCorrections, attendanceMonths, employeeChecklists, employeeChecklistTemplates, employees } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { logPayrollAccess } from '../payroll/config';
import { saveAttendance } from './attendance';

/**
 * F10 personel: çalışan portalı (93), puantaj düzeltme talepleri (94), işe giriş/ayrılış kontrol listeleri (97).
 * Portal yalnız oturumdaki kullanıcıya bağlı personel kartını okur; başka personelin verisine giden bir parametre almaz.
 */

interface Ctx {
  companyId: string;
  userId: string;
}

export async function linkEmployeeUser(tx: Tx, ctx: Ctx, employeeId: string, userId: string | null) {
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId)).for('update');
  if (!emp) throw notFound('Personel');
  if (userId) {
    const member = await tx.execute(sql`select 1 from memberships where company_id = ${ctx.companyId} and user_id = ${userId}`);
    if (!member.rows.length) throw unprocessable('Kullanıcı şirketin üyesi olmalı', 'EMPLOYEE_USER_NOT_MEMBER');
    const [other] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.userId, userId), sql`${employees.id} <> ${employeeId}`));
    if (other) throw conflict('Bu kullanıcı başka bir personel kartına bağlı', 'EMPLOYEE_USER_TAKEN');
  }
  await tx.update(employees).set({ userId, updatedAt: new Date() }).where(eq(employees.id, employeeId));
  return { employeeId, userId };
}

async function ownEmployee(tx: Tx, userId: string) {
  const [emp] = await tx
    .select({ id: employees.id, code: employees.code, fullName: employees.fullName, hireDate: employees.hireDate, leaveDate: employees.leaveDate, status: employees.status, department: employees.department, jobTitle: employees.jobTitle })
    .from(employees)
    .where(eq(employees.userId, userId));
  return emp ?? null;
}

/** Portal özeti: kendi bordroları (onaylı/ödenmiş), son iki ayın puantajı ve düzeltme talepleri. */
export async function portalSummary(tx: Tx, userId: string) {
  const emp = await ownEmployee(tx, userId);
  if (!emp) return { employee: null };
  const payslips = await tx.execute<{ run_id: string; month: string; status: string; gross: string; net: string; deductions: string }>(sql`
    select r.id as run_id, r.month, r.status, l.gross::text as gross, l.net::text as net, l.deductions_total::text as deductions
      from payroll_lines l join payroll_runs r on r.id = l.run_id
     where l.employee_id = ${emp.id} and r.status in ('approved','paid')
     order by r.month desc limit 24`);
  const thisMonth = todayIso().slice(0, 7);
  const prev = new Date(thisMonth + '-15T12:00:00Z');
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const from = prev.toISOString().slice(0, 7) + '-01';
  const attendance = await tx.execute<{ work_date: string; day_type: string; normal_hours: string; overtime_hours: string }>(sql`
    select work_date::text, day_type, normal_hours::text, overtime_hours::text from attendance_entries
     where employee_id = ${emp.id} and work_date >= ${from}::date order by work_date`);
  const closed = await tx.select({ month: attendanceMonths.month }).from(attendanceMonths).where(eq(attendanceMonths.status, 'closed'));
  return {
    employee: emp,
    payslips: payslips.rows.map((p) => ({ runId: p.run_id, month: p.month, status: p.status, gross: p.gross, net: p.net, deductions: p.deductions })),
    attendance: attendance.rows.map((a) => ({ workDate: a.work_date, dayType: a.day_type, normalHours: a.normal_hours, overtimeHours: a.overtime_hours })),
    closedMonths: closed.map((c) => c.month),
    corrections: await listCorrections(tx, { employeeId: emp.id }),
  };
}

/** Kendi bordro pusulası: yalnız onaylı/ödenmiş bordrodaki kendi satırı; şirket toplamları dönmez. Erişim kaydı tutulur. */
export async function portalSlip(tx: Tx, userId: string, runId: string) {
  const emp = await ownEmployee(tx, userId);
  if (!emp) throw notFound('Personel kaydı');
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select r.month, r.status, l.pay_basis as "payBasis", l.base_pay::text as "basePay", l.overtime_pay::text as "overtimePay",
           l.earnings_total::text as "earningsTotal", l.gross::text as gross, l.employee_social::text as "employeeSocial",
           l.income_tax::text as "incomeTax", l.other_deductions::text as "otherDeductions", l.deductions_total::text as "deductionsTotal",
           l.net::text as net
      from payroll_lines l join payroll_runs r on r.id = l.run_id
     where r.id = ${runId} and l.employee_id = ${emp.id} and r.status in ('approved','paid')`);
  const slip = rows.rows[0];
  if (!slip) throw notFound('Bordro pusulası');
  await logPayrollAccess(tx, [emp.id], 'Çalışan portalı: kendi bordro pusulası');
  return { employee: { code: emp.code, fullName: emp.fullName }, slip };
}

// --- Puantaj düzeltme talepleri ---------------------------------------------------------------------------

async function assertMonthOpen(tx: Tx, workDate: string) {
  const [closed] = await tx.select({ month: attendanceMonths.month }).from(attendanceMonths).where(and(eq(attendanceMonths.month, workDate.slice(0, 7)), eq(attendanceMonths.status, 'closed')));
  if (closed) throw unprocessable(`Puantaj ayı kapalı (${closed.month}); düzeltme için ayın yeniden açılması gerekir`, 'ATTENDANCE_MONTH_CLOSED');
}

export async function createCorrection(tx: Tx, ctx: Ctx, input: AttendanceCorrectionInput & { employeeId: string }) {
  const [emp] = await tx.select({ id: employees.id, hireDate: employees.hireDate, leaveDate: employees.leaveDate }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw notFound('Personel');
  if (input.workDate > todayIso()) throw unprocessable('Gelecek tarih için düzeltme istenmez', 'CORRECTION_FUTURE_DATE');
  await assertMonthOpen(tx, input.workDate);
  const [row] = await tx
    .insert(attendanceCorrections)
    .values({
      companyId: ctx.companyId,
      employeeId: emp.id,
      workDate: input.workDate,
      dayType: input.dayType,
      normalHours: input.normalHours,
      overtimeHours: input.overtimeHours,
      reason: input.reason,
      requestedBy: ctx.userId,
    })
    .returning();
  return row!;
}

export async function createOwnCorrection(tx: Tx, ctx: Ctx, input: AttendanceCorrectionInput) {
  const emp = await ownEmployee(tx, ctx.userId);
  if (!emp) throw unprocessable('Hesabınız bir personel kaydına bağlı değil', 'EMPLOYEE_NOT_LINKED');
  return createCorrection(tx, ctx, { ...input, employeeId: emp.id });
}

export async function listCorrections(tx: Tx, q: { status?: string; employeeId?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", c.work_date::text as "workDate",
           c.day_type as "dayType", c.normal_hours::text as "normalHours", c.overtime_hours::text as "overtimeHours", c.reason, c.status,
           c.decision_note as "decisionNote", c.decided_at as "decidedAt", ru.full_name as "requestedBy", du.full_name as "decidedBy", c.created_at as "createdAt"
      from attendance_corrections c
      join employees e on e.id = c.employee_id
      left join users ru on ru.id = c.requested_by
      left join users du on du.id = c.decided_by
     where true ${q.status ? sql`and c.status = ${q.status}` : sql``} ${q.employeeId ? sql`and c.employee_id = ${q.employeeId}` : sql``}
     order by c.created_at desc limit 300`);
  return rows.rows;
}

/** Onayda talep puantaja yazılır (ay kapalıysa onay reddedilir, talep beklemede kalır); retle yalnız karar kaydedilir. */
export async function decideCorrection(tx: Tx, ctx: Ctx, id: string, input: { decision: 'approve' | 'reject'; note?: string }) {
  const [c] = await tx.select().from(attendanceCorrections).where(eq(attendanceCorrections.id, id)).for('update');
  if (!c) throw notFound('Düzeltme talebi');
  if (c.status !== 'pending') throw unprocessable('Talep için karar verilmiş', 'CORRECTION_DECIDED');
  if (input.decision === 'approve') {
    await saveAttendance(tx, ctx, {
      entries: [
        {
          employeeId: c.employeeId,
          workDate: c.workDate,
          dayType: c.dayType as never,
          normalHours: c.normalHours,
          overtimeHours: c.overtimeHours,
          note: `Düzeltme talebi: ${c.reason}`.slice(0, 300),
        },
      ],
      clear: [],
    });
  }
  await tx
    .update(attendanceCorrections)
    .set({ status: input.decision === 'approve' ? 'approved' : 'rejected', decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: input.note ?? null })
    .where(eq(attendanceCorrections.id, id));
  const [out] = await tx.select().from(attendanceCorrections).where(eq(attendanceCorrections.id, id));
  return out!;
}

// --- İşe giriş/ayrılış kontrol listeleri -------------------------------------------------------------------

const DEFAULT_ITEMS: Record<EmployeeChecklistKind, string[]> = {
  onboarding: ['Sözleşme imzalandı', 'Sosyal güvenlik girişi yapıldı', 'Kimlik ve banka bilgisi alındı', 'İş sağlığı ve güvenliği eğitimi verildi', 'Ekipman ve erişimler tanımlandı'],
  offboarding: ['Çıkış bildirimi yapıldı', 'Ekipman ve kartlar teslim alındı', 'Erişimler kapatıldı', 'Son bordro ve tazminat hesaplandı', 'İlişik kesme belgesi verildi'],
};
const keyOf = (i: number) => `m${i + 1}`;

export async function checklistTemplate(tx: Tx, kind: EmployeeChecklistKind) {
  const [row] = await tx.select().from(employeeChecklistTemplates).where(eq(employeeChecklistTemplates.kind, kind));
  return { kind, items: row?.items ?? DEFAULT_ITEMS[kind].map((label, i) => ({ key: keyOf(i), label })), isDefault: !row };
}

export async function saveChecklistTemplate(tx: Tx, ctx: Ctx, kind: EmployeeChecklistKind, labels: string[]) {
  const items = labels.map((label, i) => ({ key: keyOf(i), label }));
  await tx
    .insert(employeeChecklistTemplates)
    .values({ companyId: ctx.companyId, kind, items, updatedBy: ctx.userId })
    .onConflictDoUpdate({ target: [employeeChecklistTemplates.companyId, employeeChecklistTemplates.kind], set: { items, updatedBy: ctx.userId, updatedAt: new Date() } });
  return checklistTemplate(tx, kind);
}

export async function employeeChecklistsFor(tx: Tx, employeeId: string) {
  return tx.select().from(employeeChecklists).where(eq(employeeChecklists.employeeId, employeeId)).orderBy(desc(employeeChecklists.createdAt));
}

export async function startChecklist(tx: Tx, ctx: Ctx, employeeId: string, kind: EmployeeChecklistKind) {
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, employeeId));
  if (!emp) throw notFound('Personel');
  const [open] = await tx.select({ id: employeeChecklists.id }).from(employeeChecklists).where(and(eq(employeeChecklists.employeeId, employeeId), eq(employeeChecklists.kind, kind), eq(employeeChecklists.status, 'open')));
  if (open) throw conflict('Bu personel için açık kontrol listesi var', 'CHECKLIST_OPEN');
  const tpl = await checklistTemplate(tx, kind);
  const [row] = await tx
    .insert(employeeChecklists)
    .values({ companyId: ctx.companyId, employeeId, kind, items: tpl.items.map((i) => ({ ...i, done: false, doneBy: null, doneAt: null, note: null })), createdBy: ctx.userId })
    .returning();
  return row!;
}

/** Madde işaretlenir; tüm maddeler tamamlanınca liste kendiliğinden tamamlanır (sonra değişmez). */
export async function updateChecklistItem(tx: Tx, ctx: Ctx, id: string, input: { key: string; done: boolean; note?: string }) {
  const [c] = await tx.select().from(employeeChecklists).where(eq(employeeChecklists.id, id)).for('update');
  if (!c) throw notFound('Kontrol listesi');
  if (c.status === 'completed') throw unprocessable('Tamamlanmış kontrol listesi değişmez', 'CHECKLIST_COMPLETED');
  if (!c.items.some((i) => i.key === input.key)) throw unprocessable('Madde bulunamadı', 'CHECKLIST_ITEM_NOT_FOUND');
  const [user] = (await tx.execute<{ name: string }>(sql`select full_name as name from users where id = ${ctx.userId}`)).rows;
  const items = c.items.map((i) =>
    i.key === input.key
      ? { ...i, done: input.done, doneBy: input.done ? (user?.name ?? null) : null, doneAt: input.done ? new Date().toISOString() : null, note: input.note ?? i.note }
      : i,
  );
  const complete = items.every((i) => i.done);
  const [row] = await tx
    .update(employeeChecklists)
    .set({ items, ...(complete ? { status: 'completed' as const, completedAt: new Date() } : {}) })
    .where(eq(employeeChecklists.id, id))
    .returning();
  return row!;
}
