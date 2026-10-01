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
import type { SubcontractRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { SUBCONTRACT_STATUSES, SubcontractStatusBadge } from './common';
import { SubcontractFormSheet } from './SubcontractFormSheet';

export function SubcontractsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useCan()('subcontracts.manage');
  const { projects } = useProjectOptions();
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');

  const qs = useMemo(() => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (status) q.set('status', status);
    return q.toString();
  }, [projectId, status]);
  const { data, isPending } = useCQuery<{ subcontracts: SubcontractRow[] }>(['subcontracts', 'list', qs], `/api/subcontracts?${qs}`);
  const rows = data?.subcontracts ?? [];
  const filtered = !!(projectId || status);

  const addButton = canManage && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('subcontracts.add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('subcontracts.title')}
        description={t('subcontracts.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu exportKey="subcontract-register" params={projectId ? { projectId } : {}} print={false} />
            {addButton}
          </div>
        }
      />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<FileSignature className="size-5" />} title={t('subcontracts.empty')} description={t('subcontracts.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select aria-label={t('subcontracts.filters.project')} value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-64">
              <option value="">{t('subcontracts.filters.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label={t('subcontracts.filters.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
              <option value="">{t('subcontracts.filters.allStatuses')}</option>
              {SUBCONTRACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`subcontracts.status.${s}`)}
                </option>
              ))}
            </Select>
          </div>
          {rows.length === 0 ? (
            <Card>
              <EmptyState title={t('common.noResults')} />
            </Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-28">{t('subcontracts.cols.code')}</Th>
                    <Th>{t('subcontracts.cols.title')}</Th>
                    <Th>{t('subcontracts.cols.party')}</Th>
                    <Th>{t('subcontracts.cols.project')}</Th>
                    <Th className="w-28">{t('subcontracts.cols.status')}</Th>
                    <Th num>{t('subcontracts.cols.amount')}</Th>
                    <Th className="w-28">{t('subcontracts.cols.end')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/subcontracts/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/subcontracts/${r.id}`)}>
                      <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                      <Td>{r.title}</Td>
                      <Td>{r.partyName}</Td>
                      <Td className="text-muted">{r.projectCode}</Td>
                      <Td>
                        <SubcontractStatusBadge status={r.status} />
                      </Td>
                      <Td num>{moneyIn(r.contractAmount, r.currencyCode)}</Td>
                      <Td className="text-muted">{r.endDate ? formatDateTR(r.endDate) : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}
      <SubcontractFormSheet open={adding} onOpenChange={setAdding} onSaved={(id) => navigate(`/subcontracts/${id}`)} />
    </>
  );
}
