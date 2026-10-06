import { sql, type SQL } from 'drizzle-orm';
import {
  buildEmployeeStatement,
  dec,
  employeeBalance,
  todayIso,
  type LedgerKind,
  type LedgerRowInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import { notFound } from '../../http/errors';
import { assertReportSize, maxReportRows } from '../../http/limits';
import { bucketOf, daysBetween, AGING_BUCKETS, type AgingBucket } from '../parties/aging';

/**
 * Personel cari erişim günlüğü: ücret/avans bakiyesi hassas veridir; okuma personel başına 'employee_ledger' alanıyla yazılır
 * (aynı kullanıcı + personel için 10 dakika içinde tekrar yazılmaz; günlük yalnız-ekleme, kullanıcı oturumdan alınır).
 */
export async function logLedgerAccess(tx: Tx, employeeIds: readonly string[], reason: string) {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return;
  await tx.execute(sql`
    insert into personal_data_access_log (id, company_id, employee_id, field, reason, user_id)
    select gen_random_uuid(), app_company_id(), e.id, 'employee_ledger', ${reason}, current_setting('app.user_id')::uuid
      from (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid as id) as e
     where not exists (
       select 1 from personal_data_access_log l
        where l.employee_id = e.id and l.field = 'employee_ledger' and l.user_id = current_setting('app.user_id')::uuid
          and l.created_at > now() - interval '10 minutes')`);
}

/**
 * Personel cari hareketleri (tek kaynak): onaylı/ödenmiş bordro net ücreti (alacak), avans (borç), avans kesintisi/geri ödemesi (alacak),
 * net maaş ödemesi (borç). İptal edilen bordro/avans/hareket sayılmaz. Bakiye = alacak − borç (pozitif: şirket personele borçlu).
 */
const LEDGER_SQL = sql`
  select l.employee_id, (to_date(r.month || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date as d, 'salary_net'::text as kind,
         r.number as ref, ('Bordro net ücret ' || r.month) as description, l.net as amount
    from payroll_lines l join payroll_runs r on r.id = l.run_id
   where r.status in ('approved', 'paid') and l.net > 0
  union all
  select a.employee_id, a.advance_date, 'advance', a.number, a.purpose, a.amount
    from employee_advances a where a.status <> 'cancelled'
  union all
  select a.employee_id, s.settled_date,
         case s.kind when 'payroll' then 'advance_deduction' when 'expense' then 'advance_expense' else 'advance_repayment' end,
         a.number,
         case s.kind when 'payroll' then 'Bordrodan avans kesintisi ' || coalesce(r.number, '') when 'expense' then 'Gider fişiyle avans mahsubu ' || coalesce(ex.entry_no,'') else 'Avans geri ödemesi' end,
         s.amount
    from employee_advance_settlements s
    join employee_advances a on a.id = s.advance_id
    left join payroll_runs r on r.id = s.payroll_run_id
    left join expense_entries ex on ex.id = s.expense_entry_id
   where s.reversed_at is null
  union all
  select p.employee_id, p.pay_date, 'salary_payment', t.txn_no, coalesce(p.note, 'Net maaş ödemesi'), p.amount
    from employee_salary_payments p join treasury_transactions t on t.id = p.treasury_txn_id
   where t.status = 'posted'`;

interface BalRow extends Record<string, unknown> {
  employeeId: string;
  code: string;
  fullName: string;
  department: string | null;
  partyId: string | null;
  salaryNet: string;
  salaryPaid: string;
  advanceGiven: string;
  advanceDeducted: string;
  advanceRepaid: string;
  advanceExpensed: string;
}

/** Personel bakiye listesi: kim kime borçlu. Hareketi ya da carisi olan personel listelenir. */
export async function employeeBalances(tx: Tx, q: { asOf?: string; query?: string }) {
  // Tarih verilmezse tüm hareketler sayılır (bordro yevmiyesi ay sonu tarihlidir; güncel bakiye ay sonunu beklemez)
  const asOf = q.asOf ?? '9999-12-31';
  const conds: SQL[] = [];
  if (q.query) conds.push(trContains(['e.full_name', 'e.code'], q.query));
  const where = conds.length ? sql`and ${sql.join(conds, sql` and `)}` : sql``;
  const res = await tx.execute<BalRow>(sql`
    with led as (${LEDGER_SQL})
    select e.id as "employeeId", e.code, e.full_name as "fullName", e.department, e.party_id as "partyId",
           coalesce(sum(led.amount) filter (where led.kind = 'salary_net'), 0)::text as "salaryNet",
           coalesce(sum(led.amount) filter (where led.kind = 'salary_payment'), 0)::text as "salaryPaid",
           coalesce(sum(led.amount) filter (where led.kind = 'advance'), 0)::text as "advanceGiven",
           coalesce(sum(led.amount) filter (where led.kind = 'advance_deduction'), 0)::text as "advanceDeducted",
           coalesce(sum(led.amount) filter (where led.kind = 'advance_repayment'), 0)::text as "advanceRepaid",
           coalesce(sum(led.amount) filter (where led.kind = 'advance_expense'), 0)::text as "advanceExpensed"
      from employees e
      left join led on led.employee_id = e.id and led.d <= ${asOf}::date
     where true ${where}
     group by e.id
    having count(led.amount) > 0 or e.party_id is not null
     order by e.code`);
  let owedToEmployees = dec(0);
  let owedByEmployees = dec(0);
  const rows = res.rows.map((r) => {
    const b = employeeBalance(r);
    if (dec(b.net).gt(0)) owedToEmployees = owedToEmployees.plus(b.net);
    if (dec(b.net).lt(0)) owedByEmployees = owedByEmployees.plus(dec(b.net).abs());
    return {
      ...r,
      salaryNet: dec(r.salaryNet).toFixed(2),
      salaryPaid: dec(r.salaryPaid).toFixed(2),
      advanceGiven: dec(r.advanceGiven).toFixed(2),
      advanceDeducted: dec(r.advanceDeducted).toFixed(2),
      advanceRepaid: dec(r.advanceRepaid).toFixed(2),
      advanceExpensed: dec(r.advanceExpensed).toFixed(2),
      ...b,
    };
  });
  await logLedgerAccess(
    tx,
    rows.map((r) => r.employeeId),
    'Personel bakiye listesi görüntüleme',
  );
  return {
    asOf: q.asOf ?? null,
    rows,
    totals: {
      owedToEmployees: owedToEmployees.toFixed(2),
      owedByEmployees: owedByEmployees.toFixed(2),
    },
  };
}

interface AdvRow extends Record<string, unknown> {
  id: string;
  number: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  advanceDate: string;
  amount: string;
  settled: string;
  purpose: string;
  projectCode: string | null;
  status: string;
}

/** Avans sicili: tarih itibarıyla kalan tutar ve yaşlandırma (avans tarihinden bu yana gün). */
export async function advanceRegister(
  tx: Tx,
  q: { status?: string; employeeId?: string; asOf?: string },
) {
  // Tarih verilmezse güncel durum (tüm kapamalar); yaş bugüne göre hesaplanır
  const asOf = q.asOf ?? '9999-12-31';
  const ageRef = q.asOf ?? todayIso();
  const conds: SQL[] = [sql`a.advance_date <= ${asOf}::date`];
  if (q.employeeId) conds.push(sql`a.employee_id = ${q.employeeId}`);
  if (q.status && q.status !== 'outstanding') conds.push(sql`a.status = ${q.status}`);
  if (q.status === 'outstanding') conds.push(sql`a.status in ('open', 'partial')`);
  const res = await tx.execute<AdvRow>(sql`
    select a.id, a.number, a.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName",
           a.advance_date::text as "advanceDate", a.amount::text as amount, a.purpose, p.code as "projectCode", a.status,
           coalesce((select sum(s.amount) from employee_advance_settlements s
                      where s.advance_id = a.id and s.reversed_at is null and s.settled_date <= ${asOf}::date), 0)::text as settled
      from employee_advances a
      join employees e on e.id = a.employee_id
      left join projects p on p.id = a.project_id
     where ${sql.join(conds, sql` and `)}
     order by a.advance_date desc, a.number desc
     limit ${maxReportRows() + 1}`);
  assertReportSize(res.rows.length);
  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, dec(0)])) as Record<
    AgingBucket,
    ReturnType<typeof dec>
  >;
  let openTotal = dec(0);
  const rows = res.rows.map((r) => {
    const open = r.status === 'cancelled' ? dec(0) : dec(r.amount).minus(r.settled);
    const ageDays = daysBetween(r.advanceDate, ageRef);
    const bucket = bucketOf(ageDays);
    if (open.gt(0)) {
      buckets[bucket] = buckets[bucket].plus(open);
      openTotal = openTotal.plus(open);
    }
    return {
      ...r,
      amount: dec(r.amount).toFixed(2),
      settled: dec(r.settled).toFixed(2),
      open: open.toFixed(2),
      ageDays,
      bucket,
    };
  });
  await logLedgerAccess(
    tx,
    rows.map((r) => r.employeeId),
    'Avans sicili görüntüleme',
  );
  return {
    asOf: ageRef,
    rows,
    totals: {
      open: openTotal.toFixed(2),
      buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, buckets[b].toFixed(2)])) as Record<
        AgingBucket,
        string
      >,
    },
  };
}

