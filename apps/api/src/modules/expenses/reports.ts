import { sql } from 'drizzle-orm';
import type { ExpenseReportQuery } from '@erp/shared';
import type { Tx } from '../../db/client';

interface Group extends Record<string, unknown> {
  count: number;
  net: string;
  vat: string;
  withholding: string;
  gross: string;
}

/**
 * Gider raporları: yalnızca kaydedilmiş (iptal edilmemiş) gider fişleri. Tutar sütunları KDV hariç gider (net), KDV, stopaj ve brüttür.
 * Kırılımlar: gider kartı, ay (aylık eğilim), proje, cari/alacaklı ve en yüksek giderler. Tümü aynı süzgeçten türer, toplamları eşittir.
 */
export async function expenseReport(tx: Tx, q: ExpenseReportQuery) {
  const conds = [sql`e.status = 'posted'`, sql`e.entry_date >= ${q.from}::date`, sql`e.entry_date <= ${q.to}::date`];
  if (q.cardId) conds.push(sql`e.card_id = ${q.cardId}::uuid`);
  if (q.projectId) conds.push(sql`e.project_id = ${q.projectId}::uuid`);
  if (q.partyId) conds.push(sql`e.party_id = ${q.partyId}::uuid`);
  const where = sql`where ${sql.join(conds, sql` and `)}`;
  const agg = sql`count(*)::int as count, sum(e.net)::text as net, sum(e.vat)::text as vat, sum(e.withholding)::text as withholding, sum(e.gross)::text as gross`;

  const totals = await tx.execute<Group>(sql`select ${agg} from expense_entries e ${where}`);
  const byCard = await tx.execute<Group & { cardId: string; cardCode: string; cardName: string; accountCode: string }>(sql`
    select c.id as "cardId", c.code as "cardCode", c.name as "cardName", a.code as "accountCode", ${agg}
      from expense_entries e join expense_cards c on c.id = e.card_id join accounts a on a.id = c.account_id ${where}
     group by c.id, c.code, c.name, a.code order by sum(e.net) desc, c.code`);
  const byMonth = await tx.execute<Group & { month: string }>(sql`
    select to_char(e.entry_date, 'YYYY-MM') as month, ${agg}
      from expense_entries e ${where} group by 1 order by 1`);
  const byProject = await tx.execute<Group & { projectId: string | null; projectCode: string | null; projectName: string | null }>(sql`
    select e.project_id as "projectId", p.code as "projectCode", p.name as "projectName", ${agg}
      from expense_entries e left join projects p on p.id = e.project_id ${where}
     group by e.project_id, p.code, p.name order by (e.project_id is null), sum(e.net) desc`);
  const byParty = await tx.execute<Group & { partyId: string | null; partyName: string | null }>(sql`
    select e.party_id as "partyId", p.name as "partyName", ${agg}
      from expense_entries e left join parties p on p.id = e.party_id ${where}
     group by e.party_id, p.name order by (e.party_id is null), sum(e.net) desc`);
  const top = await tx.execute<Record<string, unknown>>(sql`
    select e.id, e.entry_no as "entryNo", e.entry_date::text as "entryDate", e.description, c.name as "cardName", p.name as "partyName",
           e.net::text as net, e.gross::text as gross
      from expense_entries e join expense_cards c on c.id = e.card_id left join parties p on p.id = e.party_id ${where}
     order by e.net desc, e.entry_date desc, e.entry_no limit ${q.top}`);

  const zero: Group = { count: 0, net: '0', vat: '0', withholding: '0', gross: '0' };
  return {
    from: q.from,
    to: q.to,
    totals: totals.rows[0]?.count ? totals.rows[0] : zero,
    byCard: byCard.rows,
    byMonth: byMonth.rows,
    byProject: byProject.rows,
    byParty: byParty.rows,
    top: top.rows,
  };
}
