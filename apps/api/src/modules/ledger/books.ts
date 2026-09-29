import { sql } from 'drizzle-orm';
import { dec, toDbAmount, type GeneralLedgerQuery, type JournalBookQuery } from '@erp/shared';
import type { Tx } from '../../db/client';

/** Dışa aktarmada tek seferde okunabilecek en çok satır (bellek koruması). */
export const BOOK_EXPORT_MAX_LINES = 200_000;

/** Aralıktaki kaydedilmiş fiş satırı sayısı (dışa aktarma boyut denetimi için). */
export async function countBookLines(tx: Tx, from: string, to: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries e join journal_lines l on l.entry_id = e.id
    where e.status = 'posted' and e.entry_date between ${from}::date and ${to}::date`);
  return r.rows[0]?.n ?? 0;
}

export interface JournalBookLine {
  entryId: string;
  entryNo: string;
  entryDate: string;
  entryDescription: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  partyName: string | null;
  description: string | null;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
}

interface BookRow extends Record<string, unknown> {
  entry_id: string;
  entry_no: string;
  entry_date: string;
  entry_description: string;
  line_no: number;
  account_code: string;
  account_name: string;
  party_name: string | null;
  description: string | null;
  currency_code: string;
  fx_rate: string;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
}

/**
 * Yevmiye defteri: kaydedilmiş fişlerin tüm satırları (ters kayıtlar dahil: defter olayları sırasıyla gösterir),
 * tarih + fiş no + satır no sırasıyla. `total` ve `totals` sayfadan bağımsız, tüm aralık içindir.
 */
export async function journalBook(tx: Tx, q: Pick<JournalBookQuery, 'from' | 'to'> & { limit?: number; offset?: number }) {
  const range = sql`e.status = 'posted' and e.entry_date between ${q.from}::date and ${q.to}::date`;
  const agg = await tx.execute<{ n: number; debit_base: string; credit_base: string }>(sql`
    select count(*)::int as n, coalesce(sum(l.debit_base), 0) as debit_base, coalesce(sum(l.credit_base), 0) as credit_base
    from journal_entries e join journal_lines l on l.entry_id = e.id where ${range}`);
  const total = agg.rows[0]?.n ?? 0;

  const page = q.limit !== undefined ? sql`limit ${q.limit} offset ${q.offset ?? 0}` : sql``;
  const rows = await tx.execute<BookRow>(sql`
    select e.id as entry_id, e.entry_no, e.entry_date::text as entry_date, e.description as entry_description, l.line_no,
           a.code as account_code, a.name as account_name, p.name as party_name, l.description,
           l.currency_code, l.fx_rate, l.debit, l.credit, l.debit_base, l.credit_base
    from journal_entries e
    join journal_lines l on l.entry_id = e.id
    join accounts a on a.id = l.account_id
    left join parties p on p.id = l.party_id
    where ${range}
    order by e.entry_date, e.entry_no, l.line_no
    ${page}`);

  const lines: JournalBookLine[] = rows.rows.map((r) => ({
    entryId: r.entry_id,
    entryNo: r.entry_no,
    entryDate: r.entry_date,
    entryDescription: r.entry_description,
    lineNo: r.line_no,
    accountCode: r.account_code,
    accountName: r.account_name,
    partyName: r.party_name,
    description: r.description,
    currencyCode: r.currency_code,
    fxRate: r.fx_rate,
    debit: r.debit,
    credit: r.credit,
    debitBase: r.debit_base,
    creditBase: r.credit_base,
  }));
  return {
    from: q.from,
    to: q.to,
    total,
    lines,
    totals: { debitBase: toDbAmount(agg.rows[0]?.debit_base ?? 0), creditBase: toDbAmount(agg.rows[0]?.credit_base ?? 0) },
  };
}

export interface GeneralLedgerLine {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  currencyCode: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  /** Yürüyen bakiye (borç − alacak, defter para birimi) */
  balance: string;
}

export interface GeneralLedgerAccount {
  accountId: string;
  code: string;
  name: string;
  opening: string;
  lines: GeneralLedgerLine[];
  debit: string;
  credit: string;
  closing: string;
}

interface LedgerLineRow extends Record<string, unknown> {
  account_id: string;
  entry_id: string;
  entry_no: string;
  entry_date: string;
  description: string;
  currency_code: string;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
}

/**
 * Kebir (büyük defter): dönemde hareketi olan hesaplar; her hesap için devir, satırlar (yürüyen bakiye) ve
 * kapanış. Hesap sayfalıdır (`total` = hareketi olan hesap sayısı). Tutarlar defter para birimindedir.
 */
export async function generalLedger(tx: Tx, q: Pick<GeneralLedgerQuery, 'from' | 'to' | 'codePrefix'> & { limit?: number; offset?: number }) {
  const prefix = q.codePrefix ? sql`and a.code like ${`${q.codePrefix.replace(/[\\%_]/g, '\\$&')}%`}` : sql``;
  const moving = sql`exists (
      select 1 from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_id = a.id and e.status = 'posted' and e.entry_date between ${q.from}::date and ${q.to}::date)`;

  const count = await tx.execute<{ n: number }>(sql`select count(*)::int as n from accounts a where ${moving} ${prefix}`);
  const total = count.rows[0]?.n ?? 0;
  const page = q.limit !== undefined ? sql`limit ${q.limit} offset ${q.offset ?? 0}` : sql``;
  const accs = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select a.id, a.code, a.name from accounts a where ${moving} ${prefix} order by a.code ${page}`);
  if (accs.rows.length === 0) return { from: q.from, to: q.to, total, accounts: [] as GeneralLedgerAccount[] };

  const ids = sql.join(accs.rows.map((a) => sql`${a.id}::uuid`), sql`, `);
  const opening = await tx.execute<{ account_id: string; net: string }>(sql`
    select l.account_id, sum(l.debit_base - l.credit_base) as net
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where e.status = 'posted' and e.entry_date < ${q.from}::date and l.account_id in (${ids})
    group by l.account_id`);
  const openingBy = new Map(opening.rows.map((r) => [r.account_id, dec(r.net)]));

  const lines = await tx.execute<LedgerLineRow>(sql`
    select l.account_id, e.id as entry_id, e.entry_no, e.entry_date::text as entry_date,
           coalesce(l.description, e.description) as description, l.currency_code,
           l.debit, l.credit, l.debit_base, l.credit_base
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where e.status = 'posted' and e.entry_date between ${q.from}::date and ${q.to}::date and l.account_id in (${ids})
    order by e.entry_date, e.entry_no, l.line_no`);
  const linesBy = new Map<string, LedgerLineRow[]>();
  for (const r of lines.rows) {
    const list = linesBy.get(r.account_id) ?? [];
    list.push(r);
    linesBy.set(r.account_id, list);
  }

  const accounts: GeneralLedgerAccount[] = accs.rows.map((a) => {
    const open = openingBy.get(a.id) ?? dec(0);
    let running = open;
    let debit = dec(0);
    let credit = dec(0);
    const out = (linesBy.get(a.id) ?? []).map((r) => {
      running = running.plus(r.debit_base).minus(r.credit_base);
      debit = debit.plus(r.debit_base);
      credit = credit.plus(r.credit_base);
      return {
        entryId: r.entry_id,
        entryNo: r.entry_no,
        entryDate: r.entry_date,
        description: r.description,
        currencyCode: r.currency_code,
        debit: r.debit,
        credit: r.credit,
        debitBase: r.debit_base,
        creditBase: r.credit_base,
        balance: toDbAmount(running),
      };
    });
    return { accountId: a.id, code: a.code, name: a.name, opening: toDbAmount(open), lines: out, debit: toDbAmount(debit), credit: toDbAmount(credit), closing: toDbAmount(running) };
  });
  return { from: q.from, to: q.to, total, accounts };
}
