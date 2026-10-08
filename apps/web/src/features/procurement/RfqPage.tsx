import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { PurchaseOrderDetail, RfqDetail, RfqOfferRow } from '../../lib/types';
import { usePartyOptions } from '../invoices/common';
import { qtyText } from '../inventory/common';
import { num, PROCUREMENT_INVALIDATE, RfqStatusBadge } from './common';
import { MoneyInput } from '../../components/ui/MoneyInput';

export function RfqPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const can = useCan();
  const base = useCompany().baseCurrency;
  const { data, isPending } = useCQuery<RfqDetail>(['rfq', id], `/api/rfqs/${id}`);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editing, setEditing] = useState<RfqOfferRow | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const award = useCMutation((offerId: string, call) => call<{ order: PurchaseOrderDetail }>(`/api/rfqs/${id}/award`, { method: 'POST', body: { offerId } }), PROCUREMENT_INVALIDATE);
  const cancel = useCMutation((_: void, call) => call(`/api/rfqs/${id}/cancel`, { method: 'POST', body: {} }), PROCUREMENT_INVALIDATE);
  const removeOffer = useCMutation((offerId: string, call) => call(`/api/rfqs/${id}/offers/${offerId}`, { method: 'DELETE' }), PROCUREMENT_INVALIDATE);

  if (isPending || !data) return <PageLoading />;
  const { rfq, lines, offers } = data;
  const open = rfq.status === 'open';
  const canManage = can('procurement.manage');

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/purchasing/rfqs" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('procurement.rfqs.title')}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {rfq.code}
          <RfqStatusBadge status={rfq.status} />
        </h1>
        <p className="mt-1 text-sm text-muted">
          <Link className="link" to={`/purchasing/requests/${rfq.requestId}`}>{rfq.requestCode}</Link> — {rfq.requestTitle} · {rfq.projectCode}
          {rfq.dueDate && <> · {t('procurement.rfqs.dueDate')}: {formatDateTR(rfq.dueDate)}</>}
        </p>
      </div>
      {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      <Callout tone="info">{t('procurement.rfqs.compareNote', { currency: base })}</Callout>

      <Card>
        <CardHeader
          title={t('procurement.rfqs.compareTitle')}
          action={open && canManage ? (
            <Button size="sm" onClick={() => { setEditing(null); setOfferOpen(true); }}>
              <Plus className="size-4" aria-hidden />
              {t('procurement.rfqs.addOffer')}
            </Button>
          ) : undefined}
        />
        {offers.length === 0 ? (
          <p className="p-4 text-sm text-muted">{t('procurement.rfqs.noOffers')}</p>
        ) : (
          <TableWrap className="rounded-none border-0">
            <Table>
              <thead>
                <tr>
                  <Th>{t('procurement.rfqs.cols.line')}</Th>
                  <Th num className="w-24">{t('procurement.lines.quantity')}</Th>
                  {offers.map((o) => (
                    <Th key={o.id} num className="min-w-36">
                      <div className="flex flex-col items-end gap-1">
                        <span>{o.partyName}</span>
                        <span className="flex flex-wrap justify-end gap-1">
                          {o.awarded && <Badge tone="success">{t('procurement.rfqs.awarded')}</Badge>}
                          {data.cheapestOfferId === o.id && <Badge tone="brand">{t('procurement.rfqs.cheapest')}</Badge>}
                          {data.fastestOfferId === o.id && <Badge tone="neutral">{t('procurement.rfqs.fastest')}</Badge>}
                          {!o.complete && <Badge tone="warning">{t('procurement.rfqs.incomplete', { n: o.pricedCount, total: lines.length })}</Badge>}
                        </span>
                      </div>
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <Tr key={l.id}>
                    <Td>{l.lineNo}. {l.description} <span className="text-xs text-muted">({l.unit})</span></Td>
                    <Td num className="text-muted">{qtyText(l.quantity)}</Td>
                    {offers.map((o) => (
                      <Td key={o.id} num>{o.prices[l.id] ? money(o.prices[l.id]!, 4) : '—'}</Td>
                    ))}
                  </Tr>
                ))}
                <Tr>
                  <Td className="font-medium" colSpan={2}>{t('procurement.rfqs.cols.total')}</Td>
                  {offers.map((o) => <Td key={o.id} num className="font-medium">{moneyIn(o.total, o.currencyCode)}</Td>)}
                </Tr>
                <Tr>
                  <Td colSpan={2}>{t('procurement.rfqs.cols.totalBase', { currency: base })}</Td>
                  {offers.map((o) => <Td key={o.id} num>{o.totalBase ? moneyIn(o.totalBase, base) : <span className="text-warning" title={t('procurement.rfqs.noRate')}>{t('procurement.rfqs.noRateShort')}</span>}</Td>)}
                </Tr>
                <Tr>
                  <Td colSpan={2}>{t('procurement.rfqs.cols.delivery')}</Td>
                  {offers.map((o) => <Td key={o.id} num>{o.deliveryDays === null ? '—' : t('procurement.rfqs.days', { n: o.deliveryDays })}</Td>)}
                </Tr>
                <Tr>
                  <Td colSpan={2}>{t('procurement.rfqs.cols.payment')}</Td>
                  {offers.map((o) => <Td key={o.id} num>{o.paymentDays === 0 ? t('procurement.rfqs.cash') : t('procurement.rfqs.days', { n: o.paymentDays })}</Td>)}
                </Tr>
                <Tr>
                  <Td colSpan={2} />
                  {offers.map((o) => (
                    <Td key={o.id} num>
                      <div className="flex flex-wrap justify-end gap-1">
                        {open && can('procurement.approve') && (
                          <Button size="sm" variant="primary" disabled={!o.complete} loading={award.isPending} aria-label={`${t('procurement.rfqs.award')} ${o.partyName}`}
                            onClick={() => { setError(null); award.mutate(o.id, { onSuccess: (r) => { toast.success(t('procurement.rfqs.awardedToast')); navigate(`/purchasing/orders/${r.order.order.id}`); }, onError: setError }); }}>
                            {t('procurement.rfqs.award')}
                          </Button>
                        )}
                        {open && canManage && (
                          <>
                            <Button size="sm" onClick={() => { setEditing(o); setOfferOpen(true); }}>{t('common.edit')}</Button>
                            <button type="button" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`${t('common.delete')} ${o.partyName}`}
                              onClick={() => { setError(null); removeOffer.mutate(o.id, { onError: setError }); }}>
                              <Trash2 className="size-4" aria-hidden />
                            </button>
                          </>
                        )}
                      </div>
                    </Td>
                  ))}
                </Tr>
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {open && canManage && (
        <div className="flex justify-end">
          <Button variant="danger" loading={cancel.isPending} onClick={() => { setError(null); cancel.mutate(undefined, { onSuccess: () => toast.success(t('procurement.rfqs.cancelled')), onError: setError }); }}>{t('procurement.rfqs.cancel')}</Button>
        </div>
      )}

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved')]} />
      <PrintNote />

      <OfferSheet rfqId={rfq.id} data={data} offer={editing} open={offerOpen} onOpenChange={setOfferOpen} />
    </div>
  );
}

