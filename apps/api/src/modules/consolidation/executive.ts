import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  comparePeriod,
  computeKpis,
  daysInclusive,
  dec,
  hasPermission,
  parseRateList,
  pctChange,
  roundMoney,
  summarizeIncome,
  toDbAmount,
  type ExecutiveSummaryQuery,
  type IncomeSummary,
  type Kpis,
  type MoneyValue,
  type Permission,
  type PermissionSet,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import type { AuthCtx } from '../../http/context';
import { unprocessable } from '../../http/errors';
import { salesReport } from '../invoices/analytics';
import { inventorySummary } from '../inventory/reports';
import { trialBalance } from '../ledger/reports';
import { partyAging } from '../parties/service';
import { projectProfitability } from '../projects/profitability';
import { findRate } from '../settings/rates';
import { forEachScope, resolveGroupAccess, type ExcludedMember } from './access';
import { NOT_VERIFIED_NOTE } from './report';

/** Bölümün bağlı olduğu modül ve izin: kullanıcı göremiyorsa bölüm hiç üretilmez (sıfırlanmaz, çıkarılır). */
const SECTION_RULES = {
  ledger: { module: 'core.ledger', permission: 'ledger.read' },
  cash: { module: 'core.treasury', permission: 'treasury.read' },
  parties: { module: 'core.parties', permission: 'parties.read' },
  stock: { module: 'core.inventory', permission: 'inventory.read' },
  sales: { module: 'core.invoices', permission: 'invoices.read' },
  projects: { module: 'construction.projects', permission: 'projects.read' },
  hr: { module: 'hr.core', permission: 'hr.read' },
  payroll: { module: 'hr.payroll', permission: 'hr.payroll' },
} as const satisfies Record<string, { module: string; permission: Permission }>;

export interface ExecScope {
  companyId: string;
  name: string;
  baseCurrency: string;
  reportingCurrency: string | null;
  permissions: PermissionSet;
  enabledModules: ReadonlySet<string>;
}

const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
type Buckets = Record<(typeof BUCKETS)[number], string>;

export interface AgingSection {
  total: string;
  overdue: string;
  buckets: Buckets;
  previousTotal: string | null;
}
export interface TopRow {
  name: string;
  net: string;
}
export interface ProjectsSection {
  count: number;
  contractedRevenue: string;
  eac: string;
  projectedProfit: string;
  marginPct: string | null;
  top: { name: string; projectedProfit: string; marginPct: string | null }[];
}
export interface HrSection {
  headcount: number;
  hires: number;
  leavers: number;
  /** Yalnızca `hr.payroll` iznine ve modülüne sahipse; toplam (kişi bazlı değil). */
  payroll?: { gross: string; employer: string; cost: string; months: number };
}

export interface ExecutiveSummary {
  scope: { kind: 'company' | 'group'; id: string; name: string; currency: string; companies?: number };
  period: { from: string; to: string };
  compare: { from: string; to: string } | null;
  income?: {
    current: IncomeSummary;
    previous: IncomeSummary | null;
    change: { revenue: string | null; expenses: string | null; profit: string | null } | null;
    currentAssets: string;
    shortLiabilities: string;
  };
  kpis?: { current: Kpis; previous: Kpis | null };
  cash?: { total: string; approximate: boolean; accounts: number; previousTotal: string | null; byCurrency: { currency: string; balance: string }[] };
  receivables?: AgingSection;
  payables?: AgingSection;
  stock?: { stockValue: string; itemCount: number; lowCount: number; previousValue: string | null };
  topCustomers?: TopRow[];
  topSuppliers?: TopRow[];
  projects?: ProjectsSection;
  hr?: HrSection;
  /** Grup çalıştırmasında bir bölüm yalnızca bazı şirketlerde varsa, bölümde kaç şirket olduğu. */
  sectionCompanies?: Record<string, number>;
  excluded?: ExcludedMember[];
  complete?: boolean;
  note: string;
}