/** Bir personelin cari ekstresi (açılış bakiyesi + hareketler). */
export async function employeeStatement(
  tx: Tx,
  employeeId: string,
  q: { from: string; to: string },
) {
  const emp = await tx.execute<{
    id: string;
    code: string;
    fullName: string;
    partyId: string | null;
    partyCode: string | null;
  }>(sql`
    select e.id, e.code, e.full_name as "fullName", e.party_id as "partyId", p.code as "partyCode"
      from employees e left join parties p on p.id = e.party_id where e.id = ${employeeId}`);
  const employee = emp.rows[0];
  if (!employee) throw notFound('Personel');
  const opening = await tx.execute<{ credit: string; debit: string }>(sql`
    with led as (${LEDGER_SQL})
    select coalesce(sum(amount) filter (where kind in ('salary_net','advance_deduction','advance_repayment')), 0)::text as credit,
           coalesce(sum(amount) filter (where kind in ('salary_payment','advance')), 0)::text as debit
      from led where employee_id = ${employeeId} and d < ${q.from}::date`);
  const lines = await tx.execute<{
    d: string;
    kind: LedgerKind;
    ref: string;
    description: string;
    amount: string;
  }>(sql`
    with led as (${LEDGER_SQL})
    select d::text as d, kind, ref, description, amount::text as amount
      from led where employee_id = ${employeeId} and d between ${q.from}::date and ${q.to}::date
     order by d, ref
     limit ${maxReportRows() + 1}`);
  assertReportSize(lines.rows.length);
  const openingNet = dec(opening.rows[0]?.credit ?? 0)
    .minus(opening.rows[0]?.debit ?? 0)
    .toFixed(2);
  const rows: LedgerRowInput[] = lines.rows.map((r) => ({
    date: r.d,
    kind: r.kind,
    ref: r.ref,
    description: r.description,
    amount: dec(r.amount).toFixed(2),
  }));
  const st = buildEmployeeStatement(openingNet, rows);
  const open = await advanceRegister(tx, { employeeId, status: 'outstanding', asOf: q.to });
  await logLedgerAccess(tx, [employeeId], 'Personel cari ekstresi görüntüleme');
  return { employee, from: q.from, to: q.to, ...st, openAdvances: open.rows };
}

