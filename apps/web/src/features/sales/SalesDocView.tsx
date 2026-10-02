import { ArrowLeft, Ban, Check, FileText, Printer, Truck, Undo2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { dec } from '@erp/shared';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation } from '../../lib/queries';
import type { SalesDocDetail } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';
import { FulfilmentBadges, SALES_INVALIDATE, SalesStatusBadge } from './common';

type Action = 'send' | 'accept' | 'reject' | 'reopen' | 'cancel' | 'confirm' | 'close';

/**
 * Teklif/sipariş görünümü: durum eylemleri, dönüşümler (teklif → sipariş, sipariş → irsaliye/fatura), karşılanma (teslim/fatura) miktarları,
 * durum geçmişi ve yazdırma (şirket antetli, imza bloklu). Teklif/sipariş yevmiye ve stok hareketi yazmaz.
 */
export function SalesDocView({ data }: { data: SalesDocDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const { doc, lines, events, notes, invoices } = data;
  const cur = doc.currencyCode;
  const isOrder = doc.kind === 'order';
  const canManage = can('invoices.manage');
  const listPath = isOrder ? '/sales/orders' : '/sales/quotes';

  const [reasonFor, setReasonFor] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [includeUndelivered, setIncludeUndelivered] = useState(false);

  const act = useCMutation((v: { action: Action; reason?: string }, c) => c<SalesDocDetail>(`/api/sales-docs/${doc.id}/${v.action}`, { method: 'POST', body: v.reason ? { reason: v.reason } : {} }), SALES_INVALIDATE);
  const convert = useCMutation((_: void, c) => c<{ orderId: string }>(`/api/sales-docs/${doc.id}/convert`, { method: 'POST', body: {} }), SALES_INVALIDATE);
  const toDelivery = useCMutation((_: void, c) => c<{ noteId: string }>(`/api/sales-docs/${doc.id}/delivery-note`, { method: 'POST', body: {} }), SALES_INVALIDATE);
  const toInvoice = useCMutation((v: { includeUndelivered: boolean }, c) => c<{ invoiceId: string }>(`/api/sales-docs/${doc.id}/invoice`, { method: 'POST', body: v }), SALES_INVALIDATE);

  const run = (action: Action, text?: string) =>
    act.mutate(
      { action, reason: text },
      {
        onSuccess: () => {
          toast.success(t(`sales.actions.done.${action}` as never));
          setReasonFor(null);
          setReason('');
        },
        onError: (e) => {
          setReasonFor(null);
          toast.error(errorMessage(e));
        },
      },
    );

  const hasDeliverable = lines.some((l) => l.isGoods && dec(l.remainingDeliverable ?? 0).gt(0));
  const hasInvoiceable = lines.some((l) => dec(l.remainingInvoiceable ?? 0).gt(0));
  const needsReason = (a: Action) => a === 'cancel' || a === 'reject';

  const button = (action: Action, icon: ReactNode, variant: 'primary' | 'danger' | 'secondary' = 'secondary') => (
    <Button key={action} variant={variant} loading={act.isPending && act.variables?.action === action} onClick={() => (needsReason(action) || action === 'close' ? setReasonFor(action) : run(action))}>
      {icon}
      {t(`sales.actions.${action}` as never)}
    </Button>
  );

  const actions: ReactNode[] = [];
  if (canManage) {
    if (doc.kind === 'quote' && doc.status === 'sent') {
      actions.push(button('accept', <Check className="size-4" aria-hidden />, 'primary'), button('reject', <X className="size-4" aria-hidden />), button('reopen', <Undo2 className="size-4" aria-hidden />));
    }
    if (doc.kind === 'quote' && doc.status === 'accepted') {
      actions.push(
        <Button
          key="convert"
          variant="primary"
          loading={convert.isPending}
          onClick={() =>
            convert.mutate(undefined, {
              onSuccess: (r) => {
                toast.success(t('sales.actions.done.convert'));
                navigate(`/sales/docs/${r.orderId}`);
              },
              onError: (e) => toast.error(errorMessage(e)),
            })
          }
        >
          <Check className="size-4" aria-hidden />
          {t('sales.actions.convert')}
        </Button>,
      );
    }
    if (isOrder && doc.status === 'confirmed') {
      if (can('deliveries.manage') && hasDeliverable) {
        actions.push(
          <Button
            key="delivery"
            variant="primary"
            loading={toDelivery.isPending}
            onClick={() =>
              toDelivery.mutate(undefined, {
                onSuccess: (r) => {
                  toast.success(t('sales.actions.done.delivery'));
                  navigate(`/delivery-notes/${r.noteId}`);
                },
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            <Truck className="size-4" aria-hidden />
            {t('sales.actions.delivery')}
          </Button>,
        );
      }
    }
    if (isOrder && (doc.status === 'confirmed' || doc.status === 'closed') && hasInvoiceable) {
      actions.push(
        <Button key="invoice" onClick={() => setInvoiceOpen(true)}>
          <FileText className="size-4" aria-hidden />
          {t('sales.actions.invoice')}
        </Button>,
      );
    }
    if (isOrder && doc.status === 'confirmed') actions.push(button('close', <Check className="size-4" aria-hidden />));
    if (!['rejected', 'converted', 'closed', 'cancelled', 'draft'].includes(doc.status)) {
      actions.push(button('cancel', <Ban className="size-4" aria-hidden />, 'danger'));
    }
  }

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`sales.${doc.kind}.title`)}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading">{doc.docNo ?? t(`sales.kind.${doc.kind}`)}</h1>
            <Badge>{t(`sales.kind.${doc.kind}`)}</Badge>
            <SalesStatusBadge status={doc.status} kind={doc.kind} expired={doc.expired} />
            {isOrder && ['confirmed', 'closed'].includes(doc.status) && <FulfilmentBadges f={doc.fulfilment} />}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link to={`/parties/${doc.partyId}`} className="link">
              {doc.partyName}
            </Link>{' '}
            · {formatDateTR(doc.docDate)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden />
            {t('sales.actions.print')}
          </Button>
          {actions}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {doc.expired && <Callout tone="warning">{t('sales.view.expiredNote', { date: doc.validUntil ? formatDateTR(doc.validUntil) : '' })}</Callout>}
        {doc.status === 'converted' && doc.orderId && (
          <Callout tone="info">
            {t('sales.view.convertedTo')}{' '}
            <Link to={`/sales/docs/${doc.orderId}`} className="link">
              {doc.orderNo ?? t('sales.kind.order')}
            </Link>
          </Callout>
        )}

        <Card className="p-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label={t('sales.party')}>{doc.partyName}</Item>
            <Item label={t('sales.form.docDate')}>{formatDateTR(doc.docDate)}</Item>
            {doc.validUntil && <Item label={t('sales.validUntil')}>{formatDateTR(doc.validUntil)}</Item>}
            {doc.deliveryDate && <Item label={t('sales.deliveryDate')}>{formatDateTR(doc.deliveryDate)}</Item>}
            <Item label={t('sales.form.currency')}>{cur}</Item>
            <Item label={t('sales.view.priceMode')}>{doc.vatIncluded ? t('invoices.view.vatIncluded') : t('invoices.view.vatExcluded')}</Item>
            {doc.warehouseName && <Item label={t('sales.form.warehouse')}>{doc.warehouseName}</Item>}
            {doc.quoteId && (
              <Item label={t('sales.view.fromQuote')}>
                <Link to={`/sales/docs/${doc.quoteId}`} className="link">
                  {doc.quoteNo}
                </Link>
              </Item>
            )}
            {doc.notes && (
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-muted">{t('sales.form.notes')}</dt>
                <dd className="mt-0.5 whitespace-pre-line">{doc.notes}</dd>
              </div>
            )}
          </dl>
        </Card>

        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-10">#</Th>
                <Th>{t('sales.form.item')}</Th>
                <Th num>{t('sales.form.quantity')}</Th>
                <Th num>{t('sales.form.unitPrice')}</Th>
                <Th num>{t('sales.form.discount')}</Th>
                <Th num>{t('sales.view.net')}</Th>
                <Th>{t('sales.form.vat')}</Th>
                <Th num>{t('sales.gross')}</Th>
                {isOrder && (
                  <>
                    <Th num className="print:hidden">{t('sales.view.delivered')}</Th>
                    <Th num className="print:hidden">{t('sales.view.invoiced')}</Th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <Tr key={l.id}>
                  <Td className="text-muted">{l.lineNo}</Td>
                  <Td>
                    <span>{l.description}</span>
                    {l.itemCode && <span className="ml-2 font-mono text-xs text-muted">{l.itemCode}</span>}
                  </Td>
                  <Td num>
                    {qtyText(l.quantity)} {l.unit ? unitLabel(l.unit) : ''}
                  </Td>
                  <Td num>{moneyIn(l.unitPrice, cur, 2)}</Td>
                  <Td num className="text-muted">{dec(l.discountPct).isZero() ? '' : `%${qtyText(l.discountPct)}`}</Td>
                  <Td num>{moneyIn(l.net, cur)}</Td>
                  <Td className="text-muted">{l.vatCode ? `${l.vatCode} (%${qtyText(l.vatRate)})` : '—'}</Td>
                  <Td num>{moneyIn(l.gross, cur)}</Td>
                  {isOrder && (
                    <>
                      <Td num className="text-muted print:hidden">{l.isGoods ? qtyText(l.delivered) || '0' : '—'}</Td>
                      <Td num className="text-muted print:hidden">{qtyText(l.invoiced) || '0'}</Td>
                    </>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>

        <div className="flex justify-end">
          <dl className="w-full max-w-xs text-sm">
            <div className="flex justify-between py-1">
              <dt className="text-muted">{t('invoices.netTotal')}</dt>
              <dd className="num">{moneyIn(doc.netTotal, cur)}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted">{t('sales.view.vatTotal')}</dt>
              <dd className="num">{moneyIn(doc.vatTotal, cur)}</dd>
            </div>
            <div className="mt-1 flex justify-between border-t border-text pt-2 text-base">
              <dt>{t('invoices.grossTotal')}</dt>
              <dd className="num">{moneyIn(doc.grossTotal, cur)}</dd>
            </div>
          </dl>
        </div>

        {isOrder && (notes.length > 0 || invoices.length > 0) && (
          <Card className="p-5 print:hidden">
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              {notes.length > 0 && (
                <Item label={t('sales.view.notes')}>
                  {notes.map((n, i) => (
                    <span key={n.id}>
                      {i > 0 && ', '}
                      <Link to={`/delivery-notes/${n.id}`} className="link">
                        {n.noteNo ?? t('deliveries.status.draft')}
                      </Link>
                      {n.status !== 'posted' && <span className="text-muted"> ({t(`deliveries.status.${n.status}`)})</span>}
                    </span>
                  ))}
                </Item>
              )}
              {invoices.length > 0 && (
                <Item label={t('sales.view.invoices')}>
                  {invoices.map((n, i) => (
                    <span key={n.id}>
                      {i > 0 && ', '}
                      <Link to={`/invoices/${n.id}`} className="link">
                        {n.invoiceNo ?? t('invoices.status.draft')}
                      </Link>
                      {n.status !== 'posted' && <span className="text-muted"> ({t(`invoices.status.${n.status}`)})</span>}
                    </span>
                  ))}
                </Item>
              )}
            </dl>
          </Card>
        )}

        {events.length > 0 && (
          <Card className="p-5 print:hidden">
            <h2 className="mb-3 text-sm font-medium">{t('sales.view.history')}</h2>
            <ol className="flex flex-col gap-1.5 text-sm">
              {events.map((e, i) => (
                <li key={i} className="flex flex-wrap gap-x-3 text-muted">
                  <span className="num">{formatDateTR(e.createdAt.slice(0, 10))}</span>
                  <span className="text-text">{t(`sales.status.${doc.kind}.${e.toStatus}` as never)}</span>
                  {e.userName && <span>{e.userName}</span>}
                  {e.reason && <span>— {e.reason}</span>}
                </li>
              ))}
            </ol>
          </Card>
        )}

        <p className="text-xs text-muted print:hidden">{t(isOrder ? 'sales.view.orderNote' : 'sales.view.quoteNote')}</p>
        <PrintNote>{t('sales.view.printNote')}</PrintNote>
        <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved'), t('printDoc.customerApproval')]} />
      </div>

      <Modal
        open={reasonFor !== null}
        onOpenChange={(o) => !o && setReasonFor(null)}
        title={reasonFor ? t(`sales.actions.${reasonFor}` as never) : ''}
        description={reasonFor === 'close' ? t('sales.actions.closeDesc') : t('sales.actions.reasonDesc')}
        footer={
          <>
            <Button onClick={() => setReasonFor(null)}>{t('common.cancel')}</Button>
            <Button
              variant={reasonFor === 'close' ? 'primary' : 'danger'}
              loading={act.isPending}
              disabled={reasonFor !== 'close' && reason.trim().length < 3}
              onClick={() => reasonFor && run(reasonFor, reason.trim() || undefined)}
            >
              {reasonFor ? t(`sales.actions.${reasonFor}` as never) : ''}
            </Button>
          </>
        }
      >
        <Field label={t('sales.actions.reason')} required={reasonFor !== 'close'}>
          {(fid) => <Input id={fid} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Modal>

      <Modal
        open={invoiceOpen}
        onOpenChange={setInvoiceOpen}
        title={t('sales.actions.invoice')}
        description={t('sales.actions.invoiceDesc')}
        footer={
          <>
            <Button onClick={() => setInvoiceOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={toInvoice.isPending}
              onClick={() =>
                toInvoice.mutate(
                  { includeUndelivered },
                  {
                    onSuccess: (r) => {
                      setInvoiceOpen(false);
                      toast.success(t('sales.actions.done.invoice'));
                      navigate(`/invoices/${r.invoiceId}`);
                    },
                    onError: (e) => {
                      setInvoiceOpen(false);
                      toast.error(errorMessage(e));
                    },
                  },
                )
              }
            >
              {t('sales.actions.invoiceCreate')}
            </Button>
          </>
        }
      >
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={includeUndelivered} onChange={(e) => setIncludeUndelivered(e.target.checked)} />
          <span>
            {t('sales.actions.includeUndelivered')}
            <span className="block text-xs text-muted">{t('sales.actions.includeUndeliveredHint')}</span>
          </span>
        </label>
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
