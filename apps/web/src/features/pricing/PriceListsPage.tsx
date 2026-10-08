import { Plus, Tag } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { currencySymbol, formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCompanyApi } from '../../lib/queries';
import type { PriceKind, PriceListRow } from '../../lib/types';
import { KindBadge, PRICING_INVALIDATE, usePriceLists } from './common';

interface Form {
  code: string;
  name: string;
  kind: PriceKind;
  currency: string;
  validFrom: string;
  validTo: string;
  isDefault: boolean;
}

/** Fiyat listeleri: satış/alış, para birimli, geçerlilik tarihli adlandırılmış listeler. */
export function PriceListsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { company } = useCompanyApi();
  const canManage = useCan()('invoices.manage');
  const { data, isPending } = usePriceLists();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useCMutation(
    (f: Form, call) =>
      call<{ list: PriceListRow }>('/api/price-lists', {
        method: 'POST',
        body: { code: f.code.trim(), name: f.name.trim(), kind: f.kind, currency: f.currency, isDefault: f.isDefault, validFrom: f.validFrom || null, validTo: f.validTo || null },
      }),
    PRICING_INVALIDATE,
  );

  const submit = () => {
    if (!form) return;
    setError(null);
    create.mutate(form, {
      onSuccess: (res) => {
        toast.success(t('pricing.lists.created'));
        setForm(null);
        navigate(`/price-lists/${res.list.id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };

  return (
    <>
      <PageHeader
        title={t('pricing.lists.title')}
        description={t('pricing.lists.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/party-prices" className="link text-sm">
              {t('nav.partyPrices')}
            </Link>
            {canManage && (
              <Button variant="primary" onClick={() => setForm({ code: '', name: '', kind: 'sales', currency: company.baseCurrency, validFrom: '', validTo: '', isDefault: false })}>
                <Plus className="size-4" aria-hidden />
                {t('pricing.lists.add')}
              </Button>
            )}
          </div>
        }
      />
      {isPending ? (
        <PageLoading />
      ) : !data?.lists.length ? (
        <Card>
          <EmptyState icon={<Tag className="size-5" />} title={t('pricing.lists.empty')} description={t('pricing.lists.emptyHint')} />
        </Card>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t('pricing.lists.code')}</Th>
                <Th>{t('pricing.lists.name')}</Th>
                <Th>{t('pricing.lists.kind')}</Th>
                <Th>{t('pricing.lists.currency')}</Th>
                <Th>{t('pricing.lists.validity')}</Th>
                <Th num>{t('pricing.lists.itemCount')}</Th>
                <Th num>{t('pricing.lists.partyCount')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.lists.map((l) => (
                <Tr key={l.id} className={l.isActive ? undefined : 'opacity-60'}>
                  <Td className="font-mono text-[13px]">
                    <Link to={`/price-lists/${l.id}`} className="link">
                      {l.code}
                    </Link>
                  </Td>
                  <Td>
                    {l.name}
                    {l.isDefault && <Badge tone="brand" className="ml-2">{t('pricing.lists.default')}</Badge>}
                    {!l.isActive && <Badge tone="danger" className="ml-2">{t('common.inactive')}</Badge>}
                  </Td>
                  <Td>
                    <KindBadge kind={l.kind} />
                  </Td>
                  <Td>{currencySymbol(l.currencyCode)}</Td>
                  <Td className="text-muted">{l.validFrom || l.validTo ? `${l.validFrom ? formatDateTR(l.validFrom) : '…'} – ${l.validTo ? formatDateTR(l.validTo) : '…'}` : t('pricing.lists.always')}</Td>
                  <Td num>{l.itemCount}</Td>
                  <Td num>{l.partyCount}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {data?.lists.length ? (
        <div className="mt-3 flex justify-end">
          <ExportMenu exportKey="party-prices" print={false} />
        </div>
      ) : null}

      <Modal
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={t('pricing.lists.newTitle')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form || !form.code.trim() || form.name.trim().length < 2} onClick={submit}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {form && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('pricing.lists.code')} required>
                {(id) => <Input id={id} value={form.code} maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value })} autoFocus />}
              </Field>
              <Field label={t('pricing.lists.kind')}>
                {(id) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PriceKind })}>
                    <option value="sales">{t('pricing.kinds.sales')}</option>
                    <option value="purchase">{t('pricing.kinds.purchase')}</option>
                  </Select>
                )}
              </Field>
            </div>
            <Field label={t('pricing.lists.name')} required>
              {(id) => <Input id={id} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
            </Field>
            <Field label={t('pricing.lists.currency')}>
              {(id) => (
                <Select id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <CurrencyOptions wide />
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('pricing.lists.validFrom')}>{(id) => <Input id={id} type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />}</Field>
              <Field label={t('pricing.lists.validTo')}>{(id) => <Input id={id} type="date" value={form.validTo} min={form.validFrom || undefined} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />}</Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
              {t('pricing.lists.makeDefault')}
            </label>
          </form>
        )}
      </Modal>
    </>
  );
}
