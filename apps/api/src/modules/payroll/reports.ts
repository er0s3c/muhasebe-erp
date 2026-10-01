import { sql } from 'drizzle-orm';
import { dec } from '@erp/shared';
import type { Tx } from '../../db/client';

export interface PayrollCostRow {
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  wbsCode: string | null;
  wbsName: string | null;
  costCode: string | null;
  costCodeName: string | null;
  employees: number;
  hours: string;
  gross: string;
  employer: string;
  total: string;
}

/**
 * Aylık bordro maliyeti: proje / iş kalemi / maliyet koduna göre (yalnızca onaylı ve ödenmiş bordro; taslak ve iptal edilen sayılmaz).
 * Aynı tutarlar yevmiyede etiketli işçilik gideri olarak yazıldığından proje kârlılık/maliyet raporları defterden zaten görür;
 * bu rapor bordro tarafındaki kırılımı (brüt / işveren yükü / saat) ve etiketsiz maliyeti ayrıca gösterir.
 */
export async function payrollCostByProject(tx: Tx, q: { from: string; to: string }) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select a.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
           w.code as "wbsCode", w.name as "wbsName", c.code as "costCode", c.name as "costCodeName",
           count(distinct l.employee_id)::int as employees, coalesce(sum(a.hours), 0)::numeric(19,2)::text as hours,
           coalesce(sum(a.gross_amount), 0)::numeric(19,2)::text as gross, coalesce(sum(a.employer_amount), 0)::numeric(19,2)::text as employer,
           coalesce(sum(a.gross_amount + a.employer_amount), 0)::numeric(19,2)::text as total
      from payroll_line_allocations a
      join payroll_lines l on l.id = a.line_id
      join payroll_runs r on r.id = l.run_id and r.status in ('approved', 'paid')
      left join projects p on p.id = a.project_id
      left join project_wbs w on w.id = a.wbs_id
      left join cost_codes c on c.id = a.cost_code_id
     where r.month between ${q.from} and ${q.to}
     group by a.project_id, p.code, p.name, w.code, w.name, c.code, c.name
     order by p.code nulls last, w.code nulls first, c.code nulls first`);
  const rows = res.rows as unknown as PayrollCostRow[];
  const months = await tx.execute<Record<string, unknown>>(sql`
    select r.month, r.number, r.status, r.employee_count as "employeeCount", r.gross_total::numeric(19,2)::text as gross, r.deductions_total::numeric(19,2)::text as deductions,
           r.net_total::numeric(19,2)::text as net, r.employer_total::numeric(19,2)::text as employer, (r.gross_total + r.employer_total)::numeric(19,2)::text as cost, r.has_unverified_params as "hasUnverifiedParams"
      from payroll_runs r where r.status in ('approved', 'paid') and r.month between ${q.from} and ${q.to} order by r.month`);
  const sum = (k: 'gross' | 'employer' | 'total' | 'hours') => rows.reduce((s, r) => s.plus(r[k]), dec(0)).toFixed(2);
  return {
    from: q.from,
    to: q.to,
    rows,
    months: months.rows,
    totals: { hours: sum('hours'), gross: sum('gross'), employer: sum('employer'), total: sum('total') },
    unverified: months.rows.some((m) => m.hasUnverifiedParams),
  };
}
