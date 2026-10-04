import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Field, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import type { PartyPricing } from '../../lib/types';
import { PRICING_INVALIDATE, trimNum, usePriceLists } from './common';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { useServerDraft } from '../../lib/useServerDraft';

/** Cari kartında: atanan satış/alış fiyat listesi, genel iskonto ve cariye özel fiyatlara kısayol. */
export function PartyPricingCard({ partyId, kind }: { partyId: string; kind: 'customer' | 'supplier' | 'both' }) {
  const { t } = useTranslation();
  const toast = useToast();
  const enabled = useModuleEnabled('sales.pricelists');
  const can = useCan();
  const canManage = can('invoices.manage');
  const { data } = useCQuery<PartyPricing>(['party-pricing', partyId], enabled ? `/api/parties/${partyId}/pricing` : null);
  const sales = usePriceLists('sales');
  const purchase = usePriceLists('purchase');
  // Sunucu değeri kullanıcı dokunana dek gösterilir; geç gelen/yeniden çekilen sorgu girilen değeri ezmez
  const server = useMemo(
    () => ({ salesList: data?.salesPriceListId ?? '', purchaseList: data?.purchasePriceListId ?? '', salesDiscount: data ? trimNum(data.salesDiscountPct) : '', purchaseDiscount: data ? trimNum(data.purchaseDiscountPct) : '' }),
    [data],
  );
  const { value: f, update, reset } = useServerDraft(server);

  const save = useCMutation(
    (_: void, call) =>
      call(`/api/parties/${partyId}/pricing`, {
        method: 'PUT',
        body: {
          salesPriceListId: f.salesList || null,
          purchasePriceListId: f.purchaseList || null,
          salesDiscountPct: f.salesDiscount || '0',
          purchaseDiscountPct: f.purchaseDiscount || '0',
        },
      }),
    PRICING_INVALIDATE,
  );
  if (!enabled || !can('invoices.read')) return null;
  const showSales = kind !== 'supplier';
  const showPurchase = kind !== 'customer';
  const listOptions = (rows: { id: string; code: string; name: string; currencyCode: string; isActive: boolean }[] | undefined, current: string) =>
    (rows ?? []).filter((l) => l.isActive || l.id === current).map((l) => (
      <option key={l.id} value={l.id}>
        {l.code} — {l.name} ({l.currencyCode})
      </option>
    ));

  return (
    <Card className="mt-5">
      <CardHeader
        title={t('pricing.partyCard.title')}
        description={t('pricing.partyCard.hint')}
        action={
          <Link to="/party-prices" className="link text-sm">
            {t('pricing.partyCard.special')}
          </Link>
        }
      />
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        {showSales && (
          <>
            <Field label={t('pricing.partyCard.salesList')}>
              {(id) => (
                <Select id={id} value={f.salesList} disabled={!canManage} onChange={(e) => update({ salesList: e.target.value })}>
                  <option value="">{t('pricing.partyCard.noList')}</option>
                  {listOptions(sales.data?.lists, f.salesList)}
                </Select>
              )}
            </Field>
            <Field label={t('pricing.partyCard.salesDiscount')}>
              {(id) => <MoneyInput id={id} value={f.salesDiscount} disabled={!canManage} placeholder="0" onChange={(v) => update({ salesDiscount: v })} decimals={0} maxDecimals={4} />}
            </Field>
          </>
        )}
        {showPurchase && (
          <>
            <Field label={t('pricing.partyCard.purchaseList')}>
              {(id) => (
                <Select id={id} value={f.purchaseList} disabled={!canManage} onChange={(e) => update({ purchaseList: e.target.value })}>
                  <option value="">{t('pricing.partyCard.noList')}</option>
                  {listOptions(purchase.data?.lists, f.purchaseList)}
                </Select>
              )}
            </Field>
            <Field label={t('pricing.partyCard.purchaseDiscount')}>
              {(id) => <MoneyInput id={id} value={f.purchaseDiscount} disabled={!canManage} placeholder="0" onChange={(v) => update({ purchaseDiscount: v })} decimals={0} maxDecimals={4} />}
            </Field>
          </>
        )}
      </div>
      {canManage && (
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button
            variant="primary"
            size="sm"
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: () => { reset(); toast.success(t('pricing.partyCard.saved')); }, onError: (e) => toast.error(errorMessage(e)) })}
          >
            {t('common.save')}
          </Button>
        </div>
      )}
    </Card>
  );
}
