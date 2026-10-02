import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  type CreateEmployeeInput,
  type SensitiveField,
  type UpdateEmployeeInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { employees, parties, personalDataAccessLog, projects } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { nextNumber } from '../settings/numbering';
import { employeeAttendanceRows } from './attendance';
import { employeePayrollRows } from '../payroll/export-subject';
import { employeeLedgerRows } from '../employee-ledger/reports';
import { employeeSocialRows } from '../socialsecurity/export-subject';
import { employeeForeignRows } from '../foreignworkers/export-subject';
import { decryptField, encryptField, hashId, lastFour, maskTail } from './crypto';

export interface HrCtx {
  companyId: string;
  userId: string;
  /** Şifreleme anahtarı kaynağı (JWT_SECRET). */
  secret: string;
}

type Row = typeof employees.$inferSelect;

export const formatEmployeeCode = (n: number) => `PRS-${String(n).padStart(4, '0')}`;

/** Ekran/liste görünümü: hassas alanlar yalnızca maskeli (son 4 hane) ve "var/yok" bilgisiyle. */
export function toView(r: Row, projectCode?: string | null) {
  return {
    id: r.id,
    code: r.code,
    fullName: r.fullName,
    nationality: r.nationality,
    idKind: r.idKind,
    hasId: !!r.idEnc,
    idMasked: maskTail(r.idLast4),
    hasBirthDate: !!r.birthDateEnc,
    birthDateMasked: r.birthDateEnc ? '••••-••-••' : null,
    hasIban: !!r.ibanEnc,
    ibanMasked: maskTail(r.ibanLast4),
    phone: r.phone,
    email: r.email,
    address: r.address,
    hireDate: r.hireDate,
    leaveDate: r.leaveDate,
    status: r.status,
    department: r.department,
    jobTitle: r.jobTitle,
    projectId: r.projectId,
    projectCode: projectCode ?? null,
    /** Personel carisi (Faz X5; yalnızca bağlantı, hassas alan değildir). */
    partyId: r.partyId,
    note: r.note,
    createdAt: r.createdAt,
  };
}

async function lockEmployee(tx: Tx, id: string): Promise<Row> {
  const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for('update');
  if (!row) throw notFound('Personel');
  return row;
}

async function requireProject(tx: Tx, projectId: string | null | undefined) {
  if (!projectId) return;
  const [p] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!p) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
}

/** Hassas girdileri şifreli sütunlara çevirir; `undefined` = değiştirme, `null` = temizle. */
function sensitiveColumns(ctx: HrCtx, input: { idKind?: string | null; idNumber?: string | null; birthDate?: string | null; iban?: string | null }, current?: Row) {
  const out: Partial<Row> = {};
  if (input.idNumber !== undefined || input.idKind !== undefined) {
    const kind = input.idKind === undefined ? current?.idKind ?? null : input.idKind;
    if (input.idNumber === null || (input.idNumber === undefined && kind === null)) {
      Object.assign(out, { idKind: null, idEnc: null, idHash: null, idLast4: null });
    } else if (input.idNumber !== undefined) {
      if (!kind) throw unprocessable('Kimlik türü seçilmeli', 'EMPLOYEE_ID_KIND_REQUIRED');
      Object.assign(out, {
        idKind: kind,
        idEnc: encryptField(input.idNumber, ctx.secret),
        idHash: hashId(kind, input.idNumber, ctx.secret),
        idLast4: lastFour(input.idNumber),
      });
    } else if (current?.idEnc && input.idKind !== undefined && input.idKind !== current.idKind) {
      throw unprocessable('Kimlik türü değişiyorsa numara da yeniden girilmeli', 'EMPLOYEE_ID_KIND_REQUIRED');
    }
  }
  if (input.birthDate !== undefined) out.birthDateEnc = input.birthDate === null ? null : encryptField(input.birthDate, ctx.secret);
  if (input.iban !== undefined) {
    Object.assign(out, input.iban === null ? { ibanEnc: null, ibanLast4: null } : { ibanEnc: encryptField(input.iban, ctx.secret), ibanLast4: lastFour(input.iban) });
  }
  return out;
}

export async function createEmployee(tx: Tx, ctx: HrCtx, input: CreateEmployeeInput) {
  await requireProject(tx, input.projectId);
  const code = formatEmployeeCode(await nextNumber(tx, ctx.companyId, 'EMPLOYEE', 0));
  const [row] = await tx
    .insert(employees)
    .values({
      companyId: ctx.companyId,
      code,
      fullName: input.fullName,
      nationality: input.nationality ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      hireDate: input.hireDate ?? null,
      department: input.department ?? null,
      jobTitle: input.jobTitle ?? null,
      projectId: input.projectId ?? null,
      note: input.note ?? null,
      createdBy: ctx.userId,
      ...sensitiveColumns(ctx, input),
    })
    .returning();
  return getEmployee(tx, row!.id);
}

export async function updateEmployee(tx: Tx, ctx: HrCtx, id: string, input: UpdateEmployeeInput) {
  const current = await lockEmployee(tx, id);
  if (input.projectId !== undefined) await requireProject(tx, input.projectId);
  if (current.status === 'left' && (input.idNumber !== undefined || input.idKind !== undefined || input.birthDate !== undefined || input.iban !== undefined)) {
    throw unprocessable('İşten ayrılmış personelin kimlik, doğum tarihi ve IBAN bilgisi değiştirilemez', 'EMPLOYEE_LEFT_LOCKED');
  }
  const plain: Partial<Row> = {};
  for (const k of ['fullName', 'nationality', 'phone', 'email', 'address', 'hireDate', 'department', 'jobTitle', 'projectId', 'note'] as const) {
    if (input[k] !== undefined) (plain as Record<string, unknown>)[k] = input[k] ?? (k === 'fullName' ? current.fullName : null);
  }
  await tx
    .update(employees)
    .set({ ...plain, ...sensitiveColumns(ctx, input, current), updatedAt: new Date() })
    .where(eq(employees.id, id));
  // Personel carisi yalnızca adı taşır: kart adı değişirse cari adı da eşitlenir (başka alan kopyalanmaz)
  if (current.partyId && plain.fullName && plain.fullName !== current.fullName) {
    await tx.update(parties).set({ name: plain.fullName }).where(eq(parties.id, current.partyId));
  }
  return getEmployee(tx, id);
}

