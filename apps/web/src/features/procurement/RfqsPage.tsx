import { Scale } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { RfqListRow } from '../../lib/types';
import { RfqStatusBadge } from './common';

export function RfqsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending } = useCQuery<{ rfqs: RfqListRow[] }>(['rfqs', 'list'], '/api/rfqs');
  const rows = data?.rfqs ?? [];
  return (
    <>
      <PageHeader title={t('procurement.rfqs.title')} description={t('procurement.rfqs.subtitle')} />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<Scale className="size-5" />} title={t('procurement.rfqs.empty')} description={t('procurement.rfqs.emptyDesc')} /></Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-32">{t('procurement.cols.code')}</Th>
                <Th>{t('procurement.cols.request')}</Th>
                <Th>{t('procurement.cols.project')}</Th>
                <Th className="w-28">{t('procurement.cols.status')}</Th>
                <Th className="w-28">{t('procurement.cols.dueDate')}</Th>
                <Th num className="w-24">{t('procurement.cols.offers')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/purchasing/rfqs/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchasing/rfqs/${r.id}`)}>
                  <Td className="font-mono text-[13px] text-muted">{r.code}</Td>
                  <Td>{r.requestCode} — {r.title}</Td>
                  <Td className="text-muted">{r.projectCode}</Td>
                  <Td><RfqStatusBadge status={r.status} /></Td>
                  <Td className="text-muted">{r.dueDate ? formatDateTR(r.dueDate) : '—'}</Td>
                  <Td num>{r.offerCount}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
