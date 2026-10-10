import { useEffect, useState } from 'react';
import { CustomValuesPanel } from '../manufacturing/SupportPanels';
import { useTranslation } from 'react-i18next';
import { INVENTORY_ROLES, ITEM_KINDS, ITEM_UNITS, type InventoryRole } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { useCMutation, useCQuery, useCompanyApi } from '../../lib/queries';
import type { Item, ItemKind, TaxRate } from '../../lib/types';
import { STOCK_INVALIDATE, useCategories } from './common';

interface FormState {
  name: string;
  code: string;
  kind: ItemKind;
  inventoryRole: InventoryRole;
  unit: string;
  categoryId: string;
  barcode: string;
  vatCode: string;
  purchasePrice: string;
  purchaseCurrency: string;
  salePrice: string;
  saleCurrency: string;
  minLevel: string;
  targetLevel: string;
  notes: string;
  tracksSerial: boolean;
}

/** "12.500000" -> "12.5" */
const trim = (v: string | null) => (v && v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : (v ?? ''));

const fromItem = (i: Item): FormState => ({
  name: i.name,
  code: i.code,
  kind: i.kind,
  inventoryRole: i.inventoryRole ?? 'merchandise',
  unit: i.unit,
  categoryId: i.categoryId ?? '',
  barcode: i.barcode ?? '',
  vatCode: i.vatCode ?? '',
  purchasePrice: trim(i.purchasePrice),
  purchaseCurrency: i.purchaseCurrency,
  salePrice: trim(i.salePrice),
  saleCurrency: i.saleCurrency,
  minLevel: trim(i.minLevel),
  targetLevel: trim(i.targetLevel ?? null),
  notes: i.notes ?? '',
  tracksSerial: i.tracksSerial,
});

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Verilirse düzenleme; yoksa yeni kart */
  item?: Item | null;
  onSaved: (item: Item) => void;
}

