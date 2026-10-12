import { CompanySavedViews } from '../../components/layout/CompanySavedViews';
import { ListToolbar } from '../../components/ui/ListTools';
import { ClipboardCheck, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { PurchaseRequestRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { REQUEST_STATUSES, RequestStatusBadge } from './common';

export function PurchaseRequestsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectBased = useCompany().sector === 'CONSTRUCTION';
  const canManage = useCan()('procurement.manage');
  const base = useCompany().baseCurrency;
  const { projects } = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (status) q.set('status', status);
    return q.toString();
  }, [projectId, status]);
  const lim = useListLimit(qs);
  const { data, isPending, error: PurchaseRequestsPageQueryError, refetch: PurchaseRequestsPageQueryRetry, isFetching: PurchaseRequestsPageQueryFetching } = useCQuery<{ requests: PurchaseRequestRow[] } & { truncated?: boolean }>(['purchase-requests', 'list', qs, lim.limit], `/api/purchase-requests?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const rows = data?.requests ?? [];
  const filtered = !!(projectId || status);

  const add = canManage && (
    <Button variant="primary" onClick={() => navigate('/purchasing/requests/new')}>
      <Plus className="size-4" aria-hidden />
      {t('procurement.requests.add')}
    </Button>
  );
  if (PurchaseRequestsPageQueryError && !data) return <ErrorState error={PurchaseRequestsPageQueryError} onRetry={() => void PurchaseRequestsPageQueryRetry()} retrying={PurchaseRequestsPageQueryFetching} />;
  return (
    <>
      <PageHeader title={t('procurement.requests.title')} description={t('procurement.requests.subtitle')} actions={add || undefined} />
      <ListToolbar onReset={() => { setProjectId(''); setStatus(''); lim.reset(); }}><CompanySavedViews page={'purchase-requests'} filters={{ projectId, status }} onApply={view => { setProjectId(view.projectId as typeof projectId); setStatus(view.status as typeof status); lim.reset(); }} /></ListToolbar>

      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<ClipboardCheck className="size-5" />} title={t('procurement.requests.empty')} description={t('procurement.requests.emptyDesc')} action={add || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {projectBased && <Select aria-label={t('procurement.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
              <option value="">{t('procurement.filters.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </Select>}
            <Select aria-label={t('procurement.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              <option value="">{t('procurement.filters.allStatuses')}</option>
              {REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`procurement.requestStatus.${s}`)}</option>
              ))}
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card><EmptyState title={t('common.noResults')} /></Card>
          ) : (
            <>
              <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-32">{t('procurement.cols.code')}</Th>
                    <Th>{t('procurement.cols.title')}</Th>
                    {projectBased && <Th>{t('procurement.cols.project')}</Th>}
                    <Th className="w-28">{t('procurement.cols.status')}</Th>
                    <Th className="w-28">{t('procurement.cols.needDate')}</Th>
                    <Th num className="w-20">{t('procurement.cols.lines')}</Th>
                    <Th num>{t('procurement.cols.estimated', { currency: base })}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/purchasing/requests/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchasing/requests/${r.id}`)}>
                      <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                      <Td>{r.title}</Td>
                      {projectBased && <Td className="text-muted">{r.projectCode}</Td>}
                      <Td><RequestStatusBadge status={r.status} /></Td>
                      <Td className="text-muted">{r.needDate ? formatDateTR(r.needDate) : '—'}</Td>
                      <Td num>{r.lineCount}</Td>
                      <Td num>{money(r.estimatedTotal)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
              <TruncatedNote truncated={data?.truncated} shown={rows.length} onMore={lim.more} atMax={lim.atMax} />
            </>
          )}
        </div>
      )}
    </>
  );
}