/** Personel verisi dışa aktarma (ilgili kişi talebi) için bir personelin avans, kesinti ve ödeme kayıtları. */
export async function employeeLedgerRows(tx: Tx, employeeId: string) {
  const advances = await tx.execute<Record<string, unknown>>(sql`
    select number, advance_date::text as "advanceDate", amount::text as amount, settled_amount::text as "settledAmount", purpose, status
      from employee_advances where employee_id = ${employeeId} order by advance_date, number`);
  const settlements = await tx.execute<Record<string, unknown>>(sql`
    select a.number as "advanceNumber", s.kind, s.amount::text as amount, s.settled_date::text as "settledDate", s.reversed_at as "reversedAt"
      from employee_advance_settlements s join employee_advances a on a.id = s.advance_id
     where a.employee_id = ${employeeId} order by s.settled_date, s.created_at`);
  const payments = await tx.execute<Record<string, unknown>>(sql`
    select p.pay_date::text as "payDate", p.amount::text as amount, t.txn_no as "txnNo", t.status
      from employee_salary_payments p join treasury_transactions t on t.id = p.treasury_txn_id
     where p.employee_id = ${employeeId} order by p.pay_date`);
  return { advances: advances.rows, settlements: settlements.rows, salaryPayments: payments.rows };
}
