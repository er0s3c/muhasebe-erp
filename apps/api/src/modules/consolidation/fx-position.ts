import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { computeFxPosition, dec, parseRateList, roundMoney, toDbAmount, type FxPositionItem, type FxPositionQuery, type FxPositionRow } from '@erp/shared';
import type { Tx } from '../../db/client';
import type { AuthCtx } from '../../http/context';
import { allOpenItemsAndAdvances } from '../parties/service';
import { findRate } from '../settings/rates';
import { fxDifferences } from '../treasury/fx-report';
import { forEachScope, resolveGroupAccess, type ExcludedMember } from './access';
import { NOT_VERIFIED_NOTE } from './report';

export interface FxScope {
  companyId: string;
  name: string;
  baseCurrency: string;
}

export interface CashLine {
  accountName: string;
  kind: string;
  currency: string;
  /** Kendi para biriminde bakiye. */
  balance: string;
  /** Defterdeki (tarihsel) karşılık. */
  book: string;
}

export interface CompanyFxPosition {
  company: { id: string; name: string; baseCurrency: string };
  asOf: string;
  rateDate: string;
  rows: FxPositionRow[];
  totals: { equivalent: string; unrealized: string } | null;
  cashLines: CashLine[];
  /** Yıl başından `asOf`a GERÇEKLEŞMİŞ kur farkı (kambiyo raporu: 646/656); bilgi. */
  realized: { from: string; to: string; gain: string; loss: string; net: string };
  /** Grup para birimi karşılıkları (yalnızca grup çalıştırmasında). */
  groupConversion?: { currency: string; rates: Record<string, string | null>; baseToGroup: string | null };
  note: string;
}

const yearStart = (iso: string) => `${iso.slice(0, 4)}-01-01`;

/** Şirket (tek bağlam) döviz pozisyonu: kasa/banka + açık alacak − açık borç, yabancı para başına. Yalnızca rapor; yevmiye yazılmaz. */
export async function companyFxPosition(tx: Tx, scope: FxScope, q: FxPositionQuery & { groupCurrency?: string; groupRates?: string }): Promise<CompanyFxPosition> {
  const base = scope.baseCurrency;
  const rateDate = q.rateDate ?? q.asOf;
  const items: FxPositionItem[] = [];
  const cashLines: CashLine[] = [];

  const cash = await tx.execute<{ name: string; kind: string; currency_code: string; doc: string; base: string }>(sql`
    select ta.name, ta.kind, ta.currency_code,
           coalesce(sum(l.debit - l.credit), 0) as doc, coalesce(sum(l.debit_base - l.credit_base), 0) as base
      from treasury_accounts ta
      left join journal_lines l on l.account_id = ta.account_id
      left join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${q.asOf}::date
     where ta.currency_code <> ${base} and (l.id is null or e.id is not null)
     group by ta.id order by ta.kind, ta.name`);
  for (const r of cash.rows) {
    if (dec(r.doc).isZero() && dec(r.base).isZero()) continue;
    items.push({ currency: r.currency_code, kind: 'cash', amount: r.doc, book: r.base });
    cashLines.push({ accountName: r.name, kind: r.kind, currency: r.currency_code, balance: toDbAmount(r.doc), book: toDbAmount(r.base) });
  }

  for (const [type, kind] of [['receivable', 'receivable'], ['payable', 'payable']] as const) {
    const open = await allOpenItemsAndAdvances(tx, type, q.asOf);
    for (const it of open.items) {
      if (it.currencyCode === base) continue;
      items.push({ currency: it.currencyCode, kind, amount: it.remaining, book: it.remainingBase });
    }
    // Uygulanamayan döviz tahsilat/ödemesi (alınan/verilen avans, fazla ödeme) ters yönlü pozisyondur:
    // müşteriden alınan USD avans USD borçtur (alacağı azaltır), tedarikçiye verilen USD avans USD alacaktır (borcu azaltır).
    for (const a of open.advances) {
      if (a.currencyCode === base) continue;
      items.push({ currency: a.currencyCode, kind, amount: dec(a.amount).neg().toFixed(2), book: dec(a.amountBase).neg().toFixed(2) });
    }
  }

  const manual = parseRateList(q.rates);
  const rates = new Map<string, string | null>();
  for (const cur of new Set(items.map((i) => i.currency))) {
    if (!q.groupCurrency && manual.has(cur)) rates.set(cur, manual.get(cur)!);
    else rates.set(cur, (await findRate(tx, cur, base, rateDate, base))?.toFixed(8) ?? null);
  }
  const pos = computeFxPosition(items, rates);

  const rl = await fxDifferences(tx, { from: yearStart(q.asOf), to: q.asOf });
  const out: CompanyFxPosition = {
    company: { id: scope.companyId, name: scope.name, baseCurrency: base },
    asOf: q.asOf,
    rateDate,
    rows: pos.rows,
    totals: pos.totals,
    cashLines,
    realized: { from: rl.from, to: rl.to, gain: rl.totals.gain, loss: rl.totals.loss, net: rl.totals.net },
    note: 'Gerçekleşmemiş kur farkı yalnızca TAHMİNDİR (net pozisyon × seçilen kur − defter karşılığı); yevmiye yazılmaz. Dönem sonu değerleme yöntemi doğrulanmadı (M7b, LEGAL-NOTES §22).',
  };

  if (q.groupCurrency) {
    const gm = parseRateList(q.groupRates);
    const g = q.groupCurrency;
    const conv: Record<string, string | null> = {};
    for (const cur of pos.rows.map((r) => r.currency)) {
      if (cur === g) conv[cur] = '1';
      else conv[cur] = gm.get(cur) ?? (await findRate(tx, cur, g, rateDate, base))?.toFixed(8) ?? null;
    }
    const b2g = base === g ? '1' : (await findRate(tx, base, g, rateDate, base))?.toFixed(8) ?? null;
    out.groupConversion = { currency: g, rates: conv, baseToGroup: b2g };
  }
  return out;
}

