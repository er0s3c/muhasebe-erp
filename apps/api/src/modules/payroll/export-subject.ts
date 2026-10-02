import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';

/** Kişi verisi dışa aktarma/erişim talebi için bir personelin ücret şartları ve bordro satırları (hr.sensitive + gerekçe + günlük zaten uçta). */
export async function employeePayrollRows(tx: Tx, employeeId: string) {
  const terms = await tx.execute<Record<string, unknown>>(sql`
    select effective_from::text as "effectiveFrom", pay_basis as "payBasis", amount::text as amount, note
      from employee_pay_terms where employee_id = ${employeeId} order by effective_from`);
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select r.number, r.month, r.status, l.gross::text as gross, l.deductions_total::text as deductions, l.net::text as net, l.employer_total::text as "employerTotal"
      from payroll_lines l join payroll_runs r on r.id = l.run_id
     where l.employee_id = ${employeeId} order by r.month, r.number`);
  return { payTerms: terms.rows, runs: lines.rows };
}
