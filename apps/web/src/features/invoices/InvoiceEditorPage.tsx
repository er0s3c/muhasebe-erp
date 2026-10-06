import { ArrowLeft, Ban, Printer, Undo2, Paperclip } from 'lucide-react';
import { PrintSignatures } from '../../components/print/PrintBlocks';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DELIVERY_NOTE_TYPE_META, INVOICE_TYPES, INVOICE_TYPE_META, dec, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { DeliveryNoteDetail, InvoiceDetail, InvoiceType } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';
import { INVOICE_INVALIDATE, InvoiceStatusBadge, InvoiceTypeBadge } from './common';
import { InvoiceForm } from './InvoiceForm';
import { MatchCard } from './MatchCard';
import { fmtDate } from '../../lib/license';

/**
 * /invoices/new (yeni ve iade) ve /invoices/:id: taslaksa düzenlenebilir form,
 * kaydedilmiş ya da iptal edilmişse salt okunur görünüm (yazdırma, iade, iptal).
 */
export function InvoiceEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const canManage = useCan()('invoices.manage');

  const typeParam = params.get('type');
  const newType: InvoiceType = (INVOICE_TYPES as readonly string[]).includes(typeParam ?? '') ? (typeParam as InvoiceType) : 'sales';
  const returnOf = params.get('returnOf');
  const deliveryNoteId = params.get('deliveryNote');

  const detail = useCQuery<InvoiceDetail>(['invoice', id], id ? `/api/invoices/${id}` : null);
  const original = useCQuery<InvoiceDetail>(['invoice', returnOf], !id && returnOf ? `/api/invoices/${returnOf}` : null);
  const fromDelivery = useCQuery<DeliveryNoteDetail>(['delivery-note', deliveryNoteId], !id && deliveryNoteId ? `/api/delivery-notes/${deliveryNoteId}` : null);

  if (!id) {
    if (!canManage) return <Callout tone="danger">{t('errors.FORBIDDEN')}</Callout>;
    if (returnOf && !original.data) return original.error ? <Callout tone="danger">{errorMessage(original.error)}</Callout> : <PageLoading />;
    if (deliveryNoteId && !fromDelivery.data) return fromDelivery.error ? <Callout tone="danger">{errorMessage(fromDelivery.error)}</Callout> : <PageLoading />;
    // İrsaliyeden fatura: tür irsaliyenin yönünden gelir
    const type: InvoiceType = fromDelivery.data ? DELIVERY_NOTE_TYPE_META[fromDelivery.data.note.type].invoiceType : newType;
    return <InvoiceForm key={`new-${type}-${returnOf ?? ''}-${deliveryNoteId ?? ''}`} type={type} original={original.data} fromDelivery={fromDelivery.data} />;
  }
  if (detail.error) return <Callout tone="danger">{errorMessage(detail.error)}</Callout>;
  if (!detail.data) return <PageLoading />;
  if (detail.data.invoice.status === 'draft' && canManage) {
    return <InvoiceForm key={id} type={detail.data.invoice.type} initial={detail.data} />;
  }
  return <InvoiceView key={id} data={detail.data} />;
}

