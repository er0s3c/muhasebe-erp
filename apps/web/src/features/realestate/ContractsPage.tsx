import { FileSignature, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { SalesContractRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { CONTRACT_STATUSES, ContractStatusBadge, unitLabel } from './common';

export function SalesContractsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('realestate.manage');
  const { projects } = useProjectOptions();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (status) q.set('status', status);
    return q.toString();
  }, [projectId, status]);
  const { data, isPending } = useCQuery<{ contracts: SalesContractRow[] }>(['sales-contracts', 'list', qs], `/api/sales-contracts?${qs}`);
  const rows = data?.contracts ?? [];
  const filtered = !!(projectId || status);
  const add = canManage && (
    <Button variant="primary" onClick={() => navigate('/real-estate/contracts/new')}>
      <Plus className="size-4" aria-hidden />
      {t('realEstate.contracts.add')}
    </Button>
  );
  return (
    <>
      <PageHeader
        title={t('realEstate.contracts.title')}
        description={t('realEstate.contracts.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu exportKey="sales-contracts" params={projectId ? { projectId } : {}} print={false} />
            {add}
          </div>
        }
      />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card><EmptyState icon={<FileSignature className="size-5" />} title={t('realEstate.contracts.empty')} description={t('realEstate.contracts.emptyDesc')} action={add || undefined} /></Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select aria-label={t('realEstate.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
              <option value="">{t('realEstate.filters.allProjects')}</option>
              {projects.filter((p) => p.kind === 'own').map((p) => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </Select>
            <Select aria-label={t('realEstate.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              <option value="">{t('realEstate.filters.allStatuses')}</option>
              {CONTRACT_STATUSES.map((s) => (
                <option key={s} value={s}>{t(`realEstate.contractStatus.${s}`)}</option>
              ))}
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card><EmptyState title={t('common.noResults')} /></Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-36">{t('realEstate.cols.code')}</Th>
                    <Th>{t('realEstate.cols.buyer')}</Th>
                    <Th>{t('realEstate.cols.unit')}</Th>
                    <Th>{t('realEstate.cols.project')}</Th>
                    <Th className="w-28">{t('realEstate.cols.date')}</Th>
                    <Th className="w-32">{t('realEstate.cols.status')}</Th>
                    <Th num className="w-20">{t('realEstate.cols.installments')}</Th>
                    <Th num>{t('realEstate.cols.price')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/real-estate/contracts/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/real-estate/contracts/${r.id}`)}>
                      <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                      <Td>{r.partyName}</Td>
                      <Td>{unitLabel(r)}</Td>
                      <Td className="text-muted">{r.projectCode}</Td>
                      <Td className="text-muted">{formatDateTR(r.contractDate)}</Td>
                      <Td><ContractStatusBadge status={r.status} /></Td>
                      <Td num>{r.installmentCount}</Td>
                      <Td num>{moneyIn(r.price, r.currencyCode)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}
    </>
  );
}
