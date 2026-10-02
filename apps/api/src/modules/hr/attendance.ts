import { and, eq, inArray, sql } from 'drizzle-orm';
import { dec, monthBounds, todayIso, type AttendanceDayType, type UpsertAttendanceInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { attendanceEntries, attendanceMonths, employees } from '../../db/schema';
import { conflict, unprocessable } from '../../http/errors';
import { validateDimensions } from '../projects/dimension';

export interface AttendanceCtx {
  companyId: string;
  userId: string;
}

/** Şirket saat diliminde bugünün ayı (YYYY-AA). */
const currentMonth = () => todayIso().slice(0, 7);

const CHUNK = 500;
const chunks = <T>(xs: readonly T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// --- Ay kapanışı -----------------------------------------------------------------------------------------

export interface MonthLock {
  month: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenReason: string | null;
  reopenCount: number;
}

export async function getMonthLock(tx: Tx, month: string): Promise<MonthLock> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select m.status, m.closed_at as "closedAt", cu.email as "closedBy", m.close_note as "closeNote",
           m.reopened_at as "reopenedAt", ru.email as "reopenedBy", m.reopen_reason as "reopenReason", m.reopen_count as "reopenCount"
      from attendance_months m
      left join users cu on cu.id = m.closed_by
      left join users ru on ru.id = m.reopened_by
     where m.month = ${month}`);
  const r = rows.rows[0];
  if (!r) return { month, closed: false, closedAt: null, closedBy: null, closeNote: null, reopenedAt: null, reopenedBy: null, reopenReason: null, reopenCount: 0 };
  const iso = (v: unknown) => (v ? new Date(v as string | Date).toISOString() : null);
  return {
    month,
    closed: r.status === 'closed',
    closedAt: iso(r.closedAt),
    closedBy: (r.closedBy as string | null) ?? null,
    closeNote: (r.closeNote as string | null) ?? null,
    reopenedAt: iso(r.reopenedAt),
    reopenedBy: (r.reopenedBy as string | null) ?? null,
    reopenReason: (r.reopenReason as string | null) ?? null,
    reopenCount: Number(r.reopenCount),
  };
}

/** Ayı kapatır: sonrasında o ayın puantajı eklenemez/değişmez/silinemez (veritabanı korumasıyla). Gelecek ay kapatılamaz. */
export async function closeMonth(tx: Tx, ctx: AttendanceCtx, month: string, note: string | null | undefined): Promise<MonthLock> {
  if (month > currentMonth()) throw unprocessable('Henüz başlamamış ay kapatılamaz', 'ATTENDANCE_MONTH_FUTURE');
  const [cur] = await tx.select().from(attendanceMonths).where(eq(attendanceMonths.month, month)).for('update');
  if (cur?.status === 'closed') throw conflict(`${month} ayı zaten kapalı`, 'ATTENDANCE_MONTH_CLOSED');
  if (!cur) {
    await tx.insert(attendanceMonths).values({ companyId: ctx.companyId, month, status: 'closed', closedBy: ctx.userId, closeNote: note ?? null });
  } else {
    await tx
      .update(attendanceMonths)
      .set({ status: 'closed', closedAt: new Date(), closedBy: ctx.userId, closeNote: note ?? null })
      .where(eq(attendanceMonths.id, cur.id));
  }
  return getMonthLock(tx, month);
}

/** Kapalı ayı gerekçeyle yeniden açar; gerekçe/kullanıcı/zaman ayın kaydına ve denetim izine yazılır. */
export async function reopenMonth(tx: Tx, ctx: AttendanceCtx, month: string, reason: string): Promise<MonthLock> {
  const [cur] = await tx.select().from(attendanceMonths).where(eq(attendanceMonths.month, month)).for('update');
  if (!cur || cur.status !== 'closed') throw unprocessable(`${month} ayı kapalı değil`, 'ATTENDANCE_MONTH_NOT_CLOSED');
  await tx
    .update(attendanceMonths)
    .set({ status: 'open', reopenedAt: new Date(), reopenedBy: ctx.userId, reopenReason: reason.trim(), reopenCount: cur.reopenCount + 1 })
    .where(eq(attendanceMonths.id, cur.id));
  return getMonthLock(tx, month);
}

// --- Çizelge (ay) ----------------------------------------------------------------------------------------

/**
 * Ayın çizelgesi: ay içinde çalışma aralığı olan personel (ya da o ay kaydı olan), kayıtlar ve kapanış durumu.
 * İşe giriş tarihi girilmemiş aktif personel çizelgeye girmez (sayısı `missingHireDate`).
 */
export async function getMonthSheet(tx: Tx, month: string) {
  const { start, end } = monthBounds(month);
  const emps = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.code, e.full_name as "fullName", e.status, e.department, e.job_title as "jobTitle",
           e.hire_date::text as "hireDate", e.leave_date::text as "leaveDate", e.project_id as "projectId"
      from employees e
     where (e.hire_date is not null and e.hire_date <= ${end}::date and (e.leave_date is null or e.leave_date >= ${start}::date))
        or exists (select 1 from attendance_entries a where a.employee_id = e.id and a.work_date between ${start}::date and ${end}::date)
     order by e.code`);
  const entries = await tx.execute<Record<string, unknown>>(sql`
    select a.id, a.employee_id as "employeeId", a.work_date::text as "workDate", a.day_type as "dayType",
           a.normal_hours::text as "normalHours", a.overtime_hours::text as "overtimeHours",
           a.project_id as "projectId", p.code as "projectCode", a.wbs_id as "wbsId", w.code as "wbsCode",
           a.cost_code_id as "costCodeId", c.code as "costCode", a.note
      from attendance_entries a
      left join projects p on p.id = a.project_id
      left join project_wbs w on w.id = a.wbs_id
      left join cost_codes c on c.id = a.cost_code_id
     where a.work_date between ${start}::date and ${end}::date
     order by a.employee_id, a.work_date`);
  const missing = await tx.execute<{ n: number }>(sql`select count(*)::int as n from employees where status = 'active' and hire_date is null`);
  return {
    month,
    start,
    end,
    lock: await getMonthLock(tx, month),
    employees: emps.rows,
    entries: entries.rows,
    missingHireDate: missing.rows[0]?.n ?? 0,
  };
}

