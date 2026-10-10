import { Percent, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox } from '../../components/ui/Combobox';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, formatMoney } from '../../lib/format';
import { useCan, useCMutation, useCompanyApi, useCQuery } from '../../lib/queries';
import type { PartyListRow, PartyPriceRow, PriceKind } from '../../lib/types';
import { qtyText } from '../inventory/common';
import { KindBadge, PRICING_INVALIDATE, trimNum, useAllItemOptions } from './common';

const EMPTY = { partyId: '', itemId: '', kind: 'sales' as PriceKind, currency: '', price: '', discountPct: '', minQty: '', validFrom: '', validTo: '' };

/** Cariye özel fiyat ve kalem iskontoları: fiyat listesinden önce gelir (çözümleme sırası ekranda belirtilir). */
export function PartyPricesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { company } = useCompanyApi();
  const canManage = useCan()('invoices.manage');
  const [partyFilter, setPartyFilter] = useState('');
  const { data, isPending, error: PartyPricesPageQueryError, refetch: PartyPricesPageQueryRetry, isFetching: PartyPricesPageQueryFetching } = useCQuery<{ prices: PartyPriceRow[]; total: number }>(['party-prices', partyFilter], `/api/party-prices?limit=500${partyFilter ? `&partyId=${partyFilter}` : ''}`);
  const { data: partyData } = useCQuery<{ parties: PartyListRow[] }>(['parties', 'options', 'pricing'], '/api/parties?limit=500&active=true');
  const { options: itemOptions } = useAllItemOptions(canManage);
  const partyOptions = (partyData?.parties ?? []).map((p) => ({ value: p.id, label: p.name, keywords: `${p.code} ${p.taxNumber ?? ''}`, hint: p.code }));
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useCMutation(
    (f: typeof EMPTY, call) =>
      call('/api/party-prices', {
        method: 'POST',
        body: {
          partyId: f.partyId,
          itemId: f.itemId,
          kind: f.kind,
          ...(f.price !== '' ? { price: f.price, currency: f.currency || company.baseCurrency } : {}),
          ...(f.discountPct !== '' ? { discountPct: f.discountPct } : {}),
          minQty: f.minQty || '0',
          validFrom: f.validFrom || null,
          validTo: f.validTo || null,
        },
      }),
    PRICING_INVALIDATE,
  );
  const del = useCMutation((id: string, call) => call(`/api/party-prices/${id}`, { method: 'DELETE' }), PRICING_INVALIDATE);

  const submit = () => {
    if (!form) return;
    setError(null);
    add.mutate(form, {
      onSuccess: () => {
        toast.success(t('pricing.party.saved'));
        setForm(null);
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };

  if (PartyPricesPageQueryError && !data) return <ErrorState error={PartyPricesPageQueryError} onRetry={() => void PartyPricesPageQueryRetry()} retrying={PartyPricesPageQueryFetching} />;
  return (
    <>
      <PageHeader
        title={t('pricing.party.title')}
        description={t('pricing.party.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/price-lists" className="link text-sm">
              {t('nav.priceLists')}
            </Link>
            <ExportMenu exportKey="party-prices" params={{ partyId: partyFilter }} print={false} />
            {canManage && (
              <Button variant="primary" onClick={() => setForm({ ...EMPTY, partyId: partyFilter, currency: company.baseCurrency })}>
                <Plus className="size-4" aria-hidden />
                {t('pricing.party.add')}
              </Button>
            )}
          </div>
        }
      />
      <Callout>{t('pricing.order')}</Callout>
      <div className="my-4 max-w-sm">
        <Combobox options={partyOptions} value={partyFilter || null} placeholder={t('pricing.party.allParties')} aria-label={t('pricing.party.party')} onChange={setPartyFilter} />
        {partyFilter && (
          <button className="link mt-1 text-sm" onClick={() => setPartyFilter('')}>
            {t('pricing.party.clearFilter')}
          </button>
        )}
      </div>
      {isPending ? (
        <PageLoading />
      ) : !data?.prices.length ? (
        <Card>
          <EmptyState icon={<Percent className="size-5" />} title={t('pricing.party.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('pricing.party.party')}</Th>
                <Th>{t('pricing.detail.item')}</Th>
                <Th>{t('pricing.lists.kind')}</Th>
                <Th num>{t('pricing.detail.price')}</Th>
                <Th num>{t('pricing.party.discount')}</Th>
                <Th num>{t('pricing.detail.minQty')}</Th>
                <Th>{t('pricing.detail.validity')}</Th>
                {canManage && <Th className="w-12" />}
              </tr>
            </thead>
            <tbody>
              {data.prices.map((p) => (
                <Tr key={p.id}>
                  <Td>{p.partyName}</Td>
                  <Td>
                    <span className="font-mono text-[13px]">{p.itemCode}</span> {p.itemName}
                  </Td>
                  <Td>
                    <KindBadge kind={p.kind} />
                  </Td>
                  <Td num>{p.price ? formatMoney(trimNum(p.price), p.currencyCode ?? company.baseCurrency, 6) : '—'}</Td>
                  <Td num>{p.discountPct ? `%${trimNum(p.discountPct)}` : '—'}</Td>
                  <Td num>{qtyText(p.minQty) || '0'}</Td>
                  <Td className="text-muted">{p.validFrom || p.validTo ? `${p.validFrom ? formatDateTR(p.validFrom) : '…'} – ${p.validTo ? formatDateTR(p.validTo) : '…'}` : t('pricing.lists.always')}</Td>
                  {canManage && (
                    <Td>
                      <Button size="sm" variant="ghost" aria-label={`${t('pricing.party.delete')}: ${p.itemCode}`} onClick={() => del.mutate(p.id, { onError: (e) => toast.error(errorMessage(e)) })}>
                        <Trash2 className="size-3.5 text-danger" aria-hidden />
                      </Button>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      <Modal
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={t('pricing.party.add')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} disabled={!form || !form.partyId || !form.itemId || (form.price === '' && form.discountPct === '')} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {form && (
          <div className="flex flex-col gap-4">
            {error && <Callout tone="danger">{error}</Callout>}
            <Field label={t('pricing.party.party')} required>
              {(id) => <Combobox id={id} options={partyOptions} value={form.partyId || null} placeholder={t('pricing.party.pickParty')} onChange={(v) => setForm({ ...form, partyId: v })} />}
            </Field>
            <Field label={t('pricing.detail.item')} required>
              {(id) => <Combobox id={id} options={itemOptions} value={form.itemId || null} placeholder={t('pricing.detail.pickItem')} onChange={(v) => setForm({ ...form, itemId: v })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('pricing.lists.kind')}>
                {(id) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PriceKind })}>
                    <option value="sales">{t('pricing.kinds.sales')}</option>
                    <option value="purchase">{t('pricing.kinds.purchase')}</option>
                  </Select>
                )}
              </Field>
              <Field label={t('pricing.lists.currency')}>
                {(id) => (
                  <Select id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    <CurrencyOptions wide />
                  </Select>
                )}
              </Field>
              <Field label={t('pricing.detail.price')} hint={t('pricing.party.priceHint')}>
                {(id) => <MoneyInput id={id} value={form.price} maxDecimals={6} onChange={(v) => setForm({ ...form, price: v })} />}
              </Field>
              <Field label={t('pricing.party.discount')}>
                {(id) => <MoneyInput id={id} value={form.discountPct} decimals={0} maxDecimals={4} placeholder="%" onChange={(v) => setForm({ ...form, discountPct: v })} />}
              </Field>
              <Field label={t('pricing.detail.minQty')} hint={t('pricing.detail.minQtyHint')}>
                {(id) => <MoneyInput id={id} value={form.minQty} decimals={0} maxDecimals={4} onChange={(v) => setForm({ ...form, minQty: v })} />}
              </Field>
              <span />
              <Field label={t('pricing.lists.validFrom')}>{(id) => <Input id={id} type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />}</Field>
              <Field label={t('pricing.lists.validTo')}>{(id) => <Input id={id} type="date" value={form.validTo} min={form.validFrom || undefined} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />}</Field>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
