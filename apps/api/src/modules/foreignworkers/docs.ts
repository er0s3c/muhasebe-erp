import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { foreignDocStatus, todayIso, type CreateForeignDocInput, type ForeignDocListQuery, type ForeignDocStatus } from '@erp/shared';
import type { Tx } from '../../db/client';
import { employees, foreignDocRenewals, foreignDocTypes, foreignWorkerDocs, personalDataAccessLog } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { decryptField, encryptField, lastFour, maskTail } from '../hr/crypto';
import { warningAt, type ForeignCtx } from './params';
import { trContains } from '../../db/search';
import { slicePage, type PageQuery } from '../../http/paging';

const GENERIC_TYPES = [
  { code: 'WORK_PERMIT', name: 'Çalışma izni' },
  { code: 'RESIDENCE_PERMIT', name: 'İkamet izni' },
  { code: 'PASSPORT', name: 'Pasaport' },
  { code: 'HEALTH_REPORT', name: 'Sağlık raporu' },
] as const;

/**
 * Belge türü kataloğu kullanıcı verisidir; yalnızca GENEL adlar tohumlanır (geçerlilik süresi, ücret, makam yok). Silinmez,
 * pasifleştirilir; tohumlanmış bir tür pasifleştirilince yeniden etkinleşmez (kod çakışmasında dokunulmaz).
 */
export async function listTypes(tx: Tx, companyId: string) {
  for (const t of GENERIC_TYPES) {
    await tx.insert(foreignDocTypes).values({ companyId, code: t.code, name: t.name }).onConflictDoNothing({ target: [foreignDocTypes.companyId, foreignDocTypes.code] });
  }
  return tx.select().from(foreignDocTypes).orderBy(desc(foreignDocTypes.active), asc(foreignDocTypes.name));
}

export async function createType(tx: Tx, companyId: string, input: { code: string; name: string }) {
  const code = input.code.trim().toUpperCase();
  const [dup] = await tx.select({ id: foreignDocTypes.id }).from(foreignDocTypes).where(eq(foreignDocTypes.code, code));
  if (dup) throw conflict('Bu kodlu bir belge türü var', 'FOREIGN_DOC_TYPE_EXISTS');
  const [row] = await tx.insert(foreignDocTypes).values({ companyId, code, name: input.name.trim() }).returning();
  return row!;
}

export async function updateType(tx: Tx, id: string, input: { name?: string; active?: boolean }) {
  const [row] = await tx
    .update(foreignDocTypes)
    .set({ ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.active !== undefined ? { active: input.active } : {}) })
    .where(eq(foreignDocTypes.id, id))
    .returning();
  if (!row) throw notFound('Belge türü');
  return row;
}

/** Belge kaydı görüntülemesi erişim günlüğüne yazılır (alan: 'foreign_docs'); aynı kullanıcı-personel için 10 dakikada bir. */
export async function logForeignAccess(tx: Tx, employeeIds: readonly string[], reason: string) {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return;
  await tx.execute(sql`
    insert into personal_data_access_log (id, company_id, employee_id, field, reason, user_id)
    select gen_random_uuid(), app_company_id(), e.id, 'foreign_docs', ${reason}, current_setting('app.user_id')::uuid
      from (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid as id) as e
     where not exists (
       select 1 from personal_data_access_log l
        where l.employee_id = e.id and l.field = 'foreign_docs' and l.user_id = current_setting('app.user_id')::uuid
          and l.created_at > now() - interval '10 minutes')`);
}

type DocRow = typeof foreignWorkerDocs.$inferSelect;

/** Numara yalnızca maskeli (son 4 hane) görünür; durum son kullanma tarihi ve (varsa) uyarı gününden anlık hesaplanır. */
function view(r: DocRow, extra: { employeeCode: string; employeeName: string; nationality: string | null; typeName: string; typeCode: string }, today: string, warningDays: number | null) {
  const st = foreignDocStatus({ expiryDate: r.expiryDate, revoked: !!r.revokedAt, today, warningDays });
  return {
    id: r.id,
    employeeId: r.employeeId,
    ...extra,
    typeId: r.typeId,
    hasNumber: !!r.numberEnc,
    numberMasked: maskTail(r.numberLast4),
    issuingAuthority: r.issuingAuthority,
    issueDate: r.issueDate,
    expiryDate: r.expiryDate,
    referenceNote: r.referenceNote,
    note: r.note,
    renewalCount: r.renewalCount,
    revokedAt: r.revokedAt,
    revokeReason: r.revokeReason,
    status: st.status as ForeignDocStatus,
    daysToExpiry: st.daysToExpiry,
  };
}