const sum2 = (xs: Iterable<string>): MoneyValue => {
  let t = dec(0);
  for (const x of xs) t = t.plus(x);
  return t;
};

async function cashAsOf(tx: Tx, base: string, asOf: string) {
  const res = await tx.execute<{ currency_code: string; doc: string; book: string }>(sql`
    select ta.currency_code, coalesce(sum(l.debit - l.credit), 0) as doc, coalesce(sum(l.debit_base - l.credit_base), 0) as book
      from treasury_accounts ta
      left join journal_lines l on l.account_id = ta.account_id
      left join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${asOf}::date
     where ta.is_active and (l.id is null or e.id is not null)
     group by ta.id`);
  let total = dec(0);
  let approximate = false;
  const by = new Map<string, MoneyValue>();
  const rateCache = new Map<string, MoneyValue | null>();
  for (const r of res.rows) {
    by.set(r.currency_code, (by.get(r.currency_code) ?? dec(0)).plus(r.doc));
    if (r.currency_code === base) {
      total = total.plus(r.doc);
      continue;
    }
    if (!rateCache.has(r.currency_code)) rateCache.set(r.currency_code, await findRate(tx, r.currency_code, base, asOf, base));
    const rate = rateCache.get(r.currency_code);
    if (rate) total = total.plus(roundMoney(dec(r.doc).times(rate)));
    else {
      total = total.plus(r.book);
      approximate = true;
    }
  }
  return { total: toDbAmount(total), approximate, accounts: res.rows.length, byCurrency: [...by].map(([currency, balance]) => ({ currency, balance: toDbAmount(balance) })) };
}

async function agingSection(tx: Tx, type: 'receivable' | 'payable', asOf: string, prevAsOf: string | null): Promise<AgingSection> {
  const cur = (await partyAging(tx, { type, asOf })).totals;
  const prev = prevAsOf ? (await partyAging(tx, { type, asOf: prevAsOf })).totals.total : null;
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, toDbAmount(cur[b])])) as Buckets;
  return { total: toDbAmount(cur.total), overdue: toDbAmount(sum2([cur.d1_30, cur.d31_60, cur.d61_90, cur.d90plus])), buckets, previousTotal: prev === null ? null : toDbAmount(prev) };
}

async function incomeFor(tx: Tx, scope: ExecScope, from: string, to: string, includeClosing: boolean) {
  // Yıl sonu kapanış/devir fişleri varsayılan olarak hariç: gelir/gider kapanışla sıfırlanmış görünmesin
  const tb = await trialBalance(tx, { from, to, currency: 'base', baseCurrency: scope.baseCurrency, reportingCurrency: scope.reportingCurrency, excludeClosing: !includeClosing });
  const leaves = tb.rows.filter((r) => r.isPostable);
  const income = summarizeIncome(leaves);
  const closingNet = (prefix: string) => sum2(leaves.filter((r) => r.code.startsWith(prefix)).map((r) => r.closing));
  return { income, currentAssets: toDbAmount(closingNet('1')), shortLiabilities: toDbAmount(closingNet('3').neg()) };
}

