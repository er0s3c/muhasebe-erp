import { useQueries } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { applyRate, currencySymbol, dec, formatMoney, formatTR, type MoneyValue, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Combobox } from '../../components/ui/Combobox';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { useToast } from '../../components/ui/Toast';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useCMutation, useCompanyApi, useNavigation } from '../../lib/queries';
import type { StockDocDetail, StockDocType } from '../../lib/types';
import { PROJECT_COST_INVALIDATE, ProjectLineRow, projectFields } from '../projects/common';
import { SerialEntry } from './SerialEntry';
import { STOCK_INVALIDATE, qtyText, useItemOptions, useUnitLabel, useWarehouses } from './common';

export type MovementType = Exclude<StockDocType, 'count'>;
const TYPES: readonly MovementType[] = ['receipt', 'issue', 'waste', 'transfer', 'opening'];
const INBOUND: readonly MovementType[] = ['receipt', 'opening'];

interface LineState {
  key: number;
  itemId: string;
  qty: string;
  unitCost: string;
  currency: string;
  fxRate: string;
  /** Proje boyutu (inşaat): yalnızca çıkış (sarf) ve fire satırlarında */
  projectId: string;
  wbsId: string;
  /** Seri takipli kartta seri no'lar (X3) */
  serials?: string[];
}

let lineKey = 1;
const emptyLine = (currency: string, itemId = ''): LineState => ({ key: lineKey++, itemId, qty: '', unitCost: '', currency, fxRate: '', projectId: '', wbsId: '' });

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: MovementType;
  /** Kart sayfasından açılırsa kart hazır gelir */
  initialItemId?: string;
  onSaved: (doc: StockDocDetail) => void;
}