export async function listDocs(tx: Tx, q: Omit<ForeignDocListQuery, 'limit' | 'offset'>, page?: PageQuery) {
  const today = q.asOf ?? todayIso();
  const warn = await warningAt(tx, today);
  const rows = await tx
    .select({ d: foreignWorkerDocs, code: employees.code, name: employees.fullName, nationality: employees.nationality, typeName: foreignDocTypes.name, typeCode: foreignDocTypes.code })
    .from(foreignWorkerDocs)
    .innerJoin(employees, and(eq(employees.id, foreignWorkerDocs.employeeId), eq(employees.companyId, foreignWorkerDocs.companyId)))
    .innerJoin(foreignDocTypes, and(eq(foreignDocTypes.id, foreignWorkerDocs.typeId), eq(foreignDocTypes.companyId, foreignWorkerDocs.companyId)))
    .where(
      and(
        q.employeeId ? eq(foreignWorkerDocs.employeeId, q.employeeId) : undefined,
        q.typeId ? eq(foreignWorkerDocs.typeId, q.typeId) : undefined,
        q.nationality ? trContains(['employees.nationality'], q.nationality) : undefined,
        q.q ? trContains(['employees.full_name', 'employees.code'], q.q) : undefined,
      ),
    )
    .orderBy(sql`${foreignWorkerDocs.expiryDate} asc nulls last`, asc(employees.code));
  const all = rows.map((r) => view(r.d, { employeeCode: r.code, employeeName: r.name, nationality: r.nationality, typeName: r.typeName, typeCode: r.typeCode }, today, warn.days));
  const summary = { valid: 0, expiring: 0, expired: 0, revoked: 0 };
  for (const d of all) summary[d.status]++;
  const filtered = all.filter(
    (d) => (!q.status || d.status === q.status) && (q.withinDays === undefined || (d.status !== 'revoked' && d.daysToExpiry !== null && d.daysToExpiry <= q.withinDays)),
  );
  const { rows: docs, truncated } = slicePage(filtered, page);
  await logForeignAccess(tx, docs.map((d) => d.employeeId), 'Yabancı işçi belge kaydı görüntüleme');
  return { asOf: today, warning: { days: warn.days, configured: warn.configured, verified: warn.verified }, summary, docs, truncated };
}

export async function getDoc(tx: Tx, id: string) {
  const today = todayIso();
  const warn = await warningAt(tx, today);
  const [r] = await tx
    .select({ d: foreignWorkerDocs, code: employees.code, name: employees.fullName, nationality: employees.nationality, typeName: foreignDocTypes.name, typeCode: foreignDocTypes.code })
    .from(foreignWorkerDocs)
    .innerJoin(employees, and(eq(employees.id, foreignWorkerDocs.employeeId), eq(employees.companyId, foreignWorkerDocs.companyId)))
    .innerJoin(foreignDocTypes, and(eq(foreignDocTypes.id, foreignWorkerDocs.typeId), eq(foreignDocTypes.companyId, foreignWorkerDocs.companyId)))
    .where(eq(foreignWorkerDocs.id, id));
  if (!r) throw notFound('Belge');
  const renewals = await tx.select().from(foreignDocRenewals).where(eq(foreignDocRenewals.docId, id)).orderBy(desc(foreignDocRenewals.renewedAt));
  await logForeignAccess(tx, [r.d.employeeId], 'Yabancı işçi belge kaydı görüntüleme');
  return {
    doc: view(r.d, { employeeCode: r.code, employeeName: r.name, nationality: r.nationality, typeName: r.typeName, typeCode: r.typeCode }, today, warn.days),
    renewals: renewals.map((x) => ({
      id: x.id,
      prevIssueDate: x.prevIssueDate,
      prevExpiryDate: x.prevExpiryDate,
      prevNumberMasked: maskTail(x.prevNumberLast4),
      newIssueDate: x.newIssueDate,
      newExpiryDate: x.newExpiryDate,
      newNumberMasked: maskTail(x.newNumberLast4),
      note: x.note,
      renewedAt: x.renewedAt,
    })),
  };
}

