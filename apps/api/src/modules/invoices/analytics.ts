import { sql, type SQL } from 'drizzle-orm';
import { dec, roundMoney, toDbAmount, type ItemProfitQuery, type SalesReportQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR } from '../../db/search';

/** Kaydedilmiş faturalar; iade türleri negatif işaretle düşülür. İptal ve taslak hariçtir. */
const SIDE_TYPES = {
  sales: ['sales', 'sales_return'],
  purchases: ['purchase', 'expense', 'purchase_return'],
} as const;
const signed = (expr: string) => sql.raw(`case when v.type in ('sales_return', 'purchase_return') then -(${expr}) else (${expr}) end`);

export interface SalesReportRow {
  key: string;
  /** Cari/stok kartı/ay/fatura etiketi */
  label: string;
  /** Cari kodu, stok kodu ya da fatura numarası */
  code: string | null;
  docCount: number;
  /** Yalnızca stok kartı kırılımında */
  qty: string | null;
  net: string;
  vat: string;
  gross: string;
  /** Yalnızca fatura kırılımında */
  date: string | null;
  invoiceId: string | null;
  type: string | null;
  externalNo: string | null;
}

interface RawRow extends Record<string, unknown> {
  key: string | null;
  label: string | null;
  code: string | null;
  doc_count: number;
  qty: string | null;
  net: string;
  vat: string;
  gross: string;
  date: string | null;
  invoice_id: string | null;
  type: string | null;
  external_no: string | null;
}

const typeList = (side: keyof typeof SIDE_TYPES) => sql.join(SIDE_TYPES[side].map((t) => sql`${t}`), sql`, `);

/**
 * Satış ya da alış raporu (defter para birimi): cari, stok kartı, ay ya da fatura kırılımı.
 * İade faturaları negatif; toplam net, KDV özetindeki (`vat-summary`) net tutarla aynıdır.
 */
export async function salesReport(tx: Tx, side: keyof typeof SIDE_TYPES, q: SalesReportQuery) {
  const base = sql`v.status = 'posted' and v.type in (${typeList(side)}) and v.invoice_date between ${q.from}::date and ${q.to}::date`;
  const invNet = signed('coalesce(v.net_total_base, 0)');
  const invVat = signed('coalesce(v.vat_total_base, 0)');
  const invGross = signed('coalesce(v.gross_total_base, 0)');
  const lineNet = signed('coalesce(l.net_base, 0)');
  const lineVat = signed('coalesce(l.vat_base, 0)');
  const lineQty = signed('l.quantity');

  let query: SQL;
  if (q.groupBy === 'party') {
    query = sql`
      select p.id::text as key, p.name as label, p.code as code, count(*)::int as doc_count, null::text as qty,
             sum(${invNet}) as net, sum(${invVat}) as vat, sum(${invGross}) as gross,
             null::text as date, null::text as invoice_id, null::text as type, null::text as external_no
      from invoices v join parties p on p.id = v.party_id
      where ${base}
      group by p.id order by net desc, p.name collate ${TR}`;
  } else if (q.groupBy === 'item') {
    query = sql`
      select coalesce(i.id::text, '-') as key, coalesce(i.name, 'Kartsız / serbest satırlar') as label, i.code as code,
             count(distinct v.id)::int as doc_count, sum(${lineQty}) as qty,
             sum(${lineNet}) as net, sum(${lineVat}) as vat, sum(${lineNet}) + sum(${lineVat}) as gross,
             null::text as date, null::text as invoice_id, null::text as type, null::text as external_no
      from invoice_lines l join invoices v on v.id = l.invoice_id left join items i on i.id = l.item_id
      where ${base}
      group by i.id order by net desc, coalesce(i.name, 'Kartsız / serbest satırlar') collate ${TR}`;
  } else if (q.groupBy === 'month') {
    query = sql`
      select to_char(v.invoice_date, 'YYYY-MM') as key, to_char(v.invoice_date, 'YYYY-MM') as label, null::text as code,
             count(*)::int as doc_count, null::text as qty,
             sum(${invNet}) as net, sum(${invVat}) as vat, sum(${invGross}) as gross,
             null::text as date, null::text as invoice_id, null::text as type, null::text as external_no
      from invoices v
      where ${base}
      group by 1 order by 1`;
  } else {
    query = sql`
      select v.id::text as key, p.name as label, v.invoice_no as code, 1 as doc_count, null::text as qty,
             ${invNet} as net, ${invVat} as vat, ${invGross} as gross,
             v.invoice_date::text as date, v.id::text as invoice_id, v.type as type, v.external_no as external_no
      from invoices v join parties p on p.id = v.party_id
      where ${base}
      order by v.invoice_date, v.invoice_no`;
  }

  const result = await tx.execute<RawRow>(query);
  let docCount = 0;
  let net = dec(0);
  let vat = dec(0);
  let gross = dec(0);
  const rows: SalesReportRow[] = result.rows.map((r) => {
    docCount += r.doc_count;
    net = net.plus(r.net);
    vat = vat.plus(r.vat);
    gross = gross.plus(r.gross);
    return {
      key: r.key ?? '-',
      label: r.label ?? '',
      code: r.code,
      docCount: r.doc_count,
      qty: r.qty === null || r.key === '-' ? null : toDbAmount(r.qty),
      net: toDbAmount(r.net),
      vat: toDbAmount(r.vat),
      gross: toDbAmount(r.gross),
      date: r.date,
      invoiceId: r.invoice_id,
      type: r.type,
      externalNo: r.external_no,
    };
  });
  return {
    from: q.from,
    to: q.to,
    side,
    groupBy: q.groupBy,
    rows,
    // Kırılım ne olursa olsun belge sayısı fatura adedidir; stok kartı kırılımında bir fatura birden çok satırda sayılabilir
    totals: { docCount: q.groupBy === 'item' ? null : docCount, net: toDbAmount(net), vat: toDbAmount(vat), gross: toDbAmount(gross) },
  };
}

