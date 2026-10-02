import { sql } from 'drizzle-orm';
import { MATURITY_BUCKETS, dec, maturityBucket, todayIso, type ChequeDueQuery, type ChequeMaturityQuery, type MaturityBucket, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { OPEN_SQL, type ChequeView } from './service';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Row = { direction: 'received' | 'issued'; docType: string; partyId: string; partyName: string; dueDate: string; amount: string };

/**
 * Vade analizi: açık belgeler (portföyde/tahsilde olan alınan, ödenmemiş verilen) vade kovalarına ve cariye göre.
 * Alınan = beklenen tahsilat, verilen = beklenen ödeme. Tutarlar defter para birimindedir (belgeler yalnızca defter para biriminde).
 */
export async function chequeMaturity(tx: Tx, q: ChequeMaturityQuery) {
  const asOf = q.asOf ?? todayIso();
  const res = await tx.execute<Row>(sql`
    select c.direction, c.doc_type as "docType", c.party_id as "partyId", p.name as "partyName", c.due_date::text as "dueDate", c.amount::text as amount
      from cheques c join parties p on p.id = c.party_id and p.company_id = c.company_id
     where ${OPEN_SQL} ${q.direction ? sql`and c.direction = ${q.direction}` : sql``}
     order by c.due_date`);
  const empty = () => Object.fromEntries(MATURITY_BUCKETS.map((b) => [b, { count: 0, amount: dec(0) }])) as Record<MaturityBucket, { count: number; amount: MoneyValue }>;
  const dirs = { received: { count: 0, amount: dec(0), buckets: empty() }, issued: { count: 0, amount: dec(0), buckets: empty() } };
  const parties = new Map<string, { direction: string; partyId: string; partyName: string; count: number; amount: MoneyValue; overdue: MoneyValue; earliestDue: string }>();
  for (const r of res.rows) {
    const a = dec(r.amount);
    const d = dirs[r.direction];
    const b = maturityBucket(r.dueDate, asOf);
    d.count += 1;
    d.amount = d.amount.plus(a);
    d.buckets[b].count += 1;
    d.buckets[b].amount = d.buckets[b].amount.plus(a);
    const key = `${r.direction}:${r.partyId}`;
    const p = parties.get(key) ?? { direction: r.direction, partyId: r.partyId, partyName: r.partyName, count: 0, amount: dec(0), overdue: dec(0), earliestDue: r.dueDate };
    p.count += 1;
    p.amount = p.amount.plus(a);
    if (b === 'overdue') p.overdue = p.overdue.plus(a);
    if (r.dueDate < p.earliestDue) p.earliestDue = r.dueDate;
    parties.set(key, p);
  }
  const fmt = (x: { count: number; amount: MoneyValue; buckets: Record<MaturityBucket, { count: number; amount: MoneyValue }> }) => ({
    count: x.count,
    amount: x.amount.toFixed(2),
    buckets: MATURITY_BUCKETS.map((k) => ({ bucket: k, count: x.buckets[k].count, amount: x.buckets[k].amount.toFixed(2) })),
  });
  return {
    asOf,
    received: fmt(dirs.received),
    issued: fmt(dirs.issued),
    byParty: [...parties.values()]
      .sort((a, b) => a.direction.localeCompare(b.direction) || a.partyName.localeCompare(b.partyName, 'tr'))
      .map((p) => ({ ...p, amount: p.amount.toFixed(2), overdue: p.overdue.toFixed(2) })),
  };
}

/** Bu hafta (ya da N gün içinde) vadesi gelen açık belgeler; vadesi geçmişler de listelenir ve işaretlenir. */
export async function chequesDue(tx: Tx, q: ChequeDueQuery) {
  const today = todayIso();
  const to = addDays(today, q.days);
  const res = await tx.execute<Row & { id: string; docNo: string; bankName: string; status: string }>(sql`
    select c.id, c.direction, c.doc_type as "docType", c.doc_no as "docNo", c.bank_name as "bankName", c.status, c.party_id as "partyId", p.name as "partyName",
           c.due_date::text as "dueDate", c.amount::text as amount
      from cheques c join parties p on p.id = c.party_id and p.company_id = c.company_id
     where ${OPEN_SQL} and c.due_date <= ${to}::date ${q.direction ? sql`and c.direction = ${q.direction}` : sql``}
     order by c.due_date, c.doc_no`);
  const totals = { received: dec(0), issued: dec(0) };
  const rows = res.rows.map((r) => {
    totals[r.direction] = totals[r.direction].plus(r.amount);
    return { ...r, overdue: r.dueDate < today };
  });
  return { from: today, to, days: q.days, rows, totals: { received: totals.received.toFixed(2), issued: totals.issued.toFixed(2) } };
}

/** Karşılıksız (bounced) belgeler: karşılıksız tarihi, geçen gün ve cariye yeniden açılan tutar. */
export async function chequesBounced(tx: Tx, q: { direction?: 'received' | 'issued' }) {
  const today = todayIso();
  const res = await tx.execute<ChequeView & { bouncedDate: string | null }>(sql`
    select c.id, c.direction, c.doc_type as "docType", c.doc_no as "docNo", c.bank_name as "bankName", c.party_id as "partyId", p.name as "partyName",
           c.amount::text as amount, c.due_date::text as "dueDate", c.status,
           (select max(e.event_date)::text from cheque_events e where e.cheque_id = c.id and e.to_status = 'bounced') as "bouncedDate"
      from cheques c join parties p on p.id = c.party_id and p.company_id = c.company_id
     where c.status = 'bounced' ${q.direction ? sql`and c.direction = ${q.direction}` : sql``}
     order by "bouncedDate" desc, c.doc_no`);
  const total = { received: dec(0), issued: dec(0) };
  const rows = res.rows.map((r) => {
    total[r.direction] = total[r.direction].plus(r.amount);
    const days = r.bouncedDate ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.bouncedDate}T00:00:00Z`)) / 86_400_000) : null;
    return { ...r, daysSince: days };
  });
  return { asOf: today, rows, totals: { received: total.received.toFixed(2), issued: total.issued.toFixed(2) } };
}