function OfferSheet({ rfqId, data, offer, open, onOpenChange }: { rfqId: string; data: RfqDetail; offer: RfqOfferRow | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const base = useCompany().baseCurrency;
  const { options } = usePartyOptions('supplier', open);
  const [partyId, setPartyId] = useState('');
  const [currencyCode, setCurrencyCode] = useState(base);
  const [deliveryDays, setDeliveryDays] = useState('');
  const [paymentDays, setPaymentDays] = useState('0');
  const [note, setNote] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!open) return;
    setPartyId(offer?.partyId ?? '');
    setCurrencyCode(offer?.currencyCode ?? base);
    setDeliveryDays(offer?.deliveryDays != null ? String(offer.deliveryDays) : '');
    setPaymentDays(String(offer?.paymentDays ?? 0));
    setNote(offer?.note ?? '');
    setPrices(Object.fromEntries(data.lines.map((l) => [l.id, offer?.prices[l.id] ? String(Number(offer.prices[l.id])) : ''])));
    setError(null);
  }, [open, offer, data, base]);

  const priced = data.lines.filter((l) => prices[l.id]?.trim());
  const save = useCMutation(
    (_: void, call) =>
      call(`/api/rfqs/${rfqId}/offers`, {
        method: 'PUT',
        body: { partyId, currencyCode, deliveryDays: deliveryDays.trim() ? Number(deliveryDays) : null, paymentDays: Number(paymentDays) || 0, note: note.trim() || null, lines: priced.map((l) => ({ requestLineId: l.id, unitPrice: num(prices[l.id]!) })) },
      }),
    PROCUREMENT_INVALIDATE,
  );
  const canSave = !!partyId && priced.length > 0;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={offer ? t('procurement.rfqs.editOffer') : t('procurement.rfqs.addOffer')}
      description={t('procurement.rfqs.offerDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={() => { setError(null); save.mutate(undefined, { onSuccess: () => { toast.success(t('common.saved')); onOpenChange(false); }, onError: setError }); }}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('procurement.rfqs.supplier')} required>
          {(fid) => <Combobox id={fid} options={options} value={partyId || null} onChange={setPartyId} disabled={!!offer} placeholder={t('procurement.rfqs.supplierPlaceholder')} />}
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('procurement.rfqs.currency')}>{(fid) => <Select id={fid} value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}><CurrencyOptions wide /></Select>}</Field>
          <Field label={t('procurement.rfqs.deliveryDays')}>{(fid) => <Input id={fid} inputMode="numeric" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label={t('procurement.rfqs.paymentDays')} hint={t('procurement.rfqs.paymentHint')}>{(fid) => <Input id={fid} inputMode="numeric" value={paymentDays} onChange={(e) => setPaymentDays(e.target.value.replace(/\D/g, ''))} />}</Field>
        </div>
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-[13px] text-muted">{t('procurement.rfqs.unitPrices')}</legend>
          {data.lines.map((l) => (
            <div key={l.id} className="flex items-center gap-2">
              <span className="flex-1 text-sm">{l.lineNo}. {l.description} <span className="text-xs text-muted">({qtyText(l.quantity)} {l.unit})</span></span>
              <MoneyInput aria-label={`${t('procurement.rfqs.unitPrice')} ${l.lineNo}`} className="w-32 text-right" value={prices[l.id] ?? ''} onChange={(v) => setPrices((p) => ({ ...p, [l.id]: v }))} maxDecimals={6} />
            </div>
          ))}
        </fieldset>
        <Field label={t('procurement.rfqs.note')}>{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
      </div>
    </Sheet>
  );
}
