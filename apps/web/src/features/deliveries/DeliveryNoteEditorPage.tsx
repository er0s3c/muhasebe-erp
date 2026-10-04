import { ArrowLeft, Ban, FileText, Printer, Undo2 } from 'lucide-react';
import { PrintSignatures } from '../../components/print/PrintBlocks';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DELIVERY_NOTE_TYPES, DELIVERY_NOTE_TYPE_META, dec, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { DeliveryNoteDetail, DeliveryNoteType } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';
import { DELIVERY_INVALIDATE, DeliveryInvoicingBadge, DeliveryStatusBadge } from './common';
import { DeliveryNoteForm, NOTE_LIST } from './DeliveryNoteForm';
import { fmtDate } from '../../lib/license';

/**
 * /delivery-notes/new ve /delivery-notes/:id: taslaksa düzenlenebilir form,
 * kaydedilmiş ya da iptal edilmişse salt okunur görünüm (yazdırma, fatura oluşturma, iptal).
 */
export function DeliveryNoteEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const canManage = useCan()('deliveries.manage');

  const typeParam = params.get('type');
  const newType: DeliveryNoteType = (DELIVERY_NOTE_TYPES as readonly string[]).includes(typeParam ?? '') ? (typeParam as DeliveryNoteType) : 'sales';
  const detail = useCQuery<DeliveryNoteDetail>(['delivery-note', id], id ? `/api/delivery-notes/${id}` : null);

  if (!id) {
    if (!canManage) return <Callout tone="danger">{t('errors.FORBIDDEN')}</Callout>;
    return <DeliveryNoteForm key={`new-${newType}`} type={newType} />;
  }
  if (detail.error) return <Callout tone="danger">{errorMessage(detail.error)}</Callout>;
  if (!detail.data) return <PageLoading />;
  if (detail.data.note.status === 'draft' && canManage) {
    return <DeliveryNoteForm key={id} type={detail.data.note.type} initial={detail.data} />;
  }
  return <DeliveryNoteView key={id} data={detail.data} />;
}

