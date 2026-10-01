import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import type { ProgressRow } from '../../lib/types';
import { ProgressStatusBadge } from './common';

/** Sözleşmenin (ya da tüm şirketin) hakediş listesi. `subcontractId` verilirse "yeni hakediş" düğmesi çıkar. */
export function ProgressList({ subcontractId, canCreate }: { subcontractId?: string; canCreate?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const qs = subcontractId ? `?subcontractId=${subcontractId}` : '';
  const { data, isPending } = useCQuery<{ payments: ProgressRow[] }>(['progress', 'list', subcontractId ?? 'all'], `/api/progress-payments${qs}`);
  const rows = data?.payments ?? [];
  const add =
    subcontractId && canCreate && can('subcontracts.manage') ? (
      <Button variant="primary" onClick={() => navigate(`/progress-payments/new?subcontractId=${subcontractId}`)}>
        <Plus className="size-4" aria-hidden />
        {t('subcontracts.progress.add')}
      </Button>
    ) : undefined;

  if (isPending) return <PageLoading />;
  return (
    <div className="flex flex-col gap-4">
      {add && <div className="flex justify-end">{add}</div>}
      {rows.length === 0 ? (
        <Card>
          <EmptyState title={t('subcontracts.progress.empty')} description={t('subcontracts.progress.emptyDesc')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-36">{t('subcontracts.progress.cols.number')}</Th>
                <Th className="w-16">{t('subcontracts.progress.cols.no')}</Th>
                {!subcontractId && <Th>{t('subcontracts.progress.cols.contract')}</Th>}
                {!subcontractId && <Th>{t('subcontracts.progress.cols.party')}</Th>}
                <Th className="w-28">{t('subcontracts.progress.cols.period')}</Th>
                <Th className="w-28">{t('subcontracts.progress.cols.status')}</Th>
                <Th num>{t('subcontracts.progress.cols.gross')}</Th>
                <Th num>{t('subcontracts.progress.cols.net')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/progress-payments/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/progress-payments/${r.id}`)}>
                  <Td className="font-mono text-[13px] text-muted">{r.number ?? '—'}</Td>
                  <Td>{r.paymentNo}</Td>
                  {!subcontractId && <Td className="text-muted">{r.subcontractCode}</Td>}
                  {!subcontractId && <Td>{r.partyName}</Td>}
                  <Td className="text-muted">{formatDateTR(r.periodEnd)}</Td>
                  <Td>
                    <ProgressStatusBadge status={r.status} />
                  </Td>
                  <Td num>{moneyIn(r.gross, r.currencyCode)}</Td>
                  <Td num>{moneyIn(r.net, r.currencyCode)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

export function ProgressPaymentsPage() {
  const { t } = useTranslation();
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">{t('subcontracts.progress.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('subcontracts.progress.subtitle')}</p>
        </div>
      </div>
      <ProgressList />
    </>
  );
}
