import { sql } from 'drizzle-orm';
import { dec, toDbAmount, type TreasuryStatementQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { accounts } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { getTreasuryAccountRow } from './accounts';

interface StatementRow extends Record<string, unknown> {
  entry_id: string;
  entry_no: string;
  entry_date: string;
  description: string;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
  fx_rate: string;
  txn_id: string | null;
  txn_no: string | null;
  txn_type: string | null;
  txn_status: string | null;
}

/**
 * Kasa/banka hesabı ekstresi: bağlı muhasebe hesabının hareketleri; yürüyen bakiye hem hesabın kendi para
 * biriminde hem defter para biriminde (tarihsel maliyet) verilir. Hareket varsa bağlantısı satırda gelir.
 */
export async function treasuryStatement(tx: Tx, id: string, q: TreasuryStatementQuery) {
  const ta = await getTreasuryAccountRow(tx, id);
  const [gl] = await tx.select({ code: accounts.code, name: accounts.name }).from(accounts).where(eq(accounts.id, ta.accountId));

  const opening = await tx.execute<{ doc: string; base: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0) as doc, coalesce(sum(l.debit_base - l.credit_base), 0) as base
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.account_id = ${ta.accountId} and e.entry_date < ${q.from}::date`);

  const rows = await tx.execute<StatementRow>(sql`
    select e.id as entry_id, e.entry_no, e.entry_date::text as entry_date,
           coalesce(l.description, e.description) as description,
           l.debit, l.credit, l.debit_base, l.credit_base, l.fx_rate,
           t.id as txn_id, t.txn_no, t.type as txn_type, t.status as txn_status
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    left join treasury_transactions t on e.source_type = 'treasury' and t.id = e.source_id
    where l.account_id = ${ta.accountId} and e.entry_date between ${q.from}::date and ${q.to}::date
    order by e.entry_date, e.entry_no, l.line_no`);

  const openingDoc = dec(opening.rows[0]?.doc ?? 0);
  const openingBase = dec(opening.rows[0]?.base ?? 0);
  let runDoc = openingDoc;
  let runBase = openingBase;
  let debitDoc = dec(0);
  let creditDoc = dec(0);
  const lines = rows.rows.map((r) => {
    runDoc = runDoc.plus(r.debit).minus(r.credit);
    runBase = runBase.plus(r.debit_base).minus(r.credit_base);
    debitDoc = debitDoc.plus(r.debit);
    creditDoc = creditDoc.plus(r.credit);
    return {
      entryId: r.entry_id,
      entryNo: r.entry_no,
      entryDate: r.entry_date,
      description: r.description,
      debit: r.debit,
      credit: r.credit,
      debitBase: r.debit_base,
      creditBase: r.credit_base,
      fxRate: r.fx_rate,
      balanceDoc: toDbAmount(runDoc),
      balanceBase: toDbAmount(runBase),
      txnId: r.txn_id,
      txnNo: r.txn_no,
      txnType: r.txn_type,
      txnStatus: r.txn_status,
    };
  });

  return {
    account: { id: ta.id, name: ta.name, kind: ta.kind, currencyCode: ta.currencyCode, accountCode: gl?.code ?? '' },
    from: q.from,
    to: q.to,
    openingDoc: toDbAmount(openingDoc),
    openingBase: toDbAmount(openingBase),
    lines,
    totals: { debit: toDbAmount(debitDoc), credit: toDbAmount(creditDoc) },
    closingDoc: toDbAmount(runDoc),
    closingBase: toDbAmount(runBase),
  };
}