/** Stok kartı formu (yeni/düzenle) — yan panelde açılır. */
export function ItemFormSheet({ open, onOpenChange, item, onSaved }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { company } = useCompanyApi();
  const editing = !!item;
  const empty: FormState = {
    name: '', code: '', kind: 'goods', inventoryRole: 'merchandise', unit: 'adet', categoryId: '', barcode: '', vatCode: '',
    purchasePrice: '', purchaseCurrency: company.baseCurrency, salePrice: '', saleCurrency: company.baseCurrency, minLevel: '', targetLevel: '', notes: '', tracksSerial: false,
  };
  const [f, setF] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { data: cats } = useCategories();
  const { data: taxes } = useCQuery<{ taxRates: TaxRate[] }>(['tax-rates'], '/api/tax-rates', { enabled: open });

  useEffect(() => {
    if (open) {
      setF(item ? fromItem(item) : empty);
      setError(null);
      setErrors({});
    }
    // empty her render yeniden oluşur; yalnızca açılış/kart değişiminde sıfırlanmalı
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((cur) => ({ ...cur, [key]: value }));
  const goods = f.kind === 'goods';
  const vatCodes = [...new Set((taxes?.taxRates ?? []).map((r) => r.code))];

  const save = useCMutation(
    async (_: void, call) => {
      if (editing) {
        // Boş metin/değer alanı temizler (sunucu şeması)
        const res = await call<{ item: Item }>(`/api/items/${item.id}`, {
          method: 'PATCH',
          body: {
            name: f.name.trim(),
            kind: f.kind,
            ...(['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector) && goods ? { inventoryRole: f.inventoryRole } : {}),
            unit: f.unit,
            categoryId: f.categoryId || null,
            barcode: f.barcode,
            vatCode: f.vatCode,
            purchasePrice: f.purchasePrice || null,
            purchaseCurrency: f.purchaseCurrency,
            salePrice: f.salePrice || null,
            saleCurrency: f.saleCurrency,
            minLevel: goods && f.minLevel ? f.minLevel : null,
            targetLevel: goods && f.targetLevel ? f.targetLevel : null,
            notes: f.notes,
            tracksSerial: goods && f.tracksSerial,
          },
        });
        return res.item;
      }
      const res = await call<{ item: Item }>('/api/items', {
        method: 'POST',
        body: {
          name: f.name.trim(),
          kind: f.kind,
          ...(['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector) && goods ? { inventoryRole: f.inventoryRole } : {}),
          unit: f.unit,
          ...(f.code.trim() ? { code: f.code.trim() } : {}),
          ...(f.categoryId ? { categoryId: f.categoryId } : {}),
          barcode: f.barcode,
          vatCode: f.vatCode,
          ...(f.purchasePrice ? { purchasePrice: f.purchasePrice } : {}),
          purchaseCurrency: f.purchaseCurrency,
          ...(f.salePrice ? { salePrice: f.salePrice } : {}),
          saleCurrency: f.saleCurrency,
          ...(goods && f.minLevel ? { minLevel: f.minLevel } : {}),
          ...(goods && f.targetLevel ? { targetLevel: f.targetLevel } : {}),
          ...(goods && f.tracksSerial ? { tracksSerial: true } : {}),
          notes: f.notes,
        },
      });
      return res.item;
    },
    [...STOCK_INVALIDATE, ['dashboard']],
  );

  const submit = () => {
    setError(null);
    setErrors({});
    save.mutate(undefined, {
      onSuccess: (saved) => {
        toast.success(editing ? t('inventory.items.updated') : t('inventory.items.created'));
        onSaved(saved);
        onOpenChange(false);
      },
      onError: (e) => {
        setErrors(fieldErrors(e));
        setError(errorMessage(e));
      },
    });
  };

  const currencySelect = (id: string, value: string, key: 'purchaseCurrency' | 'saleCurrency') => (
    <Select id={id} value={value} onChange={(e) => set(key, e.target.value)} className="px-2 pr-6">
      <CurrencyOptions />
    </Select>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? t('inventory.form.editTitle') : t('inventory.form.newTitle')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={f.name.trim().length < 2} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim().length >= 2) submit();
        }}
        noValidate
      >
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label={t('inventory.form.name')} error={errors.name} required>
          {(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />}
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('inventory.form.kind')}>
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => set('kind', e.target.value as ItemKind)}>
                {ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`inventory.kinds.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('inventory.form.unit')}>
            {(id) => (
              <Select id={id} value={f.unit} onChange={(e) => set('unit', e.target.value)}>
                {ITEM_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(`inventory.units.${u}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {['LEATHER_FASHION', 'MANUFACTURING_WHOLESALE'].includes(company.sector) && goods && <Field label="Üretim stok rolü" hint="Hammadde ve mamul maliyet hesaplarının ayrılmasını sağlar." error={errors.inventoryRole}>
          {(id) => <Select id={id} value={f.inventoryRole} onChange={(event) => set('inventoryRole', event.target.value as InventoryRole)}>{INVENTORY_ROLES.map((role) => <option key={role} value={role}>{{ merchandise: 'Ticari mal', raw_material: 'Hammadde', semi_finished: 'Yarı mamul', finished_goods: 'Mamul' }[role]}</option>)}</Select>}
        </Field>}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('inventory.form.code')} hint={editing ? undefined : t('inventory.form.codeHint')} error={errors.code}>
            {(id) => <Input id={id} value={f.code} onChange={(e) => set('code', e.target.value)} disabled={editing} placeholder="ST-000001" />}
          </Field>
          <Field label={t('inventory.form.barcode')} error={errors.barcode}>
            {(id) => <Input id={id} value={f.barcode} onChange={(e) => set('barcode', e.target.value)} inputMode="numeric" />}
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('inventory.form.category')}>
            {(id) => (
              <Select id={id} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">{t('inventory.form.noCategory')}</option>
                {cats?.categories
                  .filter((c) => c.isActive || c.id === f.categoryId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={t('inventory.form.vatCode')} error={errors.vatCode}>
            {(id) => (
              <Select id={id} value={f.vatCode} onChange={(e) => set('vatCode', e.target.value)}>
                <option value="">{t('inventory.form.noVat')}</option>
                {vatCodes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-x-3 gap-y-5">
          <Field label={t('inventory.form.purchasePrice')} error={errors.purchasePrice}>
            {(id) => <MoneyInput id={id} value={f.purchasePrice} onChange={(v) => set('purchasePrice', v)} maxDecimals={6} />}
          </Field>
          <Field label={t('inventory.form.purchaseCurrency')}>{(id) => currencySelect(id, f.purchaseCurrency, 'purchaseCurrency')}</Field>
          <Field label={t('inventory.form.salePrice')} error={errors.salePrice}>
            {(id) => <MoneyInput id={id} value={f.salePrice} onChange={(v) => set('salePrice', v)} maxDecimals={6} />}
          </Field>
          <Field label={t('inventory.form.saleCurrency')}>{(id) => currencySelect(id, f.saleCurrency, 'saleCurrency')}</Field>
          <p className="col-span-full -mt-2 text-xs text-muted">{t('inventory.form.pricesHint')}</p>
        </div>

        {goods && (<>
          <Field label={t('inventory.form.minLevel')} hint={t('inventory.form.minLevelHint')} error={errors.minLevel}>
            {(id) => <MoneyInput id={id} value={f.minLevel} onChange={(v) => set('minLevel', v)} decimals={0} maxDecimals={4} />}
          </Field>
          <Field label="Hedef stok miktarı" hint="Minimuma düşünce satın alma önerisi bu hedefe tamamlar. Boş bırakılırsa hedef tahmin edilmez." error={errors.targetLevel}>
            {id => <MoneyInput id={id} value={f.targetLevel} onChange={value => set('targetLevel', value)} decimals={0} maxDecimals={4} />}
          </Field>
        </>)}
        {goods && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={f.tracksSerial} onChange={(e) => set('tracksSerial', e.target.checked)} />
            <span>
              {t('inventory.form.tracksSerial')}
              <span className="block text-xs text-muted">{t('inventory.form.tracksSerialHint')}</span>
            </span>
          </label>
        )}
        <Field label={t('inventory.form.notes')} error={errors.notes}>
          {(id) => <Textarea id={id} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} />}
        </Field>
      </form>
      {open&&item&&['MANUFACTURING_WHOLESALE','LEATHER_FASHION'].includes(company.sector)&&<CustomValuesPanel entity="item" id={item.id}/>}
    </Sheet>
  );
}
