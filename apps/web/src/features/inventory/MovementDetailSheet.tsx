import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { StockDocDetail } from '../../lib/types';
import { DocTypeBadge, STOCK_INVALIDATE, qtyText, useUnitLabel } from './common';

interface Props {
  /** Açık belge; null ise kapalı */
  id: string | null;
  onClose: () => void;
  /** Ters kayıt oluşunca yeni belgeye geç */
  onOpen: (id: string) => void;
}

/** Stok belgesi ayrıntısı (yan panel) ve ters kayıt. */
export function MovementDetailSheet({ id, onClose, onOpen }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const canMove = useCan()('inventory.move');
  const { data, isPending, error } = useCQuery<StockDocDetail>(['stock-doc', id], id ? `/api/stock-documents/${id}` : null);
  const [reversing, setReversing] = useState(false);
  const [revDate, setRevDate] = useState(todayIso());

  const reverse = useCMutation(
    (v: { id: string; docDate: string }, call) => call<StockDocDetail>(`/api/stock-documents/${v.id}/reverse`, { method: 'POST', body: { docDate: v.docDate } }),
    [...STOCK_INVALIDATE, ['dashboard']],
  );

  const doc = data?.document;
  const reversible = !!doc && canMove && !doc.reversedById && !doc.reversalOfId;

  return (
    <>
      <Sheet
        wide
        open={!!id}
        onOpenChange={(o) => !o && onClose()}
        title={doc ? doc.docNo : t('inventory.movements.title')}
        description={doc ? `${formatDateTR(doc.docDate)} · ${t(`inventory.docTypes.${doc.type}`)}` : undefined}
        footer={
          reversible ? (
            <Button onClick={() => setReversing(true)}>
              <Undo2 className="size-4" aria-hidden />
              {t('inventory.mdetail.reverse')}
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <Callout tone="danger">{errorMessage(error)}</Callout>
        ) : isPending || !data || !doc ? (
          <PageLoading />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <DocTypeBadge type={doc.type} />
              {doc.reversalOfId && <Badge>{t('inventory.movements.reversal')}</Badge>}
              {doc.reversedById && <Badge tone="danger">{t('inventory.movements.reversed')}</Badge>}
            </div>
            {doc.reversedById && (
              <Callout tone="warning">
                {t('inventory.mdetail.reversedBy', { no: doc.reversedByNo })}{' '}
                <button className="font-medium text-brand hover:underline" onClick={() => onOpen(doc.reversedById!)}>
                  {doc.reversedByNo}
                </button>
              </Callout>
            )}
            {doc.reversalOfId && (
              <Callout>
                {t('inventory.mdetail.reversalOf', { no: doc.reversalOfNo })}{' '}
                <button className="font-medium text-brand hover:underline" onClick={() => onOpen(doc.reversalOfId!)}>
                  {doc.reversalOfNo}
                </button>
              </Callout>
            )}

            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted">{doc.type === 'transfer' ? t('inventory.mform.fromWarehouse') : t('inventory.mdetail.warehouse')}</dt>
                <dd className="mt-0.5 font-medium">{doc.warehouseName}</dd>
              </div>
              {doc.toWarehouseName && (
                <div>
                  <dt className="text-muted">{t('inventory.mdetail.toWarehouse')}</dt>
                  <dd className="mt-0.5 font-medium">{doc.toWarehouseName}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted">{t('inventory.mdetail.date')}</dt>
                <dd className="mt-0.5 font-medium">{formatDateTR(doc.docDate)}</dd>
              </div>
              {doc.description && (
                <div className="sm:col-span-3">
                  <dt className="text-muted">{t('inventory.mform.description')}</dt>
                  <dd className="mt-0.5">{doc.description}</dd>
                </div>
              )}
            </dl>

            {doc.countId && (
              <Link to={`/inventory/counts/${doc.countId}`} className="text-sm font-medium text-brand hover:underline" onClick={onClose}>
                {t('inventory.mdetail.fromCount')}
              </Link>
            )}

            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('inventory.mdetail.item')}</Th>
                    <Th num>{t('inventory.mdetail.qty')}</Th>
                    <Th num>{t('inventory.mdetail.unitCost')}</Th>
                    <Th num>
                      {t('inventory.mdetail.value')} ({company.baseCurrency})
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <Tr key={l.lineNo}>
                      <Td>
                        <span className="font-medium">{l.itemName}</span>
                        <span className="ml-2 font-mono text-xs text-muted">{l.itemCode}</span>
                        {l.currencyCode && l.currencyCode !== company.baseCurrency && l.unitCost && l.fxRate && (
                          <span className="block text-xs text-muted">
                            {t('inventory.mdetail.fx', { cost: money(l.unitCost, 4), currency: l.currencyCode, rate: money(l.fxRate, 4) })}
                          </span>
                        )}
                        {l.adjustment && (
                          <span className="block text-xs text-warning">
                            {t('inventory.mdetail.adjustment')}: {money(l.adjustment)} {company.baseCurrency}
                          </span>
                        )}
                      </Td>
                      <Td num>
                        {l.direction === 'out' ? '−' : l.direction === 'in' ? '+' : ''}
                        {qtyText(l.qty)} {unitLabel(l.unit)}
                      </Td>
                      <Td num className="text-muted">{l.unitCostBase ? money(l.unitCostBase, 4) : '—'}</Td>
                      <Td num className="font-medium">{money(l.value)}</Td>
                    </Tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-2 font-semibold">
                    <Td colSpan={3}>{t('inventory.mdetail.total')}</Td>
                    <Td num>{money(data.totalValue)}</Td>
                  </tr>
                </tfoot>
              </Table>
            </TableWrap>
          </div>
        )}
      </Sheet>

      <Modal
        open={reversing}
        onOpenChange={setReversing}
        title={t('inventory.mdetail.reverseTitle')}
        description={t('inventory.mdetail.reverseDesc')}
        footer={
          <>
            <Button onClick={() => setReversing(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={reverse.isPending}
              disabled={!revDate}
              onClick={() =>
                id &&
                reverse.mutate(
                  { id, docDate: revDate },
                  {
                    onSuccess: (res) => {
                      toast.success(t('inventory.mdetail.reversedOk'));
                      setReversing(false);
                      onOpen(res.document.id);
                    },
                    onError: (e) => {
                      setReversing(false);
                      toast.error(errorMessage(e));
                    },
                  },
                )
              }
            >
              {t('inventory.mdetail.reverse')}
            </Button>
          </>
        }
      >
        <Field label={t('inventory.mdetail.reverseDate')}>{(fid) => <Input id={fid} type="date" value={revDate} onChange={(e) => setRevDate(e.target.value)} />}</Field>
      </Modal>
    </>
  );
}
