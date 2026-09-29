import { Coins, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CURRENCY_CODES, todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { Rate } from '../../lib/types';

export function CurrenciesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const can = useCan();
  const company = useCompany();
  const { data, isPending } = useCQuery<{ rates: Rate[] }>(['rates'], '/api/exchange-rates?limit=200');
  const [date, setDate] = useState(todayIso());
  const [values, setValues] = useState<Record<string, { buy: string; sell: string }>>({});
  const foreign = CURRENCY_CODES.filter((c) => c !== company.baseCurrency);
  const canEdit = can('rates.manage');

  const latest = useMemo(() => {
    const map: Record<string, Rate> = {};
    for (const r of data?.rates ?? []) {
      if (r.quoteCode === company.baseCurrency && !map[r.currencyCode]) map[r.currencyCode] = r;
    }
    return map;
  }, [data, company.baseCurrency]);

  const save = useCMutation(
    async (_: void, call) => {
      const entries = Object.entries(values).filter(([, v]) => v.buy !== '');
      for (const [code, v] of entries) {
        await call('/api/exchange-rates', {
          method: 'PUT',
          body: { rateDate: date, currencyCode: code, quoteCode: company.baseCurrency, buy: v.buy, ...(v.sell ? { sell: v.sell } : {}) },
        });
      }
      return entries.length;
    },
    [['rates'], ['dashboard']],
  );
  const remove = useCMutation((id: string, call) => call(`/api/exchange-rates/${id}`, { method: 'DELETE' }), [['rates']]);
  const backfill = useCMutation((_: void, call) => call<{ updated: number; stillMissing: number }>('/api/ledger/backfill-reporting', { method: 'POST' }), [['trial-balance'], ['rates']]);

  const anyFilled = Object.values(values).some((v) => v.buy !== '');

  return (
    <>
      <PageHeader title={t('settings.currencies.title')} description={t('settings.currencies.subtitle')} />
      <div className="flex flex-col gap-6">
        <Callout>{t('settings.currencies.info')}</Callout>

        {canEdit && (
          <Card>
            <CardHeader
              title={t('settings.currencies.quickEntry')}
              action={
                company.reportingCurrency ? (
                  <Button
                    size="sm"
                    loading={backfill.isPending}
                    onClick={() =>
                      backfill.mutate(undefined, {
                        onSuccess: (r) => toast.success(t('settings.currencies.backfilled', { updated: r.updated, missing: r.stillMissing })),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    <RefreshCw className="size-3.5" aria-hidden />
                    {t('settings.currencies.backfill')}
                  </Button>
                ) : undefined
              }
            />
            <div className="p-5">
              <Field label={t('settings.currencies.rateDate')} className="mb-5 max-w-48">
                {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
              </Field>
              <div className="grid gap-4 md:grid-cols-3">
                {foreign.map((code) => {
                  const last = latest[code];
                  return (
                    <div key={code} className="rounded-lg border border-border p-4">
                      <p className="mb-3 text-sm font-semibold">
                        {t('settings.currencies.unit', { from: code })} <span className="text-muted">{company.baseCurrency}</span>
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t('settings.currencies.buy')}>
                          {(id) => (
                            <MoneyInput
                              id={id}
                              decimals={4}
                              maxDecimals={8}
                              value={values[code]?.buy ?? ''}
                              placeholder={last ? money(last.buy, 4) : '0,0000'}
                              onChange={(v) => setValues((cur) => ({ ...cur, [code]: { buy: v, sell: cur[code]?.sell ?? '' } }))}
                            />
                          )}
                        </Field>
                        <Field label={t('settings.currencies.sell')}>
                          {(id) => (
                            <MoneyInput
                              id={id}
                              decimals={4}
                              maxDecimals={8}
                              value={values[code]?.sell ?? ''}
                              placeholder={last ? money(last.sell, 4) : '0,0000'}
                              onChange={(v) => setValues((cur) => ({ ...cur, [code]: { buy: cur[code]?.buy ?? '', sell: v } }))}
                            />
                          )}
                        </Field>
                      </div>
                      {last && <p className="mt-2 text-xs text-muted">{formatDateTR(last.rateDate)}</p>}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted">{t('settings.currencies.sellHint')}</p>
              <div className="mt-4">
                <Button
                  variant="primary"
                  disabled={!anyFilled}
                  loading={save.isPending}
                  onClick={() =>
                    save.mutate(undefined, {
                      onSuccess: () => {
                        toast.success(t('settings.currencies.saved'));
                        setValues({});
                      },
                      onError: (e) => toast.error(errorMessage(e)),
                    })
                  }
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </Card>
        )}

        <section>
          <h2 className="mb-3 text-[15px] font-semibold">{t('settings.currencies.history')}</h2>
          {isPending ? (
            <PageLoading />
          ) : !data?.rates.length ? (
            <Card>
              <EmptyState icon={<Coins className="size-5" />} title={t('settings.currencies.noRates')} description={t('settings.currencies.noRatesDesc')} />
            </Card>
          ) : (
            <TableWrap className="max-h-[28rem]">
              <Table>
                <thead>
                  <tr>
                    <Th>{t('common.date')}</Th>
                    <Th>{t('settings.currencies.pair')}</Th>
                    <Th num>{t('settings.currencies.buy')}</Th>
                    <Th num>{t('settings.currencies.sell')}</Th>
                    <Th>{t('settings.currencies.source')}</Th>
                    {canEdit && <Th className="w-14" />}
                  </tr>
                </thead>
                <tbody>
                  {data.rates.map((r) => (
                    <Tr key={r.id}>
                      <Td>{formatDateTR(r.rateDate)}</Td>
                      <Td className="font-medium">
                        {r.currencyCode}/{r.quoteCode}
                      </Td>
                      <Td num>{money(r.buy, 4)}</Td>
                      <Td num>{money(r.sell, 4)}</Td>
                      <Td className="text-muted">{r.source === 'manual' ? t('settings.currencies.manual') : r.source}</Td>
                      {canEdit && (
                        <Td>
                          <button
                            className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                            aria-label={t('common.delete')}
                            onClick={() =>
                              remove.mutate(r.id, {
                                onSuccess: () => toast.success(t('settings.currencies.deleted')),
                                onError: (e) => toast.error(errorMessage(e)),
                              })
                            }
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </Td>
                      )}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </section>
      </div>
    </>
  );
}
