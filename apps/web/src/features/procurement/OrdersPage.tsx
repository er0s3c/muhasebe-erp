import { PackageCheck, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TruncatedNote, useListLimit } from '../../components/ui/ListLimit';
import { useTranslation } from 'react-i18next';
import { useCompany } from '../../lib/session';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { PurchaseOrderRow } from '../../lib/types';
import { qtyText } from '../inventory/common';
import { useProjectOptions } from '../projects/common';
import { ORDER_STATUSES, OrderStatusBadge } from './common';

export function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectBased = useCompany().sector === 'CONSTRUCTION';
  const canManage = useCan()('procurement.manage');
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
  const { data, isPending } = useCQuery<{ orders: PurchaseOrderRow[] } & { truncated?: boolean }>(['purchase-orders', 'list', qs, lim.limit], `/api/purchase-orders?${qs}${qs ? '&' : ''}limit=${lim.limit}`);
  const rows = data?.orders ?? [];
  const filtered = !!(projectId || status);
  const add = canManage && (
    <Button variant="primary" onClick={() => navigate('/purchasing/orders/new')}>
      <Plus className="size-4" aria-hidden />
      {t('procurement.orders.add')}
    </Button>
  );
  return (
    <>
      <PageHeader title={t('procurement.orders.title')} description={t('procurement.orders.subtitle')} actions={add || undefined} />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card><EmptyState icon={<PackageCheck className="size-5" />} title={t('procurement.orders.empty')} description={t('procurement.orders.emptyDesc')} action={add || undefined} /></Card>
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
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`procurement.orderStatus.${s}`)}</option>
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
                    <Th className="w-36">{t('procurement.cols.code')}</Th>
                    <Th>{t('procurement.cols.supplier')}</Th>
                    {projectBased && <Th>{t('procurement.cols.project')}</Th>}
                    <Th className="w-28">{t('procurement.cols.status')}</Th>
                    <Th num className="w-32">{t('procurement.cols.receivedOrdered')}</Th>
                    <Th num>{t('procurement.cols.net')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/purchasing/orders/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchasing/orders/${r.id}`)}>
                      <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                      <Td>{r.partyName}</Td>
                      {projectBased && <Td className="text-muted">{r.projectCode}</Td>}
                      <Td><OrderStatusBadge status={r.status} /></Td>
                      <Td num className="text-muted">{qtyText(r.receivedQty) || '0'} / {qtyText(r.orderedQty)}</Td>
                      <Td num>{moneyIn(r.net, r.currencyCode)}</Td>
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