function DeliveryNoteView({ data }: { data: DeliveryNoteDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const { note, lines, invoices } = data;
  const meta = DELIVERY_NOTE_TYPE_META[note.type];
  const base = company.baseCurrency;
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayIso());
  const [reason, setReason] = useState('');

  const cancel = useCMutation(
    (v: { date: string; reason: string }, call) => call<DeliveryNoteDetail>(`/api/delivery-notes/${note.id}/cancel`, { method: 'POST', body: v }),
    DELIVERY_INVALIDATE,
  );

  const listPath = NOTE_LIST[note.type].path;
  const side = NOTE_LIST[note.type].key;
  const showCost = note.type === 'purchase';
  const canReturn = !meta.isReturn && note.status === 'posted' && can('deliveries.manage') && lines.some((l) => l.returnableQty && Number(l.returnableQty) > 0);
  const hasRemaining = lines.some((l) => dec(l.remainingQty).gt(0));
  const canInvoice = note.status === 'posted' && hasRemaining && can('invoices.manage');
  const canCancel = note.status === 'posted' && can('deliveries.post');
  const posted = note.status !== 'draft';

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`deliveries.${side}.title`)}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading">{note.noteNo}</h1>
            <Badge>{t(`deliveries.types.${note.type}`)}</Badge>
            <DeliveryStatusBadge status={note.status} />
            <DeliveryInvoicingBadge state={note.invoicing} />
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link to={`/parties/${note.partyId}`} className="link">
              {note.partyName}
            </Link>{' '}
            · {formatDateTR(note.noteDate)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden />
            {t('deliveries.view.print')}
          </Button>
          {canReturn && (
            <Button onClick={() => navigate(`/delivery-notes/new?type=${meta.returnType}&returnOf=${note.id}`)}>
              <Undo2 className="size-4" aria-hidden />
              {t('deliveries.view.createReturn')}
            </Button>
          )}
          {canInvoice && (
            <Button variant="primary" onClick={() => navigate(`/invoices/new?type=${meta.invoiceType}&deliveryNote=${note.id}`)}>
              <FileText className="size-4" aria-hidden />
              {meta.isReturn ? t('deliveries.view.createCredit') : t('deliveries.view.createInvoice')}
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              <Ban className="size-4" aria-hidden />
              {t('deliveries.view.cancel')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {note.status === 'cancelled' && (
          <Callout tone="danger" title={t('deliveries.view.cancelledTitle', { date: note.cancelledAt ? fmtDate(note.cancelledAt) : '' })}>
            {note.cancelReason}
            {note.cancelStockDocumentId && (
              <>
                {' · '}
                <Link to={`/inventory/movements?open=${note.cancelStockDocumentId}`} className="link">
                  {note.cancelStockDocumentNo}
                </Link>
              </>
            )}
          </Callout>
        )}
        {note.status === 'posted' && note.invoicing === 'invoiced' && <Callout tone="info">{t('deliveries.view.allInvoiced')}</Callout>}

        <Card className="p-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label={t('deliveries.form.warehouse')}>{note.warehouseName}</Item>
            {note.externalNo && <Item label={t('deliveries.form.externalNo')}>{note.externalNo}</Item>}
            {note.returnOfId && (
              <Item label={t('deliveries.view.returnOf')}>
                <Link to={`/delivery-notes/${note.returnOfId}`} className="link">
                  {note.returnOfNo}
                </Link>
              </Item>
            )}
            {data.returns.length > 0 && (
              <Item label={t('deliveries.view.returns')}>
                {data.returns.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ', '}
                    <Link to={`/delivery-notes/${r.id}`} className="link">
                      {r.noteNo}
                    </Link>
                    {r.status === 'cancelled' && <span className="text-muted"> ({t('deliveries.status.cancelled')})</span>}
                  </span>
                ))}
              </Item>
            )}
            {note.vehiclePlate && <Item label={t('deliveries.view.vehicle')}>{note.vehiclePlate}</Item>}
            {note.driverName && <Item label={t('deliveries.view.driver')}>{note.driverName}</Item>}
            {note.stockDocumentId && (
              <Item label={t('deliveries.view.stockDoc')}>
                <Link to={`/inventory/movements?open=${note.stockDocumentId}`} className="link">
                  {note.stockDocumentNo}
                </Link>
              </Item>
            )}
            {invoices.length > 0 && (
              <Item label={t('deliveries.view.invoices')}>
                {invoices.map((inv, i) => (
                  <span key={inv.id}>
                    {i > 0 && ', '}
                    <Link to={`/invoices/${inv.id}`} className="link">
                      {inv.invoiceNo}
                    </Link>
                    {inv.status === 'cancelled' && <span className="text-muted"> ({t('invoices.status.cancelled')})</span>}
                  </span>
                ))}
              </Item>
            )}
            {note.description && (
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-muted">{t('common.description')}</dt>
                <dd className="mt-0.5">{note.description}</dd>
              </div>
            )}
          </dl>
        </Card>

        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('deliveries.form.item')}</Th>
                <Th num>{t('deliveries.form.quantity')}</Th>
                {posted && note.status === 'posted' && (
                  <>
                    <Th num className="print:hidden">{meta.isReturn ? t('deliveries.view.credited') : t('deliveries.view.invoiced')}</Th>
                    <Th num className="print:hidden">{t('deliveries.view.remaining')}</Th>
                    {!meta.isReturn && <Th num className="print:hidden">{t('deliveries.view.returned')}</Th>}
                  </>
                )}
                {showCost && <Th num>{t('deliveries.view.unitCost')}</Th>}
                {posted && (
                  <Th num className="print:hidden">
                    {t('deliveries.view.value')} ({currencySymbol(base)})
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    <span>{l.description}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{l.itemCode}</span>
                    {l.serials && l.serials.length > 0 && (
                      <span className="block text-xs text-muted" data-testid="line-serials">
                        {t('serials.title')}: <span className="font-mono">{l.serials.join(', ')}</span>
                      </span>
                    )}
                    {l.salesOrderNo && (
                      <Link to={`/sales/docs/${l.salesOrderId}`} className="link ml-2 text-xs print:hidden">
                        {l.salesOrderNo}
                      </Link>
                    )}
                  </Td>
                  <Td num>
                    {qtyText(l.quantity)} {l.unit ? unitLabel(l.unit) : ''}
                  </Td>
                  {posted && note.status === 'posted' && (
                    <>
                      <Td num className="text-muted print:hidden">{qtyText(l.invoicedQty) || '0'}</Td>
                      <Td num className="print:hidden">{qtyText(l.remainingQty) || '0'}</Td>
                      {!meta.isReturn && <Td num className="text-muted print:hidden">{qtyText(l.returnedQty ?? '0') || '0'}</Td>}
                    </>
                  )}
                  {showCost && (
                    <Td num className="text-muted">
                      {l.unitCost ? moneyIn(l.unitCost, l.currencyCode ?? base, 4) : <Badge tone="warning">{t('deliveries.view.noPrice')}</Badge>}
                    </Td>
                  )}
                  {posted && (
                    <Td num className="print:hidden">
                      {l.stockValue ? money(l.stockValue) : '—'}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>

        <p className="text-xs text-muted print:hidden">{t('deliveries.view.noStockNote')}</p>
        <p className="text-xs text-muted">{t('deliveries.view.internalNote')}</p>
        <PrintSignatures labels={[t('printDoc.delivered'), t('printDoc.receiver')]} />
      </div>

      <Modal
        open={cancelling}
        onOpenChange={setCancelling}
        title={t('deliveries.view.cancelTitle')}
        description={t('deliveries.view.cancelDesc')}
        footer={
          <>
            <Button onClick={() => setCancelling(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              disabled={reason.trim().length < 3 || !cancelDate}
              onClick={() =>
                cancel.mutate(
                  { date: cancelDate, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('deliveries.view.cancelledMsg'));
                      setCancelling(false);
                    },
                    onError: (e) => {
                      setCancelling(false);
                      toast.error(errorMessage(e));
                    },
                  },
                )
              }
            >
              {t('deliveries.view.cancel')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('deliveries.view.cancelDate')}>{(fid) => <Input id={fid} type="date" value={cancelDate} min={note.noteDate} onChange={(e) => setCancelDate(e.target.value)} />}</Field>
          <Field label={t('deliveries.view.cancelReason')} required>{(fid) => <Input id={fid} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
      </Modal>
    </>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
