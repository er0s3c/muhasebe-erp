import { sql } from 'drizzle-orm';
import { dec, todayIso, toDbAmount } from '@erp/shared';
import type { Tx } from '../../db/client';

interface VatRow extends Record<string, unknown> {
  code: string | null;
  rate: string;
  sales_net: string;
  sales_vat: string;
  purchase_net: string;
  purchase_vat: string;
}

/**
 * KDV özeti (defter para birimi): hesaplanan KDV (satışlar − satış iadeleri) ve indirilecek KDV
 * (alış + gider − alış iadeleri), oran bazında. Yalnızca kaydedilmiş faturalar; iptal edilenler hariç
 * (iptal edilen faturanın yevmiyesi de ters çevrildiği için defterle tutarlıdır).
 * Oranlar faturada saklanan anlık görüntüdür; resmî doğrulaması yapılmamış kodlar ayrıca bildirilir.
 */
export async function vatSummary(tx: Tx, q: { from: string; to: string }) {
  const rows = await tx.execute<VatRow>(sql`
    select l.vat_code as code, l.vat_rate as rate,
      coalesce(sum(case i.type when 'sales' then l.net_base when 'sales_return' then -l.net_base else 0 end), 0) as sales_net,
      coalesce(sum(case i.type when 'sales' then l.vat_base when 'sales_return' then -l.vat_base else 0 end), 0) as sales_vat,
      coalesce(sum(case when i.type in ('purchase', 'expense') then l.net_base when i.type = 'purchase_return' then -l.net_base else 0 end), 0) as purchase_net,
      coalesce(sum(case when i.type in ('purchase', 'expense') then l.vat_base when i.type = 'purchase_return' then -l.vat_base else 0 end), 0) as purchase_vat
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.status = 'posted' and i.invoice_date between ${q.from}::date and ${q.to}::date
    group by l.vat_code, l.vat_rate
    order by l.vat_rate, l.vat_code nulls first`);

  let salesNet = dec(0);
  let salesVat = dec(0);
  let purchaseNet = dec(0);
  let purchaseVat = dec(0);
  const out = rows.rows.map((r) => {
    salesNet = salesNet.plus(r.sales_net);
    salesVat = salesVat.plus(r.sales_vat);
    purchaseNet = purchaseNet.plus(r.purchase_net);
    purchaseVat = purchaseVat.plus(r.purchase_vat);
    return {
      code: r.code,
      rate: r.rate,
      salesNet: toDbAmount(r.sales_net),
      salesVat: toDbAmount(r.sales_vat),
      purchaseNet: toDbAmount(r.purchase_net),
      purchaseVat: toDbAmount(r.purchase_vat),
    };
  });

  const codes = out.map((r) => r.code).filter((c): c is string => !!c);
  const unverified = codes.length
    ? await tx.execute<{ code: string }>(sql`
        select distinct code from tax_rates
        where verified_at is null and code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
        order by code`)
    : { rows: [] as { code: string }[] };

  return {
    from: q.from,
    to: q.to,
    rows: out,
    totals: {
      salesNet: toDbAmount(salesNet),
      salesVat: toDbAmount(salesVat),
      purchaseNet: toDbAmount(purchaseNet),
      purchaseVat: toDbAmount(purchaseVat),
      /** Hesaplanan − indirilecek: pozitif ödenecek, negatif devreden KDV. */
      payable: toDbAmount(salesVat.minus(purchaseVat)),
    },
    unverifiedCodes: unverified.rows.map((r) => r.code),
  };
}

/** Genel bakış: bu ayın net satış/alışları ve bekleyen taslaklar. */
export async function invoiceSummary(tx: Tx) {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const r = await tx.execute<{ sales: string; purchases: string; drafts: number }>(sql`
    select
      coalesce(sum(case when i.status = 'posted' and i.invoice_date >= ${monthStart}::date then
        case i.type when 'sales' then i.net_total_base when 'sales_return' then -i.net_total_base else 0 end end), 0) as sales,
      coalesce(sum(case when i.status = 'posted' and i.invoice_date >= ${monthStart}::date then
        case when i.type in ('purchase', 'expense') then i.net_total_base when i.type = 'purchase_return' then -i.net_total_base else 0 end end), 0) as purchases,
      count(*) filter (where i.status = 'draft')::int as drafts
    from invoices i`);
  const row = r.rows[0]!;
  return {
    month: monthStart.slice(0, 7),
    salesNet: toDbAmount(row.sales),
    purchasesNet: toDbAmount(row.purchases),
    draftCount: row.drafts,
  };
}