// --- Toplu kayıt -----------------------------------------------------------------------------------------

type EntryRow = typeof attendanceEntries.$inferSelect;
const key = (employeeId: string, date: string) => `${employeeId}|${date}`;
const same = (a: EntryRow, b: UpsertAttendanceInput['entries'][number]) =>
  a.dayType === b.dayType &&
  Number(a.normalHours) === Number(b.normalHours) &&
  Number(a.overtimeHours) === Number(b.overtimeHours) &&
  (a.projectId ?? null) === (b.projectId ?? null) &&
  (a.wbsId ?? null) === (b.wbsId ?? null) &&
  (a.costCodeId ?? null) === (b.costCodeId ?? null) &&
  (a.note ?? null) === (b.note?.trim() || null);

/**
 * Puantajı toplu yazar (grid ve günlük giriş): `entries` eklenir/güncellenir (personel + tarih tekil), `clear` silinir.
 * Tek işlemdir; biri reddedilirse hiçbiri yazılmaz. Değişmeyen satırlara dokunulmaz (denetim izi gürültüsü olmaz).
 * Asıl kurallar (kapalı ay, çalışma aralığı, etiket) veritabanı tetikleyicilerindedir; burada kullanıcıya anlaşılır hata verilir.
 */
export async function saveAttendance(tx: Tx, ctx: AttendanceCtx, input: UpsertAttendanceInput) {
  const items = [...input.entries, ...input.clear];
  const empIds = [...new Set(items.map((i) => i.employeeId))];
  const empRows = await tx.select().from(employees).where(inArray(employees.id, empIds));
  const empById = new Map(empRows.map((e) => [e.id, e]));
  for (const id of empIds) if (!empById.has(id)) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');

  // Kapalı ay
  const months = [...new Set(items.map((i) => i.workDate.slice(0, 7)))];
  const closed = await tx.select({ month: attendanceMonths.month }).from(attendanceMonths).where(and(inArray(attendanceMonths.month, months), eq(attendanceMonths.status, 'closed')));
  if (closed.length > 0) {
    throw unprocessable(`Puantaj ayı kapalı (${closed.map((c) => c.month).sort().join(', ')}); önce ayı yeniden açın`, 'ATTENDANCE_MONTH_CLOSED');
  }

  // Çalışma aralığı (işe giriş..çıkış)
  for (const e of input.entries) {
    const emp = empById.get(e.employeeId)!;
    if (!emp.hireDate) throw unprocessable(`${emp.code} personelinin işe giriş tarihi girilmemiş; puantaj yazılamaz`, 'EMPLOYEE_HIRE_DATE_MISSING');
    if (e.workDate < emp.hireDate || (emp.leaveDate && e.workDate > emp.leaveDate)) {
      throw unprocessable(`${emp.code} personeli ${e.workDate} tarihinde çalışma aralığında değil (işe giriş ${emp.hireDate}, çıkış ${emp.leaveDate ?? '—'})`, 'ATTENDANCE_OUT_OF_RANGE');
    }
  }

  // Mevcut kayıtlar
  const dates = items.map((i) => i.workDate).sort();
  const existing = await tx
    .select()
    .from(attendanceEntries)
    .where(and(inArray(attendanceEntries.employeeId, empIds), sql`${attendanceEntries.workDate} between ${dates[0]!}::date and ${dates[dates.length - 1]!}::date`));
  const byKey = new Map(existing.map((r) => [key(r.employeeId, r.workDate), r]));

  const inserts: UpsertAttendanceInput['entries'] = [];
  const updates: { id: string; e: UpsertAttendanceInput['entries'][number] }[] = [];
  let unchanged = 0;
  for (const e of input.entries) {
    const cur = byKey.get(key(e.employeeId, e.workDate));
    if (!cur) inserts.push(e);
    else if (same(cur, e)) unchanged++;
    else updates.push({ id: cur.id, e });
  }
  const deletes = input.clear.map((c) => byKey.get(key(c.employeeId, c.workDate))).filter((r): r is EntryRow => !!r);

  // Etiketler: yalnızca yeni ya da etiketi değişen satırlar doğrulanır (eski, tamamlanmış projeye ait kaydın notu düzeltilebilsin)
  const tagChanged = (cur: EntryRow | undefined, e: UpsertAttendanceInput['entries'][number]) =>
    !cur || (cur.projectId ?? null) !== (e.projectId ?? null) || (cur.wbsId ?? null) !== (e.wbsId ?? null) || (cur.costCodeId ?? null) !== (e.costCodeId ?? null);
  await validateDimensions(
    tx,
    ctx.companyId,
    [...inserts, ...updates.map((u) => u.e)]
      .filter((e) => tagChanged(byKey.get(key(e.employeeId, e.workDate)), e))
      .map((e) => ({ label: `${empById.get(e.employeeId)!.code} ${e.workDate}`, projectId: e.projectId, wbsId: e.wbsId, costCodeId: e.costCodeId })),
  );

  for (const part of chunks(deletes.map((d) => d.id))) await tx.delete(attendanceEntries).where(inArray(attendanceEntries.id, part));
  for (const u of updates) {
    await tx
      .update(attendanceEntries)
      .set({
        dayType: u.e.dayType,
        normalHours: u.e.normalHours,
        overtimeHours: u.e.overtimeHours,
        projectId: u.e.projectId ?? null,
        wbsId: u.e.wbsId ?? null,
        costCodeId: u.e.costCodeId ?? null,
        note: u.e.note?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(attendanceEntries.id, u.id));
  }
  for (const part of chunks(inserts)) {
    await tx.insert(attendanceEntries).values(
      part.map((e) => ({
        companyId: ctx.companyId,
        employeeId: e.employeeId,
        workDate: e.workDate,
        dayType: e.dayType,
        normalHours: e.normalHours,
        overtimeHours: e.overtimeHours,
        projectId: e.projectId ?? null,
        wbsId: e.wbsId ?? null,
        costCodeId: e.costCodeId ?? null,
        note: e.note?.trim() || null,
        createdBy: ctx.userId,
      })),
    );
  }
  return { created: inserts.length, updated: updates.length, deleted: deletes.length, unchanged };
}

// --- Raporlar --------------------------------------------------------------------------------------------

export interface SummaryRow {
  employeeId: string;
  code: string;
  fullName: string;
  department: string | null;
  status: string;
  hireDate: string | null;
  leaveDate: string | null;
  days: Record<AttendanceDayType, number>;
  entryDays: number;
  /** Çalışma aralığındaki, kaydı olmayan gün sayısı (kapanıştan önce eksikleri görmek için). */
  missingDays: number;
  normalHours: string;
  overtimeHours: string;
}

/** Aylık özet: personel başına gün türüne göre gün sayıları ve toplam saatler. */
export async function monthlySummary(tx: Tx, month: string) {
  const { start, end } = monthBounds(month);
  const res = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.code, e.full_name as "fullName", e.department, e.status, e.hire_date::text as "hireDate", e.leave_date::text as "leaveDate",
           count(a.id) filter (where a.day_type = 'worked')::int as worked,
           count(a.id) filter (where a.day_type = 'absent')::int as absent,
           count(a.id) filter (where a.day_type = 'annual_leave')::int as "annualLeave",
           count(a.id) filter (where a.day_type = 'sick_leave')::int as "sickLeave",
           count(a.id) filter (where a.day_type = 'unpaid_leave')::int as "unpaidLeave",
           count(a.id) filter (where a.day_type = 'public_holiday')::int as "publicHoliday",
           count(a.id) filter (where a.day_type = 'weekly_rest')::int as "weeklyRest",
           count(a.id)::int as "entryDays",
           coalesce(sum(a.normal_hours), 0)::text as "normalHours",
           coalesce(sum(a.overtime_hours), 0)::text as "overtimeHours",
           case when e.hire_date is null then 0
                else greatest(0, least(${end}::date, coalesce(e.leave_date, ${end}::date)) - greatest(${start}::date, e.hire_date) + 1) end as "employedDays"
      from employees e
      left join attendance_entries a on a.employee_id = e.id and a.work_date between ${start}::date and ${end}::date
     where (e.hire_date is not null and e.hire_date <= ${end}::date and (e.leave_date is null or e.leave_date >= ${start}::date))
        or exists (select 1 from attendance_entries x where x.employee_id = e.id and x.work_date between ${start}::date and ${end}::date)
     group by e.id
     order by e.code`);
  const rows: SummaryRow[] = res.rows.map((r) => ({
    employeeId: r.id as string,
    code: r.code as string,
    fullName: r.fullName as string,
    department: (r.department as string | null) ?? null,
    status: r.status as string,
    hireDate: (r.hireDate as string | null) ?? null,
    leaveDate: (r.leaveDate as string | null) ?? null,
    days: {
      worked: Number(r.worked),
      absent: Number(r.absent),
      annual_leave: Number(r.annualLeave),
      sick_leave: Number(r.sickLeave),
      unpaid_leave: Number(r.unpaidLeave),
      public_holiday: Number(r.publicHoliday),
      weekly_rest: Number(r.weeklyRest),
    },
    entryDays: Number(r.entryDays),
    missingDays: Math.max(0, Number(r.employedDays) - Number(r.entryDays)),
    normalHours: r.normalHours as string,
    overtimeHours: r.overtimeHours as string,
  }));
  const totals = {
    normalHours: rows.reduce((s, r) => s.plus(r.normalHours), dec(0)).toFixed(2),
    overtimeHours: rows.reduce((s, r) => s.plus(r.overtimeHours), dec(0)).toFixed(2),
    missingDays: rows.reduce((s, r) => s + r.missingDays, 0),
  };
  return { month, start, end, lock: await getMonthLock(tx, month), rows, totals };
}

export interface LaborRow {
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsId: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  costCodeId: string | null;
  costCode: string | null;
  costCodeName: string | null;
  personDays: number;
  employees: number;
  normalHours: string;
  overtimeHours: string;
}

/**
 * İşçilik saatleri: proje / iş kalemi / maliyet koduna göre (D3 işçilik maliyetinin girdisi). Yalnızca saatli günler;
 * etiketsiz saatler "Etiketsiz" satırında toplanır (proje süzgeci verilirse görünmez).
 */
export async function laborByProject(tx: Tx, q: { from: string; to: string; projectId?: string }) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select a.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
           a.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName",
           a.cost_code_id as "costCodeId", c.code as "costCode", c.name as "costCodeName",
           count(*)::int as "personDays", count(distinct a.employee_id)::int as employees,
           sum(a.normal_hours)::text as "normalHours", sum(a.overtime_hours)::text as "overtimeHours"
      from attendance_entries a
      left join projects p on p.id = a.project_id
      left join project_wbs w on w.id = a.wbs_id
      left join cost_codes c on c.id = a.cost_code_id
     where a.work_date between ${q.from}::date and ${q.to}::date
       and a.normal_hours + a.overtime_hours > 0
       and (${q.projectId ?? null}::uuid is null or a.project_id = ${q.projectId ?? null}::uuid)
     group by a.project_id, p.code, p.name, a.wbs_id, w.code, w.name, a.cost_code_id, c.code, c.name
     order by p.code nulls last, w.code nulls first, c.code nulls first`);
  const rows = res.rows as unknown as LaborRow[];
  const totals = {
    personDays: rows.reduce((s, r) => s + Number(r.personDays), 0),
    normalHours: rows.reduce((s, r) => s.plus(r.normalHours), dec(0)).toFixed(2),
    overtimeHours: rows.reduce((s, r) => s.plus(r.overtimeHours), dec(0)).toFixed(2),
  };
  return { from: q.from, to: q.to, rows, totals };
}

/** Kişi verisi dışa aktarma/erişim talebi için bir personelin tüm puantajı. */
export async function employeeAttendanceRows(tx: Tx, employeeId: string) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select a.work_date::text as "workDate", a.day_type as "dayType", a.normal_hours::text as "normalHours", a.overtime_hours::text as "overtimeHours",
           p.code as project, w.code as wbs, c.code as "costCode", a.note
      from attendance_entries a
      left join projects p on p.id = a.project_id
      left join project_wbs w on w.id = a.wbs_id
      left join cost_codes c on c.id = a.cost_code_id
     where a.employee_id = ${employeeId}
     order by a.work_date`);
  return res.rows;
}
