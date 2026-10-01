import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Card, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { formatDateTR, money } from '../../lib/format';
import { useCompany } from '../../lib/session';
import { useCQuery } from '../../lib/queries';
import type { ApprovalRequestRow } from '../../lib/types';

/** Onay kutusu: sıradaki adımı bu kullanıcıya düşen bekleyen talepler. */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const base = useCompany().baseCurrency;
  const { data, isPending } = useCQuery<{ requests: ApprovalRequestRow[] }>(['approvals', 'inbox'], '/api/approvals/inbox');
  const rows = data?.requests ?? [];
  return (
    <>
      <PageHeader title={t('subcontracts.approval.inboxTitle')} description={t('subcontracts.approval.inboxSubtitle')} />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-5" />} title={t('subcontracts.approval.inboxEmpty')} description={t('subcontracts.approval.inboxEmptyDesc')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('subcontracts.approval.cols.doc')}</Th>
                <Th className="w-32">{t('subcontracts.approval.cols.requested')}</Th>
                <Th>{t('subcontracts.approval.cols.step')}</Th>
                <Th num>{t('subcontracts.approval.cols.amount', { currency: base })}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const step = r.steps.find((s) => s.status === 'pending');
                const href = r.docType === 'purchase_request' ? `/purchasing/requests/${r.docId}` : r.docType === 'variation_order' ? `/variation-orders/${r.docId}` : `/progress-payments/${r.docId}`;
                return (
                  <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(href)} onKeyDown={(e) => e.key === 'Enter' && navigate(href)}>
                    <Td>{t(`subcontracts.approval.docTypes.${r.docType}`)}</Td>
                    <Td className="text-muted">{formatDateTR(r.requestedAt.slice(0, 10))}</Td>
                    <Td>{step ? `${step.stepNo}/${r.steps.length} — ${step.label ?? t('subcontracts.approval.defaultStep')}` : '—'}</Td>
                    <Td num>{money(r.amount)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
