import { sql } from 'drizzle-orm';
import {
  dec,
  reportRatio,
  toDbAmount,
  type SupplierPerformanceQuery,
  type SupplierPerformanceData,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { INVOICE_EVENTS } from '../invoices/analytics';

interface RawRow extends Record<string, unknown> {
  partyId: string;
  code: string;
  name: string;
  currency: string;
  orderCount: number;
  orderedAmount: string;
  receivedAmount: string;
  receiptCount: number;
  averageLeadDays: string | null;
  purchaseAmount: string;
  returnAmount: string;
  priceExpectedAmount: string;
  priceActualAmount: string;
  priceComparedLines: number;
}
/** Separate currency cohorts prevent summing foreign amounts or quantities in different units. */
export async function supplierPerformance(
  tx: Tx,
  timeZone: string,
  q: SupplierPerformanceQuery,
): Promise<SupplierPerformanceData> {
  const result = await tx.execute<RawRow>(sql`
    with received as (
      select rl.order_line_id, sum(rl.quantity) as qty
      from po_receipt_lines rl join po_receipts r on r.id=rl.receipt_id
      where r.status='posted' and r.receipt_date<=${q.to}::date group by rl.order_line_id
    ), orders as (
      select o.party_id, o.currency_code, count(distinct o.id)::int as order_count,
        sum(l.quantity*l.unit_price) as ordered_amount,
        sum(coalesce(r.qty,0)*l.unit_price) as received_amount
      from purchase_orders o join purchase_order_lines l on l.order_id=o.id
      left join received r on r.order_line_id=l.id
      where o.status in ('issued','closed') and (o.issued_at at time zone ${timeZone})::date between ${q.from}::date and ${q.to}::date
      group by o.party_id,o.currency_code
    ), receipts as (
      select o.party_id,o.currency_code,count(r.id)::int as receipt_count,
        avg(r.receipt_date-(o.issued_at at time zone ${timeZone})::date)
          filter(where r.receipt_date>=(o.issued_at at time zone ${timeZone})::date)::text as average_lead_days
      from po_receipts r join purchase_orders o on o.id=r.order_id
      where r.status='posted' and o.status in ('issued','closed') and r.receipt_date between ${q.from}::date and ${q.to}::date
      group by o.party_id,o.currency_code
    ), invoices_by_party as (
      select i.party_id,i.currency_code,
        coalesce(sum(v.sgn*i.net_total) filter(where i.type='purchase'),0) as purchase_amount,
        coalesce(sum(v.sgn*i.net_total) filter(where i.type='purchase_return'),0) as return_amount
      from ${INVOICE_EVENTS} v join invoices i on i.id=v.id
      where i.type in ('purchase','purchase_return') and v.invoice_date between ${q.from}::date and ${q.to}::date
      group by i.party_id,i.currency_code
    ), prices as (
      select i.party_id,i.currency_code, sum(v.sgn*l.quantity*ol.unit_price) as expected_amount,
        sum(v.sgn*l.net) as actual_amount, sum(v.sgn)::int as compared_lines
      from ${INVOICE_EVENTS} v join invoices i on i.id=v.id join invoice_lines l on l.invoice_id=i.id
      join purchase_order_lines ol on ol.id=l.po_line_id
      join purchase_orders o on o.id=ol.order_id and o.currency_code=i.currency_code
      where i.type='purchase' and v.invoice_date between ${q.from}::date and ${q.to}::date
      group by i.party_id,i.currency_code
    ), cohort as (
      select party_id,currency_code from orders union select party_id,currency_code from receipts
      union select party_id,currency_code from invoices_by_party
    )
    select p.id as "partyId",p.code,p.name,c.currency_code as currency,
      coalesce(o.order_count,0) as "orderCount",coalesce(o.ordered_amount,0)::text as "orderedAmount",coalesce(o.received_amount,0)::text as "receivedAmount",
      coalesce(r.receipt_count,0) as "receiptCount",r.average_lead_days as "averageLeadDays",
      coalesce(i.purchase_amount,0)::text as "purchaseAmount",coalesce(i.return_amount,0)::text as "returnAmount",
      coalesce(pr.expected_amount,0)::text as "priceExpectedAmount",coalesce(pr.actual_amount,0)::text as "priceActualAmount",coalesce(pr.compared_lines,0) as "priceComparedLines"
    from cohort c join parties p on p.id=c.party_id
    left join orders o on o.party_id=c.party_id and o.currency_code=c.currency_code
    left join receipts r on r.party_id=c.party_id and r.currency_code=c.currency_code
    left join invoices_by_party i on i.party_id=c.party_id and i.currency_code=c.currency_code
    left join prices pr on pr.party_id=c.party_id and pr.currency_code=c.currency_code
    order by p.code,c.currency_code`);
  return {
    ...q,
    timeZone,
    rows: result.rows.map((r) => ({
      ...r,
      orderedAmount: toDbAmount(r.orderedAmount),
      receivedAmount: toDbAmount(r.receivedAmount),
      fulfilmentPct: reportRatio(r.receivedAmount, r.orderedAmount, 100),
      averageLeadDays: r.averageLeadDays === null ? null : dec(r.averageLeadDays).toFixed(2),
      purchaseAmount: toDbAmount(r.purchaseAmount),
      returnAmount: toDbAmount(r.returnAmount),
      returnPct: dec(r.returnAmount).gte(0)
        ? reportRatio(r.returnAmount, r.purchaseAmount, 100)
        : null,
      priceExpectedAmount: toDbAmount(r.priceExpectedAmount),
      priceActualAmount: toDbAmount(r.priceActualAmount),
      priceComparedLines: Math.max(0, r.priceComparedLines),
      priceVariancePct:
        r.priceComparedLines > 0
          ? reportRatio(
              dec(r.priceActualAmount).minus(r.priceExpectedAmount).toString(),
              r.priceExpectedAmount,
              100,
            )
          : null,
    })),
  };
}
