import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  monthBounds,
  toDbAmount,
  type CreatePayrollItemInput,
  type CreatePayrollParamInput,
  type CreatePayTermInput,
  type PayrollParamSet,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { employeePayTerms, employees, payrollItems, payrollParams, users } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';

export interface PayrollCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
}

// --- Erişim günlüğü (ücret verisi) -----------------------------------------------------------------------

/**
 * Ücret verisinin okunması erişim günlüğüne yazılır (alan: 'payroll'). Kullanıcı oturum değişkeninden alınır (günlük koruması
 * başkası adına yazılmasını engeller); aynı kullanıcı-personel çifti için 10 dakika içinde tekrar yazılmaz (gürültü olmasın).
 */
export async function logPayrollAccess(tx: Tx, employeeIds: readonly string[], reason: string) {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return;
  await tx.execute(sql`
    insert into personal_data_access_log (id, company_id, employee_id, field, reason, user_id)
    select gen_random_uuid(), app_company_id(), e.id, 'payroll', ${reason}, current_setting('app.user_id')::uuid
      from (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid as id) as e
     where not exists (
       select 1 from personal_data_access_log l
        where l.employee_id = e.id and l.field = 'payroll' and l.user_id = current_setting('app.user_id')::uuid
          and l.created_at > now() - interval '10 minutes')`);
}

// --- Parametreler ----------------------------------------------------------------------------------------

export async function listParams(tx: Tx) {
  return tx.select().from(payrollParams).orderBy(asc(payrollParams.key), desc(payrollParams.effectiveFrom));
}

