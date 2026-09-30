import { sql } from 'drizzle-orm';
import {
  PROJECT_OPEN_STATUSES,
  PROJECT_REVENUE_PREFIXES,
  PROJECT_TAGGABLE_ACCOUNT_TYPES,
  combineMetrics,
  computeLeafMetrics,
  dec,
  roundMoney,
  type ProjectMetrics,
  type ProjectTransactionsQuery,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR } from '../../db/search';
import { currentBudget } from './budgets';
import { latestProgress } from './progress';
import { getProjectRow } from './service';
import { listWbs } from './wbs';

/** Hesap kodu ön eki regex'i: gelir tarafı (60, 61, 64); diğer tüm etiketli hesaplar maliyet tarafıdır. */
const REVENUE_RE = `^(${PROJECT_REVENUE_PREFIXES.join('|')})`;
const TAGGABLE_TYPES = sql.join(PROJECT_TAGGABLE_ACCOUNT_TYPES.map((t) => sql`${t}`), sql`, `);

export interface MetricsOut {
  budget: string;
  actual: string;
  remaining: string;
  spentPct: string | null;
  percent: string | null;
  earnedValue: string;
  hasProgress: boolean;
  etc: string;
  eac: string;
  variance: string;
  cpi: string | null;
}

export function serializeMetrics(m: ProjectMetrics): MetricsOut {
  return {
    budget: m.budget.toFixed(2),
    actual: m.actual.toFixed(2),
    remaining: m.remaining.toFixed(2),
    spentPct: m.spentPct ? m.spentPct.toFixed(2) : null,
    percent: m.percent ? m.percent.toFixed(2) : null,
    earnedValue: m.earnedValue.toFixed(2),
    hasProgress: m.hasProgress,
    etc: m.etc.toFixed(2),
    eac: m.eac.toFixed(2),
    variance: m.variance.toFixed(2),
    cpi: m.cpi ? m.cpi.toFixed(4) : null,
  };
}

interface ActualRow extends Record<string, unknown> {
  wbsId: string | null;
  cost: string;
  revenue: string;
}

/** İş kalemi bazında gerçekleşen: etiketli, kaydedilmiş satırlar; maliyet = net borç, gelir = net alacak (≤ asOf). */
async function loadActuals(tx: Tx, projectId: string, asOf: string) {
  const rows = await tx.execute<ActualRow>(sql`
    select jl.wbs_id as "wbsId",
           coalesce(sum(jl.debit_base - jl.credit_base) filter (where a.code !~ ${REVENUE_RE}), 0)::text as cost,
           coalesce(sum(jl.credit_base - jl.debit_base) filter (where a.code ~ ${REVENUE_RE}), 0)::text as revenue
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
     where jl.project_id = ${projectId} and je.status = 'posted' and je.entry_date <= ${asOf}::date
     group by jl.wbs_id`);
  return new Map(rows.rows.map((r) => [r.wbsId, { cost: dec(r.cost), revenue: dec(r.revenue) }]));
}

export interface CostReportRow extends MetricsOut {
  wbsId: string | null;
  parentId: string | null;
  code: string;
  name: string;
  depth: number;
  isLeaf: boolean;
  isActive: boolean;
  /** İş kalemi atanmamış maliyet satırı (bütçesi yok). */
  unassigned: boolean;
  /** Yaprakta: asOf tarihindeki geçerli ilerleme kaydı. */
  progress: { percent: string; etcOverride: string | null; asOfDate: string; note: string | null } | null;
  revenue: string;
}

/**
 * Proje maliyet raporu: iş kırılımı ağacı boyunca yürürlükteki bütçe, gerçekleşen, tamamlanma, ETC/EAC ve sapma.
 * Üst düğümler yaprakların toplamıdır. İş kalemi verilmemiş etiketli satırlar "atanmamış" satırında toplanır.
 */
