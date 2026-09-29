import { sql, type SQL } from 'drizzle-orm';
import { dec, toDbAmount, type FxDifferencesQuery, type TreasuryTxnType } from '@erp/shared';
import type { Tx } from '../../db/client';
import { loadMappings } from '../ledger/mappings';

export interface FxDifferenceRow {
  transactionId: string;
  txnNo: string;
  type: TreasuryTxnType;
  txnDate: string;
  accountName: string;
  partyName: string | null;
  currencyCode: string;
  /** Kambiyo kârı ve zararı (defter para birimi, pozitif) */
  gain: string;
  loss: string;
  /** kâr − zarar */
  net: string;
}

interface Raw extends Record<string, unknown> {
  id: string;
  txn_no: string;
  type: TreasuryTxnType;
  txn_date: string;
  account_name: string;
  party_name: string | null;
  currency_code: string;
  gain: string;
  loss: string;
}

/**
 * Gerçekleşen kambiyo (kur farkı) kârı/zararı: tahsilat, ödeme ve döviz satışı hareketlerinin yevmiyesindeki
 * 646/656 (hesap eşlemesindeki `fx_gain`/`fx_loss`) satırları. İptal edilen hareketler hariçtir (ters kayıtla
 * net sıfırdır). Eşleme yoksa boş döner.
 */
export async function fxDifferences(tx: Tx, q: FxDifferencesQuery) {
  const map = await loadMappings(tx);
  const gainId = map.get('fx_gain')?.id;
  const lossId = map.get('fx_loss')?.id;
  const ids = [gainId, lossId].filter((v): v is string => !!v);
  const empty = { from: q.from, to: q.to, rows: [] as FxDifferenceRow[], totals: { gain: toDbAmount(0), loss: toDbAmount(0), net: toDbAmount(0) } };
  if (ids.length === 0) return empty;

  const gain: SQL = gainId ? sql`coalesce(sum(l.credit_base - l.debit_base) filter (where l.account_id = ${gainId}::uuid), 0)` : sql`0`;
  const loss: SQL = lossId ? sql`coalesce(sum(l.debit_base - l.credit_base) filter (where l.account_id = ${lossId}::uuid), 0)` : sql`0`;
  const result = await tx.execute<Raw>(sql`
    select t.id, t.txn_no, t.type, t.txn_date::text as txn_date, ta.name as account_name, p.name as party_name,
           t.currency_code, ${gain} as gain, ${loss} as loss
    from treasury_transactions t
    join treasury_accounts ta on ta.id = t.account_id
    left join parties p on p.id = t.party_id
    join journal_lines l on l.entry_id = t.journal_entry_id
      and l.account_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    where t.status = 'posted' and t.txn_date between ${q.from}::date and ${q.to}::date
    group by t.id, ta.name, p.name
    order by t.txn_date, t.txn_no`);

  let g = dec(0);
  let l = dec(0);
  const rows: FxDifferenceRow[] = result.rows.map((r) => {
    g = g.plus(r.gain);
    l = l.plus(r.loss);
    return {
      transactionId: r.id,
      txnNo: r.txn_no,
      type: r.type,
      txnDate: r.txn_date,
      accountName: r.account_name,
      partyName: r.party_name,
      currencyCode: r.currency_code,
      gain: toDbAmount(r.gain),
      loss: toDbAmount(r.loss),
      net: toDbAmount(dec(r.gain).minus(r.loss)),
    };
  });
  return { from: q.from, to: q.to, rows, totals: { gain: toDbAmount(g), loss: toDbAmount(l), net: toDbAmount(g.minus(l)) } };
}
