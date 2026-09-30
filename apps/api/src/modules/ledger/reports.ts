import { sql } from 'drizzle-orm';
import { dec, sum, toDbAmount, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { notFound, unprocessable } from '../../http/errors';
import { assertReportSize, maxReportRows } from '../../http/limits';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  parentId: string | null;
  isPostable: boolean;
  /** Dönem başı net bakiye (borç − alacak); pozitif = borç bakiyesi. */
  opening: string;
  debit: string;
  credit: string;
  /** Dönem sonu net bakiye (borç − alacak). */
  closing: string;
}

export interface TrialBalance {
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string; difference: string };
  /** Raporlama para biriminde tutarı eksik satır sayısı; > 0 ise sonuç güvenilmez. */
  missingReportingLines: number;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_postable: boolean;
  opening_d: string;
  opening_c: string;
  period_d: string;
  period_c: string;
}

export async function trialBalance(
  tx: Tx,
  q: {
    from: string;
    to: string;
    currency: 'base' | 'reporting';
    baseCurrency: string;
    reportingCurrency: string | null;
  },
): Promise<TrialBalance> {
  if (q.currency === 'reporting' && !q.reportingCurrency) {
    throw unprocessable('Şirkette raporlama para birimi tanımlı değil', 'REPORTING_CURRENCY_NOT_SET');
  }
  const d = q.currency === 'base' ? sql.raw('l.debit_base') : sql.raw('l.debit_reporting');
  const c = q.currency === 'base' ? sql.raw('l.credit_base') : sql.raw('l.credit_reporting');

  const result = await tx.execute<RawRow>(sql`
    select a.id, a.code, a.name, a.parent_id, a.is_postable,
      coalesce(sum(${d}) filter (where e.entry_date <  ${q.from}::date), 0) as opening_d,
      coalesce(sum(${c}) filter (where e.entry_date <  ${q.from}::date), 0) as opening_c,
      coalesce(sum(${d}) filter (where e.entry_date >= ${q.from}::date), 0) as period_d,
      coalesce(sum(${c}) filter (where e.entry_date >= ${q.from}::date), 0) as period_c
    from accounts a
    left join journal_lines l on l.account_id = a.id
    left join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${q.to}::date
    where l.id is null or e.id is not null
    group by a.id
    order by a.code`);

  const missing =
    q.currency === 'reporting'
      ? await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from journal_lines l
          join journal_entries e on e.id = l.entry_id
          where e.status = 'posted' and e.entry_date <= ${q.to}::date and l.debit_reporting is null`)
      : null;

  // Kendi hareketi olan satırlar (yaprak) ve dönem başı bakiyeleri
  const own = new Map<string, { od: MoneyValue; oc: MoneyValue; pd: MoneyValue; pc: MoneyValue }>();
  const accounts = result.rows;
  for (const r of accounts) {
    own.set(r.id, { od: dec(r.opening_d), oc: dec(r.opening_c), pd: dec(r.period_d), pc: dec(r.period_c) });
  }

  // Alt hesap tutarlarını üst gruplara topla
  const byId = new Map(accounts.map((r) => [r.id, r]));
  const rolled = new Map<string, { od: MoneyValue; oc: MoneyValue; pd: MoneyValue; pc: MoneyValue }>();
  for (const r of accounts) {
    const v = own.get(r.id)!;
    let cur: RawRow | undefined = r;
    while (cur) {
      const agg = rolled.get(cur.id) ?? { od: dec(0), oc: dec(0), pd: dec(0), pc: dec(0) };
      agg.od = agg.od.plus(v.od);
      agg.oc = agg.oc.plus(v.oc);
      agg.pd = agg.pd.plus(v.pd);
      agg.pc = agg.pc.plus(v.pc);
      rolled.set(cur.id, agg);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }

  const rows: TrialBalanceRow[] = [];
  for (const r of accounts) {
    const v = rolled.get(r.id)!;
    const hasActivity = !v.od.isZero() || !v.oc.isZero() || !v.pd.isZero() || !v.pc.isZero();
    if (!hasActivity) continue;
    const opening = v.od.minus(v.oc);
    rows.push({
      accountId: r.id,
      code: r.code,
      name: r.name,
      parentId: r.parent_id,
      isPostable: r.is_postable,
      opening: toDbAmount(opening),
      debit: toDbAmount(v.pd),
      credit: toDbAmount(v.pc),
      closing: toDbAmount(opening.plus(v.pd).minus(v.pc)),
    });
  }

  // Genel toplam yalnızca kendi hareketi olan hesaplardan (çift saymamak için)
  const totalDebit = sum([...own.values()].map((v) => v.pd));
  const totalCredit = sum([...own.values()].map((v) => v.pc));
  const openingDiff = sum([...own.values()].map((v) => v.od.minus(v.oc)));

  return {
    from: q.from,
    to: q.to,
    currency: q.currency === 'base' ? q.baseCurrency : (q.reportingCurrency as string),
    rows,
    totals: {
      debit: toDbAmount(totalDebit),
      credit: toDbAmount(totalCredit),
      // Defter dengeli olduğundan dönem başı ve dönem hareketi farkı sıfır olmalı (raporlama
      // para biriminde yuvarlama nedeniyle küçük fark çıkabilir).
      difference: toDbAmount(totalDebit.minus(totalCredit).plus(openingDiff)),
    },
    missingReportingLines: missing?.rows[0]?.n ?? 0,
  };
}

export interface AccountLedgerLine {
  entryId: string;
  entryNo: string;
  entryDate: string;
  accountCode: string;
  description: string;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  /** Yürüyen bakiye, defter para biriminde (borç − alacak). */
  balance: string;
}

export interface AccountLedger {
  account: { id: string; code: string; name: string };
  from: string;
  to: string;
  opening: string;
  lines: AccountLedgerLine[];
  totals: { debitBase: string; creditBase: string };
  closing: string;
}

/** Hesap ekstresi (muavin). Üst hesap seçilirse alt hesapların hareketleri de gelir. */
export async function accountLedger(
  tx: Tx,
  q: { accountId: string; from: string; to: string },
): Promise<AccountLedger> {
  const acc = await tx.execute<{ id: string; code: string; name: string }>(
    sql`select id, code, name from accounts where id = ${q.accountId}`,
  );
  const account = acc.rows[0];
  if (!account) throw notFound('Hesap');

  const opening = await tx.execute<{ d: string; c: string }>(sql`
    with recursive tree as (
      select id from accounts where id = ${q.accountId}
      union all
      select a.id from accounts a join tree t on a.parent_id = t.id
    )
    select coalesce(sum(l.debit_base), 0) as d, coalesce(sum(l.credit_base), 0) as c
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    where e.status = 'posted' and e.entry_date < ${q.from}::date
      and l.account_id in (select id from tree)`);

  const lines = await tx.execute<{
    entry_id: string;
    entry_no: string;
    entry_date: string;
    code: string;
    description: string;
    currency_code: string;
    fx_rate: string;
    debit: string;
    credit: string;
    debit_base: string;
    credit_base: string;
  }>(sql`
    with recursive tree as (
      select id from accounts where id = ${q.accountId}
      union all
      select a.id from accounts a join tree t on a.parent_id = t.id
    )
    select e.id as entry_id, e.entry_no, e.entry_date::text as entry_date, a.code,
      coalesce(l.description, e.description) as description,
      l.currency_code, l.fx_rate, l.debit, l.credit, l.debit_base, l.credit_base
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id
    where e.status = 'posted' and e.entry_date between ${q.from}::date and ${q.to}::date
      and l.account_id in (select id from tree)
    order by e.entry_date, e.entry_no, l.line_no
    limit ${maxReportRows() + 1}`);
  assertReportSize(lines.rows.length);

  const openingNet = dec(opening.rows[0]?.d ?? 0).minus(opening.rows[0]?.c ?? 0);
  let running = openingNet;
  let totalD = dec(0);
  let totalC = dec(0);
  const out: AccountLedgerLine[] = lines.rows.map((r) => {
    running = running.plus(r.debit_base).minus(r.credit_base);
    totalD = totalD.plus(r.debit_base);
    totalC = totalC.plus(r.credit_base);
    return {
      entryId: r.entry_id,
      entryNo: r.entry_no,
      entryDate: r.entry_date,
      accountCode: r.code,
      description: r.description,
      currencyCode: r.currency_code,
      fxRate: r.fx_rate,
      debit: r.debit,
      credit: r.credit,
      debitBase: r.debit_base,
      creditBase: r.credit_base,
      balance: toDbAmount(running),
    };
  });

  return {
    account,
    from: q.from,
    to: q.to,
    opening: toDbAmount(openingNet),
    lines: out,
    totals: { debitBase: toDbAmount(totalD), creditBase: toDbAmount(totalC) },
    closing: toDbAmount(running),
  };
}
