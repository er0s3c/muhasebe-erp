import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { decryptField } from '../hr/crypto';

/** Kişi verisi dışa aktarma/erişim talebi için bir personelin sosyal güvenlik profilleri (açık numara dahil) ve bildirim satırları. */
export async function employeeSocialRows(tx: Tx, employeeId: string, secret: string) {
  const profiles = await tx.execute<Record<string, unknown>>(sql`
    select effective_from::text as "effectiveFrom", payroll_type_code as "payrollTypeCode", insurance_start::text as "insuranceStart",
           insurance_end::text as "insuranceEnd", ssn_enc as "ssnEnc", note
      from employee_social_profiles where employee_id = ${employeeId} order by effective_from`);
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select d.number, d.month, d.status, l.days_worked as "daysWorked", l.premium_base::text as "premiumBase", l.employee_premium::text as "employeePremium",
           l.employer_premium::text as "employerPremium", l.support_employee::text as "supportEmployee", l.support_employer::text as "supportEmployer"
      from social_declaration_lines l join social_declarations d on d.id = l.declaration_id
     where l.employee_id = ${employeeId} order by d.month`);
  return {
    profiles: profiles.rows.map(({ ssnEnc, ...p }) => ({ ...p, socialSecurityNo: ssnEnc ? decryptField(ssnEnc as string, secret) : null })),
    declarations: lines.rows,
  };
}
