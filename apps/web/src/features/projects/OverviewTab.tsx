import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { cn } from '../../lib/cn';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ProjectCostReport, ProjectDetail } from '../../lib/types';
import { VarianceText } from './common';

interface Props {
  project: ProjectDetail;
  onOpenBudget: () => void;
  onOpenWbs: () => void;
}

/** Özet sekmesi: toplam ölçütler + iş kırılımı boyunca bütçe, gerçekleşen, tamamlanma, ETC/EAC ve sapma. */
export function OverviewTab({ project, onOpenBudget, onOpenWbs }: Props) {
  const { t } = useTranslation();
  const base = useCompany().baseCurrency;
  const can = useCan();
  const [asOf, setAsOf] = useState(todayIso());
  const [hideEmpty, setHideEmpty] = useState(true);
  const { data, isPending } = useCQuery<ProjectCostReport>(['project', project.id, 'cost-report', asOf], `/api/projects/${project.id}/cost-report?asOf=${asOf}`);

  if (isPending || !data) return <PageLoading />;
  const { totals, rows, budget } = data;
  const hasRows = rows.length > 0;
  const shown = hideEmpty ? rows.filter((r) => r.isActive || Number(r.budget) !== 0 || Number(r.actual) !== 0 || !r.isLeaf) : rows;
  const suffix = <span className="text-base text-muted">{base}</span>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <Field label={t('projects.overview.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} className="w-44" />}</Field>
          {budget ? (
            <Badge tone="brand">{t('projects.overview.budgetRev', { rev: budget.revisionNo, date: formatDateTR(budget.approvedAt.slice(0, 10)) })}</Badge>
          ) : (
            <Badge tone="warning">{t('projects.overview.noBudget')}</Badge>
          )}
        </div>
        <ExportMenu exportKey="project-cost-report" params={{ projectId: project.id, asOf }} />
      </div>

      {!budget && (
        <Callout
          tone="warning"
          title={t('projects.overview.noBudgetTitle')}
          action={can('projects.budget') ? <Button onClick={onOpenBudget}>{t('projects.overview.goBudget')}</Button> : undefined}
        >
          {t('projects.overview.noBudgetBody')}
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('projects.kpi.budget')} sub={t('projects.overview.budgetSub')}>
          {money(totals.budget)} {suffix}
        </Stat>
        <Stat label={t('projects.kpi.actual')} sub={t('projects.overview.actualSub', { pct: totals.spentPct ? money(totals.spentPct, 1) : '—' })}>
          {money(totals.actual)} {suffix}
        </Stat>
        <Stat label={t('projects.kpi.eac')} sub={t('projects.overview.eacSub', { etc: money(totals.etc) })}>
          {money(totals.eac)} {suffix}
        </Stat>
        <Stat label={t('projects.kpi.variance')} sub={t('projects.overview.varianceSub')}>
          <VarianceText value={totals.variance} />
        </Stat>
        <Stat label={t('projects.overview.progress')} sub={t('projects.overview.progressSub')}>
          {totals.percent ? `%${money(totals.percent, 1)}` : '—'}
        </Stat>
        <Stat label={t('projects.overview.remaining')} sub={t('projects.overview.remainingSub')}>
          <span className={cn(Number(totals.remaining) < 0 && 'text-danger')}>{money(totals.remaining)}</span> {suffix}
        </Stat>
        <Stat label={t('projects.overview.cpi')} sub={t('projects.overview.cpiSub')}>
          {totals.cpi ? money(totals.cpi, 2) : '—'}
        </Stat>
        <Stat label={t('projects.overview.revenue')} sub={t('projects.overview.revenueSub')}>
          {money(totals.revenue)} {suffix}
        </Stat>
      </div>

      <Card>
        <CardHeader
          title={t('projects.overview.tableTitle')}
          description={t('projects.overview.tableDesc')}
          action={
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
              {t('projects.overview.hideEmpty')}
            </label>
          }
        />
        {!hasRows ? (
          <EmptyState
            title={t('projects.overview.noWbs')}
            description={t('projects.overview.noWbsDesc')}
            action={can('projects.manage') ? <Button onClick={onOpenWbs}>{t('projects.overview.goWbs')}</Button> : undefined}
          />
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>{t('projects.cols.wbs')}</Th>
                  <Th num>{t('projects.cols.budget')}</Th>
                  <Th num>{t('projects.cols.actual')}</Th>
                  <Th num className="w-20">
                    {t('projects.cols.spent')}
                  </Th>
                  <Th num className="w-24">
                    {t('projects.cols.percent')}
                  </Th>
                  <Th num>{t('projects.cols.etc')}</Th>
                  <Th num>{t('projects.cols.eac')}</Th>
                  <Th num>{t('projects.cols.variance')}</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <Tr key={r.wbsId ?? 'unassigned'} className={cn(!r.isLeaf && 'bg-surface-2', !r.isActive && 'opacity-60')}>
                    <Td>
                      <span className="flex items-baseline gap-2" style={{ paddingLeft: `${(r.depth - 1) * 1.25}rem` }}>
                        <span className="font-mono text-[13px] text-muted">{r.code}</span>
                        <span className={cn(r.unassigned && 'text-warning')}>{r.name}</span>
                        {!r.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
                      </span>
                    </Td>
                    <Td num>{money(r.budget)}</Td>
                    <Td num>{money(r.actual)}</Td>
                    <Td num className="text-muted">
                      {r.spentPct ? `%${money(r.spentPct, 0)}` : '—'}
                    </Td>
                    <Td num className="text-muted">
                      {r.percent ? `%${money(r.percent, 1)}` : '—'}
                    </Td>
                    <Td num>{money(r.etc)}</Td>
                    <Td num>{money(r.eac)}</Td>
                    <Td num>
                      <VarianceText value={r.variance} />
                    </Td>
                  </Tr>
                ))}
                <Tr className="border-t border-text bg-surface-2">
                  <Td>{t('common.total')}</Td>
                  <Td num>{money(totals.budget)}</Td>
                  <Td num>{money(totals.actual)}</Td>
                  <Td num className="text-muted">
                    {totals.spentPct ? `%${money(totals.spentPct, 0)}` : '—'}
                  </Td>
                  <Td num className="text-muted">
                    {totals.percent ? `%${money(totals.percent, 1)}` : '—'}
                  </Td>
                  <Td num>{money(totals.etc)}</Td>
                  <Td num>{money(totals.eac)}</Td>
                  <Td num>
                    <VarianceText value={totals.variance} />
                  </Td>
                </Tr>
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