export interface GroupFxRow {
  currency: string;
  cash: string;
  receivables: string;
  payables: string;
  net: string;
  /** Grup para birimi karşılığı (her şirketin kendi kayıtlı kuruyla / elle kurla); eksik kur varsa null. */
  equivalent: string | null;
  /** Şirketlerin gerçekleşmemiş kur farkı tahminlerinin grup para birimine çevrilmiş toplamı; eksikse null. */
  unrealized: string | null;
  companies: number;
}

export interface GroupFxPosition {
  group: { id: string; name: string; reportingCurrency: string };
  asOf: string;
  rateDate: string;
  rows: GroupFxRow[];
  totals: { equivalent: string; unrealized: string } | null;
  perCompany: CompanyFxPosition[];
  excluded: ExcludedMember[];
  complete: boolean;
  note: string;
}

export async function groupFxPosition(app: FastifyInstance, ctx: AuthCtx, groupId: string, q: FxPositionQuery): Promise<GroupFxPosition> {
  const access = await resolveGroupAccess(app, ctx, groupId);
  const g = access.group.reportingCurrency;
  const per = (
    await forEachScope(ctx.tx, access, (scope) => companyFxPosition(ctx.tx, scope, { ...q, groupCurrency: g, groupRates: q.rates, rates: undefined }))
  ).map((r) => r.value);

  type Acc = { cash: ReturnType<typeof dec>; rec: ReturnType<typeof dec>; pay: ReturnType<typeof dec>; net: ReturnType<typeof dec>; eq: ReturnType<typeof dec> | null; un: ReturnType<typeof dec> | null; n: number };
  const acc = new Map<string, Acc>();
  for (const c of per) {
    for (const r of c.rows) {
      const a = acc.get(r.currency) ?? { cash: dec(0), rec: dec(0), pay: dec(0), net: dec(0), eq: dec(0), un: dec(0), n: 0 };
      a.cash = a.cash.plus(r.cash);
      a.rec = a.rec.plus(r.receivables);
      a.pay = a.pay.plus(r.payables);
      a.net = a.net.plus(r.net);
      a.n += 1;
      const cr = c.groupConversion!.rates[r.currency] ?? null;
      const b2g = c.groupConversion!.baseToGroup;
      a.eq = a.eq !== null && cr ? a.eq.plus(roundMoney(dec(r.net).times(cr))) : null;
      a.un = a.un !== null && r.unrealized !== null && b2g ? a.un.plus(roundMoney(dec(r.unrealized).times(b2g))) : null;
      acc.set(r.currency, a);
    }
  }
  const rows: GroupFxRow[] = [...acc].sort((x, y) => x[0].localeCompare(y[0])).map(([currency, a]) => ({
    currency,
    cash: toDbAmount(a.cash),
    receivables: toDbAmount(a.rec),
    payables: toDbAmount(a.pay),
    net: toDbAmount(a.net),
    equivalent: a.eq ? toDbAmount(a.eq) : null,
    unrealized: a.un ? toDbAmount(a.un) : null,
    companies: a.n,
  }));
  const complete = rows.every((r) => r.equivalent !== null && r.unrealized !== null);
  const totals = rows.length && complete
    ? { equivalent: toDbAmount(rows.reduce((s, r) => s.plus(r.equivalent!), dec(0))), unrealized: toDbAmount(rows.reduce((s, r) => s.plus(r.unrealized!), dec(0))) }
    : null;
  return {
    group: { id: access.group.id, name: access.group.name, reportingCurrency: g },
    asOf: q.asOf,
    rateDate: q.rateDate ?? q.asOf,
    rows,
    totals,
    perCompany: per,
    excluded: access.excluded,
    complete: access.excluded.length === 0,
    note: `Her şirketin yabancı para pozisyonu kendi defter para birimine göredir (şirketin kendi para birimi pozisyon sayılmaz). ${NOT_VERIFIED_NOTE}`,
  };
}
