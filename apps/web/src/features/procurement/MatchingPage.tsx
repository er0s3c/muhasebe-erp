import { Link2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompany } from '../../lib/session';
import { useNavigate } from 'react-router-dom';
import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { OrderMatchRow } from '../../lib/types';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { useServerDraft } from '../../lib/useServerDraft';

const stateOf = (r: OrderMatchRow) => (r.hasExcess ? 'excess' : dec(r.uninvoicedReceiptAmount).gt(0) ? 'uninvoiced' : dec(r.receivedAmount).isZero() ? 'open' : 'ok');
const TONE = { ok: 'success', uninvoiced: 'warning', excess: 'danger', open: 'neutral' } as const;

/** Sipariş bazında sipariş / mal kabul / fatura karşılaştırması ve tolerans ayarı. */
export function OrderMatchingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projectBased = useCompany().sector === 'CONSTRUCTION';
  const toast = useToast();
  const can = useCan();
  const { data, isPending, error: OrderMatchingPageQueryError, refetch: OrderMatchingPageQueryRetry, isFetching: OrderMatchingPageQueryFetching } = useCQuery<{ orders: OrderMatchRow[] }>(['procurement', 'matching'], '/api/procurement/matching');
  const rows = data?.orders ?? [];
  if (OrderMatchingPageQueryError && !data) return <ErrorState error={OrderMatchingPageQueryError} onRetry={() => void OrderMatchingPageQueryRetry()} retrying={OrderMatchingPageQueryFetching} />;
  return (
    <>
      <PageHeader title={t('procurement.match.title')} description={t('procurement.match.subtitle')} />
      {isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Link2 className="size-5" />} title={t('procurement.match.empty')} description={t('procurement.match.emptyDesc')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('procurement.match.cols.order')}</Th>
                <Th>{t('procurement.match.cols.party')}</Th>
                {projectBased && <Th className="w-28">{t('procurement.match.cols.project')}</Th>}
                <Th num>{t('procurement.match.cols.orderedAmount')}</Th>
                <Th num>{t('procurement.match.cols.receivedAmount')}</Th>
                <Th num>{t('procurement.match.cols.uninvoiced')}</Th>
                <Th className="w-36">{t('procurement.match.cols.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = stateOf(r);
                return (
                  <Tr key={r.id} clickable tabIndex={0} onClick={() => navigate(`/purchasing/orders/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/purchasing/orders/${r.id}`)}>
                    <Td className="font-mono text-[13px]">{r.code}</Td>
                    <Td>{r.partyName}</Td>
                    {projectBased && <Td className="text-muted">{r.projectCode}</Td>}
                    <Td num>{moneyIn(r.orderedAmount, r.currencyCode)}</Td>
                    <Td num>{moneyIn(r.receivedAmount, r.currencyCode)}</Td>
                    <Td num>{moneyIn(r.uninvoicedReceiptAmount, r.currencyCode)}</Td>
                    <Td>
                      <Badge tone={TONE[s]}>{t(`procurement.match.state.${s}`)}</Badge>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {can('procurement.read') && <ToleranceCard canEdit={can('procurement.manage')} onSaved={() => toast.success(t('procurement.match.saved'))} />}
    </>
  );
}

function ToleranceCard({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data } = useCQuery<{ settings: { qtyTolerancePct: string; priceTolerancePct: string } }>(['procurement', 'settings'], '/api/procurement/settings');
  const server = useMemo(() => ({ qty: data?.settings.qtyTolerancePct ?? '', price: data?.settings.priceTolerancePct ?? '' }), [data]);
  const { value: form, update, reset } = useServerDraft(server);
  const { qty, price } = form;
  const save = useCMutation(
    (_: void, call) => call('/api/procurement/settings', { method: 'PUT', body: { qtyTolerancePct: qty, priceTolerancePct: price } }),
    [['procurement']],
  );
  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader title={t('procurement.match.settingsTitle')} description={t('procurement.match.settingsDesc')} />
      <div className="flex flex-wrap items-end gap-4 p-4">
        <Field label={t('procurement.match.qtyTol')}>{(id) => <MoneyInput id={id} className="w-32" value={qty} disabled={!canEdit} onChange={(v) => update({ qty: v })} decimals={0} maxDecimals={4} />}</Field>
        <Field label={t('procurement.match.priceTol')}>{(id) => <MoneyInput id={id} className="w-32" value={price} disabled={!canEdit} onChange={(v) => update({ price: v })} decimals={0} maxDecimals={4} />}</Field>
        {canEdit && (
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { reset(); onSaved(); }, onError: (e) => toast.error(errorMessage(e)) })}>
            {t('common.save')}
          </Button>
        )}
      </div>
    </Card>
  );
}
