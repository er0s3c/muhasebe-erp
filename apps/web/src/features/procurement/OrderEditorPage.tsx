import { ArrowLeft } from 'lucide-react';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { PurchaseOrderDetail, PurchaseRequestDetail } from '../../lib/types';
import { usePartyOptions, useTaxRates } from '../invoices/common';
import { qtyText, useWarehouses } from '../inventory/common';
import { useProjectOptions } from '../projects/common';
import { emptyLine, LinesEditor, lineValid, num, OrderStatusBadge, PROCUREMENT_INVALIDATE, type LineDraft } from './common';

export function PurchaseOrderEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const isNew = !id || id === 'new';
  const requestId = isNew ? params.get('requestId') : null;
  const { projects } = useProjectOptions();
  const { options: partyOptions } = usePartyOptions('supplier');
  const { data: taxData } = useTaxRates();

  const detailQ = useCQuery<PurchaseOrderDetail>(['purchase-order', id], isNew ? null : `/api/purchase-orders/${id}`);
  const reqQ = useCQuery<PurchaseRequestDetail>(['purchase-request', requestId], requestId ? `/api/purchase-requests/${requestId}` : null);
  const detail = detailQ.data;
  const order = detail?.order;
  const status = isNew ? 'draft' : order?.status ?? 'draft';
  const editable = status === 'draft' && can('procurement.manage');

  const [projectId, setProjectId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [currencyCode, setCurrencyCode] = useState(base);
  const [vatCode, setVatCode] = useState('');
  const [paymentDays, setPaymentDays] = useState('30');
  const [deliveryLocation, setDeliveryLocation] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<Error | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [receiptOpen, setReceiptOpen] = useState(false);

  useEffect(() => {
    if (!detail) return;
    const o = detail.order;
    setProjectId(o.projectId);
    setPartyId(o.partyId);
    setCurrencyCode(o.currencyCode);
    setVatCode(o.vatCode ?? '');
    setPaymentDays(String(o.paymentDays));
    setDeliveryLocation(o.deliveryLocation ?? '');
    setNote(o.note ?? '');
    setLines(detail.lines.map((l) => ({ key: l.id, itemId: l.itemId ?? '', description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), price: String(Number(l.unitPrice)), wbsId: l.wbsId ?? '' })));
  }, [detail]);
  // Onaylı talepten: satırlar ve proje talepten gelir
  useEffect(() => {
    const r = reqQ.data;
    if (!isNew || !r) return;
    setProjectId(r.request.projectId);
    setLines(r.lines.map((l) => ({ key: l.id, itemId: l.itemId ?? '', description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), price: l.estUnitPrice ? String(Number(l.estUnitPrice)) : '', wbsId: l.wbsId ?? '' })));
  }, [isNew, reqQ.data]);

  const vatOptions = useMemo(() => {
    const today = todayIso();
    const seen = new Map<string, { code: string; rate: string }>();
    for (const r of [...(taxData?.taxRates ?? [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom))) {
      if (r.validFrom <= today && (!r.validTo || r.validTo >= today) && !seen.has(r.code)) seen.set(r.code, r);
    }
    return [...seen.values()];
  }, [taxData]);

  const body = () => ({
    ...(isNew ? { projectId, requestId: requestId ?? null } : {}),
    partyId,
    currencyCode,
    vatCode: vatCode || null,
    paymentDays: Number(paymentDays) || 0,
    deliveryLocation: deliveryLocation.trim() || null,
    note: note.trim() || null,
    lines: lines.map((l, i) => ({ requestLineId: isNew ? reqQ.data?.lines[i]?.id ?? null : null, itemId: l.itemId || null, description: l.description.trim(), unit: l.unit.trim(), quantity: num(l.quantity), unitPrice: num(l.price), wbsId: l.wbsId || null })),
  });
  const invalid = !partyId || (isNew && !projectId) || lines.some((l) => !lineValid(l, true));

  const save = useCMutation(
    (_: void, call) => (isNew ? call<PurchaseOrderDetail>('/api/purchase-orders', { method: 'POST', body: body() }) : call<PurchaseOrderDetail>(`/api/purchase-orders/${id}`, { method: 'PUT', body: body() })),
    PROCUREMENT_INVALIDATE,
  );
  const act = useCMutation((v: 'issue' | 'close', call) => call(`/api/purchase-orders/${id}/${v}`, { method: 'POST', body: {} }), PROCUREMENT_INVALIDATE);
  const cancel = useCMutation((_: void, call) => call(`/api/purchase-orders/${id}/cancel`, { method: 'POST', body: { reason: cancelReason.trim() } }), PROCUREMENT_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/purchase-orders/${id}`, { method: 'DELETE' }), PROCUREMENT_INVALIDATE);
  const cancelReceipt = useCMutation((v: string, call) => call(`/api/po-receipts/${v}/cancel`, { method: 'POST', body: { reason: t('procurement.orders.receiptCancelReason') } }), PROCUREMENT_INVALIDATE);

  const go = <T,>(fn: (o: { onSuccess: (r: T) => void; onError: (e: Error) => void }) => void, ok: (r: T) => void) => {
    setError(null);
    fn({ onSuccess: ok, onError: setError });
  };

  if (!isNew && detailQ.isPending) return <PageLoading />;
  const total = lines.reduce((s, l) => s + (Number(num(l.quantity)) || 0) * (Number(num(l.price)) || 0), 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/purchasing/orders" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('procurement.orders.title')}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {isNew ? t('procurement.orders.newTitle') : order?.code}
          {!isNew && <OrderStatusBadge status={status} />}
          {order && order.receiptState !== 'none' && <Badge tone={order.receiptState === 'complete' ? 'success' : 'warning'}>{t(`procurement.orders.receiptState.${order.receiptState}`)}</Badge>}
        </h1>
        {order?.requestId && <p className="mt-1 text-sm text-muted"><Link className="text-brand hover:underline" to={`/purchasing/requests/${order.requestId}`}>{order.requestCode}</Link></p>}
      </div>

      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {order?.status === 'cancelled' && <Callout tone="danger" title={t('procurement.orders.cancelledTitle')}>{order.cancelReason}</Callout>}
      {status === 'draft' && <Callout tone="info">{t('procurement.orders.draftNote')}</Callout>}

      <Card>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('procurement.orders.project')} required>
            {(fid) => <Combobox id={fid} disabled={!isNew || !!requestId} value={projectId || null} onChange={setProjectId} placeholder={t('procurement.requests.projectPlaceholder')} options={projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled').map((p) => ({ value: p.id, label: `${p.code} — ${p.name}`, keywords: `${p.code} ${p.name}` }))} />}
          </Field>
          <Field label={t('procurement.orders.supplier')} required>
            {(fid) => <Combobox id={fid} disabled={!editable} value={partyId || null} onChange={setPartyId} options={partyOptions} placeholder={t('procurement.rfqs.supplierPlaceholder')} />}
          </Field>
          <Field label={t('procurement.rfqs.currency')}>{(fid) => <Select id={fid} value={currencyCode} disabled={!editable} onChange={(e) => setCurrencyCode(e.target.value)}><CurrencyOptions wide /></Select>}</Field>
          <Field label={t('procurement.orders.vat')}>
            {(fid) => (
              <Select id={fid} value={vatCode} disabled={!editable} onChange={(e) => setVatCode(e.target.value)}>
                <option value="">{t('procurement.orders.noVat')}</option>
                {vatOptions.map((v) => <option key={v.code} value={v.code}>{v.code} — %{Number(v.rate)}</option>)}
              </Select>
            )}
          </Field>
          <Field label={t('procurement.rfqs.paymentDays')} hint={t('procurement.rfqs.paymentHint')}>{(fid) => <Input id={fid} inputMode="numeric" value={paymentDays} disabled={!editable} onChange={(e) => setPaymentDays(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label={t('procurement.orders.location')}>{(fid) => <Input id={fid} value={deliveryLocation} disabled={!editable} onChange={(e) => setDeliveryLocation(e.target.value)} maxLength={300} />}</Field>
          <div className="sm:col-span-3">
            <Field label={t('procurement.requests.note')}>{(fid) => <Textarea id={fid} rows={2} value={note} disabled={!editable} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}</Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('procurement.orders.linesTitle')} />
        {editable || !detail ? (
          <LinesEditor projectId={projectId} lines={lines} onChange={setLines} disabled={!editable} priceLabel={t('procurement.orders.unitPrice')} wbsRequired />
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th className="w-8">#</Th>
                  <Th>{t('procurement.lines.description')}</Th>
                  <Th className="w-28">{t('procurement.lines.wbs')}</Th>
                  <Th num className="w-24">{t('procurement.lines.quantity')}</Th>
                  <Th num className="w-24">{t('procurement.orders.receivedCol')}</Th>
                  <Th num className="w-24">{t('procurement.orders.remaining')}</Th>
                  <Th num className="w-28">{t('procurement.orders.unitPrice')}</Th>
                  <Th num className="w-32">{t('common.amount')}</Th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <Tr key={l.id}>
                    <Td className="text-muted">{l.lineNo}</Td>
                    <Td>{l.description} <span className="text-xs text-muted">({l.unit}){l.itemCode ? ` · ${l.itemCode}` : ''}</span></Td>
                    <Td className="text-muted">{l.wbsCode ?? '—'}</Td>
                    <Td num>{qtyText(l.quantity)}</Td>
                    <Td num>{qtyText(l.receivedQty) || '0'}</Td>
                    <Td num>{qtyText(l.remainingQty) || '0'}</Td>
                    <Td num className="text-muted">{moneyIn(l.unitPrice, order!.currencyCode, 4)}</Td>
                    <Td num>{moneyIn(l.amount, order!.currencyCode)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <dl className="flex flex-col items-end gap-1 border-t border-border px-4 py-3 text-sm">
          {order && !editable ? (
            <>
              <div className="flex gap-6"><dt className="text-muted">{t('procurement.orders.net')}</dt><dd className="num w-36 text-right">{moneyIn(order.net, order.currencyCode)}</dd></div>
              <div className="flex gap-6"><dt className="text-muted">{t('procurement.orders.vatAmount')}{order.vatCode ? ` (${order.vatCode} %${Number(order.vatRate)})` : ''}</dt><dd className="num w-36 text-right">{moneyIn(order.vat, order.currencyCode)}</dd></div>
              <div className="flex gap-6 font-medium"><dt>{t('procurement.orders.gross')}</dt><dd className="num w-36 text-right">{moneyIn(order.gross, order.currencyCode)}</dd></div>
            </>
          ) : (
            <div className="flex gap-6"><dt className="text-muted">{t('procurement.orders.net')}</dt><dd className="num w-36 text-right">{moneyIn(total.toFixed(2), currencyCode)}</dd></div>
          )}
        </dl>
      </Card>

      {detail && (status === 'issued' || status === 'closed' || detail.receipts.length > 0) && (
        <Card>
          <CardHeader
            title={t('procurement.orders.receiptsTitle')}
            description={t('procurement.orders.receiptsDesc')}
            action={status === 'issued' && can('procurement.manage') ? <Button size="sm" variant="primary" onClick={() => setReceiptOpen(true)}>{t('procurement.orders.receive')}</Button> : undefined}
          />
          {detail.receipts.length === 0 ? (
            <p className="p-4 text-sm text-muted">{t('procurement.orders.noReceipts')}</p>
          ) : (
            <TableWrap className="rounded-none border-0">
              <Table>
                <thead>
                  <tr>
                    <Th className="w-36">{t('procurement.cols.code')}</Th>
                    <Th className="w-28">{t('common.date')}</Th>
                    <Th className="w-28">{t('common.status')}</Th>
                    <Th>{t('procurement.rfqs.note')}</Th>
                    <Th className="w-28" />
                  </tr>
                </thead>
                <tbody>
                  {detail.receipts.map((r) => (
                    <Tr key={r.id}>
                      <Td className="font-mono text-[13px]">{r.receiptNo}</Td>
                      <Td>{formatDateTR(r.receiptDate)}</Td>
                      <Td><Badge tone={r.status === 'posted' ? 'success' : 'danger'}>{t(`procurement.orders.receiptStatus.${r.status}`)}</Badge></Td>
                      <Td className="text-muted">{r.cancelReason ?? r.note ?? ''}</Td>
                      <Td>
                        {r.status === 'posted' && can('procurement.approve') && (
                          <Button size="sm" variant="danger" loading={cancelReceipt.isPending} aria-label={`${t('procurement.orders.cancelReceipt')} ${r.receiptNo}`} onClick={() => go((o) => cancelReceipt.mutate(r.id, o), () => toast.success(t('procurement.orders.receiptCancelled')))}>
                            {t('procurement.orders.cancelReceipt')}
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === 'issued' && can('procurement.approve') && (
          <>
            <Button variant="danger" onClick={() => { setCancelReason(''); setCancelOpen(true); }}>{t('procurement.orders.cancel')}</Button>
            <Button loading={act.isPending} onClick={() => go((o) => act.mutate('close', o), () => toast.success(t('procurement.orders.closed')))}>{t('procurement.orders.close')}</Button>
          </>
        )}
        {!isNew && status === 'draft' && can('procurement.manage') && (
          <Button variant="danger" loading={remove.isPending} onClick={() => go((o) => remove.mutate(undefined, o), () => { toast.success(t('common.deleted')); navigate('/purchasing/orders'); })}>{t('common.delete')}</Button>
        )}
        {editable && (
          <Button loading={save.isPending} disabled={invalid} onClick={() => go<PurchaseOrderDetail>((o) => save.mutate(undefined, o), (res) => { toast.success(t('common.saved')); if (isNew) navigate(`/purchasing/orders/${res.order.id}`, { replace: true }); })}>{t('procurement.requests.saveDraft')}</Button>
        )}
        {!isNew && status === 'draft' && can('procurement.approve') && (
          <Button variant="primary" loading={act.isPending} onClick={() => go((o) => act.mutate('issue', o), () => toast.success(t('procurement.orders.issued')))}>{t('procurement.orders.issue')}</Button>
        )}
      </div>

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved'), t('printDoc.supplier')]} />
      <PrintNote />

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('procurement.orders.cancelTitle')}
        description={t('procurement.orders.cancelDesc')}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={cancel.isPending} disabled={cancelReason.trim().length < 3} onClick={() => go((o) => cancel.mutate(undefined, o), () => { setCancelOpen(false); toast.success(t('procurement.orders.cancelled')); })}>{t('procurement.orders.cancel')}</Button>
          </>
        }
      >
        <Field label={t('procurement.orders.cancelReason')} required>{(fid) => <Input id={fid} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={300} />}</Field>
      </Modal>

      {detail && <ReceiptModal detail={detail} open={receiptOpen} onOpenChange={setReceiptOpen} />}
    </div>
  );
}

function ReceiptModal({ detail, open, onOpenChange }: { detail: PurchaseOrderDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data: wh } = useWarehouses();
  const warehouses = (wh?.warehouses ?? []).filter((w) => w.isActive);
  const [date, setDate] = useState(todayIso());
  const [externalNo, setExternalNo] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const hasStock = detail.lines.some((l) => l.itemId && l.itemKind === 'goods' && Number(qty[l.id]) > 0);

  useEffect(() => {
    if (!open) return;
    setDate(todayIso());
    setExternalNo('');
    setNote('');
    setWarehouseId('');
    setQty(Object.fromEntries(detail.lines.map((l) => [l.id, String(Number(l.remainingQty))])));
    setError(null);
  }, [open, detail]);

  const receive = useCMutation(
    (_: void, call) =>
      call(`/api/purchase-orders/${detail.order.id}/receipts`, {
        method: 'POST',
        body: {
          receiptDate: date,
          externalNo: externalNo.trim() || null,
          warehouseId: warehouseId || null,
          note: note.trim() || null,
          lines: detail.lines.filter((l) => Number(num(qty[l.id] ?? '0')) > 0).map((l) => ({ orderLineId: l.id, quantity: num(qty[l.id]!) })),
        },
      }),
    PROCUREMENT_INVALIDATE,
  );
  const any = detail.lines.some((l) => Number(num(qty[l.id] ?? '0')) > 0);
  const over = detail.lines.some((l) => Number(num(qty[l.id] ?? '0')) > Number(l.remainingQty));
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('procurement.orders.receiveTitle')}
      description={t('procurement.orders.receiveDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={receive.isPending} disabled={!any || over || (hasStock && !externalNo.trim())} onClick={() => { setError(null); receive.mutate(undefined, { onSuccess: () => { onOpenChange(false); toast.success(t('procurement.orders.received')); }, onError: setError }); }}>
            {t('procurement.orders.receive')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('procurement.orders.receiptDate')} required>{(fid) => <Input id={fid} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('procurement.orders.externalNo')} required={hasStock} hint={t('procurement.orders.externalNoHint')}>{(fid) => <Input id={fid} value={externalNo} onChange={(e) => setExternalNo(e.target.value)} maxLength={40} />}</Field>
          <Field label={t('procurement.orders.warehouse')}>
            {(fid) => (
              <Select id={fid} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">{t('procurement.orders.defaultWarehouse')}</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-[13px] text-muted">{t('procurement.orders.receiveQty')}</legend>
          {detail.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm">{l.lineNo}. {l.description} <span className="text-xs text-muted">({t('procurement.orders.remaining')}: {qtyText(l.remainingQty) || '0'} {l.unit})</span></span>
              <Input aria-label={`${t('procurement.orders.receiveQty')} ${l.lineNo}`} inputMode="decimal" className="num w-28 text-right" value={qty[l.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value }))} />
            </div>
          ))}
        </fieldset>
        {over && <Callout tone="danger">{t('procurement.orders.overReceipt')}</Callout>}
        <Field label={t('procurement.rfqs.note')}>{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
      </div>
    </Modal>
  );
}
