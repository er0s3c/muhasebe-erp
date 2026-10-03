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
 * KDV özeti (defter para birimi): hesaplanan KDV (satışlar − satış iadeleri + işveren hakedişleri) ve indirilecek KDV
 * (alış + gider faturası + gider fişi + taşeron hakedişi − alış iadeleri), oran bazında.
 *
 * Dönem kuralı (ACC-4): her belge KENDİ yevmiye tarihinde (+) sayılır; iptal edilen belge orijinal döneminden SİLİNMEZ,
 * iptal (ters kayıt) tarihinin döneminde eksi (−) satır olarak görünür. Böylece verilmiş bir dönemin özeti sonradan
 * değişmez ve her dönem için hesaplanan/indirilecek KDV, KDV hesaplarının (391/191 eşlemesi) o dönemdeki hareketine eşittir.
 * Elle yevmiyeyle KDV hesabına yazılan tutarlar belgeye bağlı olmadığından özette yoktur; `reconciliation` farkı gösterir.
 * KDV tevkifatı (hakediş) ayrı hesaplarda izlenir ve burada yer almaz. Oranlar belgede saklanan anlık görüntüdür;
 * resmî doğrulaması yapılmamış kodlar ayrıca bildirilir.
 */
export async function vatSummary(tx: Tx, q: { from: string; to: string }) {
  const rows = await tx.execute<VatRow>(sql`
    with ev as (
      -- Belge yevmiyesi kendi tarihinde (+), ters kaydı (iptal) kendi tarihinde (−)
      select e.id as entry_id, 1 as sgn
        from journal_entries e
       where e.status = 'posted' and e.reversal_of_id is null and e.entry_date between ${q.from}::date and ${q.to}::date
      union all
      select e.id, -1
        from journal_entries e join journal_entries r on r.id = e.reversed_by_id and r.status = 'posted'
       where e.status = 'posted' and r.entry_date between ${q.from}::date and ${q.to}::date
    ),
    docs as (
      select l.vat_code as code, l.vat_rate as rate, ev.sgn,
             case i.type when 'sales' then 1 when 'sales_return' then -1 else 0 end as s_sign,
             case when i.type in ('purchase', 'expense') then 1 when i.type = 'purchase_return' then -1 else 0 end as p_sign,
             l.net_base as net, l.vat_base as vat
        from invoice_lines l
        join invoices i on i.id = l.invoice_id and i.status in ('posted', 'cancelled')
        join ev on ev.entry_id = i.journal_entry_id
      union all
      select x.vat_code, x.vat_rate, ev.sgn, 0, 1, x.net, x.vat
        from expense_entries x join ev on ev.entry_id = x.journal_entry_id
      union all
      select p.vat_code, p.vat_rate, ev.sgn,
             case when p.direction = 'receivable' then 1 else 0 end,
             case when p.direction = 'receivable' then 0 else 1 end,
             round(p.gross * coalesce(p.fx_rate, 1), 2), round(p.vat * coalesce(p.fx_rate, 1), 2)
        from progress_payments p join ev on ev.entry_id = p.entry_id
       where p.status in ('posted', 'cancelled')
    )
    select code, rate,
      coalesce(sum(sgn * s_sign * net), 0) as sales_net,
      coalesce(sum(sgn * s_sign * vat), 0) as sales_vat,
      coalesce(sum(sgn * p_sign * net), 0) as purchase_net,
      coalesce(sum(sgn * p_sign * vat), 0) as purchase_vat
    from docs
    group by code, rate
    having sum(abs(net)) <> 0 or sum(abs(vat)) <> 0
    order by rate, code nulls first`);

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

  // Mutabakat: KDV hesaplarının (eşlenmiş 391/191) dönem hareketi
  const ledger = await tx.execute<{ output: string; input: string }>(sql`
    select
      coalesce(sum(l.credit_base - l.debit_base) filter (where l.account_id = (select account_id from account_mappings where key = 'vat_output')), 0) as output,
      coalesce(sum(l.debit_base - l.credit_base) filter (where l.account_id = (select account_id from account_mappings where key = 'vat_input')), 0) as input
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where e.entry_date between ${q.from}::date and ${q.to}::date
      and l.account_id in (select account_id from account_mappings where key in ('vat_output', 'vat_input'))`);
  const ledgerOutput = dec(ledger.rows[0]?.output ?? 0);
  const ledgerInput = dec(ledger.rows[0]?.input ?? 0);

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
    /** KDV hesaplarının dönem hareketi ile özetin farkı (elle yevmiye vb.); belgelerden oluşan defterde 0. */
    reconciliation: {
      ledgerOutput: toDbAmount(ledgerOutput),
      ledgerInput: toDbAmount(ledgerInput),
      outputDifference: toDbAmount(ledgerOutput.minus(salesVat)),
      inputDifference: toDbAmount(ledgerInput.minus(purchaseVat)),
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