export async function createDoc(tx: Tx, ctx: ForeignCtx, input: CreateForeignDocInput) {
  const [emp] = await tx.select({ id: employees.id, nationality: employees.nationality }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  if (!emp.nationality?.trim()) throw unprocessable('Personel kartında uyruk girilmemiş; önce uyruğu kaydedin', 'EMPLOYEE_NATIONALITY_MISSING');
  const [type] = await tx.select().from(foreignDocTypes).where(eq(foreignDocTypes.id, input.typeId));
  if (!type) throw unprocessable('Belge türü bulunamadı', 'FOREIGN_DOC_TYPE_NOT_FOUND');
  if (!type.active) throw unprocessable('Belge türü pasif', 'FOREIGN_DOC_TYPE_INACTIVE');
  const no = input.documentNo?.trim();
  const [row] = await tx
    .insert(foreignWorkerDocs)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      typeId: input.typeId,
      numberEnc: no ? encryptField(no, ctx.secret) : null,
      numberLast4: no ? lastFour(no) : null,
      issuingAuthority: input.issuingAuthority?.trim() || null,
      issueDate: input.issueDate ?? null,
      expiryDate: input.expiryDate ?? null,
      referenceNote: input.referenceNote?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return (await getDoc(tx, row!.id)).doc;
}

export async function updateDoc(tx: Tx, id: string, input: { issuingAuthority?: string | null; referenceNote?: string | null; note?: string | null }) {
  const rows = await tx
    .update(foreignWorkerDocs)
    .set({
      ...(input.issuingAuthority !== undefined ? { issuingAuthority: input.issuingAuthority?.trim() || null } : {}),
      ...(input.referenceNote !== undefined ? { referenceNote: input.referenceNote?.trim() || null } : {}),
      ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(foreignWorkerDocs.id, id))
    .returning({ id: foreignWorkerDocs.id });
  if (rows.length === 0) throw notFound('Belge');
  return (await getDoc(tx, id)).doc;
}

export async function deleteDoc(tx: Tx, id: string) {
  const rows = await tx.delete(foreignWorkerDocs).where(eq(foreignWorkerDocs.id, id)).returning({ id: foreignWorkerDocs.id });
  if (rows.length === 0) throw notFound('Belge');
}

/** Yenileme: önceki değerler salt-eklenir geçmişe yazılır, sonra belge güncellenir (tek işlemde; tetikleyici eşleşmeyi doğrular). */
export async function renewDoc(tx: Tx, ctx: ForeignCtx, id: string, input: { issueDate?: string | null; expiryDate: string; documentNo?: string | null; note?: string | null }) {
  const [cur] = await tx.select().from(foreignWorkerDocs).where(eq(foreignWorkerDocs.id, id)).for('update');
  if (!cur) throw notFound('Belge');
  if (cur.revokedAt) throw unprocessable('İptal edilmiş belge yenilenemez', 'FOREIGN_DOC_REVOKED');
  const no = input.documentNo?.trim();
  const newIssue = input.issueDate === undefined ? cur.issueDate : input.issueDate;
  const newNoEnc = no ? encryptField(no, ctx.secret) : cur.numberEnc;
  const newLast4 = no ? lastFour(no) : cur.numberLast4;
  // Aynı bilgilerle (aynı numara dahil) tekrarlanan yenileme geçmişe ikinci kez yazılmaz (API-11)
  const sameNo = !no || (cur.numberEnc !== null && decryptField(cur.numberEnc, ctx.secret) === no);
  if (newIssue === cur.issueDate && input.expiryDate === cur.expiryDate && sameNo) throw conflict('Yenilemede bilgi değişmedi (aynı tarih ve numara)', 'RENEWAL_NO_CHANGE');
  if (newIssue && input.expiryDate < newIssue) throw unprocessable('Son kullanma tarihi veriliş tarihinden önce olamaz', 'FOREIGN_DOC_DATES');
  await tx.insert(foreignDocRenewals).values({
    companyId: ctx.companyId,
    docId: id,
    prevIssueDate: cur.issueDate,
    prevExpiryDate: cur.expiryDate,
    prevNumberLast4: cur.numberLast4,
    newIssueDate: newIssue,
    newExpiryDate: input.expiryDate,
    newNumberLast4: newLast4,
    note: input.note?.trim() || null,
    renewedBy: ctx.userId,
  });
  await tx
    .update(foreignWorkerDocs)
    .set({ issueDate: newIssue, expiryDate: input.expiryDate, numberEnc: newNoEnc, numberLast4: newLast4, renewalCount: cur.renewalCount + 1, updatedAt: new Date() })
    .where(eq(foreignWorkerDocs.id, id));
  return (await getDoc(tx, id)).doc;
}

export async function revokeDoc(tx: Tx, ctx: ForeignCtx, id: string, reason: string) {
  const [cur] = await tx.select().from(foreignWorkerDocs).where(eq(foreignWorkerDocs.id, id)).for('update');
  if (!cur) throw notFound('Belge');
  if (cur.revokedAt) throw conflict('Belge zaten iptal edilmiş', 'FOREIGN_DOC_REVOKED');
  await tx.update(foreignWorkerDocs).set({ revokedAt: new Date(), revokedBy: ctx.userId, revokeReason: reason.trim(), updatedAt: new Date() }).where(eq(foreignWorkerDocs.id, id));
  return (await getDoc(tx, id)).doc;
}

/** Numaranın açık okunması: gerekçe zorunlu, aynı işlemde erişim günlüğüne yazılır. */
export async function revealDocNo(tx: Tx, ctx: ForeignCtx, id: string, reason: string) {
  const [row] = await tx.select().from(foreignWorkerDocs).where(eq(foreignWorkerDocs.id, id));
  if (!row) throw notFound('Belge');
  if (!row.numberEnc) throw unprocessable('Bu alan boş', 'FIELD_EMPTY');
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, employeeId: row.employeeId, field: 'foreign_doc_no', reason: reason.trim(), userId: ctx.userId });
  return { field: 'foreign_doc_no', value: decryptField(row.numberEnc, ctx.secret) };
}
