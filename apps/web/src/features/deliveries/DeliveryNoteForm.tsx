import { ArrowLeft, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { CURRENCY_CODES, DELIVERY_NOTE_TYPE_META, dec, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCompanyApi, useNavigation } from '../../lib/queries';
import type { DeliveryNoteDetail, DeliveryNoteType } from '../../lib/types';
import { qtyText, useItemOptions, useUnitLabel, useWarehouses } from '../inventory/common';
import { usePartyOptions } from '../invoices/common';
import { DELIVERY_INVALIDATE } from './common';

interface LineState {
  key: number;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  unitCost: string;
  currency: string;
  fxRate: string;
}

let lineKey = 1;
const emptyLine = (currency: string): LineState => ({ key: lineKey++, itemId: '', description: '', quantity: '1', unit: '', unitCost: '', currency, fxRate: '' });

/** "12.5000" -> "12.5"; "3.0000" -> "3" */
const trim = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** İrsaliye girişi (yeni / taslak düzenleme): cari, depo, satırlar; kaydet ve stoğa işle. */
export function DeliveryNoteForm({ type, initial }: { type: DeliveryNoteType; initial?: DeliveryNoteDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const unitLabel = useUnitLabel();
  const { company } = useCompanyApi();
  const base = company.baseCurrency;
  const meta = DELIVERY_NOTE_TYPE_META[type];
  const inbound = meta.inbound;
  const canPost = useCan()('deliveries.post');
  const allowNegative = useNavigation().data?.company.allowNegativeStock ?? false;

  const { options: partyOptions } = usePartyOptions(meta.partyKind);
  const { data: whData } = useWarehouses();
  const warehouses = (whData?.warehouses ?? []).filter((w) => w.isActive);
  const defaultWh = warehouses.find((w) => w.isDefault) ?? warehouses[0];

  const [partyId, setPartyId] = useState(initial?.note.partyId ?? '');
  const [noteDate, setNoteDate] = useState(initial?.note.noteDate ?? todayIso());
  const [warehouseId, setWarehouseId] = useState(initial?.note.warehouseId ?? '');
  const [externalNo, setExternalNo] = useState(initial?.note.externalNo ?? '');
  const [vehiclePlate, setVehiclePlate] = useState(initial?.note.vehiclePlate ?? '');
  const [driverName, setDriverName] = useState(initial?.note.driverName ?? '');
  const [description, setDescription] = useState(initial?.note.description ?? '');
  const [lines, setLines] = useState<LineState[]>(() =>
    initial
      ? initial.lines.map((l) => ({
          key: lineKey++,
          itemId: l.itemId,
          description: l.description,
          quantity: trim(l.quantity),
          unit: l.unit ?? '',
          unitCost: l.unitCost ? trim(l.unitCost) : '',
          currency: l.currencyCode ?? base,
          fxRate: l.fxRate && l.currencyCode !== base ? trim(l.fxRate) : '',
        }))
      : [emptyLine(base)],
  );
  const [error, setError] = useState<Error | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const effectiveWh = warehouseId || defaultWh?.id || '';
  const { byId: itemById, options: itemOptions } = useItemOptions(true, effectiveWh || undefined);

  const patch = (key: number, p: Partial<LineState>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const pickItem = (key: number, itemId: string) => {
    const it = itemById.get(itemId);
    if (!it) return;
    patch(key, {
      itemId,
      description: it.name,
      unit: it.unit,
      // Alışta kartın alış fiyatı hazır gelir (kendi para biriminde); satışta maliyet girilmez
      ...(inbound && it.purchasePrice ? { unitCost: trim(it.purchasePrice), currency: it.purchaseCurrency, fxRate: '' } : {}),
    });
  };

  const bodyOf = (post: boolean) => ({
    ...(initial ? {} : { type }),
    partyId,
    noteDate,
    externalNo: inbound ? externalNo.trim() || undefined : undefined,
    warehouseId: effectiveWh || null,
    vehiclePlate: vehiclePlate.trim() || undefined,
    driverName: driverName.trim() || undefined,
    description: description.trim() || undefined,
    post,
    lines: lines.map((l) => ({
      itemId: l.itemId,
      description: l.description.trim() || undefined,
      quantity: l.quantity,
      unit: l.unit || null,
      ...(inbound && l.unitCost !== ''
        ? { unitCost: l.unitCost, currency: l.currency || base, ...(l.currency !== base && l.fxRate ? { fxRate: l.fxRate } : {}) }
        : {}),
    })),
  });

  const save = useCMutation(
    (post: boolean, c) =>
      initial
        ? c<DeliveryNoteDetail>(`/api/delivery-notes/${initial.note.id}`, { method: 'PUT', body: bodyOf(post) })
        : c<DeliveryNoteDetail>('/api/delivery-notes', { method: 'POST', body: bodyOf(post) }),
    DELIVERY_INVALIDATE,
  );
  const remove = useCMutation((_: void, c) => c(`/api/delivery-notes/${initial!.note.id}`, { method: 'DELETE' }), DELIVERY_INVALIDATE);

  const submit = (post: boolean) => {
    setError(null);
    setFieldError(null);
    if (!partyId) return setFieldError(t('deliveries.form.partyRequired'));
    if (lines.some((l) => !l.itemId || !l.quantity || dec(l.quantity).lte(0))) return setFieldError(t('deliveries.form.linesRequired'));
    if (post && inbound && !externalNo.trim()) return setFieldError(t('deliveries.form.externalRequired'));
    save.mutate(post, {
      onSuccess: (res) => {
        toast.success(post ? t('deliveries.form.postedMsg', { no: res.note.noteNo ?? '' }) : t('deliveries.form.savedMsg'));
        navigate(`/delivery-notes/${res.note.id}`, { replace: true });
      },
      onError: (e) => setError(e),
    });
  };

  const listPath = inbound ? '/delivery-notes/purchases' : '/delivery-notes/sales';
  const side = inbound ? 'purchases' : 'sales';
  if (!whData) return <PageLoading />;

  const gridCols = inbound
    ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_96px_minmax(0,1fr)_88px_minmax(0,0.8fr)_32px]'
    : 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_120px_32px]';

  return (
    <>
      <Link to={listPath} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="size-4" aria-hidden />
        {t(`deliveries.${side}.title`)}
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-heading">
          {initial ? t('deliveries.form.editTitle', { type: t(`deliveries.types.${type}`) }) : t('deliveries.form.newTitle', { type: t(`deliveries.types.${type}`) })}
        </h1>
      </div>

      <div className="flex flex-col gap-5">
        {(error || fieldError) && <Callout tone="danger">{error ? errorMessage(error) : fieldError}</Callout>}

        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={inbound ? t('deliveries.form.supplier') : t('deliveries.form.customer')} required className="sm:col-span-2">
              {(id) => <Combobox id={id} options={partyOptions} value={partyId || null} placeholder={t('deliveries.form.pickParty')} onChange={setPartyId} />}
            </Field>
            <Field label={t('deliveries.form.noteDate')} required>
              {(id) => <Input id={id} type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />}
            </Field>
            <Field label={t('deliveries.form.warehouse')} required>
              {(id) => (
                <Select id={id} value={effectiveWh} onChange={(e) => setWarehouseId(e.target.value)}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {inbound && (
              <Field label={t('deliveries.form.externalNo')} required>
                {(id) => <Input id={id} value={externalNo} maxLength={40} onChange={(e) => setExternalNo(e.target.value)} />}
              </Field>
            )}
            <Field label={t('deliveries.form.vehiclePlate')}>
              {(id) => <Input id={id} value={vehiclePlate} maxLength={20} onChange={(e) => setVehiclePlate(e.target.value)} />}
            </Field>
            <Field label={t('deliveries.form.driverName')}>
              {(id) => <Input id={id} value={driverName} maxLength={80} onChange={(e) => setDriverName(e.target.value)} />}
            </Field>
            <Field label={t('common.description')} className="sm:col-span-2 lg:col-span-4">
              {(id) => <Input id={id} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <section aria-label={t('deliveries.form.lines')}>
            <div className={cn('mb-2 grid items-end gap-2 px-1 micro max-lg:hidden', gridCols)}>
              <span>{t('deliveries.form.item')}</span>
              <span>{t('common.description')}</span>
              <span className="text-right">{t('deliveries.form.quantity')}</span>
              {inbound && (
                <>
                  <span className="text-right">{t('deliveries.form.unitCost')}</span>
                  <span>{t('deliveries.form.currency')}</span>
                  <span className="text-right">{t('deliveries.form.fxRate')}</span>
                </>
              )}
              <span />
            </div>
            <div className="flex flex-col gap-3">
              {lines.map((l, i) => {
                const it = itemById.get(l.itemId);
                const onHand = it ? dec(it.onHand) : null;
                const short = !inbound && !allowNegative && onHand !== null && l.quantity !== '' && dec(l.quantity).gt(onHand);
                return (
                  <div key={l.key} className="rounded-lg border border-border p-2 lg:border-0 lg:p-0">
                    <div className={cn('grid grid-cols-2 items-center gap-2', gridCols)}>
                      <Combobox
                        className="col-span-2 lg:col-span-1"
                        options={itemOptions}
                        value={l.itemId || null}
                        placeholder={t('deliveries.form.pickItem')}
                        aria-label={`${t('deliveries.form.item')} ${i + 1}`}
                        onChange={(v) => pickItem(l.key, v)}
                      />
                      <Input className="col-span-2 lg:col-span-1" value={l.description} maxLength={300} aria-label={`${t('common.description')} ${i + 1}`} placeholder={t('common.description')} onChange={(e) => patch(l.key, { description: e.target.value })} />
                      <MoneyInput value={l.quantity} decimals={0} maxDecimals={4} aria-label={`${t('deliveries.form.quantity')} ${i + 1}`} placeholder={l.unit ? unitLabel(l.unit) : undefined} className="text-right" onChange={(v) => patch(l.key, { quantity: v })} />
                      {inbound && (
                        <>
                          <MoneyInput value={l.unitCost} maxDecimals={6} aria-label={`${t('deliveries.form.unitCost')} ${i + 1}`} className="text-right" onChange={(v) => patch(l.key, { unitCost: v })} />
                          <Select
                            className="px-2 pr-6"
                            value={l.currency}
                            aria-label={`${t('deliveries.form.currency')} ${i + 1}`}
                            onChange={(e) => patch(l.key, { currency: e.target.value, fxRate: '' })}
                          >
                            {CURRENCY_CODES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </Select>
                          <MoneyInput value={l.fxRate} decimals={4} maxDecimals={8} disabled={l.currency === base || l.unitCost === ''} placeholder="—" aria-label={`${t('deliveries.form.fxRate')} ${i + 1}`} className="text-right" onChange={(v) => patch(l.key, { fxRate: v })} />
                        </>
                      )}
                      <button
                        className="justify-self-end rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                        disabled={lines.length <= 1}
                        onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
                        aria-label={t('deliveries.form.removeLine')}
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    {(it && !inbound) || (inbound && it && l.unitCost === '') ? (
                      <p className={cn('mt-1.5 pl-1 text-[13px]', short ? 'text-warning' : 'text-muted')}>
                        {!inbound && onHand !== null && (short ? t('deliveries.form.notEnough', { qty: qtyText(it!.onHand) || '0', unit: unitLabel(it!.unit) }) : t('deliveries.form.onHand', { qty: qtyText(it!.onHand) || '0', unit: unitLabel(it!.unit) }))}
                        {inbound && l.unitCost === '' && t('deliveries.form.unitCostHint')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setLines((cur) => [...cur, emptyLine(base)])}>
                <Plus className="size-3.5" aria-hidden />
                {t('deliveries.form.addLine')}
              </Button>
            </div>
          </section>
        </Card>

        <p className="text-[13px] text-muted">{t('deliveries.form.postNote')}</p>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {initial && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" aria-hidden />
                {t('deliveries.form.deleteDraft')}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => navigate(listPath)}>{t('common.cancel')}</Button>
            <Button loading={save.isPending && !save.variables} onClick={() => submit(false)}>
              {t('deliveries.form.saveDraft')}
            </Button>
            {canPost && (
              <Button variant="primary" loading={save.isPending && !!save.variables} onClick={() => submit(true)}>
                {t('deliveries.form.savePost')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deliveries.form.deleteDraft')}
        description={t('deliveries.form.deleteConfirm')}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => {
                    toast.success(t('deliveries.form.deleted'));
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