export async function projectCostReport(tx: Tx, projectId: string, asOf: string) {
  const project = await getProjectRow(tx, projectId);
  const { wbs } = await listWbs(tx, projectId);
  const nodes = wbs as {
    id: string;
    parentId: string | null;
    code: string;
    name: string;
    depth: number;
    isLeaf: boolean;
    isActive: boolean;
  }[];

  const budget = await currentBudget(tx, projectId);
  const budgetByWbs = new Map<string, string>();
  if (budget) {
    const lines = await tx.execute<{ wbsId: string; amount: string }>(sql`
      select wbs_id as "wbsId", amount::text as amount from project_budget_lines where budget_id = ${budget.id}`);
    for (const l of lines.rows) budgetByWbs.set(l.wbsId, l.amount);
  }
  const progress = await latestProgress(tx, projectId, asOf);
  const actuals = await loadActuals(tx, projectId, asOf);

  const children = new Map<string | null, typeof nodes>();
  for (const n of nodes) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

  // Yapraklar, sonra (DFS sırasının tersiyle) üst düğümler
  const metrics = new Map<string, ProjectMetrics>();
  const revenueOf = new Map<string, ReturnType<typeof dec>>();
  for (const n of [...nodes].reverse()) {
    const act = actuals.get(n.id);
    if (n.isLeaf) {
      const p = progress.get(n.id);
      metrics.set(
        n.id,
        computeLeafMetrics({
          budget: budgetByWbs.get(n.id) ?? 0,
          actual: act?.cost ?? 0,
          percent: p ? p.percent : null,
          etcOverride: p?.etcOverride ?? null,
        }),
      );
      revenueOf.set(n.id, act?.revenue ?? dec(0));
    } else {
      const kids = children.get(n.id) ?? [];
      metrics.set(n.id, combineMetrics(kids.map((k) => metrics.get(k.id)!)));
      revenueOf.set(n.id, kids.reduce((s, k) => s.plus(revenueOf.get(k.id)!), dec(0)));
    }
  }

  const rows: CostReportRow[] = nodes.map((n) => {
    const p = n.isLeaf ? progress.get(n.id) : undefined;
    return {
      wbsId: n.id,
      parentId: n.parentId,
      code: n.code,
      name: n.name,
      depth: n.depth,
      isLeaf: n.isLeaf,
      isActive: n.isActive,
      unassigned: false,
      progress: p ? { percent: dec(p.percent).toFixed(2), etcOverride: p.etcOverride, asOfDate: p.asOfDate, note: p.note } : null,
      revenue: revenueOf.get(n.id)!.toFixed(2),
      ...serializeMetrics(metrics.get(n.id)!),
    };
  });

  // İş kalemi atanmamış etiketli satırlar
  const unassignedAct = actuals.get(null);
  const unassignedMetrics = unassignedAct ? computeLeafMetrics({ budget: 0, actual: unassignedAct.cost, percent: null, etcOverride: null }) : null;
  if (unassignedAct && unassignedMetrics && (!unassignedAct.cost.isZero() || !unassignedAct.revenue.isZero())) {
    rows.push({
      wbsId: null,
      parentId: null,
      code: '—',
      name: 'İş kalemine atanmamış',
      depth: 1,
      isLeaf: true,
      isActive: true,
      unassigned: true,
      progress: null,
      revenue: unassignedAct.revenue.toFixed(2),
      ...serializeMetrics(unassignedMetrics),
    });
  }

  const leafMetrics = [...nodes.filter((n) => n.isLeaf).map((n) => metrics.get(n.id)!), ...(unassignedMetrics ? [unassignedMetrics] : [])];
  const totals = combineMetrics(leafMetrics);
  const revenue = [...actuals.values()].reduce((s, a) => s.plus(a.revenue), dec(0));

  return {
    project: { id: project.id, code: project.code, name: project.name, kind: project.kind, status: project.status },
    asOf,
    budget: budget ? { id: budget.id, revisionNo: budget.revisionNo, approvedAt: budget.approvedAt } : null,
    rows,
    totals: { ...serializeMetrics(totals), revenue: roundMoney(revenue).toFixed(2) },
  };
}

/** Projeye etiketli kaydedilmiş satırlar (hareket dökümü); iş kalemi ve tarih süzgeçli, sayfalı. */
export async function projectTransactions(tx: Tx, projectId: string, q: ProjectTransactionsQuery) {
  await getProjectRow(tx, projectId);
  const conds = [sql`jl.project_id = ${projectId}`, sql`je.status = 'posted'`];
  if (q.wbsId) conds.push(sql`jl.wbs_id = ${q.wbsId}`);
  if (q.unassigned) conds.push(sql`jl.wbs_id is null`);
  if (q.from) conds.push(sql`je.entry_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`je.entry_date <= ${q.to}::date`);
  const where = sql.join(conds, sql` and `);

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select jl.id as "lineId", je.id as "entryId", je.entry_no as "entryNo", je.entry_date::text as date,
           coalesce(jl.description, je.description) as description,
           a.code as "accountCode", a.name as "accountName",
           jl.debit_base::text as "debitBase", jl.credit_base::text as "creditBase",
           case when a.code ~ ${REVENUE_RE} then 'revenue' else 'cost' end as side,
           jl.wbs_id as "wbsId", w.code as "wbsCode", w.name as "wbsName",
           je.source_type as "sourceType", je.reversal_of_id as "reversalOfId"
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      left join project_wbs w on w.id = jl.wbs_id
     where ${where}
     order by je.entry_date desc, je.entry_no desc, jl.line_no
     limit ${q.limit} offset ${q.offset}`);
  const agg = await tx.execute<{ n: number; cost: string; revenue: string }>(sql`
    select count(*)::int as n,
           coalesce(sum(jl.debit_base - jl.credit_base) filter (where a.code !~ ${REVENUE_RE}), 0)::text as cost,
           coalesce(sum(jl.credit_base - jl.debit_base) filter (where a.code ~ ${REVENUE_RE}), 0)::text as revenue
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
     where ${where}`);
  const a = agg.rows[0];
  return { transactions: rows.rows, total: a?.n ?? 0, costNet: a?.cost ?? '0', revenueNet: a?.revenue ?? '0' };
}

