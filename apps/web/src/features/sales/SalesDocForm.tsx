import { ArrowLeft, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { calcInvoice, dec, todayIso, type SalesDocKind } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { moneyIn } from '../../lib/format';
import { useCMutation, useCompanyApi, useCQuery } from '../../lib/queries';
import type { ItemListRow, PriceResolution, SalesDocDetail } from '../../lib/types';
import { useUnitLabel, useWarehouses } from '../inventory/common';
import { usePartyOptions, useTaxRates, vatRateFor } from '../invoices/common';
import { SALES_INVALIDATE } from './common';

interface LineState {
  key: number;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPct: string;
  /** Fiyatın kaynağı (fiyat çözümleyici önerisi); kullanıcı fiyatı değiştirince silinir. */
  priceNote?: string;
  vatCode: string;
}

let lineKey = 1;
const emptyLine = (): LineState => ({ key: lineKey++, itemId: '', description: '', quantity: '1', unit: '', unitPrice: '', discountPct: '', vatCode: '' });
const trim = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/**
 * Teklif/sipariş girişi (yeni / taslak düzenleme): cari, tarihler, para birimi, satırlar. Fiyat boş bırakılırsa stok kartının
 * satış fiyatı (kart para birimi belge para birimiyle aynıysa) kullanılır; cari özel fiyat/fiyat listeleri ileride aynı yerden gelecek.
 */
export function SalesDocForm({ kind, initial }: { kind: SalesDocKind; initial?: SalesDocDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const unitLabel = useUnitLabel();
  const { company, call } = useCompanyApi();
  const base = company.baseCurrency;

  const { options: partyOptions, byId: partyById } = usePartyOptions('customer');
  const { data: whData } = useWarehouses();
  const warehouses = (whData?.warehouses ?? []).filter((w) => w.isActive);
  const { data: taxData } = useTaxRates();
  const taxRates = useMemo(() => taxData?.taxRates ?? [], [taxData]);
  const { data: itemData } = useCQuery<{ items: ItemListRow[] }>(['items', 'options', 'sales-doc'], '/api/items?limit=500&active=true');
  const itemById = useMemo(() => new Map((itemData?.items ?? []).map((i) => [i.id, i])), [itemData]);
  const itemOptions: ComboOption[] = (itemData?.items ?? []).map((i) => ({
    value: i.id,
    label: `${i.code} — ${i.name}`,
    keywords: `${i.code} ${i.barcode ?? ''}`,
    hint: i.kind === 'service' ? t('inventory.kinds.service') : undefined,
  }));

  const [partyId, setPartyId] = useState(initial?.doc.partyId ?? '');
  const [docDate, setDocDate] = useState(initial?.doc.docDate ?? todayIso());
  const [validUntil, setValidUntil] = useState(initial?.doc.validUntil ?? '');
  const [deliveryDate, setDeliveryDate] = useState(initial?.doc.deliveryDate ?? '');
  const [currency, setCurrency] = useState(initial?.doc.currencyCode ?? '');
  const [vatIncluded, setVatIncluded] = useState(initial?.doc.vatIncluded ?? false);
  const [warehouseId, setWarehouseId] = useState(initial?.doc.warehouseId ?? '');
  const [notes, setNotes] = useState(initial?.doc.notes ?? '');
  const [lines, setLines] = useState<LineState[]>(() =>
    initial
      ? initial.lines.map((l) => ({
          key: lineKey++,
          itemId: l.itemId ?? '',
          description: l.description,
          quantity: trim(l.quantity),
          unit: l.unit ?? '',
          unitPrice: trim(l.unitPrice),
          discountPct: dec(l.discountPct).isZero() ? '' : trim(l.discountPct),
          vatCode: l.vatCode ?? '',
        }))
      : [emptyLine()],
  );
  const [error, setError] = useState<Error | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const effectiveCurrency = currency || partyById.get(partyId)?.currencyCode || base;
  const patch = (key: number, p: Partial<LineState>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const priceOf = (it: ItemListRow) => (it.salePrice && it.saleCurrency === effectiveCurrency ? trim(it.salePrice) : '');
  /** Fiyat çözümleyici: cariye özel fiyat > cari listesi > varsayılan liste > kart; iskonto fiyattan sonra. Kullanıcı her zaman değiştirebilir. */
  const suggest = async (key: number, itemId: string, qty: string) => {
    if (!partyId || !itemId || !qty || dec(qty).lte(0)) return;
    const qs = new URLSearchParams({ partyId, itemId, kind: 'sales', date: docDate, currency: effectiveCurrency, quantity: qty });
    try {
      const r = await call<PriceResolution>(`/api/price-resolution?${qs}`);
      if (r.unitPrice === null && dec(r.discountPct).isZero()) return;
      setLines((cur) =>
        cur.map((l) =>
          l.key === key && l.itemId === itemId
            ? {
                ...l,
                ...(r.unitPrice !== null ? { unitPrice: trim(r.unitPrice) } : {}),
                discountPct: dec(r.discountPct).isZero() ? '' : trim(r.discountPct),
                priceNote: r.unitPrice !== null ? t(`pricing.source.${r.priceSource}`, { list: r.priceListName ?? '' }) + (dec(r.discountPct).isZero() ? '' : ` · ${t(`pricing.discountSource.${r.discountSource}`)}`) : '',
              }
            : l,
        ),
      );
    } catch {
      // Öneri alınamazsa kart fiyatı ve elle giriş geçerlidir
    }
  };
  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
    if (!it) return;
    patch(key, { itemId, description: it.name, unit: it.unit, unitPrice: priceOf(it), priceNote: '', vatCode: it.vatCode ?? '' });
    void suggest(key, itemId, lines.find((l) => l.key === key)?.quantity || '1');
  };

  const totals = useMemo(
    () =>
      calcInvoice(
        lines.map((l) => ({ quantity: l.quantity || '0', unitPrice: l.unitPrice || '0', discountPct: l.discountPct || '0', vatRate: vatRateFor(taxRates, l.vatCode, docDate) })),
        vatIncluded,
      ),
    [lines, vatIncluded, taxRates, docDate],
  );

  const bodyOf = () => ({
    ...(initial ? {} : { kind }),
    partyId,
    docDate,
    ...(kind === 'quote' ? { validUntil: validUntil || null } : { deliveryDate: deliveryDate || null }),
    currency: effectiveCurrency,
    vatIncluded,
    warehouseId: warehouseId || null,
    notes: notes.trim() || undefined,
    lines: lines.map((l) => ({
      itemId: l.itemId || null,
      description: l.description.trim() || undefined,
      quantity: l.quantity,
      unit: l.unit || null,
      ...(l.unitPrice !== '' ? { unitPrice: l.unitPrice } : {}),
      discountPct: l.discountPct || '0',
      vatCode: l.vatCode || null,
    })),
  });

  const save = useCMutation(async (advance: 'send' | 'confirm' | null, c) => {
    const res = initial
      ? await c<SalesDocDetail>(`/api/sales-docs/${initial.doc.id}`, { method: 'PUT', body: bodyOf() })
      : await c<SalesDocDetail>('/api/sales-docs', { method: 'POST', body: bodyOf() });
    // Kaydet ve gönder/onayla: taslak yazıldıktan sonra durum geçişi (numara bu adımda verilir)
    if (advance) await c(`/api/sales-docs/${res.doc.id}/${advance}`, { method: 'POST', body: {} });
    return res;
  }, SALES_INVALIDATE);
  const cancelDoc = useCMutation((reason: string, c) => c(`/api/sales-docs/${initial!.doc.id}/cancel`, { method: 'POST', body: { reason } }), SALES_INVALIDATE);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const remove = useCMutation((_: void, c) => c(`/api/sales-docs/${initial!.doc.id}`, { method: 'DELETE' }), SALES_INVALIDATE);

  const submit = (advance: 'send' | 'confirm' | null) => {
    setError(null);
    setFieldError(null);
    if (!partyId) return setFieldError(t('sales.form.partyRequired'));
    if (lines.some((l) => (!l.itemId && !l.description.trim()) || !l.quantity || dec(l.quantity).lte(0))) return setFieldError(t('sales.form.linesRequired'));
    if (lines.some((l) => !l.itemId && l.unitPrice === '')) return setFieldError(t('sales.form.priceRequired'));
    save.mutate(advance, {
      onSuccess: (res) => {
        toast.success(advance ? t(`sales.actions.done.${advance}`) : t('sales.form.savedMsg'));
        navigate(`/sales/docs/${res.doc.id}`, { replace: true });
      },
      onError: (e) => setError(e),
    });
  };

  const listPath = kind === 'quote' ? '/sales/quotes' : '/sales/orders';
  if (!whData || !itemData || !taxData) return <PageLoading />;
  const gridCols = 'lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1.5fr)_88px_120px_72px_minmax(0,0.9fr)_32px]';

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text print:hidden">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`sales.${kind}.title`)}
      </Link>
      <h1 className="mb-6 text-heading">{initial ? t('sales.form.editTitle', { type: t(`sales.kind.${kind}`) }) : t(`sales.new.${kind}`)}</h1>

      <div className="flex flex-col gap-5">
        {(error || fieldError) && <Callout tone="danger">{error ? errorMessage(error) : fieldError}</Callout>}

        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('sales.form.customer')} required className="sm:col-span-2">
              {(id) => <Combobox id={id} options={partyOptions} value={partyId || null} placeholder={t('sales.form.pickParty')} onChange={setPartyId} />}
            </Field>
            <Field label={t('sales.form.docDate')} required>
              {(id) => <Input id={id} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />}
            </Field>
            {kind === 'quote' ? (
              <Field label={t('sales.validUntil')}>{(id) => <Input id={id} type="date" value={validUntil} min={docDate} onChange={(e) => setValidUntil(e.target.value)} />}</Field>
            ) : (
              <Field label={t('sales.deliveryDate')}>{(id) => <Input id={id} type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />}</Field>
            )}
            <Field label={t('sales.form.currency')}>
              {(id) => (
                <Select id={id} value={effectiveCurrency} onChange={(e) => setCurrency(e.target.value)}>
                  <CurrencyOptions />
                </Select>
              )}
            </Field>
            <Field label={t('sales.form.warehouse')}>
              {(id) => (
                <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                  <option value="">{t('sales.form.defaultWarehouse')}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={vatIncluded} onChange={(e) => setVatIncluded(e.target.checked)} />
                {t('sales.form.vatIncluded')}
              </label>
            </div>
            <Field label={t('sales.form.notes')} className="sm:col-span-2 lg:col-span-4">
              {(id) => <Textarea id={id} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <section aria-label={t('sales.form.lines')}>
            <div className={cn('mb-2 grid items-end gap-2 px-1 micro max-lg:hidden', gridCols)}>
              <span>{t('sales.form.item')}</span>
              <span>{t('common.description')}</span>
              <span className="text-right">{t('sales.form.quantity')}</span>
              <span className="text-right">{t('sales.form.unitPrice')}</span>
              <span className="text-right">{t('sales.form.discount')}</span>
              <span>{t('sales.form.vat')}</span>
              <span />
            </div>
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const it = itemById.get(l.itemId);
                const noCardPrice = it && !l.unitPrice && !priceOf(it);
                return (
                  <div key={l.key} className="rounded-lg border border-border p-2 lg:border-0 lg:p-0">
                    <div className={cn('grid grid-cols-2 items-center gap-2', gridCols)}>
                      <Combobox
                        className="col-span-2 lg:col-span-1"
                        options={itemOptions}
                        value={l.itemId || null}
                        placeholder={t('sales.form.pickItem')}
                        aria-label={`${t('sales.form.item')} ${i + 1}`}
                        onChange={(v) => pickItem(l.key, v)}
                      />
                      <Input className="col-span-2 lg:col-span-1" value={l.description} maxLength={300} aria-label={`${t('common.description')} ${i + 1}`} placeholder={l.itemId ? undefined : t('sales.form.freeText')} onChange={(e) => patch(l.key, { description: e.target.value })} />
                      <MoneyInput value={l.quantity} decimals={0} maxDecimals={4} aria-label={`${t('sales.form.quantity')} ${i + 1}`} placeholder={l.unit ? unitLabel(l.unit) : undefined} className="text-right" onChange={(v) => patch(l.key, { quantity: v })} />
                      <MoneyInput value={l.unitPrice} maxDecimals={6} aria-label={`${t('sales.form.unitPrice')} ${i + 1}`} className="text-right" onChange={(v) => patch(l.key, { unitPrice: v, priceNote: '' })} />
                      <MoneyInput value={l.discountPct} decimals={0} maxDecimals={4} aria-label={`${t('sales.form.discount')} ${i + 1}`} placeholder="0" className="text-right" onChange={(v) => patch(l.key, { discountPct: v })} />
                      <Select className="px-2 pr-6" value={l.vatCode} aria-label={`${t('sales.form.vat')} ${i + 1}`} onChange={(e) => patch(l.key, { vatCode: e.target.value })}>
                        <option value="">{t('sales.form.noVat')}</option>
                        {[...new Set(taxRates.map((r) => r.code))].map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </Select>
                      <button
                        className="justify-self-end rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                        disabled={lines.length <= 1}
                        onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
                        aria-label={t('sales.form.removeLine')}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    {l.priceNote && (
                      <p className="mt-1.5 pl-1 text-[13px] text-muted" data-testid="price-source">
                        {t('pricing.priceFrom', { source: l.priceNote })}{' '}
                        <button type="button" className="link" onClick={() => void suggest(l.key, l.itemId, l.quantity || '1')}>
                          {t('pricing.refresh')}
                        </button>
                      </p>
                    )}
                    {noCardPrice && <p className="mt-1.5 pl-1 text-[13px] text-warning">{t('sales.form.noCardPrice', { currency: effectiveCurrency })}</p>}
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setLines((cur) => [...cur, emptyLine()])}>
                <Plus className="size-3.5" aria-hidden />
                {t('sales.form.addLine')}
              </Button>
            </div>
            <div className="mt-5 flex justify-end border-t border-border pt-4">
              <dl className="w-full max-w-xs text-sm">
                <div className="flex justify-between py-1">
                  <dt className="text-muted">{t('invoices.netTotal')}</dt>
                  <dd className="num">{moneyIn(totals.net.toFixed(2), effectiveCurrency)}</dd>
                </div>
                {totals.byRate.filter((g) => !dec(g.vat).isZero()).map((g) => (
                  <div key={g.rate} className="flex justify-between py-1">
                    <dt className="text-muted">{t('invoices.vatAt', { rate: dec(g.rate).toFixed(0) })}</dt>
                    <dd className="num">{moneyIn(g.vat.toFixed(2), effectiveCurrency)}</dd>
                  </div>
                ))}
                <div className="mt-1 flex justify-between border-t border-text pt-2 text-base">
                  <dt>{t('invoices.grossTotal')}</dt>
                  <dd className="num" data-testid="gross-total">{moneyIn(totals.gross.toFixed(2), effectiveCurrency)}</dd>
                </div>
              </dl>
            </div>
          </section>
        </Card>

        <p className="text-[13px] text-muted">{t('sales.form.note')}</p>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {initial && !initial.doc.docNo && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" aria-hidden />
                {t('sales.form.deleteDraft')}
              </Button>
            )}
            {initial?.doc.docNo && (
              <Button variant="danger" onClick={() => setCancelOpen(true)}>
                <Trash2 className="size-4" aria-hidden />
                {t('sales.actions.cancel')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => navigate(initial ? `/sales/docs/${initial.doc.id}` : listPath)}>{t('common.cancel')}</Button>
            <Button loading={save.isPending && save.variables === null} onClick={() => submit(null)}>
              {t('sales.form.save')}
            </Button>
            <Button variant="primary" loading={save.isPending && save.variables !== null} onClick={() => submit(kind === 'quote' ? 'send' : 'confirm')}>
              {kind === 'quote' ? t('sales.form.saveSend') : t('sales.form.saveConfirm')}
            </Button>
          </div>
        </div>
      </div>

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('sales.actions.cancel')}
        description={t('sales.actions.reasonDesc')}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={cancelDoc.isPending}
              disabled={cancelReason.trim().length < 3}
              onClick={() =>
                cancelDoc.mutate(cancelReason.trim(), {
                  onSuccess: () => {
                    toast.success(t('sales.actions.done.cancel'));
                    navigate(listPath, { replace: true });
                  },
                  onError: (e) => {
                    setCancelOpen(false);
                    toast.error(errorMessage(e));
                  },
                })
              }
            >
              {t('sales.actions.cancel')}
            </Button>
          </>
        }
      >
        <Field label={t('sales.actions.reason')} required>
          {(fid) => <Input id={fid} value={cancelReason} maxLength={300} onChange={(e) => setCancelReason(e.target.value)} />}
        </Field>
      </Modal>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('sales.form.deleteDraft')}
        description={t('sales.form.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('sales.form.deleted'));
                    navigate(listPath, { replace: true });
                  },
                  onError: (e) => {
                    setConfirmDelete(false);
                    toast.error(errorMessage(e));
                  },
                })
              }
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {null}
      </Modal>
    </>
  );
}
