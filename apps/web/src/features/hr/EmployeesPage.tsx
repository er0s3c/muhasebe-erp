import { Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { EmployeeRow } from '../../lib/types';
import { EmployeeFormSheet } from './EmployeeFormSheet';
import { EmployeeStatusBadge } from './common';

export function EmployeesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  }, [status, q]);
  const { data, isPending } = useCQuery<{ employees: EmployeeRow[] }>(['employees', 'list', qs], `/api/employees?${qs}`);
  const rows = data?.employees ?? [];
  const filtered = !!(status || q.trim());
  const addButton = can('hr.manage') && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('hr.add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('hr.title')}
        description={t('hr.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu exportKey="employees" params={{ status }} print={false} disabled={rows.length === 0} />
            {addButton}
          </div>
        }
      />
      <div className="mb-4">
        <Callout tone="info">{t('hr.privacyNote')}</Callout>
      </div>
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 && !filtered ? (
        <Card>
          <EmptyState icon={<Users className="size-5" />} title={t('hr.empty')} description={t('hr.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Input aria-label={t('hr.search')} placeholder={t('hr.search')} value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
            <Select aria-label={t('hr.cols.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">{t('hr.allStatuses')}</option>
              <option value="active">{t('hr.status.active')}</option>
              <option value="left">{t('hr.status.left')}</option>
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
                    <Th className="w-24">{t('hr.cols.code')}</Th>
                    <Th>{t('hr.cols.name')}</Th>
                    <Th>{t('hr.cols.department')}</Th>
                    <Th>{t('hr.cols.jobTitle')}</Th>
                    <Th className="w-32">{t('hr.cols.id')}</Th>
                    <Th className="w-28">{t('hr.cols.hire')}</Th>
                    <Th className="w-28">{t('hr.cols.status')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/hr/employees/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/hr/employees/${r.id}`)}>
                      <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                      <Td>{r.fullName}</Td>
                      <Td className="text-muted">{r.department ?? '—'}</Td>
                      <Td className="text-muted">{r.jobTitle ?? '—'}</Td>
                      <Td className="font-mono text-[13px] text-muted">{r.idMasked ?? '—'}</Td>
                      <Td className="text-muted">{r.hireDate ? formatDateTR(r.hireDate) : '—'}</Td>
                      <Td><EmployeeStatusBadge status={r.status} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </div>
      )}
      <EmployeeFormSheet open={adding} onOpenChange={setAdding} onSaved={(id) => navigate(`/hr/employees/${id}`)} />
    </>
  );
}