/**
 * Şirket geneli proje özeti + defterle mutabakat: projelere etiketli maliyet ile etiketsiz maliyet-tarafı
 * hareketlerin toplamı, defterdeki tüm maliyet-tarafı (gelir/gider/maliyet türü, 60/61/64 dışı) hareketine eşittir.
 */
export async function projectsSummary(tx: Tx, asOf: string) {
  const list = await tx.execute<{ id: string }>(sql`
    select id from projects where status <> 'cancelled' order by code collate ${TR}`);
  const projects = [];
  const parts: ProjectMetrics[] = [];
  for (const { id } of list.rows) {
    const r = await projectCostReport(tx, id, asOf);
    projects.push({ ...r.project, budgetRevision: r.budget?.revisionNo ?? null, revenue: r.totals.revenue, ...pick(r.totals) });
    parts.push(
      combineMetrics(
        r.rows.filter((x) => x.isLeaf).map((x) =>
          computeLeafMetrics({ budget: x.budget, actual: x.actual, percent: x.progress?.percent ?? null, etcOverride: x.progress?.etcOverride ?? null }),
        ),
      ),
    );
  }
  const totals = combineMetrics(parts);

  const ledger = await tx.execute<{ allocated: string; unallocated: string }>(sql`
    select coalesce(sum(jl.debit_base - jl.credit_base) filter (where jl.project_id is not null), 0)::text as allocated,
           coalesce(sum(jl.debit_base - jl.credit_base) filter (where jl.project_id is null), 0)::text as unallocated
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
     where je.status = 'posted' and je.entry_date <= ${asOf}::date
       and a.type in (${TAGGABLE_TYPES}) and a.code !~ ${REVENUE_RE}`);
  const l = ledger.rows[0];
  const allocated = dec(l?.allocated ?? 0);
  const unallocated = dec(l?.unallocated ?? 0);
  return {
    asOf,
    projects,
    totals: pick(serializeMetrics(totals)),
    allocatedCost: roundMoney(allocated).toFixed(2),
    unallocatedCost: roundMoney(unallocated).toFixed(2),
    ledgerCost: roundMoney(allocated.plus(unallocated)).toFixed(2),
  };
}

const pick = (m: MetricsOut) => ({
  budget: m.budget,
  actual: m.actual,
  remaining: m.remaining,
  percent: m.percent,
  etc: m.etc,
  eac: m.eac,
  variance: m.variance,
  cpi: m.cpi,
});

/** Seçiciler için: etiket alabilen (açık) projeler ve aktif yaprak iş kalemleri. */
export async function projectOptions(tx: Tx) {
  const statuses = sql.join(PROJECT_OPEN_STATUSES.map((s) => sql`${s}`), sql`, `);
  const projects = await tx.execute<{ id: string; code: string; name: string; kind: string; status: string }>(sql`
    select id, code, name, kind, status from projects where status in (${statuses}) order by code collate ${TR}`);
  const leaves = await tx.execute<{ id: string; projectId: string; code: string; name: string }>(sql`
    select w.id, w.project_id as "projectId", w.code, w.name
      from project_wbs w join projects p on p.id = w.project_id
     where w.is_active and p.status in (${statuses})
       and not exists (select 1 from project_wbs c where c.parent_id = w.id)
     order by w.project_id, w.code collate ${TR}`);
  const byProject = new Map<string, { id: string; code: string; name: string }[]>();
  for (const w of leaves.rows) byProject.set(w.projectId, [...(byProject.get(w.projectId) ?? []), { id: w.id, code: w.code, name: w.name }]);
  return { projects: projects.rows.map((p) => ({ ...p, wbs: byProject.get(p.id) ?? [] })) };
}