export async function terminateEmployee(tx: Tx, id: string, leaveDate: string) {
  const current = await lockEmployee(tx, id);
  if (current.status === 'left') throw unprocessable('Personel zaten işten ayrılmış', 'EMPLOYEE_ALREADY_LEFT');
  if (current.hireDate && leaveDate < current.hireDate) throw unprocessable('Çıkış tarihi işe giriş tarihinden önce olamaz', 'EMPLOYEE_DATES');
  await tx.update(employees).set({ status: 'left', leaveDate, updatedAt: new Date() }).where(eq(employees.id, id));
  return getEmployee(tx, id);
}

export async function rehireEmployee(tx: Tx, id: string, hireDate: string | undefined) {
  const current = await lockEmployee(tx, id);
  if (current.status !== 'left') throw unprocessable('Yalnızca işten ayrılmış personel yeniden işe alınır', 'EMPLOYEE_NOT_LEFT');
  await tx.update(employees).set({ status: 'active', leaveDate: null, ...(hireDate ? { hireDate } : {}), updatedAt: new Date() }).where(eq(employees.id, id));
  return getEmployee(tx, id);
}

export async function getEmployee(tx: Tx, id: string) {
  const [r] = await tx
    .select({ e: employees, projectCode: projects.code })
    .from(employees)
    .leftJoin(projects, eq(projects.id, employees.projectId))
    .where(eq(employees.id, id));
  if (!r) throw notFound('Personel');
  return { employee: toView(r.e, r.projectCode) };
}

export async function listEmployees(tx: Tx, q: { status?: string; q?: string }) {
  const term = q.q ? `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await tx
    .select({ e: employees, projectCode: projects.code })
    .from(employees)
    .leftJoin(projects, eq(projects.id, employees.projectId))
    .where(and(q.status ? eq(employees.status, q.status) : undefined, term ? or(ilike(employees.fullName, term), ilike(employees.code, term), ilike(employees.department, term)) : undefined))
    .orderBy(asc(employees.code));
  return { employees: rows.map((r) => toView(r.e, r.projectCode)) };
}

const FIELD_COLUMN: Record<SensitiveField, 'idEnc' | 'birthDateEnc' | 'ibanEnc'> = { id_number: 'idEnc', birth_date: 'birthDateEnc', iban: 'ibanEnc' };

/** Hassas alanın açık okunması: gerekçe zorunlu, aynı işlemde erişim günlüğüne yazılır. */
export async function revealField(tx: Tx, ctx: HrCtx, id: string, field: SensitiveField, reason: string) {
  const [row] = await tx.select().from(employees).where(eq(employees.id, id));
  if (!row) throw notFound('Personel');
  const blob = row[FIELD_COLUMN[field]];
  if (!blob) throw unprocessable('Bu alan boş', 'FIELD_EMPTY');
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, employeeId: id, field, reason: reason.trim(), userId: ctx.userId });
  return { field, value: decryptField(blob, ctx.secret) };
}

/** Bir personelin tüm verisi (ilgili kişi dışa aktarma/erişim talebi): açık metin; günlüğe 'export' olarak yazılır. */
export async function exportEmployeeData(tx: Tx, ctx: HrCtx, id: string, reason: string) {
  const [row] = await tx.select().from(employees).where(eq(employees.id, id));
  if (!row) throw notFound('Personel');
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, employeeId: id, field: 'export', reason: reason.trim(), userId: ctx.userId });
  const dec = (b: string | null) => (b ? decryptField(b, ctx.secret) : null);
  const accessLog = await tx.execute<Record<string, unknown>>(sql`
    select l.field, l.reason, l.created_at as "at", u.email as "by"
      from personal_data_access_log l join users u on u.id = l.user_id
     where l.employee_id = ${id} order by l.created_at desc`);
  const requests = await tx.execute<Record<string, unknown>>(sql`
    select kind, status, requester_name as "requesterName", description, resolution_note as "resolutionNote", opened_at as "openedAt", resolved_at as "resolvedAt"
      from data_subject_requests where employee_id = ${id} order by opened_at desc`);
  return {
    exportedAt: new Date().toISOString(),
    employee: {
      code: row.code,
      fullName: row.fullName,
      nationality: row.nationality,
      idKind: row.idKind,
      idNumber: dec(row.idEnc),
      birthDate: dec(row.birthDateEnc),
      iban: dec(row.ibanEnc),
      phone: row.phone,
      email: row.email,
      address: row.address,
      hireDate: row.hireDate,
      leaveDate: row.leaveDate,
      status: row.status,
      department: row.department,
      jobTitle: row.jobTitle,
      note: row.note,
    },
    attendance: await employeeAttendanceRows(tx, id),
    payroll: await employeePayrollRows(tx, id),
    employeeLedger: await employeeLedgerRows(tx, id),
    socialSecurity: await employeeSocialRows(tx, id, ctx.secret),
    foreignWorker: await employeeForeignRows(tx, id, ctx.secret),
    accessLog: accessLog.rows,
    requests: requests.rows,
  };
}
