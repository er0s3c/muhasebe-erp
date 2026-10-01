import { sql } from 'drizzle-orm';
import { dec, splitByProject } from '@erp/shared';
import type { Tx } from '../../db/client';

export type PremiumMonthRow = {
  id: string;
  number: string;
  month: string;
  status: 'draft' | 'finalized';
  employeeCount: number;
  premiumBase: string;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
  employeeDue: string;
  employerDue: string;
  hasUnverifiedParams: boolean;
};

export interface PremiumProjectRow {
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  employees: number;
  employeePremium: string;
  employerPremium: string;
  supportEmployee: string;
  supportEmployer: string;
  employeeDue: string;
  employerDue: string;
}

/**
 * Prim özeti: aya göre (bildirim toplamları) ve projeye göre. Projeye dağıtım, bordro etiket dağılımının brüt ağırlığına göredir
 * (en büyük kalan yöntemi: toplamlar bildirimle birebir tutar); etiketsiz kısım "etiketsiz" satırıdır.
 * Taslak bildirimler de listelenir (durum sütunuyla); toplamlara yalnızca kesinleşmiş olanlar girer.
 */
export async function premiumSummary(tx: Tx, q: { from: string; to: string }) {
  const months = await tx.execute<PremiumMonthRow>(sql`
    select d.id, d.number, d.month, d.status, d.employee_count as "employeeCount", d.premium_base_total::numeric(19,2)::text as "premiumBase",
           d.employee_premium_total::numeric(19,2)::text as "employeePremium", d.employer_premium_total::numeric(19,2)::text as "employerPremium",
           d.support_employee_total::numeric(19,2)::text as "supportEmployee", d.support_employer_total::numeric(19,2)::text as "supportEmployer",
           (d.employee_premium_total - d.support_employee_total)::numeric(19,2)::text as "employeeDue",
           (d.employer_premium_total - d.support_employer_total)::numeric(19,2)::text as "employerDue",
           d.has_unverified_params as "hasUnverifiedParams"
      from social_declarations d where d.month between ${q.from} and ${q.to} order by d.month`);

  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.employee_id as "employeeId", l.employee_premium::text as "employeePremium", l.employer_premium::text as "employerPremium",
           l.support_employee::text as "supportEmployee", l.support_employer::text as "supportEmployer", l.payroll_line_id as "payrollLineId"
      from social_declaration_lines l join social_declarations d on d.id = l.declaration_id
     where d.status = 'finalized' and d.month between ${q.from} and ${q.to}`);
  const allocs = await tx.execute<{ line_id: string; project_id: string | null; w: string }>(sql`
    select a.line_id, a.project_id, sum(a.gross_amount)::text as w
      from payroll_line_allocations a
     where a.line_id in (select l.payroll_line_id from social_declaration_lines l join social_declarations d on d.id = l.declaration_id
                          where d.status = 'finalized' and d.month between ${q.from} and ${q.to})
     group by a.line_id, a.project_id`);
  const byLine = new Map<string, { key: string; weight: string }[]>();
  for (const a of allocs.rows) byLine.set(a.line_id, [...(byLine.get(a.line_id) ?? []), { key: a.project_id ?? '', weight: a.w }]);

  type Acc = { emps: Set<string>; ep: ReturnType<typeof dec>; rp: ReturnType<typeof dec>; se: ReturnType<typeof dec>; sr: ReturnType<typeof dec> };
  const acc = new Map<string, Acc>();
  for (const l of lines.rows) {
    const parts = splitByProject(
      { ep: l.employeePremium as string, rp: l.employerPremium as string, se: l.supportEmployee as string, sr: l.supportEmployer as string },
      byLine.get(l.payrollLineId as string) ?? [],
    );
    for (const p of parts) {
      const a = acc.get(p.key) ?? { emps: new Set<string>(), ep: dec(0), rp: dec(0), se: dec(0), sr: dec(0) };
      a.emps.add(l.employeeId as string);
      a.ep = a.ep.plus(p.amounts.ep);
      a.rp = a.rp.plus(p.amounts.rp);
      a.se = a.se.plus(p.amounts.se);
      a.sr = a.sr.plus(p.amounts.sr);
      acc.set(p.key, a);
    }
  }
  const ids = [...acc.keys()].filter((k) => k);
  const proj = ids.length
    ? await tx.execute<{ id: string; code: string; name: string }>(sql`select id, code, name from projects where id in (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)})`)
    : { rows: [] as { id: string; code: string; name: string }[] };
  const pmap = new Map(proj.rows.map((p) => [p.id, p]));
  const rows: PremiumProjectRow[] = [...acc.entries()]
    .map(([key, a]) => ({
      projectId: key || null,
      projectCode: pmap.get(key)?.code ?? null,
      projectName: pmap.get(key)?.name ?? null,
      employees: a.emps.size,
      employeePremium: a.ep.toFixed(2),
      employerPremium: a.rp.toFixed(2),
      supportEmployee: a.se.toFixed(2),
      supportEmployer: a.sr.toFixed(2),
      employeeDue: a.ep.minus(a.se).toFixed(2),
      employerDue: a.rp.minus(a.sr).toFixed(2),
    }))
    .sort((x, y) => (x.projectCode ?? '￿').localeCompare(y.projectCode ?? '￿'));

  const fin = months.rows.filter((m) => m.status === 'finalized');
  const sum = (k: 'employeePremium' | 'employerPremium' | 'supportEmployee' | 'supportEmployer' | 'employeeDue' | 'employerDue') => fin.reduce((s, m) => s.plus(m[k]), dec(0)).toFixed(2);
  return {
    from: q.from,
    to: q.to,
    months: months.rows,
    projects: rows,
    totals: { employeePremium: sum('employeePremium'), employerPremium: sum('employerPremium'), supportEmployee: sum('supportEmployee'), supportEmployer: sum('supportEmployer'), employeeDue: sum('employeeDue'), employerDue: sum('employerDue') },
    unverified: fin.some((m) => m.hasUnverifiedParams),
  };
}