export async function createParam(tx: Tx, ctx: PayrollCtx, input: CreatePayrollParamInput) {
  const [dup] = await tx
    .select({ id: payrollParams.id })
    .from(payrollParams)
    .where(and(eq(payrollParams.key, input.key), eq(payrollParams.effectiveFrom, input.effectiveFrom)));
  if (dup) throw conflict('Bu parametre için aynı başlangıç tarihli bir satır var', 'PAYROLL_PARAM_EXISTS');
  const [row] = await tx
    .insert(payrollParams)
    .values({
      companyId: ctx.companyId,
      key: input.key,
      value: input.value,
      effectiveFrom: input.effectiveFrom,
      enabled: input.enabled,
      sourceNote: input.sourceNote?.trim() || null,
      supersedesId: input.supersedesId ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

/** Açma/kapama ve kaynak notu. Kaynak notu değişirse doğrulama sıfırlanır (değişen kayıt yeniden doğrulanmalı). */
export async function updateParam(tx: Tx, id: string, input: { enabled?: boolean; sourceNote?: string | null }) {
  const [cur] = await tx.select().from(payrollParams).where(eq(payrollParams.id, id)).for('update');
  if (!cur) throw notFound('Bordro parametresi');
  const noteChanged = input.sourceNote !== undefined && (input.sourceNote?.trim() || null) !== (cur.sourceNote ?? null);
  const [row] = await tx
    .update(payrollParams)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sourceNote !== undefined ? { sourceNote: input.sourceNote?.trim() || null } : {}),
      ...(noteChanged ? { verifiedBy: null, verifiedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(payrollParams.id, id))
    .returning();
  return row!;
}

export async function verifyParam(tx: Tx, id: string, userId: string, note: string | null | undefined) {
  const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [row] = await tx
    .update(payrollParams)
    .set({ verifiedBy: u?.email ?? userId, verifiedAt: new Date(), ...(note ? { sourceNote: note } : {}), updatedAt: new Date() })
    .where(eq(payrollParams.id, id))
    .returning();
  if (!row) throw notFound('Bordro parametresi');
  return row;
}

export async function deleteParam(tx: Tx, id: string) {
  const rows = await tx.delete(payrollParams).where(eq(payrollParams.id, id)).returning({ id: payrollParams.id });
  if (rows.length === 0) throw notFound('Bordro parametresi');
}

/**
 * Tarihte geçerli AÇIK parametreler: anahtar başına başlangıcı tarihten önce olan en yeni satır; o satır kapalıysa parametre
 * kapalıdır (yeni satır eskiyi kapatabilir). Parametresiz anahtar yoktur: motor yalnızca kullanıcının yazdığını yapar.
 */
export async function resolveParams(tx: Tx, onDate: string): Promise<{ set: PayrollParamSet; ids: Record<string, string> }> {
  const rows = await tx.execute<{ id: string; key: string; value: string; enabled: boolean; verified: boolean }>(sql`
    select distinct on (key) id, key, value::text as value, enabled, verified_at is not null as verified
      from payroll_params where effective_from <= ${onDate}::date
     order by key, effective_from desc`);
  const set: PayrollParamSet = {};
  const ids: Record<string, string> = {};
  for (const r of rows.rows) {
    if (!r.enabled) continue;
    (set as Record<string, { value: string; verified: boolean }>)[r.key] = { value: String(Number(r.value)), verified: r.verified };
    ids[r.key] = r.id;
  }
  return { set, ids };
}

// --- Ücret şartları --------------------------------------------------------------------------------------

export async function listTerms(tx: Tx, q: { employeeId?: string }) {
  const rows = await tx
    .select({
      id: employeePayTerms.id,
      employeeId: employeePayTerms.employeeId,
      employeeCode: employees.code,
      employeeName: employees.fullName,
      effectiveFrom: employeePayTerms.effectiveFrom,
      payBasis: employeePayTerms.payBasis,
      amount: employeePayTerms.amount,
      note: employeePayTerms.note,
    })
    .from(employeePayTerms)
    .innerJoin(employees, and(eq(employees.id, employeePayTerms.employeeId), eq(employees.companyId, employeePayTerms.companyId)))
    .where(q.employeeId ? eq(employeePayTerms.employeeId, q.employeeId) : undefined)
    .orderBy(asc(employees.code), desc(employeePayTerms.effectiveFrom));
  return rows;
}

export async function createTerm(tx: Tx, ctx: PayrollCtx, input: CreatePayTermInput) {
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  const [dup] = await tx
    .select({ id: employeePayTerms.id })
    .from(employeePayTerms)
    .where(and(eq(employeePayTerms.employeeId, input.employeeId), eq(employeePayTerms.effectiveFrom, input.effectiveFrom)));
  if (dup) throw conflict('Bu personelin aynı başlangıç tarihli bir ücret şartı var; önce onu silin', 'PAY_TERM_EXISTS');
  const [row] = await tx
    .insert(employeePayTerms)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      effectiveFrom: input.effectiveFrom,
      payBasis: input.payBasis,
      amount: toDbAmount(input.amount),
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

export async function deleteTerm(tx: Tx, id: string) {
  const rows = await tx.delete(employeePayTerms).where(eq(employeePayTerms.id, id)).returning({ id: employeePayTerms.id });
  if (rows.length === 0) throw notFound('Ücret şartı');
}

/** Ayın son günündeki geçerli ücret şartı (ay boyunca tek şart uygulanır). */
export async function termsAtMonthEnd(tx: Tx, month: string) {
  const { end } = monthBounds(month);
  const rows = await tx.execute<{ employee_id: string; pay_basis: string; amount: string; effective_from: string }>(sql`
    select distinct on (employee_id) employee_id, pay_basis, amount::text as amount, effective_from::text as effective_from
      from employee_pay_terms where effective_from <= ${end}::date
     order by employee_id, effective_from desc`);
  return new Map(rows.rows.map((r) => [r.employee_id, r]));
}

// --- Kalem kataloğu --------------------------------------------------------------------------------------

export async function listItems(tx: Tx) {
  return tx.select().from(payrollItems).orderBy(asc(payrollItems.kind), asc(payrollItems.code));
}

export async function createItem(tx: Tx, ctx: PayrollCtx, input: CreatePayrollItemInput) {
  const code = input.code.trim().toUpperCase();
  const [dup] = await tx.select({ id: payrollItems.id }).from(payrollItems).where(eq(payrollItems.code, code));
  if (dup) throw conflict(`${code} kodlu bir bordro kalemi var`, 'PAYROLL_ITEM_EXISTS');
  const [row] = await tx
    .insert(payrollItems)
    .values({
      companyId: ctx.companyId,
      code,
      name: input.name.trim(),
      kind: input.kind,
      affectsSocialBase: input.kind === 'earning' ? input.affectsSocialBase : false,
      affectsTaxBase: input.kind === 'earning' ? input.affectsTaxBase : false,
      liability: input.kind === 'deduction' ? input.liability : 'other',
    })
    .returning();
  return row!;
}

export async function updateItem(tx: Tx, id: string, input: { name?: string; affectsSocialBase?: boolean; affectsTaxBase?: boolean; liability?: 'tax' | 'social' | 'other'; isActive?: boolean }) {
  const [cur] = await tx.select().from(payrollItems).where(eq(payrollItems.id, id)).for('update');
  if (!cur) throw notFound('Bordro kalemi');
  const earning = cur.kind === 'earning';
  const [row] = await tx
    .update(payrollItems)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(earning && input.affectsSocialBase !== undefined ? { affectsSocialBase: input.affectsSocialBase } : {}),
      ...(earning && input.affectsTaxBase !== undefined ? { affectsTaxBase: input.affectsTaxBase } : {}),
      ...(!earning && input.liability !== undefined ? { liability: input.liability } : {}),
    })
    .where(eq(payrollItems.id, id))
    .returning();
  return row!;
}