/** Stok hareketi formu: giriş/devir (maliyetli, dövizli), çıkış/fire, transfer. */
export function MovementFormSheet({ open, onOpenChange, initialType = 'receipt', initialItemId, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const unitLabel = useUnitLabel();
  const { company, call } = useCompanyApi();
  const base = company.baseCurrency;
  const { data: nav } = useNavigation();
  const allowNegative = nav?.company.allowNegativeStock ?? false;
  const { data: whData } = useWarehouses();
  const warehouses = (whData?.warehouses ?? []).filter((w) => w.isActive);

  const [type, setType] = useState<MovementType>(initialType);
  const [date, setDate] = useState(todayIso());
  const [warehouseId, setWarehouseId] = useState('');
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<LineState[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const inbound = INBOUND.includes(type);
  // Malzeme sarfı ve fire maliyeti projeye yazılabilir
  const projectAllowed = type === 'issue' || type === 'waste';
  const { byId, options } = useItemOptions(open, warehouseId || undefined);

  useEffect(() => {
    if (!open) return;
    setType(initialType);
    setDate(todayIso());
    setToWarehouseId('');
    setDescription('');
    setError(null);
    setFieldError(null);
    setLines([emptyLine(base, initialItemId)]);
  }, [open, initialType, initialItemId, base]);

  // Varsayılan depoyu (yüklenince) hazırla
  useEffect(() => {
    if (open && !warehouseId && warehouses.length > 0) {
      setWarehouseId((warehouses.find((w) => w.isDefault) ?? warehouses[0]!).id);
    }
  }, [open, warehouseId, warehouses]);
  useEffect(() => {
    if (!open) setWarehouseId('');
  }, [open]);

  // Dövizli giriş satırları için hareket tarihindeki kayıtlı kuru önizleme amacıyla sorgula
  const foreign = inbound ? [...new Set(lines.map((l) => l.currency).filter((c) => c !== base))] : [];
  const rateQueries = useQueries({
    queries: foreign.map((cur) => ({
      queryKey: [company.id, 'rate-lookup', cur, base, date],
      queryFn: () => call<{ rate: string | null }>(`/api/exchange-rates/lookup?from=${cur}&to=${base}&date=${date}`),
      enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(date),
    })),
  });
  const lookedUp = new Map(foreign.map((cur, i) => [cur, rateQueries[i]?.data?.rate ?? null]));

  const rateOf = (l: LineState): MoneyValue | null =>
    l.currency === base ? dec(1) : l.fxRate ? dec(l.fxRate) : lookedUp.get(l.currency) ? dec(lookedUp.get(l.currency)!) : null;

  const computed = useMemo(() => {
    let total = dec(0);
    let missing = false;
    let overdrawn = false;
    for (const l of lines) {
      if (!l.itemId || !l.qty) continue;
      if (inbound) {
        if (l.unitCost === '') continue;
        const rate = rateOf(l);
        if (!rate) missing = true;
        else total = total.plus(applyRate(dec(l.qty).times(l.unitCost), rate));
      } else {
        const it = byId.get(l.itemId);
        if (!it) continue;
        total = total.plus(dec(l.qty).times(it.avgCost ?? 0));
        if (!allowNegative && dec(l.qty).gt(it.onHand)) overdrawn = true;
      }
    }
    return { total, missing, overdrawn };
    // lookedUp/rateOf her render yeniden kurulur; içerik rateQueries ile değişir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, inbound, byId, allowNegative, base, rateQueries.map((q) => q.data?.rate ?? '').join('|')]);

  const patch = (key: number, p: Partial<LineState>) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const save = useCMutation(
    (_: void, c) =>
      c<StockDocDetail>('/api/stock-documents', {
        method: 'POST',
        body: {
          type,
          docDate: date,
          warehouseId,
          ...(type === 'transfer' ? { toWarehouseId } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          lines: lines.map((l) => ({
            itemId: l.itemId,
            quantity: l.qty,
            ...(inbound ? { unitCost: l.unitCost, currency: l.currency, ...(l.currency !== base && l.fxRate ? { fxRate: l.fxRate } : {}) } : {}),
            ...(projectAllowed ? projectFields(l.projectId, l.wbsId) : {}),
            ...(l.serials && l.serials.length > 0 ? { serials: l.serials } : {}),
          })),
        },
      }),
    [...STOCK_INVALIDATE, ['dashboard'], ...PROJECT_COST_INVALIDATE],
  );

  const submit = () => {
    setError(null);
    setFieldError(null);
    if (lines.length === 0 || lines.some((l) => !l.itemId || !l.qty || dec(l.qty).lte(0))) return setFieldError(t('inventory.mform.linesRequired'));
    if (inbound && lines.some((l) => l.unitCost === '')) return setFieldError(t('inventory.mform.costRequired'));
    save.mutate(undefined, {
      onSuccess: (doc) => {
        toast.success(t('inventory.mform.saved', { no: doc.document.docNo }));
        onSaved(doc);
        onOpenChange(false);
      },
      onError: (e) => setError(e),
    });
  };

  const fxMissing = error instanceof ApiError && error.code === 'FX_RATE_MISSING';
  const canSave = !!warehouseId && (type !== 'transfer' || (!!toWarehouseId && toWarehouseId !== warehouseId)) && !computed.missing && !computed.overdrawn;
  const gridIn = 'lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1fr)_84px_minmax(0,0.8fr)_minmax(0,1.1fr)_32px]';
  const gridOut = 'lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.8fr)_32px]';

  return (
    <Sheet
      wide
      open={open}
      onOpenChange={onOpenChange}
      title={t('inventory.mform.title')}
      footer={
        <>
          <div className="mr-auto text-sm" aria-live="polite">
            {computed.missing ? (
              <span className="text-warning">{t('inventory.mform.fxMissing')}</span>
            ) : computed.overdrawn ? (
              <span className="text-danger">{t('inventory.mform.insufficient')}</span>
            ) : computed.total.gt(0) ? (
              <span className="text-muted">
                {inbound ? t('inventory.mform.totalValue', { currency: currencySymbol(base) }) : t('inventory.mform.estimated', { value: formatMoney(computed.total.toFixed(2), base) })}
                {inbound && <span className="num ml-2 text-text">{formatTR(computed.total.toFixed(2))}</span>}
              </span>
            ) : null}
          </div>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={submit}>
            {t('inventory.mform.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {(error || fieldError) && (
          <Callout
            tone="danger"
            action={
              fxMissing ? (
                <Link to="/settings/currencies" className="shrink-0 text-sm link" onClick={() => onOpenChange(false)}>
                  {t('ledger.journal.enterFx')}
                </Link>
              ) : undefined
            }
          >
            {error ? errorMessage(error) : fieldError}
          </Callout>
        )}

        <div>
          <p className="mb-1.5 text-[13px]">{t('inventory.mform.type')}</p>
          <SegmentedTabs variant="filter"
            value={type}
            onChange={(k) => {
              setType(k);
              setLines((cur) => cur.map((l) => ({ ...l, unitCost: '', fxRate: '', projectId: '', wbsId: '' })));
            }}
            items={TYPES.map((k) => ({ key: k, label: t(`inventory.docTypes.${k}`) }))}
          />
          <p className="mt-2 text-[13px] text-muted">{t(`inventory.mform.hints.${type}`)}</p>
        </div>

        <div className={cn('grid gap-4', type === 'transfer' ? 'sm:grid-cols-[160px_1fr_1fr]' : 'sm:grid-cols-[160px_1fr]')}>
          <Field label={t('inventory.mform.date')} required>
            {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label={type === 'transfer' ? t('inventory.mform.fromWarehouse') : t('inventory.mform.warehouse')} required>
            {(id) => (
              <Select id={id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'transfer' && (
            <Field label={t('inventory.mform.toWarehouse')} required>
              {(id) => (
                <Select id={id} value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                  <option value="" />
                  {warehouses
                    .filter((w) => w.id !== warehouseId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <Field label={t('inventory.mform.description')}>
          {(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />}
        </Field>

        <section aria-label={t('inventory.mform.lines')}>
          <div className={cn('mb-2 grid items-end gap-2 px-1 micro max-lg:hidden', inbound ? gridIn : gridOut)}>
            <span>{t('inventory.mform.item')}</span>
            <span className="text-right">{t('inventory.mform.quantity')}</span>
            {inbound ? (
              <>
                <span className="text-right">{t('inventory.mform.unitCost')}</span>
                <span>{t('inventory.mform.currency')}</span>
                <span className="text-right">{t('inventory.mform.fxRate')}</span>
                <span className="text-right">{t('inventory.mform.valueBase', { currency: currencySymbol(base) })}</span>
              </>
            ) : (
              <span />
            )}
            <span />
          </div>
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => {
              const it = byId.get(l.itemId);
              const rate = rateOf(l);
              const value = inbound && l.qty && l.unitCost !== '' && rate ? applyRate(dec(l.qty).times(l.unitCost), rate) : null;
              const over = !inbound && it && l.qty && !allowNegative && dec(l.qty).gt(it.onHand);
              return (
                <div key={l.key} className="flex flex-col gap-1.5 rounded-lg border border-border p-2 lg:border-0 lg:p-0">
                <div className={cn('grid grid-cols-2 items-center gap-2', inbound ? gridIn : gridOut)}>
                  <Combobox
                    className="col-span-2 lg:col-span-1"
                    options={options}
                    value={l.itemId || null}
                    placeholder={t('inventory.mform.pickItem')}
                    aria-label={`${t('inventory.mform.item')} ${i + 1}`}
                    onChange={(v) => patch(l.key, { itemId: v, serials: [] })}
                  />
                  <MoneyInput value={l.qty} decimals={0} maxDecimals={4} aria-label={`${t('inventory.mform.quantity')} ${i + 1}`} placeholder={it ? unitLabel(it.unit) : t('inventory.mform.quantity')} onChange={(v) => patch(l.key, { qty: v })} />
                  {inbound ? (
                    <>
                      <MoneyInput value={l.unitCost} maxDecimals={6} aria-label={`${t('inventory.mform.unitCost')} ${i + 1}`} placeholder={t('inventory.mform.unitCost')} onChange={(v) => patch(l.key, { unitCost: v })} />
                      <Select className="px-2 pr-6" value={l.currency} onChange={(e) => patch(l.key, { currency: e.target.value, fxRate: '' })} aria-label={`${t('inventory.mform.currency')} ${i + 1}`}>
                        <CurrencyOptions />
                      </Select>
                      <MoneyInput
                        value={l.fxRate}
                        decimals={4}
                        maxDecimals={8}
                        disabled={l.currency === base}
                        placeholder={l.currency === base ? '—' : lookedUp.get(l.currency) ? formatTR(lookedUp.get(l.currency), 4) : '?'}
                        aria-label={`${t('inventory.mform.fxRate')} ${i + 1}`}
                        onChange={(v) => patch(l.key, { fxRate: v })}
                      />
                      <span className="num text-right text-sm" aria-label={`${t('inventory.mform.valueBase', { currency: currencySymbol(base) })} ${i + 1}`}>
                        {value ? formatTR(value.toFixed(2)) : '—'}
                      </span>
                    </>
                  ) : (
                    <div className="col-span-2 text-[13px] lg:col-span-1">
                      {it ? (
                        <>
                          <span className={cn(over ? ' text-danger' : 'text-muted')}>
                            {t('inventory.mform.available', { qty: qtyText(it.onHand) || '0', unit: unitLabel(it.unit) })}
                          </span>
                          {l.qty && it.avgCost && (
                            <span className="ml-2 text-muted">· {t('inventory.mform.estimated', { value: formatMoney(dec(l.qty).times(it.avgCost).toFixed(2), base) })}</span>
                          )}
                        </>
                      ) : null}
                    </div>
                  )}
                  <button
                    className="justify-self-end rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"
                    disabled={lines.length <= 1}
                    onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}
                    aria-label={t('inventory.mform.removeLine')}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                {it?.tracksSerial && (
                  <div className="pl-1 text-[13px] text-muted">
                    <SerialEntry label={String(i + 1)} serials={l.serials ?? []} quantity={l.qty} onChange={(serials) => patch(l.key, { serials })} />
                  </div>
                )}
                {projectAllowed && (
                  <ProjectLineRow label={String(i + 1)} projectId={l.projectId} wbsId={l.wbsId} onChange={(v) => patch(l.key, v)} />
                )}
                </div>
              );
            })}
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={() => setLines((cur) => [...cur, emptyLine(base)])}>
              <Plus className="size-3.5" aria-hidden />
              {t('inventory.mform.addLine')}
            </Button>
          </div>
        </section>
      </div>
    </Sheet>
  );
}
