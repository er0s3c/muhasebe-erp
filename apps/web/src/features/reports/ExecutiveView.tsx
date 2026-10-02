import { useTranslation } from 'react-i18next';
import { KPI_DEFINITIONS } from '@erp/shared';
import { Card, CardHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import type { AgingSectionData, ExecutiveSummaryData, KpiData } from '../../lib/types';
import { ExcludedNotice } from './FxPositionView';

const pct = (v: string | null) => (v === null ? '—' : `%${Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`);
const num = (v: string | null, dp = 2) => (v === null ? '—' : Number(v).toLocaleString('tr-TR', { maximumFractionDigits: dp }));

/** Karşılaştırmalı iki çubuk (dönem / karşılaştırma): grafik kütüphanesi yok, CSS çubuğu. Negatifler 0 çizgisinde kırpılır; değerler yanında yazılıdır. */
function CompareBars({ label, cur, prev, currency }: { label: string; cur: string; prev: string | null; currency: string }) {
  const { t } = useTranslation();
  const max = Math.max(Math.abs(Number(cur)), Math.abs(Number(prev ?? 0)), 1);
  const bar = (v: string, tone: string, name: string) => (
    <div className="flex items-center gap-2 text-xs" aria-label={`${label} ${name}`}>
      <span className="w-20 shrink-0 text-muted">{name}</span>
      <div className="h-2 grow rounded bg-surface-2">
        <div className={cn('h-2 rounded', tone)} style={{ width: `${(Math.abs(Number(v)) / max) * 100}%` }} />
      </div>
      <span className={cn('w-28 shrink-0 text-right tabular-nums', Number(v) < 0 && 'text-danger')}>{moneyIn(v, currency)}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">{label}</p>
      {bar(cur, 'bg-brand', t('executive.current'))}
      {prev !== null && bar(prev, 'bg-border-strong', t('executive.previous'))}
    </div>
  );
}

const change = (v: string | null | undefined) => (v === null || v === undefined ? null : <span className={cn('ml-2 text-xs', Number(v) >= 0 ? 'text-success' : 'text-danger')}>{Number(v) >= 0 ? '+' : ''}{pct(v)}</span>);

function Aging({ title, a, cur }: { title: string; a: AgingSectionData; cur: string }) {
  const { t } = useTranslation();
  const cols = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
  return (
    <Card className="p-5">
      <CardHeader title={title} />
      <p className="text-heading" data-testid={`agg-total-${title}`}>{moneyIn(a.total, cur)}{a.previousTotal !== null && <span className="ml-2 text-xs text-muted">{t('executive.previous')}: {moneyIn(a.previousTotal, cur)}</span>}</p>
      <TableWrap className="mt-3">
        <Table>
          <thead>
            <tr>{cols.map((c) => <Th key={c} num>{t(`executive.bucket.${c}`)}</Th>)}</tr>
          </thead>
          <tbody>
            <Tr>{cols.map((c) => <Td key={c} num>{money(a.buckets[c])}</Td>)}</Tr>
          </tbody>
        </Table>
      </TableWrap>
    </Card>
  );
}

/** Yönetici özeti: bölüm yoksa (izin/modül) hiç çizilmez. KPI tanımları ekranda yazılıdır. */
export function ExecutiveView({ data }: { data: ExecutiveSummaryData }) {
  const { t } = useTranslation();
  const c = data.scope.currency;
  const inc = data.income;
  const kpiKeys = Object.keys(KPI_DEFINITIONS) as (keyof KpiData)[];
  return (
    <div className="flex flex-col gap-5" data-testid="executive-summary">
      {data.complete === false && data.excluded && <ExcludedNotice excluded={data.excluded} />}
      <p className="text-sm text-muted">
        {data.scope.name} · {formatDateTR(data.period.from)} – {formatDateTR(data.period.to)} · {c}
        {data.compare && <> · {t('executive.comparedTo')} {formatDateTR(data.compare.from)} – {formatDateTR(data.compare.to)}</>}
        {data.scope.companies !== undefined && <> · {t('executive.companyCount', { n: data.scope.companies })}</>}
      </p>

      {inc && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 print:grid-cols-3">
          <Stat label={t('executive.revenue')}><span data-testid="kpi-revenue">{moneyIn(inc.current.revenue, c)}</span>{change(inc.change?.revenue)}</Stat>
          <Stat label={t('executive.expenses')}><span data-testid="kpi-expenses">{moneyIn(inc.current.expenses, c)}</span>{change(inc.change?.expenses)}</Stat>
          <Stat label={t('executive.profit')}><span data-testid="kpi-profit" className={cn(Number(inc.current.profit) < 0 && 'text-danger')}>{moneyIn(inc.current.profit, c)}</span>{change(inc.change?.profit)}</Stat>
        </div>
      )}

      {inc && data.compare && (
        <Card className="p-5">
          <CardHeader title={t('executive.comparison')} />
          <div className="flex flex-col gap-4">
            <CompareBars label={t('executive.revenue')} cur={inc.current.revenue} prev={inc.previous?.revenue ?? null} currency={c} />
            <CompareBars label={t('executive.expenses')} cur={inc.current.expenses} prev={inc.previous?.expenses ?? null} currency={c} />
            <CompareBars label={t('executive.profit')} cur={inc.current.profit} prev={inc.previous?.profit ?? null} currency={c} />
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 print:grid-cols-3">
        {data.cash && <Stat label={t('executive.cash')} sub={data.cash.approximate ? t('executive.approx') : data.cash.previousTotal !== null ? `${t('executive.previous')}: ${moneyIn(data.cash.previousTotal, c)}` : undefined}><span data-testid="kpi-cash">{moneyIn(data.cash.total, c)}</span></Stat>}
        {data.stock && <Stat label={t('executive.stock')} sub={t('executive.stockSub', { n: data.stock.itemCount, low: data.stock.lowCount })}><span data-testid="kpi-stock">{moneyIn(data.stock.stockValue, c)}</span></Stat>}
        {data.hr && <Stat label={t('executive.headcount')} sub={t('executive.hrSub', { hires: data.hr.hires, leavers: data.hr.leavers })}><span data-testid="kpi-headcount">{data.hr.headcount}</span></Stat>}
      </div>

      {(data.receivables || data.payables) && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data.receivables && <Aging title={t('executive.receivables')} a={data.receivables} cur={c} />}
          {data.payables && <Aging title={t('executive.payables')} a={data.payables} cur={c} />}
        </div>
      )}

      {(data.topCustomers || data.topSuppliers) && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {([['topCustomers', data.topCustomers], ['topSuppliers', data.topSuppliers]] as const).map(([k, rows]) =>
            rows ? (
              <Card key={k} className="p-5">
                <CardHeader title={t(`executive.${k}`)} description={t('executive.topNote')} />
                {rows.length === 0 ? (
                  <p className="text-sm text-muted">{t('executive.noData')}</p>
                ) : (
                  <ol className="flex flex-col gap-1.5 text-sm">
                    {rows.map((r, i) => (
                      <li key={`${r.name}-${i}`} className="flex justify-between gap-3">
                        <span className="truncate">{r.name}</span>
                        <span className="tabular-nums">{moneyIn(r.net, c)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            ) : null,
          )}
        </div>
      )}

      {data.projects && (
        <Card className="p-5" data-testid="exec-projects">
          <CardHeader title={t('executive.projects')} description={t('executive.projectsNote')} />
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div><p className="text-muted">{t('executive.projectCount')}</p><p>{data.projects.count}</p></div>
            <div><p className="text-muted">{t('executive.contracted')}</p><p>{moneyIn(data.projects.contractedRevenue, c)}</p></div>
            <div><p className="text-muted">{t('executive.projectedProfit')}</p><p>{moneyIn(data.projects.projectedProfit, c)}</p></div>
            <div><p className="text-muted">{t('executive.margin')}</p><p>{pct(data.projects.marginPct)}</p></div>
          </div>
        </Card>
      )}

      {data.hr?.payroll && (
        <Card className="p-5" data-testid="exec-payroll">
          <CardHeader title={t('executive.payroll')} description={t('executive.payrollNote')} />
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div><p className="text-muted">{t('executive.gross')}</p><p>{moneyIn(data.hr.payroll.gross, c)}</p></div>
            <div><p className="text-muted">{t('executive.employer')}</p><p>{moneyIn(data.hr.payroll.employer, c)}</p></div>
            <div><p className="text-muted">{t('executive.payrollCost')}</p><p>{moneyIn(data.hr.payroll.cost, c)}</p></div>
          </div>
        </Card>
      )}

      {data.kpis && (
        <Card className="p-5">
          <CardHeader title={t('executive.kpis')} description={t('executive.kpisNote')} />
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('executive.kpi')}</Th>
                  <Th num>{t('executive.current')}</Th>
                  {data.kpis.previous && <Th num>{t('executive.previous')}</Th>}
                  <Th>{t('executive.definition')}</Th>
                </tr>
              </thead>
              <tbody>
                {kpiKeys.map((k) => {
                  const isPct = k.endsWith('Pct');
                  const fmt = (v: string | null) => (isPct ? pct(v) : num(v, k === 'dsoDays' ? 1 : 2));
                  return (
                    <Tr key={k} data-testid={`kpi-${k}`}>
                      <Td>{KPI_DEFINITIONS[k].label}</Td>
                      <Td num>{fmt(data.kpis!.current[k])}</Td>
                      {data.kpis!.previous && <Td num>{fmt(data.kpis!.previous[k])}</Td>}
                      <Td className="text-xs text-muted">{KPI_DEFINITIONS[k].definition}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      )}
      <p className="text-xs text-muted">{data.note}</p>
    </div>
  );
}
