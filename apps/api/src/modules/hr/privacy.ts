import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { dataSubjectRequests, personalDataInventory, users } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';

interface Seed {
  key: string;
  tableName: string;
  fieldName: string;
  category: 'identity' | 'contact' | 'financial' | 'employment' | 'other';
  purpose: string;
  legalBasis: string;
  retention: string;
  isSensitive?: boolean;
  transferAbroad?: boolean;
}

const BASIS_CONTRACT = 'Sözleşmenin kurulması/ifası (doğrulanmadı)';
const BASIS_LEGAL = 'Yasal yükümlülük (doğrulanmadı)';
const BASIS_INTEREST = 'Meşru menfaat (doğrulanmadı)';
const RETENTION_TBD = 'Belirlenmedi (hukuki saklama süresi doğrulanmadı)';

/**
 * Başlangıç envanteri: sistemin bugün tuttuğu kişisel veri alanları. Amaç/dayanak/süre **taslaktır, hiçbiri doğrulanmamıştır**
 * (89/2007; LEGAL-NOTES §5): işleten hukuk müşaviriyle gözden geçirip düzenler ve "doğrulandı" işaretler.
 */
export const INVENTORY_SEED: readonly Seed[] = [
  { key: 'employees.full_name', tableName: 'employees', fieldName: 'full_name', category: 'identity', purpose: 'Personel kaydı, puantaj ve bordro', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'employees.id_number', tableName: 'employees', fieldName: 'id_enc', category: 'identity', purpose: 'Kimlik doğrulama, sosyal güvenlik bildirimi', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'employees.birth_date', tableName: 'employees', fieldName: 'birth_date_enc', category: 'identity', purpose: 'Sosyal güvenlik bildirimi', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'employees.iban', tableName: 'employees', fieldName: 'iban_enc', category: 'financial', purpose: 'Maaş ve avans ödemesi', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD, isSensitive: true },
  { key: 'employees.contact', tableName: 'employees', fieldName: 'phone, email, address', category: 'contact', purpose: 'İletişim', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'employees.employment', tableName: 'employees', fieldName: 'hire_date, leave_date, department, job_title, project_id', category: 'employment', purpose: 'İstihdam ve işçilik maliyeti takibi', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'attendance.entries', tableName: 'attendance_entries', fieldName: 'work_date, normal_hours, overtime_hours, project_id, wbs_id, cost_code_id, note', category: 'employment', purpose: 'Günlük puantaj: çalışma saatleri, fazla mesai ve işçilik maliyetinin projeye/iş kalemine dağıtımı', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'attendance.leave_type', tableName: 'attendance_entries', fieldName: 'day_type', category: 'employment', purpose: 'İzin ve devamsızlık takibi (yıllık/hastalık/ücretsiz izin, devamsızlık); hastalık izni günü sağlık verisi sayılabilir (doğrulanmadı)', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'payroll.pay_terms', tableName: 'employee_pay_terms', fieldName: 'pay_basis, amount, effective_from, note', category: 'financial', purpose: 'Personel ücret şartı (aylık/günlük/saatlik ücret); bordro hesabının girdisi. Ücret verisi hr.payroll izniyle sınırlıdır ve okunması erişim günlüğüne yazılır', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD, isSensitive: true },
  { key: 'payroll.lines', tableName: 'payroll_lines', fieldName: 'gross, deductions, net, employer costs, hours, leave days', category: 'financial', purpose: 'Aylık bordro satırı: brüt/net ücret, kesintiler, işveren yükü ve devam özeti; iç belgedir, resmî bordro değildir', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'employee_ledger.advances', tableName: 'employee_advances', fieldName: 'amount, advance_date, purpose, settled_amount, status', category: 'financial', purpose: 'Personele verilen avanslar, bordrodan kesinti ve geri ödemeler (personel cari); personel bakiyesi ücret verisi gibi hassastır, hr.payroll izniyle sınırlıdır ve okunması erişim günlüğüne yazılır. Yasal dayanak ve avans kesintisi uygulaması doğrulanmadı', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD, isSensitive: true },
  { key: 'employee_ledger.salary_payments', tableName: 'employee_salary_payments', fieldName: 'amount, pay_date, payroll_run_id', category: 'financial', purpose: 'Net maaş ödemesi kaydı (kasa/banka hareketine bağlı) ve personel cari bakiyesi; hr.payroll izniyle sınırlıdır, okunması erişim günlüğüne yazılır. Dayanak ve saklama süresi doğrulanmadı', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'social.profile', tableName: 'employee_social_profiles', fieldName: 'ssn_enc, ssn_last4, payroll_type_code, insurance_start, insurance_end', category: 'identity', purpose: 'Sosyal güvenlik numarası (şifreli, maskeli gösterim) ve sigorta dönemi; sosyal güvenlik bildirimi çıktısının girdisi. Açık okuma hr.sensitive izni + gerekçe + erişim günlüğü ister. Yasal dayanak/format doğrulanmadı', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'social.declaration_lines', tableName: 'social_declaration_lines', fieldName: 'premium_base, employee_premium, employer_premium, support amounts, days, ssn_last4', category: 'financial', purpose: 'Aylık sosyal güvenlik bildirimi satırı (genel düzen; resmî biçim değildir, doğrulanmadı): prim matrahı, prim ve destek tutarları, gün sayıları. Yalnızca hr.payroll izniyle okunur, okuma erişim günlüğüne yazılır', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'foreign.docs', tableName: 'foreign_worker_docs', fieldName: 'number_enc, number_last4, issuing_authority, issue_date, expiry_date, reference_note', category: 'identity', purpose: 'Yabancı işçi belgeleri (çalışma/ikamet izni, pasaport, sağlık raporu vb.) ve son kullanma takibi; belge numarası şifreli + maskeli, açık okuma hr.sensitive izni + gerekçe + erişim günlüğü ister. Yasal dayanak ve saklama süresi doğrulanmadı', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD, isSensitive: true },
  { key: 'foreign.guarantees', tableName: 'foreign_worker_guarantees', fieldName: 'amount, currency, deposited_date, deposit_reference, status, resolved_date', category: 'financial', purpose: 'Yabancı işçi teminatı takibi (tutar kullanıcı parametresinden, yatırma/iade/irat tarihleri). Yasal dayanak ve tutar doğrulanmadı', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD },
  { key: 'parties.contact', tableName: 'parties', fieldName: 'name, tax_number, phone, email, address', category: 'contact', purpose: 'Müşteri/tedarikçi/taşeron cari kaydı ve fatura', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'users.account', tableName: 'users', fieldName: 'email, full_name', category: 'identity', purpose: 'Uygulama kullanıcı hesabı ve yetkilendirme', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
  { key: 'security_events.ip', tableName: 'security_events', fieldName: 'ip, user_agent', category: 'other', purpose: 'Güvenlik olaylarının izlenmesi (giriş, parola, MFA)', legalBasis: BASIS_INTEREST, retention: RETENTION_TBD },
  { key: 'audit_log.changes', tableName: 'audit_log', fieldName: 'changes', category: 'other', purpose: 'Denetim izi: kim neyi ne zaman değiştirdi', legalBasis: BASIS_LEGAL, retention: RETENTION_TBD },
  { key: 'real_estate.buyers', tableName: 'sales_contracts', fieldName: 'party_id', category: 'contact', purpose: 'Gayrimenkul alıcı sözleşmesi ve taksit takibi', legalBasis: BASIS_CONTRACT, retention: RETENTION_TBD },
] as const;

/** Envanteri şirket için tohumlar (yoksa ekler; kullanıcı düzenlemelerine dokunmaz). */
async function seedInventory(tx: Tx, companyId: string) {
  for (const s of INVENTORY_SEED) {
    await tx
      .insert(personalDataInventory)
      .values({ companyId, key: s.key, tableName: s.tableName, fieldName: s.fieldName, category: s.category, purpose: s.purpose, legalBasis: s.legalBasis, retention: s.retention, isSensitive: s.isSensitive ?? false, transferAbroad: s.transferAbroad ?? false })
      .onConflictDoNothing({ target: [personalDataInventory.companyId, personalDataInventory.key] });
  }
}

export async function listInventory(tx: Tx, companyId: string) {
  await seedInventory(tx, companyId);
  const rows = await tx.select().from(personalDataInventory).orderBy(personalDataInventory.tableName, personalDataInventory.key);
  return { inventory: rows };
}

export async function updateInventory(tx: Tx, id: string, input: { purpose?: string; legalBasis?: string; retention?: string | null; transferAbroad?: boolean; note?: string | null }) {
  const [row] = await tx
    .update(personalDataInventory)
    .set({ ...input, verifiedBy: null, verifiedAt: null, updatedAt: new Date() }) // değişen kayıt yeniden doğrulanmalı
    .where(eq(personalDataInventory.id, id))
    .returning();
  if (!row) throw notFound('Envanter kaydı');
  return row;
}

export async function verifyInventory(tx: Tx, id: string, userId: string, note: string | null | undefined) {
  const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [row] = await tx
    .update(personalDataInventory)
    .set({ verifiedBy: u?.email ?? userId, verifiedAt: new Date(), ...(note ? { note } : {}), updatedAt: new Date() })
    .where(eq(personalDataInventory.id, id))
    .returning();
  if (!row) throw notFound('Envanter kaydı');
  return row;
}

// --- İlgili kişi talepleri -----------------------------------------------------------------------------

export async function createRequest(tx: Tx, ctx: { companyId: string; userId: string }, input: { employeeId?: string | null; requesterName: string; kind: string; description?: string | null }) {
  const [row] = await tx
    .insert(dataSubjectRequests)
    .values({ companyId: ctx.companyId, employeeId: input.employeeId ?? null, requesterName: input.requesterName, kind: input.kind, description: input.description ?? null, createdBy: ctx.userId })
    .returning();
  return row!;
}

export async function listRequests(tx: Tx, q: { status?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select r.id, r.kind, r.status, r.requester_name as "requesterName", r.description, r.resolution_note as "resolutionNote",
           r.opened_at as "openedAt", r.resolved_at as "resolvedAt", r.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName"
      from data_subject_requests r left join employees e on e.id = r.employee_id
     where (${q.status ?? null}::text is null or r.status = ${q.status ?? null}::text)
     order by r.opened_at desc`);
  return { requests: rows.rows };
}

export async function resolveRequest(tx: Tx, ctx: { userId: string }, id: string, input: { outcome: 'completed' | 'rejected'; resolutionNote: string }) {
  const [cur] = await tx.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id)).for('update');
  if (!cur) throw notFound('Talep');
  if (cur.status !== 'open') throw unprocessable('Talep zaten sonuçlanmış', 'DSR_NOT_OPEN');
  const [row] = await tx
    .update(dataSubjectRequests)
    .set({ status: input.outcome, resolutionNote: input.resolutionNote, resolvedAt: new Date(), resolvedBy: ctx.userId })
    .where(and(eq(dataSubjectRequests.id, id), eq(dataSubjectRequests.status, 'open')))
    .returning();
  return row!;
}

// --- Erişim günlüğü ------------------------------------------------------------------------------------

export async function listAccessLog(tx: Tx, q: { employeeId?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.field, l.reason, l.created_at as "at", l.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", u.email as "by"
      from personal_data_access_log l
      join employees e on e.id = l.employee_id
      join users u on u.id = l.user_id
     where (${q.employeeId ?? null}::uuid is null or l.employee_id = ${q.employeeId ?? null}::uuid)
     order by l.created_at desc
     limit 500`);
  return { log: rows.rows };
}

