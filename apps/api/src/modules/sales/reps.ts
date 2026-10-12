import { and, eq, sql } from 'drizzle-orm';
import { dec, roundMoney, toDbAmount, type PartySalesRepInput, type SalesRepReportQuery, type SalesRepTargetsInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { parties, salesRepChanges, salesRepTargets, users } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { INVOICE_EVENTS } from '../invoices/analytics';

/**
 * Satış sorumlusu, hedef ve ticari kârlılık (öneri 13). Sorumlu şirket üyesi bir kullanıcıdır; müşteri sorumlusu değişince
 * eski/yeni ve gerekçe geçmişe yazılır. Fatura satırı, bağlı siparişin sorumlusuna, sipariş yoksa carinin bugünkü sorumlusuna
 * sayılır (rapor bunu açıkça belirtir).
 */

export async function assertSalesRep(tx: Tx, companyId: string, userId: string) {
  const r = await tx.execute<{ ok: number }>(sql`
    select 1 as ok from memberships m join users u on u.id = m.user_id
     where m.company_id = ${companyId} and m.user_id = ${userId} and u.is_active limit 1`);
  if (r.rows.length === 0) throw unprocessable('Satış sorumlusu şirketin etkin bir üyesi olmalı', 'SALES_REP_NOT_MEMBER');
}

/** Sorumlu seçimi için şirket üyeleri (yalnız ad). */
export async function listSalesReps(tx: Tx, companyId: string) {
  const r = await tx.execute<{ id: string; name: string }>(sql`
    select u.id, u.full_name as name from memberships m join users u on u.id = m.user_id
     where m.company_id = ${companyId} and u.is_active order by u.full_name`);
  return { reps: r.rows };
}

export async function setPartySalesRep(tx: Tx, ctx: { companyId: string; userId: string }, partyId: string, input: PartySalesRepInput) {
  const [party] = await tx.select({ id: parties.id, salesRepId: parties.salesRepId }).from(parties).where(eq(parties.id, partyId)).for('update');
  if (!party) throw notFound('Cari');
  if (input.userId) await assertSalesRep(tx, ctx.companyId, input.userId);
  if ((party.salesRepId ?? null) === (input.userId ?? null)) return partySalesRepHistory(tx, partyId);
  await tx.update(parties).set({ salesRepId: input.userId }).where(eq(parties.id, partyId));
  await tx.insert(salesRepChanges).values({
    companyId: ctx.companyId,
    partyId,
    fromUserId: party.salesRepId,
    toUserId: input.userId,
    reason: input.reason ?? null,
    changedBy: ctx.userId,
  });
  return partySalesRepHistory(tx, partyId);
}

export async function partySalesRepHistory(tx: Tx, partyId: string) {
  const [party] = await tx
    .select({ salesRepId: parties.salesRepId, salesRepName: users.fullName })
    .from(parties)
    .leftJoin(users, eq(users.id, parties.salesRepId))
    .where(eq(parties.id, partyId));
  if (!party) throw notFound('Cari');
  const history = await tx.execute<{ id: string; from_name: string | null; to_name: string | null; reason: string | null; changed_by: string | null; changed_at: string }>(sql`
    select c.id, f.full_name as from_name, t.full_name as to_name, c.reason, b.full_name as changed_by, c.changed_at::text as changed_at
      from sales_rep_changes c
      left join users f on f.id = c.from_user_id
      left join users t on t.id = c.to_user_id
      left join users b on b.id = c.changed_by
     where c.party_id = ${partyId} order by c.changed_at desc, c.id desc limit 100`);
  return {
    salesRepId: party.salesRepId,
    salesRepName: party.salesRepName,
    history: history.rows.map((h) => ({ id: h.id, fromName: h.from_name, toName: h.to_name, reason: h.reason, changedBy: h.changed_by, changedAt: h.changed_at })),
  };
}

export async function listSalesRepTargets(tx: Tx, year: number) {
  const rows = await tx
    .select({ userId: salesRepTargets.userId, month: salesRepTargets.month, amount: salesRepTargets.amount, name: users.fullName })
    .from(salesRepTargets)
    .leftJoin(users, eq(users.id, salesRepTargets.userId))
    .where(eq(salesRepTargets.year, year))
    .orderBy(salesRepTargets.userId, salesRepTargets.month);
  return { year, targets: rows.map((r) => ({ userId: r.userId, name: r.name, month: r.month, amount: toDbAmount(r.amount) })) };
}

/** Hedefleri yıl için yazar; tutarı 0 olan hedef silinir. Listede olmayan ay/kişi değişmez. */
export async function saveSalesRepTargets(tx: Tx, ctx: { companyId: string; userId: string }, input: SalesRepTargetsInput) {
  for (const userId of new Set(input.targets.map((t) => t.userId))) await assertSalesRep(tx, ctx.companyId, userId);
  for (const t of input.targets) {
    const where = and(eq(salesRepTargets.userId, t.userId), eq(salesRepTargets.year, input.year), eq(salesRepTargets.month, t.month));
    if (dec(t.amount).isZero()) {
      await tx.delete(salesRepTargets).where(where);
      continue;
    }
    await tx
      .insert(salesRepTargets)
      .values({ companyId: ctx.companyId, userId: t.userId, year: input.year, month: t.month, amount: t.amount, updatedBy: ctx.userId })
      .onConflictDoUpdate({
        target: [salesRepTargets.companyId, salesRepTargets.userId, salesRepTargets.year, salesRepTargets.month],
        set: { amount: t.amount, updatedBy: ctx.userId, updatedAt: new Date() },
      });
  }
  return listSalesRepTargets(tx, input.year);
}

interface RepAgg {
  repId: string | null;
  repName: string | null;
  quotes: number;
  quotesWon: number;
  quotesLost: number;
  ordersConfirmed: number;
  ordersNetBase: string;
  sales: string;
  cost: string;
  target: string | null;
}

/** Sorumlu başına teklif/kazanma, onaylı sipariş, faturalı net satış, maliyet, katkı ve hedef gerçekleşmesi (defter para birimi). */
export async function salesRepReport(tx: Tx, q: SalesRepReportQuery) {
  if (q.to < q.from) throw unprocessable('Bitiş tarihi başlangıçtan önce olamaz', 'DATE_RANGE_INVALID');
  const sign = sql`v.sgn * case when v.type = 'sales_return' then -1 else 1 end`;
  const rows = await tx.execute<RepAgg & Record<string, unknown>>(sql`
    with quote_stats as (
      select o.sales_rep_id as rep_id, count(*)::int as quotes,
             count(*) filter (where o.status in ('accepted','converted'))::int as won,
             count(*) filter (where o.status = 'rejected')::int as lost
        from sales_orders o
       where o.kind = 'quote' and o.status not in ('draft','cancelled') and o.doc_date between ${q.from}::date and ${q.to}::date
       group by o.sales_rep_id
    ), order_stats as (
      select o.sales_rep_id as rep_id, count(*)::int as orders,
             coalesce(sum((select s.net_base from sales_doc_snapshots s where s.order_id = o.id and s.event = 'confirmed' order by s.revision_no desc limit 1)), 0) as net_base
        from sales_orders o
       where o.kind = 'order' and o.status in ('confirmed','closed') and o.doc_date between ${q.from}::date and ${q.to}::date
       group by o.sales_rep_id
    ), invoice_stats as (
      select coalesce(so.sales_rep_id, p.sales_rep_id) as rep_id,
             coalesce(sum(${sign} * coalesce(l.net_base, 0)), 0) as sales,
             coalesce(sum(${sign} * coalesce(l.cost_value, 0)), 0) as cost
        from invoice_lines l
        join ${INVOICE_EVENTS} v on v.id = l.invoice_id
        join parties p on p.id = v.party_id
        left join sales_order_lines sol on sol.id = l.sales_order_line_id
        left join sales_orders so on so.id = sol.order_id
       where v.type in ('sales','sales_return') and v.invoice_date between ${q.from}::date and ${q.to}::date
       group by 1
    ), target_stats as (
      select t.user_id as rep_id, sum(t.amount) as target
        from sales_rep_targets t
       where make_date(t.year, t.month, 1) between date_trunc('month', ${q.from}::date)::date and ${q.to}::date
       group by t.user_id
    ), reps as (
      select rep_id from quote_stats union select rep_id from order_stats union select rep_id from invoice_stats union select rep_id from target_stats
    )
    select r.rep_id as "repId", u.full_name as "repName",
           coalesce(qs.quotes, 0) as quotes, coalesce(qs.won, 0) as "quotesWon", coalesce(qs.lost, 0) as "quotesLost",
           coalesce(os.orders, 0) as "ordersConfirmed", coalesce(os.net_base, 0)::text as "ordersNetBase",
           coalesce(i.sales, 0)::text as sales, coalesce(i.cost, 0)::text as cost, ts.target::text as target
      from reps r
      left join users u on u.id = r.rep_id
      left join quote_stats qs on qs.rep_id is not distinct from r.rep_id
      left join order_stats os on os.rep_id is not distinct from r.rep_id
      left join invoice_stats i on i.rep_id is not distinct from r.rep_id
      left join target_stats ts on ts.rep_id is not distinct from r.rep_id
     order by coalesce(i.sales, 0) desc, u.full_name nulls last`);
  let sales = dec(0);
  let cost = dec(0);
  const out = rows.rows.map((r) => {
    const s = dec(r.sales);
    const c = dec(r.cost);
    sales = sales.plus(s);
    cost = cost.plus(c);
    const profit = s.minus(c);
    const decided = r.quotesWon + r.quotesLost;
    return {
      repId: r.repId,
      repName: r.repName,
      quotes: r.quotes,
      quotesWon: r.quotesWon,
      quotesLost: r.quotesLost,
      winRatePct: decided > 0 ? roundMoney(dec(r.quotesWon).div(decided).times(100)).toFixed(2) : null,
      ordersConfirmed: r.ordersConfirmed,
      ordersNetBase: toDbAmount(r.ordersNetBase),
      sales: toDbAmount(s),
      cost: toDbAmount(c),
      profit: toDbAmount(profit),
      marginPct: s.isZero() ? null : roundMoney(profit.div(s).times(100)).toFixed(2),
      target: r.target === null ? null : toDbAmount(r.target),
      achievementPct: r.target && dec(r.target).gt(0) ? roundMoney(s.div(r.target).times(100)).toFixed(2) : null,
    };
  });
  return {
    from: q.from,
    to: q.to,
    rows: out,
    totals: { sales: toDbAmount(sales), cost: toDbAmount(cost), profit: toDbAmount(sales.minus(cost)) },
  };
}

