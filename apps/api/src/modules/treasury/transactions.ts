import { sql, type SQL } from 'drizzle-orm';
import { dec, toDbAmount, type ListTreasuryTransactionsQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import { notFound } from '../../http/errors';
import { loadMappings } from '../ledger/mappings';

interface HeadRow extends Record<string, unknown> {
  id: string;
  type: string;
  status: string;
  txnNo: string;
  txnDate: string;
  accountId: string;
  accountName: string;
  accountKind: string;
  currencyCode: string;
  amount: string;
  toAccountId: string | null;
  toAccountName: string | null;
  toCurrencyCode: string | null;
  counterAmount: string | null;
  fxRate: string | null;
  partyId: string | null;
  partyCode: string | null;
  partyName: string | null;
  glAccountId: string | null;
  glAccountCode: string | null;
  glAccountName: string | null;
  description: string | null;
  journalEntryId: string;
  journalEntryNo: string | null;
  postedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNo: string | null;
}

export async function getTreasuryTransaction(tx: Tx, id: string) {
  const head = await tx.execute<HeadRow>(sql`
    select t.id, t.type, t.status, t.txn_no as "txnNo", t.txn_date::text as "txnDate",
           t.account_id as "accountId", ta.name as "accountName", ta.kind as "accountKind", t.currency_code as "currencyCode",
           t.amount, t.to_account_id as "toAccountId", tb.name as "toAccountName", tb.currency_code as "toCurrencyCode",
           t.counter_amount as "counterAmount", t.fx_rate as "fxRate",
           t.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           t.gl_account_id as "glAccountId", g.code as "glAccountCode", g.name as "glAccountName",
           t.description, t.journal_entry_id as "journalEntryId", je.entry_no as "journalEntryNo",
           t.posted_at as "postedAt", t.cancelled_at as "cancelledAt", t.cancel_reason as "cancelReason",
           t.cancel_journal_entry_id as "cancelJournalEntryId", cje.entry_no as "cancelJournalEntryNo"
    from treasury_transactions t
    join treasury_accounts ta on ta.id = t.account_id
    left join treasury_accounts tb on tb.id = t.to_account_id
    left join parties p on p.id = t.party_id
    left join accounts g on g.id = t.gl_account_id
    left join journal_entries je on je.id = t.journal_entry_id
    left join journal_entries cje on cje.id = t.cancel_journal_entry_id
    where t.id = ${id}`);
  const transaction = head.rows[0];
  if (!transaction) throw notFound('Kasa/banka hareketi');

  const allocations = await tx.execute<{
    lineId: string;
    entryId: string;
    entryNo: string;
    entryDate: string;
    description: string;
    currencyCode: string;
    amount: string;
    amountBase: string;
    settleAmount: string;
  }>(sql`
    select a.charge_line_id as "lineId", e.id as "entryId", e.entry_no as "entryNo", e.entry_date::text as "entryDate",
           coalesce(l.description, e.description) as description, l.currency_code as "currencyCode",
           a.amount, a.amount_base as "amountBase", a.settle_amount as "settleAmount"
    from party_allocations a
    join journal_lines l on l.id = a.charge_line_id
    join journal_entries e on e.id = l.entry_id
    where a.transaction_id = ${id}
    order by e.entry_date, e.entry_no, l.line_no`);

  // Kur farkı: hareketin yevmiyesinde kambiyo hesaplarına yazılan net tutar (+ kâr, − zarar; defter para birimi)
  const map = await loadMappings(tx);
  const fxIds = [map.get('fx_gain')?.id, map.get('fx_loss')?.id].filter((v): v is string => !!v);
  let fxNet = dec(0);
  if (fxIds.length > 0) {
    const fx = await tx.execute<{ net: string }>(sql`
      select coalesce(sum(credit_base - debit_base), 0) as net
      from journal_lines
      where entry_id = ${transaction.journalEntryId} and account_id in (${sql.join(fxIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
    fxNet = dec(fx.rows[0]?.net ?? 0);
  }
  return { transaction, allocations: allocations.rows, fxNet: toDbAmount(fxNet) };
}

export async function listTreasuryTransactions(tx: Tx, q: ListTreasuryTransactionsQuery) {
  const conds: SQL[] = [];
  if (q.type) conds.push(sql`t.type = ${q.type}`);
  if (q.status) conds.push(sql`t.status = ${q.status}`);
  if (q.accountId) conds.push(sql`(t.account_id = ${q.accountId} or t.to_account_id = ${q.accountId})`);
  if (q.partyId) conds.push(sql`t.party_id = ${q.partyId}`);
  if (q.from) conds.push(sql`t.txn_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`t.txn_date <= ${q.to}::date`);
  if (q.query) conds.push(trContains(['t.txn_no', "coalesce(t.description, '')", "coalesce(p.name, '')", "coalesce(p.code, '')"], q.query));
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const from = sql`
    from treasury_transactions t
    join treasury_accounts ta on ta.id = t.account_id
    left join treasury_accounts tb on tb.id = t.to_account_id
    left join parties p on p.id = t.party_id
    left join accounts g on g.id = t.gl_account_id`;

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select t.id, t.type, t.status, t.txn_no as "txnNo", t.txn_date::text as "txnDate",
           ta.name as "accountName", t.currency_code as "currencyCode", t.amount,
           tb.name as "toAccountName", tb.currency_code as "toCurrencyCode", t.counter_amount as "counterAmount",
           p.name as "partyName", g.code as "glAccountCode", g.name as "glAccountName", t.description
    ${from}
    ${where}
    order by t.txn_date desc, t.txn_no desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n ${from} ${where}`);
  return { transactions: rows.rows, total: total.rows[0]?.n ?? 0 };
}
