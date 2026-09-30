import { HardHat, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { ProjectListRow, ProjectsSummary } from '../../lib/types';
import { PROJECT_STATUSES, ProjectKindBadge, ProjectStatusBadge, VarianceText } from './common';
import { ProjectFormSheet } from './ProjectFormSheet';

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const base = useCompany().baseCurrency;
  const canManage = useCan()('projects.manage');
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const asOf = todayIso();

  // Komut paletinden ("Yeni proje") derin bağlantı
  useEffect(() => {
    if (params.get('new') === '1') {
      setAdding(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const qs = useMemo(() => {
    const q = new URLSearchParams({ limit: '200' });
    if (status) q.set('status', status);
    if (kind) q.set('kind', kind);
    if (query.trim()) q.set('q', query.trim());
    return q.toString();
  }, [status, kind, query]);
  const { data, isPending } = useCQuery<{ projects: ProjectListRow[]; total: number }>(['projects', 'list', qs], `/api/projects?${qs}`);
  const { data: summary } = useCQuery<ProjectsSummary>(['projects', 'summary', asOf], `/api/projects/summary?asOf=${asOf}`);
  const byId = useMemo(() => new Map((summary?.projects ?? []).map((p) => [p.id, p])), [summary]);

  const projects = data?.projects ?? [];
  const filtered = !!(status || kind || query.trim());
  const addButton = canManage && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('projects.add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('projects.title')}
        description={t('projects.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu exportKey="projects-summary" params={{ asOf }} print={false} disabled={!summary} />
            {addButton}
          </div>
        }
      />

      {isPending ? (
        <PageLoading />
      ) : projects.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<HardHat className="size-5" />} title={t('projects.empty')} description={t('projects.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {summary && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label={t('projects.kpi.budget')} sub={t('projects.kpi.budgetSub')}>
                  {money(summary.totals.budget)} <span className="text-base text-muted">{base}</span>
                </Stat>
                <Stat label={t('projects.kpi.actual')} sub={t('projects.kpi.actualSub')}>
                  {money(summary.totals.actual)} <span className="text-base text-muted">{base}</span>
                </Stat>
                <Stat label={t('projects.kpi.eac')} sub={t('projects.kpi.eacSub')}>
                  {money(summary.totals.eac)} <span className="text-base text-muted">{base}</span>
                </Stat>
                <Stat label={t('projects.kpi.variance')} sub={t('projects.kpi.varianceSub')}>
                  <VarianceText value={summary.totals.variance} />
                </Stat>
              </div>
              {Number(summary.unallocatedCost) !== 0 && (
                <Callout tone="info" title={t('projects.unallocated.title')}>
                  {t('projects.unallocated.body', {
                    amount: `${money(summary.unallocatedCost)} ${base}`,
                    allocated: `${money(summary.allocatedCost)} ${base}`,
                    total: `${money(summary.ledgerCost)} ${base}`,
                  })}
                </Callout>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input className="pl-9" aria-label={t('common.search')} placeholder={t('projects.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Select aria-label={t('projects.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">{t('projects.filters.allStatuses')}</option>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`projects.status.${s}`)}
                </option>
              ))}
            </Select>
            <Select aria-label={t('projects.filters.kind')} value={kind} onChange={(e) => setKind(e.target.value)} className="w-52">
              <option value="">{t('projects.filters.allKinds')}</option>
              <option value="own">{t('projects.kinds.own')}</option>
              <option value="contract">{t('projects.kinds.contract')}</option>
            </Select>
          </div>

          {projects.length === 0 ? (
            <Card>
              <EmptyState title={t('common.noResults')} />
            </Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-28">{t('projects.cols.code')}</Th>
                    <Th>{t('projects.cols.name')}</Th>
                    <Th className="w-28">{t('projects.cols.status')}</Th>
                    <Th num>{t('projects.cols.budget')}</Th>
                    <Th num>{t('projects.cols.actual')}</Th>
                    <Th num className="w-28">
                      {t('projects.cols.percent')}
                    </Th>
                    <Th num>{t('projects.cols.eac')}</Th>
                    <Th num>{t('projects.cols.variance')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => {
                    const s = byId.get(p.id);
                    return (
                      <Tr
                        key={p.id}
                        clickable
                        tabIndex={0}
                        className={p.status === 'cancelled' ? 'opacity-60' : undefined}
                        onClick={() => navigate(`/projects/${p.id}`)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') navigate(`/projects/${p.id}`);
                        }}
                      >
                        <Td className="font-mono text-[13px] text-muted">{p.code}</Td>
                        <Td>
                          <span className="block truncate">{p.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <ProjectKindBadge kind={p.kind} />
                            {p.clientName ? <span>{p.clientName}</span> : null}
                            {p.location ? <span>{p.location}</span> : null}
                          </span>
                        </Td>
                        <Td>
                          <ProjectStatusBadge status={p.status} />
                        </Td>
                        <Td num>{s ? money(s.budget) : '—'}</Td>
                        <Td num>{s ? money(s.actual) : '—'}</Td>
                        <Td num className="text-muted">
                          {s?.percent ? `%${money(s.percent, 1)}` : '—'}
                        </Td>
                        <Td num>{s ? money(s.eac) : '—'}</Td>
                        <Td num>{s ? <VarianceText value={s.variance} /> : '—'}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}

      <ProjectFormSheet open={adding} onOpenChange={setAdding} onSaved={(p) => navigate(`/projects/${p.id}`)} />
    </>
  );
}