export interface ItemProfitRow {
  itemId: string | null;
  code: string | null;
  name: string;
  unit: string | null;
  /** Kartsız satırlarda birimler karışık olduğundan null */
  qty: string | null;
  sales: string;
  cost: string;
  profit: string;
  /** Kâr / satış (%, 2 ondalık); satış sıfırsa null */
  marginPct: string | null;
}

interface ProfitRaw extends Record<string, unknown> {
  item_id: string | null;
  code: string | null;
  name: string | null;
  unit: string | null;
  qty: string;
  sales: string;
  cost: string;
}

/**
 * Stok kartı bazında satış (net), maliyet ve kâr: satış faturaları eksi satış iadeleri. Maliyet, fatura satırına
 * kayıt anında yazılan `cost_value` değeridir (yevmiyedeki 621 satırıyla aynı). Kartsız/hizmet satırları
 * ayrı bir satırda maliyetsiz gelir; böylece toplam satış, KDV özeti ve 600−610 hareketiyle uyuşur.
 */
export async function itemProfitability(tx: Tx, q: ItemProfitQuery) {
  const sign = sql`case when v.type = 'sales_return' then -1 else 1 end`;
  const result = await tx.execute<ProfitRaw>(sql`
    select i.id::text as item_id, i.code, coalesce(i.name, 'Kartsız / serbest satırlar') as name, i.unit,
           coalesce(sum(${sign} * l.quantity), 0) as qty,
           coalesce(sum(${sign} * coalesce(l.net_base, 0)), 0) as sales,
           coalesce(sum(${sign} * coalesce(l.cost_value, 0)), 0) as cost
    from invoice_lines l
    join invoices v on v.id = l.invoice_id
    left join items i on i.id = l.item_id
    where v.status = 'posted' and v.type in ('sales', 'sales_return') and v.invoice_date between ${q.from}::date and ${q.to}::date
    group by i.id
    order by (coalesce(sum(${sign} * coalesce(l.net_base, 0)), 0) - coalesce(sum(${sign} * coalesce(l.cost_value, 0)), 0)) desc, coalesce(i.name, 'Kartsız / serbest satırlar') collate ${TR}`);

  let sales = dec(0);
  let cost = dec(0);
  const rows: ItemProfitRow[] = result.rows.map((r) => {
    const s = dec(r.sales);
    const c = dec(r.cost);
    sales = sales.plus(s);
    cost = cost.plus(c);
    const profit = s.minus(c);
    return {
      itemId: r.item_id,
      code: r.code,
      name: r.name ?? '',
      unit: r.unit,
      qty: r.item_id === null ? null : toDbAmount(r.qty),
      sales: toDbAmount(s),
      cost: toDbAmount(c),
      profit: toDbAmount(profit),
      marginPct: s.isZero() ? null : roundMoney(profit.div(s).times(100)).toFixed(2),
    };
  });
  const profit = sales.minus(cost);
  return {
    from: q.from,
    to: q.to,
    rows,
    totals: {
      sales: toDbAmount(sales),
      cost: toDbAmount(cost),
      profit: toDbAmount(profit),
      marginPct: sales.isZero() ? null : roundMoney(profit.div(sales).times(100)).toFixed(2),
    },
  };
}
