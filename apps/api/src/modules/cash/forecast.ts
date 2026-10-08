import { eq, sql } from 'drizzle-orm';
import { applyRate, dec, toDbAmount, todayIso, estimatePaymentDelay, type CashForecastQuery, type CreateCashForecastItemInput, type MoneyValue, type UpdateCashForecastItemInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { cashForecastItems } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import type { LedgerCtx } from '../ledger/journal';
import { allOpenItems } from '../parties/service';
import { findRate } from '../settings/rates';
import { treasurySummary } from '../treasury/accounts';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export interface ForecastItem {
  date: string;
  week: number | null;
  source: 'receivable' | 'payable' | 'manual';
  direction: 'in' | 'out';
  description: string;
  partyName: string | null;
  currencyCode: string;
  /** Kalem para biriminde kalan tutar ve defter para birimi karşılığı (bugünkü kurla). */
  amount: string;
  amountBase: string;
  overdue: boolean;
  itemId?: string;
  /** Çek/senet portföyünden gelen kalem (vade = belge vadesi). */
  cheque?: boolean;
  dueDate?: string;
  timingSource?: 'due' | 'payment_history' | 'conservative_history' | 'manual' | 'cheque';
  sampleCount?: number;
  delayDays?: number;
  confidence?: 'low' | 'medium' | 'high';
}

/**
 * 13 haftalık (ya da `weeks`) nakit projeksiyonu, mevcut verilerden türetilir:
 * giriş = açık alacak kalemleri (vadelerine göre) + elle girişler; çıkış = açık borç kalemleri (tedarikçi faturaları,
 * onaylı hakedişler) + elle çıkışlar. Vadesi geçmiş kalemler 1. haftaya alınır (`overdue`). Açılış = kasa/banka bakiyelerinin
 * defter karşılığı. Dövizli kalemler bugünkü kurla çevrilir (kur yoksa defter tutarı kullanılır ve sayılır).
 */
export async function cashForecast(tx: Tx, ctx: LedgerCtx, q: CashForecastQuery) {
  const today = todayIso();
  const from = q.from ?? today;
  const weeks = q.weeks;
  const horizonEnd = addDays(from, weeks * 7 - 1);
  const base = ctx.baseCurrency;
  const timing = q.timing ?? 'due';
  const history = timing === 'due' ? [] : (await tx.execute<{party_id:string; control:string; due_date:string; paid_date:string}>(sql`
    select p.party_id,p.control,c.id,c.due_date::text as due_date,max(se.entry_date)::text as paid_date
    from party_allocations p
    join treasury_transactions t on t.id=p.transaction_id and t.company_id=p.company_id and t.status='posted'
    join journal_lines c on c.id=p.charge_line_id and c.company_id=p.company_id
    join journal_entries ce on ce.id=c.entry_id and ce.company_id=p.company_id and ce.status='posted' and ce.reversed_by_id is null
    join journal_lines s on s.id=p.settle_line_id and s.company_id=p.company_id
    join journal_entries se on se.id=s.entry_id and se.company_id=p.company_id and se.status='posted' and se.reversed_by_id is null
    where c.due_date is not null and ce.entry_date<=${today}::date and se.entry_date<=${today}::date
    group by p.party_id,p.control,c.id,c.due_date,c.debit_base,c.credit_base
    having sum(p.amount_base)>=abs(c.debit_base-c.credit_base)-0.01 and max(se.entry_date)>=${today}::date-180
  `)).rows;
  const timingCache = new Map<string,ReturnType<typeof estimatePaymentDelay>>();

  const rates = new Map<string, MoneyValue | null>();
  let missing = 0;
  const toBase = async (amount: MoneyValue, cur: string, fallbackBase?: MoneyValue): Promise<MoneyValue> => {
    if (cur === base) return amount;
    if (!rates.has(cur)) rates.set(cur, await findRate(tx, cur, base, today, base));
    const r = rates.get(cur);
    if (r) return applyRate(amount, r);
    missing++;
    return fallbackBase ?? dec(0);
  };

  const weekOf = (date: string) => {
    if (date < from) return 1;
    if (date > horizonEnd) return null;
    return Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 / 7) + 1;
  };

  const items: ForecastItem[] = [];
  for (const type of ['receivable', 'payable'] as const) {
    for (const it of await allOpenItems(tx, type, today)) {
      if (dec(it.remaining).lte(0)) continue;
      const due = it.dueDate;
      const projectOk = !q.projectId; // cari kalemleri projeye bağlı değildir; proje süzgeci yalnızca elle kalemlere uygulanır
      if (!projectOk) continue;
      const key = it.partyId + ':' + type;
      if (!timingCache.has(key)) timingCache.set(key, estimatePaymentDelay(history.filter(h=>h.party_id===it.partyId && h.control===type).map(h=>({dueDate:h.due_date,paidDate:h.paid_date})), timing==='conservative'?'conservative':'history', today));
      const learned = timingCache.get(key)!;
      const delay = (timing==='due' ? 0 : learned.delayDays) + (type==='receivable' ? q.collectionDelayDays ?? 0 : 0);
      const expected = addDays(due, delay);
      items.push({
        date: expected,
        dueDate: due,
        week: weekOf(expected),
        source: type,
        direction: type === 'receivable' ? 'in' : 'out',
        description: it.description,
        partyName: it.partyName,
        currencyCode: it.currencyCode,
        amount: dec(it.remaining).toFixed(2),
        amountBase: (await toBase(dec(it.remaining), it.currencyCode, dec(it.remainingBase))).toFixed(2),
        overdue: due < from,
        timingSource: timing!=='due' && learned.source==='payment_history' ? timing==='conservative'?'conservative_history':'payment_history' : 'due',
        sampleCount: learned.sampleCount,
        delayDays: delay,
        confidence: timing==='due' ? 'low' : learned.confidence,
      });
    }
  }
  // Çek/senet portföyü (Faz X1): portföyde/tahsildeki alınan belgeler beklenen giriş, ödenmemiş verilen belgeler beklenen çıkıştır.
  // Cari kalemleri kayıtta kapandığı için (B portföy / A 120) bu tutarlar başka türlü projeksiyonda görünmez. Yalnızca defter para birimi.
  if (!q.projectId) {
    const docs = await tx.execute<{ direction: string; doc_type: string; doc_no: string; due_date: string; amount: string;amount_base:string;currency_code:string; party_name: string }>(sql`
      select c.direction, c.doc_type, c.doc_no, c.due_date::text, c.amount::text,c.amount_base::text,c.currency_code, p.name as party_name
        from cheques c join parties p on p.id = c.party_id and p.company_id = c.company_id
       where ((c.direction = 'received' and c.status in ('portfolio','in_collection')) or (c.direction = 'issued' and c.status = 'issued'))
       order by c.due_date, c.doc_no`);
    for (const d of docs.rows) {
      const received = d.direction === 'received';
      items.push({
        date: d.due_date,
        week: weekOf(d.due_date),
        source: received ? 'receivable' : 'payable',
        direction: received ? 'in' : 'out',
        description: `${d.doc_type === 'cheque' ? 'Çek' : 'Senet'} ${d.doc_no}`,
        partyName: d.party_name,
        currencyCode: d.currency_code,
        amount: dec(d.amount).toFixed(2),
        amountBase: (await toBase(dec(d.amount),d.currency_code,dec(d.amount_base))).toFixed(2),
        overdue: d.due_date < from,
        cheque: true,
        timingSource: 'cheque',
        dueDate: d.due_date,
      });
    }
  }
  const manual = await tx.execute<{ id: string; item_date: string; direction: string; description: string; amount: string; currency_code: string }>(sql`
    select id, item_date::text, direction, description, amount::text, currency_code from cash_forecast_items
     where item_date <= ${horizonEnd}::date and (${q.projectId ?? null}::uuid is null or project_id = ${q.projectId ?? null}::uuid)
     order by item_date`);
  for (const m of manual.rows) {
    items.push({
      date: m.item_date,
      week: weekOf(m.item_date),
      source: 'manual',
      direction: m.direction as 'in' | 'out',
      description: m.description,
      partyName: null,
      currencyCode: m.currency_code,
      amount: dec(m.amount).toFixed(2),
      amountBase: (await toBase(dec(m.amount), m.currency_code)).toFixed(2),
      overdue: m.item_date < from,
      itemId: m.id,
      timingSource: 'manual',
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description, 'tr'));

  const summary = await treasurySummary(tx, ctx, today);
  const opening = dec(summary.equivalent);
  const buckets = Array.from({ length: weeks }, (_, i) => ({
    week: i + 1,
    start: addDays(from, i * 7),
    end: addDays(from, i * 7 + 6),
    receivables: dec(0),
    payables: dec(0),
    manualIn: dec(0),
    manualOut: dec(0),
  }));
  const later = { receivables: dec(0), payables: dec(0) };
  for (const it of items) {
    const amt = dec(it.amountBase);
    if (it.week === null) {
      if (it.source === 'receivable') later.receivables = later.receivables.plus(amt);
      else if (it.source === 'payable') later.payables = later.payables.plus(amt);
      continue;
    }
    const b = buckets[it.week - 1]!;
    if (it.source === 'receivable') b.receivables = b.receivables.plus(amt);
    else if (it.source === 'payable') b.payables = b.payables.plus(amt);
    else if (it.direction === 'in') b.manualIn = b.manualIn.plus(amt);
    else b.manualOut = b.manualOut.plus(amt);
  }
  let running = opening;
  const outBuckets = buckets.map((b) => {
    const inflow = b.receivables.plus(b.manualIn);
    const outflow = b.payables.plus(b.manualOut);
    const net = inflow.minus(outflow);
    running = running.plus(net);
    return {
      week: b.week,
      start: b.start,
      end: b.end,
      receivables: b.receivables.toFixed(2),
      manualIn: b.manualIn.toFixed(2),
      payables: b.payables.toFixed(2),
      manualOut: b.manualOut.toFixed(2),
      inflow: inflow.toFixed(2),
      outflow: outflow.toFixed(2),
      net: net.toFixed(2),
      closing: running.toFixed(2),
    };
  });
  const lowest = outBuckets.reduce((m, b) => (dec(b.closing).lt(m.value) ? { week: b.week, value: dec(b.closing) } : m), { week: 0, value: opening });
  return {
    from,
    weeks,
    baseCurrency: base,
    opening: opening.toFixed(2),
    openingApproximate: summary.approximate,
    buckets: outBuckets,
    later: { receivables: later.receivables.toFixed(2), payables: later.payables.toFixed(2) },
    lowest: { week: lowest.week, balance: lowest.value.toFixed(2) },
    items: items.filter((i) => i.week !== null),
    missingRate: missing,
    timing,
    collectionDelayDays: q.collectionDelayDays ?? 0,
    assumptions: { asOf: today, historyDays:180, minSamples:3, learnedItems:items.filter(i=>i.timingSource==='payment_history'||i.timingSource==='conservative_history').length, fallbackItems:items.filter(i=>i.timingSource==='due').length, overdueReceivables:items.filter(i=>i.source==='receivable' && i.overdue).reduce((s,i)=>s.plus(i.amountBase),dec(0)).toFixed(2) },
  };
}

// --- Elle girilen kalemler ----------------------------------------------------------------------

export async function listForecastItems(tx: Tx) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select i.id, i.item_date::text as "itemDate", i.direction, i.description, i.amount::text as amount, i.currency_code as "currencyCode",
           i.project_id as "projectId", p.code as "projectCode"
      from cash_forecast_items i left join projects p on p.id = i.project_id
     order by i.item_date, i.created_at`);
  return { items: rows.rows };
}

async function requireProject(tx: Tx, projectId: string | null | undefined) {
  if (!projectId) return;
  const r = await tx.execute(sql`select 1 from projects where id = ${projectId}`);
  if (r.rows.length === 0) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
}

export async function createForecastItem(tx: Tx, ctx: { companyId: string; userId: string }, input: CreateCashForecastItemInput) {
  await requireProject(tx, input.projectId);
  const [row] = await tx
    .insert(cashForecastItems)
    .values({ companyId: ctx.companyId, itemDate: input.itemDate, direction: input.direction, description: input.description, amount: toDbAmount(dec(input.amount)), currencyCode: input.currencyCode, projectId: input.projectId ?? null, createdBy: ctx.userId })
    .returning({ id: cashForecastItems.id });
  return { id: row!.id };
}

export async function updateForecastItem(tx: Tx, id: string, input: UpdateCashForecastItemInput) {
  await requireProject(tx, input.projectId);
  const rows = await tx
    .update(cashForecastItems)
    .set({ itemDate: input.itemDate, direction: input.direction, description: input.description, amount: toDbAmount(dec(input.amount)), currencyCode: input.currencyCode, projectId: input.projectId ?? null })
    .where(eq(cashForecastItems.id, id))
    .returning({ id: cashForecastItems.id });
  if (rows.length === 0) throw notFound('Nakit projeksiyonu kalemi');
  return { id };
}

export async function deleteForecastItem(tx: Tx, id: string) {
  const rows = await tx.delete(cashForecastItems).where(eq(cashForecastItems.id, id)).returning({ id: cashForecastItems.id });
  if (rows.length === 0) throw notFound('Nakit projeksiyonu kalemi');
}
