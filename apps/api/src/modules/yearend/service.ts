import { and, asc, desc, eq, gt, lt, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  YEAR_END_CARRY_SOURCE,
  YEAR_END_CLOSE_SOURCE,
  YEAR_END_MAPPING_KEYS,
  YEAR_END_RESULT_TYPES,
  computeClosingPlan,
  defaultFiscalYearName,
  monthsInRange,
  nextDayIso,
  type ClosingLine,
  type ClosingPlan,
  type CloseFiscalYearInput,
  type CreateFiscalYearInput,
  type ResultAccountRef,
  type ResultBalanceRow,
  type YearEndMappingKey,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { fiscalPeriods, fiscalYearEvents, fiscalYears, journalEntries, journalLines } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { notClosingEntry } from '../ledger/closing';
import { postJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { loadMappings, MAPPING_LABELS } from '../ledger/mappings';
import { trialBalance } from '../ledger/reports';
import { generatePeriods, requireOpenPeriod } from '../settings/periods';

export type FiscalYearRow = typeof fiscalYears.$inferSelect;

export interface ClosingOptions {
  carryForward: boolean;
  includeCostAccounts: boolean;
}

export const DEFAULT_CLOSING_OPTIONS: ClosingOptions = { carryForward: true, includeCostAccounts: true };

// ---- Mali yıl listesi ve tanımı ------------------------------------------------------------------------------------------

export async function listFiscalYears(tx: Tx) {
  const years = await tx.select().from(fiscalYears).orderBy(asc(fiscalYears.startDate));
  const events = years.length ? await tx.select().from(fiscalYearEvents).orderBy(asc(fiscalYearEvents.at)) : [];
  const withEvents = years.map((y) => ({ ...y, events: events.filter((e) => e.fiscalYearId === y.id) }));

  // Öneri: hareketi ya da dönemi olan, henüz mali yıl tanımı bulunmayan takvim yılları (kod takvim yılını VARSAYMAZ; yalnızca öneri)
  const cand = await tx.execute<{ y: number }>(sql`
    select y from (
      select distinct extract(year from entry_date)::int as y from journal_entries
      union select distinct year from fiscal_periods
    ) s order by y`);
  const suggestions = cand.rows
    .map((r) => ({ startDate: `${r.y}-01-01`, endDate: `${r.y}-12-31`, name: String(r.y) }))
    .filter((s) => !years.some((y) => y.startDate <= s.endDate && y.endDate >= s.startDate));
  return { years: withEvents, suggestions };
}

export async function createFiscalYear(tx: Tx, ctx: LedgerCtx, input: CreateFiscalYearInput) {
  const name = input.name ?? defaultFiscalYearName(input.startDate, input.endDate);
  const dup = await tx.select({ id: fiscalYears.id }).from(fiscalYears).where(eq(fiscalYears.name, name));
  if (dup.length) throw conflict(`"${name}" adlı bir mali yıl zaten var`, 'FISCAL_YEAR_NAME_TAKEN');
  const [row] = await tx
    .insert(fiscalYears)
    .values({ companyId: ctx.companyId, name, startDate: input.startDate, endDate: input.endDate, createdBy: ctx.userId })
    .returning();
  return row!;
}

export async function getFiscalYear(tx: Tx, id: string, forUpdate = false): Promise<FiscalYearRow> {
  const q = tx.select().from(fiscalYears).where(eq(fiscalYears.id, id));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Mali yıl');
  return row;
}

export async function deleteFiscalYear(tx: Tx, id: string) {
  const y = await getFiscalYear(tx, id, true);
  if (y.status !== 'open') throw conflict('Kapatılmış mali yıl silinemez', 'FISCAL_YEAR_CLOSED');
  await tx.delete(fiscalYears).where(eq(fiscalYears.id, id));
}

// ---- Kapanış hesabı ------------------------------------------------------------------------------------------------------

interface MappedRefs {
  profit: ResultAccountRef;
  loss: ResultAccountRef;
  retainedProfit: ResultAccountRef;
  retainedLoss: ResultAccountRef;
}

async function loadResultMappings(tx: Tx): Promise<{ refs: MappedRefs | null; missing: YearEndMappingKey[] }> {
  const all = await loadMappings(tx);
  const missing = YEAR_END_MAPPING_KEYS.filter((k) => !all.has(k));
  if (missing.length) return { refs: null, missing };
  const get = (k: YearEndMappingKey) => {
    const a = all.get(k)!;
    return { id: a.id, code: a.code, name: a.name };
  };
  return {
    refs: { profit: get('year_end_profit'), loss: get('year_end_loss'), retainedProfit: get('year_end_retained_profit'), retainedLoss: get('year_end_retained_loss') },
    missing: [],
  };
}

interface RawBalance extends Record<string, unknown> {
  account_id: string;
  code: string;
  name: string;
  currency_code: string | null;
  is_active: boolean;
  project_id: string | null;
  wbs_id: string | null;
  cost_code_id: string | null;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
  debit_reporting: string | null;
  credit_reporting: string | null;
}

/** Yılın kaydedilmiş, kapanış-dışı satırlarından gelir/gider/maliyet bakiyeleri (hesap × proje × iş kalemi × maliyet kodu). */
async function loadResultBalances(tx: Tx, year: { startDate: string; endDate: string }, opts: ClosingOptions) {
  const types = (opts.includeCostAccounts ? YEAR_END_RESULT_TYPES : YEAR_END_RESULT_TYPES.filter((t) => t !== 'cost')).map((t) => sql`${t}`);
  const res = await tx.execute<RawBalance>(sql`
    select a.id as account_id, a.code, a.name, a.currency_code, a.is_active,
           l.project_id, l.wbs_id, l.cost_code_id,
           sum(l.debit)::text as debit, sum(l.credit)::text as credit,
           sum(l.debit_base)::text as debit_base, sum(l.credit_base)::text as credit_base,
           case when bool_or(l.debit_reporting is null or l.credit_reporting is null) then null else sum(l.debit_reporting)::text end as debit_reporting,
           case when bool_or(l.debit_reporting is null or l.credit_reporting is null) then null else sum(l.credit_reporting)::text end as credit_reporting
      from journal_lines l
      join journal_entries je on je.id = l.entry_id and je.status = 'posted'
      join accounts a on a.id = l.account_id
     where je.entry_date between ${year.startDate}::date and ${year.endDate}::date
       and ${notClosingEntry('je')}
       and a.type in (${sql.join(types, sql`, `)})
     group by a.id, l.project_id, l.wbs_id, l.cost_code_id
     order by a.code`);
  const rows: ResultBalanceRow[] = res.rows.map((r) => ({
    accountId: r.account_id,
    code: r.code,
    name: r.name,
    currencyCode: r.currency_code,
    projectId: r.project_id,
    wbsId: r.wbs_id,
    costCodeId: r.cost_code_id,
    debit: r.debit,
    credit: r.credit,
    debitBase: r.debit_base,
    creditBase: r.credit_base,
    debitReporting: r.debit_reporting,
    creditReporting: r.credit_reporting,
  }));
  return { rows, raw: res.rows };
}

export interface PlanBundle {
  plan: ClosingPlan;
  refs: MappedRefs | null;
  missingMappings: YearEndMappingKey[];
  inactiveAccounts: { code: string; name: string }[];
  costClassAccounts: number;
}

export async function computePlan(tx: Tx, baseCurrency: string, year: { startDate: string; endDate: string }, opts: ClosingOptions): Promise<PlanBundle> {
  const { refs, missing } = await loadResultMappings(tx);
  const { rows, raw } = await loadResultBalances(tx, year, opts);
  const placeholder: ResultAccountRef = { id: '', code: '', name: '' };
  const plan = computeClosingPlan({
    baseCurrency,
    rows,
    profit: refs?.profit ?? placeholder,
    loss: refs?.loss ?? placeholder,
    retainedProfit: refs?.retainedProfit ?? placeholder,
    retainedLoss: refs?.retainedLoss ?? placeholder,
  });
  const active = new Map(raw.map((r) => [r.account_id, r.is_active]));
  const closing = new Set(plan.closingLines.map((l) => l.accountId));
  const inactive = [...new Map(raw.filter((r) => !active.get(r.account_id) && closing.has(r.account_id)).map((r) => [r.account_id, { code: r.code, name: r.name }])).values()];
  const costClass = new Set(rows.filter((r) => r.code.startsWith('7') && closing.has(r.accountId)).map((r) => r.accountId)).size;
  return { plan, refs, missingMappings: missing, inactiveAccounts: inactive, costClassAccounts: costClass };
}

// ---- Ön kontrol listesi --------------------------------------------------------------------------------------------------

export type CheckSeverity = 'ok' | 'info' | 'warning' | 'blocker';

export interface PreflightCheck {
  /** Ekranda `yearend.checks.<key>` ile adlandırılır. */
  key: string;
  severity: CheckSeverity;
  count?: number;
  /** Ekranda bağlantı: ilgili sayfa. */
  link?: string;
  /** Kısa ayrıntılar (en çok 5; hesap kodu, ay vb.). */
  details?: string[];
}

const count = async (tx: Tx, q: SQL) => Number((await tx.execute<{ n: number }>(q)).rows[0]?.n ?? 0);

export async function preflight(tx: Tx, baseCurrency: string, year: FiscalYearRow, opts: ClosingOptions) {
  const checks: PreflightCheck[] = [];
  const add = (key: string, n: number, severity: Exclude<CheckSeverity, 'ok'>, extra: Partial<PreflightCheck> = {}) =>
    checks.push({ key, count: n, severity: n > 0 ? severity : 'ok', ...(n > 0 ? extra : {}) });
  const s = year.startDate;
  const e = year.endDate;

  if (year.status === 'closed') {
    checks.push({ key: 'already_closed', severity: 'info' });
  }

  // Katı sıra: önceki mali yıl kapanmış olmalı
  const earlier = await tx
    .select({ name: fiscalYears.name })
    .from(fiscalYears)
    .where(and(lt(fiscalYears.endDate, s), sql`${fiscalYears.status} <> 'closed'`));
  add('previous_year_open', earlier.length, 'blocker', { details: earlier.map((x) => x.name).slice(0, 5) });

  // Önceki yıllardan kalan, kapatılmamış gelir/gider bakiyesi (mali yıl tanımı olmayan geçmiş)
  const carried = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select l.account_id from journal_lines l
        join journal_entries je on je.id = l.entry_id and je.status = 'posted'
        join accounts a on a.id = l.account_id
       where je.entry_date < ${s}::date and ${notClosingEntry('je')} and a.type in ('income','expense','cost')
       group by l.account_id having sum(l.debit_base - l.credit_base) <> 0) x`);
  const carriedN = Number(carried.rows[0]?.n ?? 0);
  const coveredByClosed = await tx.select({ id: fiscalYears.id }).from(fiscalYears).where(and(lt(fiscalYears.endDate, s), eq(fiscalYears.status, 'closed')));
  // Önceki yıl kapatıldıysa o yılın kapanış fişi bakiyeyi sıfırlamıştır; yine de kapanış-dışı net farklıysa uyarılır
  add('earlier_result_balance', coveredByClosed.length === 0 ? carriedN : 0, 'warning');

  add('draft_entries', await count(tx, sql`select count(*)::int as n from journal_entries where status = 'draft' and entry_date between ${s}::date and ${e}::date`), 'blocker', { link: '/accounting/journal' });
  add('draft_invoices', await count(tx, sql`select count(*)::int as n from invoices where status = 'draft' and invoice_date between ${s}::date and ${e}::date`), 'blocker', { link: '/invoices/sales' });
  add('draft_deliveries', await count(tx, sql`select count(*)::int as n from delivery_notes where status = 'draft' and note_date between ${s}::date and ${e}::date`), 'blocker', { link: '/delivery-notes/sales' });
  add('open_stock_counts', await count(tx, sql`select count(*)::int as n from stock_counts where status = 'draft' and count_date between ${s}::date and ${e}::date`), 'blocker', { link: '/inventory/counts' });
  add('pending_approvals', await count(tx, sql`select count(*)::int as n from approval_requests where status = 'pending'`), 'warning', { link: '/approvals' });

  const months = monthsInRange(s, e);
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const ym = (m: { year: number; month: number }) => `${m.year}-${String(m.month).padStart(2, '0')}`;
  const draftPayroll = await count(tx, sql`select count(*)::int as n from payroll_runs where status = 'draft' and month between ${ym(first)} and ${ym(last)}`);
  add('draft_payroll', draftPayroll, 'warning', { link: '/hr/payroll' });
  const openAttendance = await count(tx, sql`select count(*)::int as n from attendance_months where status = 'open' and month between ${ym(first)} and ${ym(last)}`);
  add('open_attendance', openAttendance, 'warning', { link: '/hr/attendance' });

  // Dönemler: kapanışta eksik aylar oluşturulur ve tüm aylar kilitlenir (bilgi)
  const per = await tx.execute<{ total: number; open: number }>(sql`
    select count(*)::int as total, count(*) filter (where status <> 'closed')::int as open from fiscal_periods
     where start_date >= ${s}::date and end_date <= ${e}::date`);
  const openPeriods = months.length - Number(per.rows[0]?.total ?? 0) + Number(per.rows[0]?.open ?? 0);
  checks.push({ key: 'periods_to_lock', severity: openPeriods > 0 ? 'info' : 'ok', count: openPeriods, link: '/settings/periods' });

  // Devir: sonraki yılın ilk dönemi açık olmalı
  if (opts.carryForward) {
    const nextStart = nextDayIso(e);
    const [np] = await tx.select({ status: fiscalPeriods.status }).from(fiscalPeriods).where(and(sql`${fiscalPeriods.startDate} <= ${nextStart}::date`, sql`${fiscalPeriods.endDate} >= ${nextStart}::date`));
    add('next_period_closed', np && np.status !== 'open' ? 1 : 0, 'blocker', { link: '/settings/periods', details: [nextStart] });
  }

  // Hesap eşlemeleri, hesap durumları, kapatılamayan döviz kalıntıları, 7. sınıf
  const bundle = await computePlan(tx, baseCurrency, year, opts);
  add('mappings_missing', bundle.missingMappings.length, 'blocker', { link: '/settings/account-mapping', details: bundle.missingMappings.map((k) => MAPPING_LABELS[k]) });
  add('inactive_result_accounts', bundle.inactiveAccounts.length, 'blocker', { link: '/accounting/accounts', details: bundle.inactiveAccounts.map((a) => `${a.code} ${a.name}`).slice(0, 5) });
  add('fx_residual', bundle.plan.issues.length, 'blocker', { details: bundle.plan.issues.map((i) => i.message).slice(0, 5) });
  add('cost_class_balances', opts.includeCostAccounts ? bundle.costClassAccounts : 0, 'warning', { link: '/accounting/trial-balance' });
  if (bundle.plan.closingLines.length === 0) checks.push({ key: 'nothing_to_close', severity: 'info' });

  // Mizan dengesi (kapanış fişleri dahil tüm kayıtlar, yıl sonuna kadar)
  const tb = await trialBalance(tx, { from: s, to: e, currency: 'base', baseCurrency, reportingCurrency: null });
  const diff = tb.totals.difference;
  checks.push({ key: 'trial_balance', severity: Number(diff) === 0 ? 'ok' : 'blocker', link: '/accounting/trial-balance', ...(Number(diff) === 0 ? {} : { details: [diff] }) });

  // Her zaman: kur değerlemesi yapılmadı (M7b kapsam dışı) ve doğrulanmadı uyarısı
  checks.push({ key: 'fx_revaluation_not_done', severity: 'warning' });

  const blockers = checks.filter((c) => c.severity === 'blocker').length;
  return {
    checks,
    canClose: year.status === 'open' && blockers === 0,
    blockers,
    result: { kind: bundle.plan.kind, net: bundle.plan.net, accountCount: bundle.plan.accountCount, lineCount: bundle.plan.closingLines.length },
  };
}

// ---- Önizleme -----------------------------------------------------------------------------------------------------------

async function dimensionLabels(tx: Tx, lines: readonly ClosingLine[]) {
  const projectIds = [...new Set(lines.map((l) => l.projectId).filter((x): x is string => !!x))];
  const wbsIds = [...new Set(lines.map((l) => l.wbsId).filter((x): x is string => !!x))];
  const proj = projectIds.length ? (await tx.execute<{ id: string; code: string }>(sql`select id, code from projects where id in (${sql.join(projectIds.map((i) => sql`${i}::uuid`), sql`, `)})`)).rows : [];
  const wbs = wbsIds.length ? (await tx.execute<{ id: string; code: string }>(sql`select id, code from project_wbs where id in (${sql.join(wbsIds.map((i) => sql`${i}::uuid`), sql`, `)})`)).rows : [];
  const pm = new Map(proj.map((p) => [p.id, p.code]));
  const wm = new Map(wbs.map((w) => [w.id, w.code]));
  return (l: ClosingLine) => ({ projectCode: l.projectId ? (pm.get(l.projectId) ?? null) : null, wbsCode: l.wbsId ? (wm.get(l.wbsId) ?? null) : null });
}

export async function previewClosing(tx: Tx, baseCurrency: string, year: FiscalYearRow, opts: ClosingOptions) {
  const bundle = await computePlan(tx, baseCurrency, year, opts);
  const label = await dimensionLabels(tx, [...bundle.plan.closingLines, ...bundle.plan.carryLines]);
  const view = (l: ClosingLine) => ({ ...l, ...label(l) });
  const carryOn = opts.carryForward && bundle.plan.carryLines.length > 0;
  return {
    year: { id: year.id, name: year.name, startDate: year.startDate, endDate: year.endDate, status: year.status },
    options: opts,
    kind: bundle.plan.kind,
    net: bundle.plan.net,
    accountCount: bundle.plan.accountCount,
    issues: bundle.plan.issues,
    missingMappings: bundle.missingMappings,
    reportingComplete: bundle.plan.reportingComplete,
    closingEntry: bundle.plan.closingLines.length
      ? { date: year.endDate, description: `${year.name} yıl sonu kapanış fişi`, lines: bundle.plan.closingLines.map(view), totals: bundle.plan.totals }
      : null,
    carryEntry: carryOn
      ? { date: nextDayIso(year.endDate), description: `${year.name} dönem sonucunun devri`, lines: bundle.plan.carryLines.map(view) }
      : null,
  };
}

// ---- Kapanış -------------------------------------------------------------------------------------------------------------

/** Kapanış/devir fişini yazar ve kaydeder (kaynak türü year_end_*; kaynak kimliği = olay kimliği). */
async function postClosingEntry(
  tx: Tx,
  ctx: LedgerCtx,
  p: { date: string; description: string; source: string; sourceId: string; lines: readonly ClosingLine[] },
) {
  const period = await requireOpenPeriod(tx, p.date);
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      companyId: ctx.companyId,
      entryDate: p.date,
      periodId: period.id,
      description: p.description,
      sourceType: p.source,
      sourceId: p.sourceId,
      createdBy: ctx.userId,
    })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(
    p.lines.map((l, i) => ({
      entryId: entry!.id,
      companyId: ctx.companyId,
      lineNo: i + 1,
      accountId: l.accountId,
      description: l.description,
      currencyCode: l.currencyCode,
      fxRate: l.fxRate,
      debit: l.debit,
      credit: l.credit,
      debitBase: l.debitBase,
      creditBase: l.creditBase,
      debitReporting: l.debitReporting,
      creditReporting: l.creditReporting,
      projectId: l.projectId,
      wbsId: l.wbsId,
      costCodeId: l.costCodeId,
    })),
  );
  const posted = await postJournalEntry(tx, ctx, entry!.id);
  return { id: posted.id, entryNo: posted.entryNo as string };
}

export async function closeFiscalYear(tx: Tx, ctx: LedgerCtx, id: string, input: CloseFiscalYearInput) {
  const year = await getFiscalYear(tx, id, true);
  if (year.status !== 'open') throw conflict(`${year.name} mali yılı zaten kapalı`, 'FISCAL_YEAR_CLOSED');
  if (input.confirm !== year.name) {
    throw unprocessable(`Onay metni mali yılın adıyla (${year.name}) aynı olmalı`, 'CONFIRMATION_MISMATCH');
  }
  const opts: ClosingOptions = { carryForward: input.carryForward, includeCostAccounts: input.includeCostAccounts };

  // Eksik ayları oluştur (takvim yılı bazında), ardından ön kontrol işlem içinde yeniden çalışır
  const firstYear = Number(year.startDate.slice(0, 4));
  const lastYear = Number((opts.carryForward ? nextDayIso(year.endDate) : year.endDate).slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) await generatePeriods(tx, ctx.companyId, y);

  const pre = await preflight(tx, ctx.baseCurrency, year, opts);
  if (!pre.canClose) {
    const blockers = pre.checks.filter((c) => c.severity === 'blocker');
    throw unprocessable('Kapanışa engel durumlar var; ön kontrol listesini çözün', 'YEAR_END_BLOCKED', { blockers });
  }

  const bundle = await computePlan(tx, ctx.baseCurrency, year, opts);
  const plan = bundle.plan;
  const eventId = uuidv7();
  const closeEntry = plan.closingLines.length
    ? await postClosingEntry(tx, ctx, { date: year.endDate, description: `${year.name} yıl sonu kapanış fişi`, source: YEAR_END_CLOSE_SOURCE, sourceId: eventId, lines: plan.closingLines })
    : null;
  const carryEntry =
    opts.carryForward && plan.carryLines.length
      ? await postClosingEntry(tx, ctx, { date: nextDayIso(year.endDate), description: `${year.name} dönem sonucunun devri`, source: YEAR_END_CARRY_SOURCE, sourceId: eventId, lines: plan.carryLines })
      : null;

  // Yılın tüm dönemlerini mevcut dönem kilidiyle kapat, sonra mali yılı kapat (veritabanı tetikleyicisi koşulları yeniden denetler)
  await tx.execute(sql`
    update fiscal_periods set status = 'closed', closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, ${ctx.userId}::uuid)
     where company_id = ${ctx.companyId}::uuid and start_date >= ${year.startDate}::date and end_date <= ${year.endDate}::date and status <> 'closed'`);
  const [closed] = await tx
    .update(fiscalYears)
    .set({ status: 'closed', closedAt: new Date(), closedBy: ctx.userId, reopenReason: null })
    .where(eq(fiscalYears.id, id))
    .returning();

  const mappingSnapshot = bundle.refs
    ? { profit: bundle.refs.profit.code, loss: bundle.refs.loss.code, retainedProfit: bundle.refs.retainedProfit.code, retainedLoss: bundle.refs.retainedLoss.code }
    : null;
  await tx.insert(fiscalYearEvents).values({
    id: eventId,
    companyId: ctx.companyId,
    fiscalYearId: id,
    action: 'close',
    resultBase: plan.net,
    closeEntryId: closeEntry?.id ?? null,
    carryEntryId: carryEntry?.id ?? null,
    snapshot: { options: opts, mappings: mappingSnapshot, kind: plan.kind, accountCount: plan.accountCount, unverified: true },
    by: ctx.userId,
  });
  return { year: closed!, kind: plan.kind, net: plan.net, closeEntry, carryEntry };
}

// ---- Yeniden açma --------------------------------------------------------------------------------------------------------

export async function reopenFiscalYear(tx: Tx, ctx: LedgerCtx, id: string, reason: string) {
  const year = await getFiscalYear(tx, id, true);
  if (year.status !== 'closed') throw conflict(`${year.name} mali yılı kapalı değil`, 'FISCAL_YEAR_NOT_CLOSED');
  const later = await tx
    .select({ name: fiscalYears.name })
    .from(fiscalYears)
    .where(and(gt(fiscalYears.startDate, year.endDate), eq(fiscalYears.status, 'closed')));
  if (later.length) {
    throw unprocessable(`Sonraki mali yıl kapalı (${later.map((l) => l.name).join(', ')}); önce onu yeniden açın (sıra zorunlu)`, 'FISCAL_YEAR_ORDER');
  }
  const [closeEvent] = await tx
    .select()
    .from(fiscalYearEvents)
    .where(and(eq(fiscalYearEvents.fiscalYearId, id), eq(fiscalYearEvents.action, 'close')))
    .orderBy(desc(fiscalYearEvents.at))
    .limit(1);

  // 1) mali yılı aç (gerekçe zorunlu; tetikleyici sırayı da denetler), 2) dönemleri aç, 3) kapanış/devir fişlerini ters kaydet
  await tx.update(fiscalYears).set({ status: 'open', closedAt: null, closedBy: null, reopenReason: reason, reopenedAt: new Date() }).where(eq(fiscalYears.id, id));
  await tx.execute(sql`
    update fiscal_periods set status = 'open', closed_at = null, closed_by = null
     where company_id = ${ctx.companyId}::uuid and start_date >= ${year.startDate}::date and end_date <= ${year.endDate}::date`);

  const reversal: { carry: string | null; close: string | null } = { carry: null, close: null };
  const reverse = async (entryId: string | null | undefined, label: string) => {
    if (!entryId) return null;
    const [orig] = await tx.select({ date: journalEntries.entryDate, reversedBy: journalEntries.reversedById }).from(journalEntries).where(eq(journalEntries.id, entryId));
    if (!orig || orig.reversedBy) return null;
    try {
      const r = await reverseJournalEntry(tx, ctx, entryId, { entryDate: orig.date, description: `${label} geri alındı (${year.name} mali yılı yeniden açıldı): ${reason}` });
      return r.id;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'PERIOD_CLOSED' || code === 'PERIOD_MISSING') {
        throw unprocessable(`${orig.date} tarihli ${label} geri alınamadı: ilgili dönem kapalı. Önce o dönemi açın`, 'REOPEN_PERIOD_CLOSED', { date: orig.date });
      }
      throw err;
    }
  };
  reversal.carry = await reverse(closeEvent?.carryEntryId, 'devir fişi');
  reversal.close = await reverse(closeEvent?.closeEntryId, 'kapanış fişi');

  await tx.insert(fiscalYearEvents).values({
    companyId: ctx.companyId,
    fiscalYearId: id,
    action: 'reopen',
    reason,
    closeEntryId: reversal.close,
    carryEntryId: reversal.carry,
    snapshot: { reversedCloseEntryId: closeEvent?.closeEntryId ?? null, reversedCarryEntryId: closeEvent?.carryEntryId ?? null },
    by: ctx.userId,
  });
  return getFiscalYear(tx, id);
}

// ---- Durum (kapalı yıl bilgisi) ------------------------------------------------------------------------------------------

/** Verilen tarihin kapalı bir mali yıla düşüp düşmediği (ekran uyarısı için). */
export async function closedYearsOverlapping(tx: Tx, from: string, to: string) {
  return tx
    .select({ id: fiscalYears.id, name: fiscalYears.name, startDate: fiscalYears.startDate, endDate: fiscalYears.endDate })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.status, 'closed'), sql`${fiscalYears.startDate} <= ${to}::date`, sql`${fiscalYears.endDate} >= ${from}::date`));
}

/** Kapanış fişlerinin satırları (kapalı yılda gerçek fişler, açık yılda önizleme). */
export async function closingEntryLines(tx: Tx, baseCurrency: string, year: FiscalYearRow, opts: ClosingOptions) {
  if (year.status !== 'closed') return { source: 'preview' as const, preview: await previewClosing(tx, baseCurrency, year, opts), entries: [] };
  const [ev] = await tx
    .select()
    .from(fiscalYearEvents)
    .where(and(eq(fiscalYearEvents.fiscalYearId, year.id), eq(fiscalYearEvents.action, 'close')))
    .orderBy(desc(fiscalYearEvents.at))
    .limit(1);
  const ids = [ev?.closeEntryId, ev?.carryEntryId].filter((x): x is string => !!x);
  const lines = ids.length
    ? await tx.execute<Record<string, string | null>>(sql`
        select e.entry_no, e.entry_date::text as entry_date, e.source_type, a.code, a.name, l.line_no, l.description,
               l.currency_code, l.debit, l.credit, l.debit_base, l.credit_base, p.code as project_code, w.code as wbs_code
          from journal_lines l
          join journal_entries e on e.id = l.entry_id
          join accounts a on a.id = l.account_id
          left join projects p on p.id = l.project_id
          left join project_wbs w on w.id = l.wbs_id
         where e.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         order by e.entry_date, e.entry_no, l.line_no`)
    : { rows: [] };
  return { source: 'posted' as const, preview: null, entries: lines.rows };
}