/** Şirket yönetici özeti: her bölüm kendi modül + izniyle kapılıdır; kapalı/yetkisiz bölüm çıkarılır. Tutarlar şirketin defter para biriminde. */
export async function companyExecutive(tx: Tx, scope: ExecScope, q: ExecutiveSummaryQuery): Promise<ExecutiveSummary> {
  const can = (k: keyof typeof SECTION_RULES) => scope.enabledModules.has(SECTION_RULES[k].module) && hasPermission(scope.permissions, SECTION_RULES[k].permission);
  const cmp = comparePeriod(q.from, q.to, q.compare);
  const days = daysInclusive(q.from, q.to);
  const out: ExecutiveSummary = {
    scope: { kind: 'company', id: scope.companyId, name: scope.name, currency: scope.baseCurrency },
    period: { from: q.from, to: q.to },
    compare: cmp,
    note: 'KPI tanımları ekranda yazılıdır. Tutarlar şirketin defter para birimindedir. İç yönetim raporudur; yasal tablo değildir.',
  };

  let recTotals: AgingSection | undefined;
  if (can('ledger')) {
    const cur = await incomeFor(tx, scope, q.from, q.to, q.includeClosing);
    const prev = cmp ? await incomeFor(tx, scope, cmp.from, cmp.to, q.includeClosing) : null;
    out.income = {
      current: cur.income,
      previous: prev?.income ?? null,
      change: prev ? { revenue: pctChange(cur.income.revenue, prev.income.revenue), expenses: pctChange(cur.income.expenses, prev.income.expenses), profit: pctChange(cur.income.profit, prev.income.profit) } : null,
      currentAssets: cur.currentAssets,
      shortLiabilities: cur.shortLiabilities,
    };
  }
  if (can('parties')) {
    out.receivables = await agingSection(tx, 'receivable', q.to, cmp?.to ?? null);
    out.payables = await agingSection(tx, 'payable', q.to, cmp?.to ?? null);
    recTotals = out.receivables;
  }
  if (out.income) {
    const k = (i: IncomeSummary, assets: string | null, liab: string | null, rec: AgingSection | undefined): Kpis =>
      computeKpis({ netSales: i.netSales, costOfSales: i.costOfSales, profit: i.profit, currentAssets: assets, shortLiabilities: liab, receivablesTotal: rec?.total ?? null, receivablesOverdue: rec?.overdue ?? null, days });
    out.kpis = {
      current: k(out.income.current, out.income.currentAssets, out.income.shortLiabilities, recTotals),
      // Önceki dönem için bilanço/alacak oranları hesaplanmaz (yalnız gelir temelli KPI'lar)
      previous: out.income.previous ? k(out.income.previous, null, null, undefined) : null,
    };
  }
  if (can('cash')) {
    const c = await cashAsOf(tx, scope.baseCurrency, q.to);
    const p = cmp ? await cashAsOf(tx, scope.baseCurrency, cmp.to) : null;
    out.cash = { ...c, previousTotal: p?.total ?? null };
  }
  if (can('stock')) {
    const s = await inventorySummary(tx, q.to);
    const p = cmp ? await inventorySummary(tx, cmp.to) : null;
    out.stock = { stockValue: s.stockValue, itemCount: s.itemCount, lowCount: s.lowCount, previousValue: p?.stockValue ?? null };
  }
  if (can('sales')) {
    const top = async (side: 'sales' | 'purchases') =>
      (await salesReport(tx, side, { from: q.from, to: q.to, groupBy: 'party' })).rows.slice(0, 5).map((r) => ({ name: r.label, net: r.net }));
    out.topCustomers = await top('sales');
    out.topSuppliers = await top('purchases');
  }
  if (can('projects')) {
    const p = await projectProfitability(tx, q.to, scope.baseCurrency, scope.reportingCurrency);
    out.projects = {
      count: p.rows.length,
      contractedRevenue: p.totals.contractedRevenue,
      eac: p.totals.eac,
      projectedProfit: p.totals.projectedProfit,
      marginPct: p.totals.marginPct,
      top: [...p.rows].sort((a, b) => Number(b.projectedProfit) - Number(a.projectedProfit)).slice(0, 5).map((r) => ({ name: r.name, projectedProfit: r.projectedProfit, marginPct: r.marginPct })),
    };
  }
  if (can('hr')) {
    const h = await tx.execute<{ headcount: number; hires: number; leavers: number }>(sql`
      select count(*) filter (where (hire_date is null or hire_date <= ${q.to}::date) and (leave_date is null or leave_date > ${q.to}::date))::int as headcount,
             count(*) filter (where hire_date between ${q.from}::date and ${q.to}::date)::int as hires,
             count(*) filter (where leave_date between ${q.from}::date and ${q.to}::date)::int as leavers
        from employees`);
    out.hr = { headcount: h.rows[0]?.headcount ?? 0, hires: h.rows[0]?.hires ?? 0, leavers: h.rows[0]?.leavers ?? 0 };
    if (can('payroll')) {
      const p = await tx.execute<{ gross: string; employer: string; months: number }>(sql`
        select coalesce(sum(gross_total), 0)::text as gross, coalesce(sum(employer_total), 0)::text as employer, count(*)::int as months
          from payroll_runs where status in ('approved', 'paid') and month between ${q.from.slice(0, 7)} and ${q.to.slice(0, 7)}`);
      const r = p.rows[0]!;
      out.hr.payroll = { gross: toDbAmount(r.gross), employer: toDbAmount(r.employer), cost: toDbAmount(dec(r.gross).plus(r.employer)), months: r.months };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grup: şirket özetlerini grup para birimine çevir ve topla
// ---------------------------------------------------------------------------

const incomeKeys = ['netSales', 'costOfSales', 'grossProfit', 'operatingExpenses', 'otherIncome', 'otherExpenses', 'uncloseCosts', 'revenue', 'expenses', 'profit'] as const;

function scaleIncome(i: IncomeSummary, rate: string): IncomeSummary {
  const o = {} as Record<string, string>;
  for (const k of incomeKeys) o[k] = toDbAmount(roundMoney(dec(i[k]).times(rate)));
  return o as unknown as IncomeSummary;
}
function addIncome(a: IncomeSummary | null, b: IncomeSummary | null): IncomeSummary | null {
  if (!a) return b;
  if (!b) return a;
  const o = {} as Record<string, string>;
  for (const k of incomeKeys) o[k] = toDbAmount(dec(a[k]).plus(b[k]));
  return o as unknown as IncomeSummary;
}

/** Şirket özetini kurla (şirket defter para birimi -> grup) çevirir. */
export function scaleExecutive(d: ExecutiveSummary, rate: string): ExecutiveSummary {
  const m = (v: string) => toDbAmount(roundMoney(dec(v).times(rate)));
  const mn = (v: string | null) => (v === null ? null : m(v));
  const aging = (a: AgingSection): AgingSection => ({ total: m(a.total), overdue: m(a.overdue), buckets: Object.fromEntries(BUCKETS.map((b) => [b, m(a.buckets[b])])) as Buckets, previousTotal: mn(a.previousTotal) });
  const out: ExecutiveSummary = { ...d };
  if (d.income) out.income = { ...d.income, current: scaleIncome(d.income.current, rate), previous: d.income.previous ? scaleIncome(d.income.previous, rate) : null, currentAssets: m(d.income.currentAssets), shortLiabilities: m(d.income.shortLiabilities) };
  if (d.cash) out.cash = { ...d.cash, total: m(d.cash.total), previousTotal: mn(d.cash.previousTotal), byCurrency: [] };
  if (d.receivables) out.receivables = aging(d.receivables);
  if (d.payables) out.payables = aging(d.payables);
  if (d.stock) out.stock = { ...d.stock, stockValue: m(d.stock.stockValue), previousValue: mn(d.stock.previousValue) };
  if (d.topCustomers) out.topCustomers = d.topCustomers.map((r) => ({ ...r, net: m(r.net) }));
  if (d.topSuppliers) out.topSuppliers = d.topSuppliers.map((r) => ({ ...r, net: m(r.net) }));
  if (d.projects) out.projects = { ...d.projects, contractedRevenue: m(d.projects.contractedRevenue), eac: m(d.projects.eac), projectedProfit: m(d.projects.projectedProfit), top: d.projects.top.map((t) => ({ ...t, projectedProfit: m(t.projectedProfit) })) };
  if (d.hr?.payroll) out.hr = { ...d.hr, payroll: { ...d.hr.payroll, gross: m(d.hr.payroll.gross), employer: m(d.hr.payroll.employer), cost: m(d.hr.payroll.cost) } };
  return out;
}

const addAging = (a: AgingSection | undefined, b: AgingSection | undefined): AgingSection | undefined => {
  if (!a) return b;
  if (!b) return a;
  return {
    total: toDbAmount(dec(a.total).plus(b.total)),
    overdue: toDbAmount(dec(a.overdue).plus(b.overdue)),
    buckets: Object.fromEntries(BUCKETS.map((k) => [k, toDbAmount(dec(a.buckets[k]).plus(b.buckets[k]))])) as Buckets,
    previousTotal: a.previousTotal !== null && b.previousTotal !== null ? toDbAmount(dec(a.previousTotal).plus(b.previousTotal)) : null,
  };
};

/** Aynı para biriminde (grup) çevrilmiş şirket özetlerini toplar; kullanıcının görebildiği bölümler birleşir (sectionCompanies kaç şirketten geldiğini söyler). */
export function mergeExecutives(parts: ExecutiveSummary[], head: Pick<ExecutiveSummary, 'scope' | 'period' | 'compare'>, days: number): ExecutiveSummary {
  const out: ExecutiveSummary = { ...head, note: parts[0]?.note ?? '' };
  const cnt: Record<string, number> = {};
  const bump = (k: string) => (cnt[k] = (cnt[k] ?? 0) + 1);
  for (const p of parts) {
    if (p.income) {
      bump('income');
      out.income = out.income
        ? {
            current: addIncome(out.income.current, p.income.current)!,
            previous: out.income.previous && p.income.previous ? addIncome(out.income.previous, p.income.previous) : null,
            change: null,
            currentAssets: toDbAmount(dec(out.income.currentAssets).plus(p.income.currentAssets)),
            shortLiabilities: toDbAmount(dec(out.income.shortLiabilities).plus(p.income.shortLiabilities)),
          }
        : { ...p.income };
    }
    if (p.cash) {
      bump('cash');
      out.cash = out.cash
        ? { total: toDbAmount(dec(out.cash.total).plus(p.cash.total)), approximate: out.cash.approximate || p.cash.approximate, accounts: out.cash.accounts + p.cash.accounts, previousTotal: out.cash.previousTotal !== null && p.cash.previousTotal !== null ? toDbAmount(dec(out.cash.previousTotal).plus(p.cash.previousTotal)) : null, byCurrency: [] }
        : { ...p.cash };
    }
    if (p.receivables) bump('receivables');
    if (p.payables) bump('payables');
    out.receivables = addAging(out.receivables, p.receivables);
    out.payables = addAging(out.payables, p.payables);
    if (p.stock) {
      bump('stock');
      out.stock = out.stock
        ? { stockValue: toDbAmount(dec(out.stock.stockValue).plus(p.stock.stockValue)), itemCount: out.stock.itemCount + p.stock.itemCount, lowCount: out.stock.lowCount + p.stock.lowCount, previousValue: out.stock.previousValue !== null && p.stock.previousValue !== null ? toDbAmount(dec(out.stock.previousValue).plus(p.stock.previousValue)) : null }
        : { ...p.stock };
    }
    const topMerge = (a: TopRow[] | undefined, b: TopRow[] | undefined, label: string) => (b ? [...(a ?? []), ...b.map((r) => ({ name: `${r.name} (${label})`, net: r.net }))] : a);
    if (p.topCustomers) bump('topCustomers');
    if (p.topSuppliers) bump('topSuppliers');
    out.topCustomers = topMerge(out.topCustomers, p.topCustomers, p.scope.name);
    out.topSuppliers = topMerge(out.topSuppliers, p.topSuppliers, p.scope.name);
    if (p.projects) {
      bump('projects');
      const a = out.projects;
      const contracted = dec(a?.contractedRevenue ?? 0).plus(p.projects.contractedRevenue);
      const projected = dec(a?.projectedProfit ?? 0).plus(p.projects.projectedProfit);
      out.projects = {
        count: (a?.count ?? 0) + p.projects.count,
        contractedRevenue: toDbAmount(contracted),
        eac: toDbAmount(dec(a?.eac ?? 0).plus(p.projects.eac)),
        projectedProfit: toDbAmount(projected),
        marginPct: contracted.gt(0) ? projected.div(contracted).times(100).toFixed(1) : null,
        top: [...(a?.top ?? []), ...p.projects.top].sort((x, y) => Number(y.projectedProfit) - Number(x.projectedProfit)).slice(0, 5),
      };
    }
    if (p.hr) {
      bump('hr');
      const a = out.hr;
      out.hr = { headcount: (a?.headcount ?? 0) + p.hr.headcount, hires: (a?.hires ?? 0) + p.hr.hires, leavers: (a?.leavers ?? 0) + p.hr.leavers, ...(a?.payroll || p.hr.payroll ? { payroll: { gross: toDbAmount(dec(a?.payroll?.gross ?? 0).plus(p.hr.payroll?.gross ?? 0)), employer: toDbAmount(dec(a?.payroll?.employer ?? 0).plus(p.hr.payroll?.employer ?? 0)), cost: toDbAmount(dec(a?.payroll?.cost ?? 0).plus(p.hr.payroll?.cost ?? 0)), months: Math.max(a?.payroll?.months ?? 0, p.hr.payroll?.months ?? 0) } } : {}) };
    }
  }
  if (out.income) {
    out.income.change = out.income.previous
      ? { revenue: pctChange(out.income.current.revenue, out.income.previous.revenue), expenses: pctChange(out.income.current.expenses, out.income.previous.expenses), profit: pctChange(out.income.current.profit, out.income.previous.profit) }
      : null;
    out.topCustomers = out.topCustomers?.sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
    out.topSuppliers = out.topSuppliers?.sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
    const k = (i: IncomeSummary, assets: string | null, liab: string | null) =>
      computeKpis({ netSales: i.netSales, costOfSales: i.costOfSales, profit: i.profit, currentAssets: assets, shortLiabilities: liab, receivablesTotal: out.receivables?.total ?? null, receivablesOverdue: out.receivables?.overdue ?? null, days });
    out.kpis = { current: k(out.income.current, out.income.currentAssets, out.income.shortLiabilities), previous: out.income.previous ? k(out.income.previous, null, null) : null };
  } else {
    out.topCustomers = out.topCustomers?.sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
    out.topSuppliers = out.topSuppliers?.sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
  }
  out.sectionCompanies = cnt;
  return out;
}

export async function groupExecutive(app: FastifyInstance, ctx: AuthCtx, groupId: string, q: ExecutiveSummaryQuery): Promise<ExecutiveSummary> {
  const access = await resolveGroupAccess(app, ctx, groupId);
  const g = access.group.reportingCurrency;
  const manual = parseRateList(q.rates);
  const parts = await forEachScope(ctx.tx, access, async (scope) => {
    const summary = await companyExecutive(ctx.tx, scope, q);
    let rate: string;
    if (scope.baseCurrency === g) rate = '1';
    else {
      const m = manual.get(scope.baseCurrency);
      const r = m ?? (await findRate(ctx.tx, scope.baseCurrency, g, q.to, scope.baseCurrency))?.toFixed(8);
      if (!r) {
        throw unprocessable(`${scope.name}: ${scope.baseCurrency}/${g} kuru bulunamadı (${q.to}). Şirkette kur girin ya da elle kur verin.`, 'FX_RATE_MISSING', { companyId: scope.companyId });
      }
      rate = r;
    }
    return scaleExecutive(summary, rate);
  });
  const merged = mergeExecutives(
    parts.map((p) => p.value),
    { scope: { kind: 'group', id: access.group.id, name: access.group.name, currency: g, companies: parts.length }, period: { from: q.from, to: q.to }, compare: comparePeriod(q.from, q.to, q.compare) },
    daysInclusive(q.from, q.to),
  );
  merged.excluded = access.excluded;
  merged.complete = access.excluded.length === 0;
  merged.note = `Tutarlar grup para biriminde, her şirketin dönem sonu kuruyla (ya da elle kurla) tek kur üzerinden çevrilmiştir; şirketler arası işlemler ELENMEZ. ${NOT_VERIFIED_NOTE}`;
  return merged;
}
