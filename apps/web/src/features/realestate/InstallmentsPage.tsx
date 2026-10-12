import { CalendarClock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { DueInstallmentRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { unitLabel } from './common';

/** Tahsil edilecek taksitler: vade sırasıyla; gecikenler vurgulanır. */
export function SalesInstallmentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { projects } = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [mode, setMode] = useState<'all' | 'overdue'>('all');
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (mode === 'overdue') q.set('overdue', 'true');
    return q.toString();
  }, [projectId, mode]);
  const lim = useListLimit(qs);
  const { data, isPending, error: SalesInstallmentsPageQueryError, refetch: SalesInstallmentsPageQueryRetry, isFetching: SalesInstallmentsPageQueryFetching } = useCQuery<{ asOf: string; installments: DueInstallmentRow[] } & { truncated?: boolean }>(['sales-installments', 'list', qs, lim.limit], `/api/real-estate/installments?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const rows = data?.installments ?? [];
  if (SalesInstallmentsPageQueryError && !data) return <ErrorState error={SalesInstallmentsPageQueryError} onRetry={() => void SalesInstallmentsPageQueryRetry()} retrying={SalesInstallmentsPageQueryFetching} />;
  return (
    <>
      <PageHeader
        title={t('realEstate.installments.title')}
        description={t('realEstate.installments.subtitle')}
        actions={<ExportMenu exportKey="overdue-installments" params={projectId ? { projectId } : {}} print={false} />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label={t('realEstate.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
          <option value="">{t('realEstate.filters.allProjects')}</option>
          {projects.filter((p) => p.kind === 'own').map((p) => (
            <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
          ))}
        </Select>
        <SegmentedTabs variant="filter" items={[{ key: 'all', label: t('realEstate.installments.all') }, { key: 'overdue', label: t('realEstate.installments.overdue') }]} value={mode} onChange={setMode} />
      </div>
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<CalendarClock className="size-5" />} title={t('realEstate.installments.empty')} description={t('realEstate.installments.emptyDesc')} /></Card>
      ) : (
        <>
          <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('realEstate.cols.due')}</Th>
                <Th>{t('realEstate.cols.buyer')}</Th>
                <Th>{t('realEstate.cols.unit')}</Th>
                <Th className="w-36">{t('realEstate.cols.code')}</Th>
                <Th num className="w-16">#</Th>
                <Th num>{t('realEstate.cols.amount')}</Th>
                <Th num>{t('realEstate.cols.remaining')}</Th>
                <Th className="w-32">{t('realEstate.cols.state')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/real-estate/contracts/${r.contractId}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/real-estate/contracts/${r.contractId}`)}>
                  <Td>{formatDateTR(r.dueDate)}</Td>
                  <Td>{r.partyName}</Td>
                  <Td>{r.projectCode} · {unitLabel(r)}</Td>
                  <Td className="font-mono text-[13px] text-muted">{r.contractCode}</Td>
                  <Td num>{r.seq}</Td>
                  <Td num>{moneyIn(r.amount, r.currencyCode)}</Td>
                  <Td num>{moneyIn(r.remaining, r.currencyCode)}</Td>
                  <Td>{r.daysOverdue > 0 ? <Badge tone="danger">{t('realEstate.installments.daysOverdue', { n: r.daysOverdue })}</Badge> : <Badge tone="neutral">{t('realEstate.installments.upcoming')}</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
          <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
        </>
      )}
    </>
  );
}
