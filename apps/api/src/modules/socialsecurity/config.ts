import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { CreateEligibilityInput, CreateSocialProfileInput, CreateSupportRuleInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { employeeSocialProfiles, employeeSupportEligibility, employees, personalDataAccessLog, socialSupportRules, users } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { decryptField, encryptField, lastFour, maskTail } from '../hr/crypto';

export interface SocialCtx {
  companyId: string;
  userId: string;
  /** Şifreleme anahtarı kaynağı (JWT_SECRET). */
  secret: string;
}

/**
 * Sosyal güvenlik verisinin (profil, bildirim) okunması erişim günlüğüne yazılır (alan: 'social_security'); kullanıcı oturum
 * değişkeninden alınır, aynı kullanıcı-personel çifti için 10 dakika içinde tekrar yazılmaz.
 */
export async function logSocialAccess(tx: Tx, employeeIds: readonly string[], reason: string) {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return;
  await tx.execute(sql`
    insert into personal_data_access_log (id, company_id, employee_id, field, reason, user_id)
    select gen_random_uuid(), app_company_id(), e.id, 'social_security', ${reason}, current_setting('app.user_id')::uuid
      from (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid as id) as e
     where not exists (
       select 1 from personal_data_access_log l
        where l.employee_id = e.id and l.field = 'social_security' and l.user_id = current_setting('app.user_id')::uuid
          and l.created_at > now() - interval '10 minutes')`);
}

// --- Profiller -------------------------------------------------------------------------------------------

type ProfileRow = typeof employeeSocialProfiles.$inferSelect;

/** Numara yalnızca maskeli (son 4 hane) ve "var/yok" bilgisiyle görünür. */
const profileView = (r: ProfileRow) => ({
  id: r.id,
  employeeId: r.employeeId,
  effectiveFrom: r.effectiveFrom,
  payrollTypeCode: r.payrollTypeCode,
  insuranceStart: r.insuranceStart,
  insuranceEnd: r.insuranceEnd,
  hasSsn: !!r.ssnEnc,
  ssnMasked: maskTail(r.ssnLast4),
  note: r.note,
});

export async function listProfiles(tx: Tx, q: { employeeId?: string }) {
  const rows = await tx
    .select({ p: employeeSocialProfiles, code: employees.code, name: employees.fullName })
    .from(employeeSocialProfiles)
    .innerJoin(employees, and(eq(employees.id, employeeSocialProfiles.employeeId), eq(employees.companyId, employeeSocialProfiles.companyId)))
    .where(q.employeeId ? eq(employeeSocialProfiles.employeeId, q.employeeId) : undefined)
    .orderBy(asc(employees.code), desc(employeeSocialProfiles.effectiveFrom));
  await logSocialAccess(tx, rows.map((r) => r.p.employeeId), 'Sosyal güvenlik profili görüntüleme');
  return { profiles: rows.map((r) => ({ ...profileView(r.p), employeeCode: r.code, employeeName: r.name })) };
}

export async function createProfile(tx: Tx, ctx: SocialCtx, input: CreateSocialProfileInput) {
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  const [dup] = await tx
    .select({ id: employeeSocialProfiles.id })
    .from(employeeSocialProfiles)
    .where(and(eq(employeeSocialProfiles.employeeId, input.employeeId), eq(employeeSocialProfiles.effectiveFrom, input.effectiveFrom)));
  if (dup) throw conflict('Bu personelin aynı başlangıç tarihli bir profili var; önce onu silin', 'SOCIAL_PROFILE_EXISTS');
  const ssn = input.socialSecurityNo?.trim();
  const [row] = await tx
    .insert(employeeSocialProfiles)
    .values({
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      effectiveFrom: input.effectiveFrom,
      payrollTypeCode: input.payrollTypeCode?.trim() || null,
      insuranceStart: input.insuranceStart ?? null,
      insuranceEnd: input.insuranceEnd ?? null,
      ssnEnc: ssn ? encryptField(ssn, ctx.secret) : null,
      ssnLast4: ssn ? lastFour(ssn) : null,
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return profileView(row!);
}

export async function deleteProfile(tx: Tx, id: string) {
  const rows = await tx.delete(employeeSocialProfiles).where(eq(employeeSocialProfiles.id, id)).returning({ id: employeeSocialProfiles.id });
  if (rows.length === 0) throw notFound('Sosyal güvenlik profili');
}

/** Numaranın açık okunması: gerekçe zorunlu, aynı işlemde erişim günlüğüne yazılır. */
export async function revealSocialNo(tx: Tx, ctx: SocialCtx, id: string, reason: string) {
  const [row] = await tx.select().from(employeeSocialProfiles).where(eq(employeeSocialProfiles.id, id));
  if (!row) throw notFound('Sosyal güvenlik profili');
  if (!row.ssnEnc) throw unprocessable('Bu alan boş', 'FIELD_EMPTY');
  await tx.insert(personalDataAccessLog).values({ companyId: ctx.companyId, employeeId: row.employeeId, field: 'social_security_no', reason: reason.trim(), userId: ctx.userId });
  return { field: 'social_security_no', value: decryptField(row.ssnEnc, ctx.secret) };
}

/** Ayın son günündeki geçerli profil (ay boyunca tek profil uygulanır). */
export async function profilesAtMonthEnd(tx: Tx, monthEnd: string) {
  const rows = await tx.execute<{ employee_id: string; payroll_type_code: string | null; insurance_start: string | null; insurance_end: string | null; ssn_last4: string | null; has_ssn: boolean }>(sql`
    select distinct on (employee_id) employee_id, payroll_type_code, insurance_start::text as insurance_start, insurance_end::text as insurance_end,
           ssn_last4, ssn_enc is not null as has_ssn
      from employee_social_profiles where effective_from <= ${monthEnd}::date
     order by employee_id, effective_from desc`);
  return new Map(rows.rows.map((r) => [r.employee_id, r]));
}

// --- Prim desteği kuralları ------------------------------------------------------------------------------

export async function listRules(tx: Tx) {
  return tx.select().from(socialSupportRules).orderBy(asc(socialSupportRules.code), desc(socialSupportRules.effectiveFrom));
}

export async function createRule(tx: Tx, ctx: SocialCtx, input: CreateSupportRuleInput) {
  const code = input.code.trim().toUpperCase();
  const [dup] = await tx
    .select({ id: socialSupportRules.id })
    .from(socialSupportRules)
    .where(and(eq(socialSupportRules.code, code), eq(socialSupportRules.effectiveFrom, input.effectiveFrom)));
  if (dup) throw conflict('Bu kural için aynı başlangıç tarihli bir satır var', 'SUPPORT_RULE_EXISTS');
  const [row] = await tx
    .insert(socialSupportRules)
    .values({
      companyId: ctx.companyId,
      code,
      name: input.name.trim(),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      target: input.target,
      mode: input.mode,
      value: input.value,
      enabled: input.enabled,
      sourceNote: input.sourceNote?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

/** Açma/kapama, ad, bitiş tarihi ve kaynak notu. Kaynak notu değişirse doğrulama sıfırlanır. */
export async function updateRule(tx: Tx, id: string, input: { enabled?: boolean; sourceNote?: string | null; effectiveTo?: string | null; name?: string }) {
  const [cur] = await tx.select().from(socialSupportRules).where(eq(socialSupportRules.id, id)).for('update');
  if (!cur) throw notFound('Destek kuralı');
  const noteChanged = input.sourceNote !== undefined && (input.sourceNote?.trim() || null) !== (cur.sourceNote ?? null);
  if (input.effectiveTo && input.effectiveTo < cur.effectiveFrom) throw unprocessable('Bitiş başlangıçtan önce olamaz', 'SUPPORT_RULE_DATES');
  const [row] = await tx
    .update(socialSupportRules)
    .set({
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
      ...(input.sourceNote !== undefined ? { sourceNote: input.sourceNote?.trim() || null } : {}),
      ...(noteChanged ? { verifiedBy: null, verifiedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(socialSupportRules.id, id))
    .returning();
  return row!;
}

export async function verifyRule(tx: Tx, id: string, userId: string, note: string | null | undefined) {
  const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [row] = await tx
    .update(socialSupportRules)
    .set({ verifiedBy: u?.email ?? userId, verifiedAt: new Date(), ...(note ? { sourceNote: note } : {}), updatedAt: new Date() })
    .where(eq(socialSupportRules.id, id))
    .returning();
  if (!row) throw notFound('Destek kuralı');
  return row;
}

export async function deleteRule(tx: Tx, id: string) {
  const rows = await tx.delete(socialSupportRules).where(eq(socialSupportRules.id, id)).returning({ id: socialSupportRules.id });
  if (rows.length === 0) throw notFound('Destek kuralı');
}

// --- Uygunluk (beyan) ------------------------------------------------------------------------------------

export async function listEligibility(tx: Tx, q: { employeeId?: string }) {
  const rows = await tx
    .select({
      id: employeeSupportEligibility.id,
      employeeId: employeeSupportEligibility.employeeId,
      employeeCode: employees.code,
      employeeName: employees.fullName,
      ruleCode: employeeSupportEligibility.ruleCode,
      validFrom: employeeSupportEligibility.validFrom,
      validTo: employeeSupportEligibility.validTo,
      note: employeeSupportEligibility.note,
    })
    .from(employeeSupportEligibility)
    .innerJoin(employees, and(eq(employees.id, employeeSupportEligibility.employeeId), eq(employees.companyId, employeeSupportEligibility.companyId)))
    .where(q.employeeId ? eq(employeeSupportEligibility.employeeId, q.employeeId) : undefined)
    .orderBy(asc(employees.code), asc(employeeSupportEligibility.ruleCode), desc(employeeSupportEligibility.validFrom));
  return { eligibility: rows };
}

export async function createEligibility(tx: Tx, ctx: SocialCtx, input: CreateEligibilityInput) {
  const [emp] = await tx.select({ id: employees.id }).from(employees).where(eq(employees.id, input.employeeId));
  if (!emp) throw unprocessable('Personel bulunamadı', 'EMPLOYEE_NOT_FOUND');
  const code = input.ruleCode.trim().toUpperCase();
  const [rule] = await tx.select({ id: socialSupportRules.id }).from(socialSupportRules).where(eq(socialSupportRules.code, code)).limit(1);
  if (!rule) throw unprocessable('Bu kodlu bir destek kuralı yok; önce kuralı tanımlayın', 'SUPPORT_RULE_NOT_FOUND');
  const [dup] = await tx
    .select({ id: employeeSupportEligibility.id })
    .from(employeeSupportEligibility)
    .where(and(eq(employeeSupportEligibility.employeeId, input.employeeId), eq(employeeSupportEligibility.ruleCode, code), eq(employeeSupportEligibility.validFrom, input.validFrom)));
  if (dup) throw conflict('Aynı personel, kural ve başlangıç için kayıt var', 'SUPPORT_ELIGIBILITY_EXISTS');
  const [row] = await tx
    .insert(employeeSupportEligibility)
    .values({ companyId: ctx.companyId, employeeId: input.employeeId, ruleCode: code, validFrom: input.validFrom, validTo: input.validTo ?? null, note: input.note?.trim() || null, createdBy: ctx.userId })
    .returning();
  return row!;
}

export async function deleteEligibility(tx: Tx, id: string) {
  const rows = await tx.delete(employeeSupportEligibility).where(eq(employeeSupportEligibility.id, id)).returning({ id: employeeSupportEligibility.id });
  if (rows.length === 0) throw notFound('Uygunluk kaydı');
}