function InvoiceView({ data }: { data: InvoiceDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const can = useCan();
  const projectsOn = useModuleEnabled('construction.projects');
  const { invoice: inv, lines } = data;
  const meta = INVOICE_TYPE_META[inv.type];
  const base = company.baseCurrency;
  const foreign = inv.currencyCode !== base;
  const [cancelling, setCancelling] = useState(false);
  const [cancelDate, setCancelDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  // İptal reddedilirse (ör. tahsil edilmiş fatura) gerekçe ve yönlendirme pencerede kalır: kullanıcı önce tahsilatı iptal eder
  const [cancelError, setCancelError] = useState<string | null>(null);
  const creditLimit = (location.state as { creditLimit?: { limit: string; balance: string } } | null)?.creditLimit;

  const cancel = useCMutation(
    (v: { date: string; reason: string }, call) => call<InvoiceDetail>(`/api/invoices/${inv.id}/cancel`, { method: 'POST', body: v }),
    INVOICE_INVALIDATE,
  );

  const listPath = meta.side === 'sales' ? '/invoices/sales' : '/invoices/purchases';
  const canReturn = inv.status === 'posted' && !meta.isReturn && inv.type !== 'expense' && can('invoices.manage');
  const canCancel = inv.status === 'posted' && can('invoices.post');
  const returnType: InvoiceType = inv.type === 'sales' ? 'sales_return' : 'purchase_return';
  const showQtyReturned = lines.some((l) => l.returnedQty && dec(l.returnedQty).gt(0));

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`invoices.${meta.side}.title`)}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-heading">{inv.invoiceNo}</h1>
            <InvoiceTypeBadge type={inv.type} />
            <InvoiceStatusBadge status={inv.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link to={`/parties/${inv.partyId}`} className="link">
              {inv.partyName}
            </Link>{' '}
            · {formatDateTR(inv.invoiceDate)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Link className="link inline-flex items-center gap-2 text-sm" to={`/workspace/documents?kind=invoice&id=${inv.id}`}><Paperclip className="size-4" aria-hidden />Belge ekleri</Link>
          <Button onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden />
            {t('invoices.view.print')}
          </Button>
          {canReturn && (
            <Button onClick={() => navigate(`/invoices/new?type=${returnType}&returnOf=${inv.id}`)}>
              <Undo2 className="size-4" aria-hidden />
              {t('invoices.view.createReturn')}
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" onClick={() => setCancelling(true)}>
              <Ban className="size-4" aria-hidden />
              {t('invoices.view.cancel')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {inv.status === 'cancelled' && (
          <Callout tone="danger" title={t('invoices.view.cancelledTitle', { date: inv.cancelledAt ? fmtDate(inv.cancelledAt) : '' })}>
            {inv.cancelReason}
            {inv.cancelJournalEntryId && (
              <>
                {' · '}
                <Link to={`/accounting/journal?open=${inv.cancelJournalEntryId}`} className="link">
                  {inv.cancelJournalEntryNo}
                </Link>
              </>
            )}
          </Callout>
        )}
        {creditLimit && (
          <Callout tone="warning">{t('invoices.view.creditLimit', { limit: moneyIn(creditLimit.limit, base), balance: moneyIn(creditLimit.balance, base) })}</Callout>
        )}
        {inv.returnOfId && (
          <Callout>
            {t('invoices.form.returnOf')}{' '}
            <Link to={`/invoices/${inv.returnOfId}`} className="link">
              {inv.returnOfNo}
            </Link>
          </Callout>
        )}
        {data.returns.length > 0 && (
          <Callout>
            {t('invoices.view.returns')}:{' '}
            {data.returns.map((r, i) => (
              <span key={r.id}>
                {i > 0 && ', '}
                <Link to={`/invoices/${r.id}`} className="link">
                  {r.invoiceNo}
                </Link>
                {r.status === 'cancelled' && <span className="text-muted"> ({t('invoices.status.cancelled')})</span>}
              </span>
            ))}
          </Callout>
        )}

        <Card className="p-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label={t('invoices.dueDate')}>{inv.dueDate ? formatDateTR(inv.dueDate) : '—'}</Item>
            {inv.externalNo && <Item label={t('invoices.form.externalNo')}>{inv.externalNo}</Item>}
            <Item label={t('invoices.form.currency')}>
              {currencySymbol(inv.currencyCode)}
              {foreign && inv.fxRate && <span className="ml-2 text-muted">1 {currencySymbol(inv.currencyCode)} = {moneyIn(inv.fxRate, base, 4)}</span>}
            </Item>
            {inv.warehouseName && <Item label={t('invoices.form.warehouse')}>{inv.warehouseName}</Item>}
            <Item label={t('invoices.view.priceMode')}>{inv.vatIncluded ? t('invoices.view.vatIncluded') : t('invoices.view.vatExcluded')}</Item>
            {inv.journalEntryId && (
              <Item label={t('invoices.view.journal')}>
                <Link to={`/accounting/journal?open=${inv.journalEntryId}`} className="link">
                  {inv.journalEntryNo}
                </Link>
              </Item>
            )}
            {inv.stockDocumentId && (
              <Item label={t('invoices.view.stockDoc')}>
                <Link to={`/inventory/movements?open=${inv.stockDocumentId}`} className="link">
                  {inv.stockDocumentNo}
                </Link>
              </Item>
            )}
            {inv.description && (
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-muted">{t('common.description')}</dt>
                <dd className="mt-0.5">{inv.description}</dd>
              </div>
            )}
          </dl>
        </Card>

        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('invoices.form.item')}</Th>
                <Th num>{t('invoices.form.quantity')}</Th>
                <Th num>{t('invoices.form.unitPrice')}</Th>
                <Th num>{t('invoices.form.discount')}</Th>
                <Th num>{t('invoices.form.vat')}</Th>
                <Th num>{t('invoices.form.lineNet')}</Th>
                <Th num>{t('invoices.form.lineGross')}</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <Tr key={l.id}>
                  <Td>
                    <span>{l.description}</span>
                    {l.itemCode && <span className="ml-2 font-mono text-xs text-muted">{l.itemCode}</span>}
                    {l.serials && l.serials.length > 0 && (
                      <span className="block text-xs text-muted" data-testid="line-serials">
                        {t('serials.title')}: <span className="font-mono">{l.serials.join(', ')}</span>
                      </span>
                    )}
                    {l.accountCode && <span className="block text-xs text-muted">{t('invoices.form.account')}: {l.accountCode}</span>}
                    {l.projectId && (
                      <span className="block text-xs text-muted">
                        {t('projects.picker.label')}:{' '}
                        {projectsOn ? (
                          <Link to={`/projects/${l.projectId}`} className="link">
                            {l.projectCode}
                          </Link>
                        ) : (
                          l.projectCode
                        )}
                        {l.wbsCode ? ` · ${l.wbsCode} ${l.wbsName ?? ''}` : ''}
                      </span>
                    )}
                    {l.poLineId && (
                      <span className="block text-xs text-muted">{t('procurement.match.fromOrder', { code: l.orderCode ?? '' })}</span>
                    )}
                    {l.deliveryNoteId && (
                      <span className="block text-xs text-muted">
                        <Link to={`/delivery-notes/${l.deliveryNoteId}`} className="link">
                          {t('deliveries.line.from', { no: l.deliveryNoteNo ?? '', line: l.deliveryLineNo ?? '' })}
                        </Link>
                      </span>
                    )}
                    {showQtyReturned && l.returnedQty && dec(l.returnedQty).gt(0) && (
                      <span className="block text-xs text-muted">{t('invoices.view.returned', { qty: qtyText(l.returnedQty) })}</span>
                    )}
                  </Td>
                  <Td num>
                    {qtyText(l.quantity)} {l.unit ? unitLabel(l.unit) : ''}
                  </Td>
                  <Td num>{money(l.unitPrice, 2)}</Td>
                  <Td num className="text-muted">{dec(l.discountPct).isZero() ? '—' : `%${qtyText(l.discountPct)}`}</Td>
                  <Td num className="text-muted">{l.vatCode ? `%${dec(l.vatRate).toFixed(0)}` : '—'}</Td>
                  <Td num>{money(l.net)}</Td>
                  <Td num>{money(l.gross)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>

        {lines.some((l) => l.poLineId) && <MatchCard invoiceId={inv.id} currency={inv.currencyCode} overrideReason={inv.matchOverrideReason} />}

        <div className="flex justify-end">
          <dl className="w-full max-w-xs text-sm">
            <div className="flex justify-between py-1">
              <dt className="text-muted">{t('invoices.netTotal')}</dt>
              <dd className="num">{moneyIn(inv.netTotal, inv.currencyCode)}</dd>
            </div>
            <div className="flex justify-between py-1">
              <dt className="text-muted">{t('invoices.vatTotal')}</dt>
              <dd className="num">{moneyIn(inv.vatTotal, inv.currencyCode)}</dd>
            </div>
            <div className="mt-1 flex justify-between border-t border-text pt-2 text-base">
              <dt>{t('invoices.grossTotal')}</dt>
              <dd className="num" data-testid="gross-total">{moneyIn(inv.grossTotal, inv.currencyCode)}</dd>
            </div>
            {foreign && inv.grossTotalBase && (
              <div className="flex justify-between py-1 text-muted">
                <dt>{t('invoices.baseEquivalent')}</dt>
                <dd className="num">{moneyIn(inv.grossTotalBase, base)}</dd>
              </div>
            )}
          </dl>
        </div>

        <p className="text-xs text-muted">{t('invoices.view.internalNote')}</p>
        <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved')]} />
      </div>

      <Modal
        open={cancelling}
        onOpenChange={(o) => {
          setCancelling(o);
          if (!o) setCancelError(null);
        }}
        title={t('invoices.view.cancelTitle')}
        description={t('invoices.view.cancelDesc')}
        footer={
          <>
            <Button onClick={() => { setCancelling(false); setCancelError(null); }}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={cancel.isPending}
              disabled={reason.trim().length < 3 || !cancelDate}
              onClick={() =>
                cancel.mutate(
                  { date: cancelDate, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      toast.success(t('invoices.view.cancelledMsg'));
                      setCancelling(false);
                    },
                    onError: (e) => setCancelError(errorMessage(e)),
                  },
                )
              }
            >
              {t('invoices.view.cancel')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {cancelError && (
            <Callout tone="danger" title={t('invoices.view.cancelBlocked')}>
              {cancelError}
            </Callout>
          )}
          <Field label={t('invoices.view.cancelDate')}>{(fid) => <Input id={fid} type="date" value={cancelDate} min={inv.invoiceDate} onChange={(e) => setCancelDate(e.target.value)} />}</Field>
          <Field label={t('invoices.view.cancelReason')} required>{(fid) => <Input id={fid} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
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

