import { sql } from 'drizzle-orm';
import { dec, toDbAmount } from '@erp/shared';
import type { Tx } from '../../db/client';
import { loadMappings } from '../ledger/mappings';

/**
 * Alış ek maliyetleri fark mutabakatı (öneri 51). İthalat dosyası maliyetleri aktarım (clearing) hesabına alacak yazar; gider
 * faturaları aynı hesaba borç yazar. Mutabakat üç soruyu yanıtlar:
 *  1) Dosyadaki maliyet kalemi, bağlandığı faturanın tutarıyla (KDV hariç, defter para birimi) eşit mi?
 *  2) Aktarım hesabına yazılmış ama hiçbir dosyaya bağlanmamış fatura var mı?
 *  3) Aktarım hesabının kalan bakiyesi ne (sıfır değilse dağıtılmamış ya da faturası gelmemiş maliyet vardır)?
 * Yalnız kayıtlı (posted) dosya ve faturalar dikkate alınır; tahmin yapılmaz.
 */
export async function landedReconciliation(tx: Tx, asOf: string) {
  const mappings = await loadMappings(tx);
  const clearing = mappings.get('import_cost_clearing') ?? null;

  // 1) Faturaya bağlı maliyet kalemleri, fatura başına toplanır (bir fatura birden çok kalemi karşılayabilir)
  const linked = (await tx.execute<{ invoice_id: string; invoice_no: string | null; party_name: string | null; files: string; cost_base: string; invoice_net_base: string }>(sql`
    select c.invoice_id, i.invoice_no, p.name as party_name, string_agg(distinct f.code, ', ') as files,
           sum(c.amount_base)::text as cost_base,
           (select coalesce(sum(il.net_base), 0) from invoice_lines il where il.invoice_id = c.invoice_id)::text as invoice_net_base
      from import_cost_lines c
      join import_files f on f.id = c.import_file_id and f.status = 'posted' and f.post_date <= ${asOf}::date
      join invoices i on i.id = c.invoice_id and i.status = 'posted'
      left join parties p on p.id = i.party_id
     where c.invoice_id is not null
     group by c.invoice_id, i.invoice_no, p.name
     order by i.invoice_no`)).rows.map((r) => {
    const difference = dec(r.invoice_net_base).minus(r.cost_base);
    return { invoiceId: r.invoice_id, invoiceNo: r.invoice_no, partyName: r.party_name, files: r.files, costBase: toDbAmount(r.cost_base), invoiceNetBase: toDbAmount(r.invoice_net_base), difference: toDbAmount(difference), matched: difference.isZero() };
  });

  // Faturası bağlanmamış maliyet kalemleri (tutar kullanıcı girişidir; belgeyle doğrulanmamıştır)
  const unlinkedCosts = (await tx.execute<{ file_code: string; description: string; amount_base: string }>(sql`
    select f.code as file_code, c.description, c.amount_base::text
      from import_cost_lines c join import_files f on f.id = c.import_file_id and f.status = 'posted' and f.post_date <= ${asOf}::date
     where c.invoice_id is null order by f.code, c.line_no`)).rows.map((r) => ({ fileCode: r.file_code, description: r.description, amountBase: toDbAmount(r.amount_base) }));

  // 2) Aktarım hesabına yazılmış, hiçbir kayıtlı dosyaya bağlanmamış faturalar
  const orphanInvoices = clearing
    ? (await tx.execute<{ invoice_id: string; invoice_no: string | null; invoice_date: string; party_name: string | null; amount_base: string }>(sql`
        select i.id as invoice_id, i.invoice_no, i.invoice_date::text as invoice_date, p.name as party_name, sum(l.debit_base - l.credit_base)::text as amount_base
          from invoices i
          join journal_lines l on l.entry_id = i.journal_entry_id and l.account_id = ${clearing.id}::uuid
          left join parties p on p.id = i.party_id
         where i.status = 'posted' and i.invoice_date <= ${asOf}::date
           and not exists (select 1 from import_cost_lines c join import_files f on f.id = c.import_file_id and f.status <> 'cancelled' where c.invoice_id = i.id)
         group by i.id, i.invoice_no, i.invoice_date, p.name
         order by i.invoice_date, i.invoice_no`)).rows.map((r) => ({ invoiceId: r.invoice_id, invoiceNo: r.invoice_no, invoiceDate: r.invoice_date, partyName: r.party_name, amountBase: toDbAmount(r.amount_base) }))
    : [];

  // 3) Aktarım hesabı bakiyesi: borç (+) = faturası gelmiş ama dosyaya dağıtılmamış maliyet; alacak (−) = dağıtılmış ama faturası gelmemiş
  const balance = clearing
    ? dec((await tx.execute<{ b: string }>(sql`
        select coalesce(sum(l.debit_base - l.credit_base), 0)::text as b
          from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
         where l.account_id = ${clearing.id}::uuid and e.entry_date <= ${asOf}::date`)).rows[0]!.b)
    : null;

  return {
    asOf,
    clearingAccount: clearing ? { id: clearing.id, code: clearing.code, name: clearing.name } : null,
    clearingBalance: balance === null ? null : toDbAmount(balance),
    linked,
    unlinkedCosts,
    orphanInvoices,
    summary: {
      mismatched: linked.filter((l) => !l.matched).length,
      unlinkedCosts: unlinkedCosts.length,
      orphanInvoices: orphanInvoices.length,
      balanced: balance !== null && balance.isZero(),
    },
  };
}
