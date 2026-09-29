import { Coins, FileUp, Landmark, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
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

interface ImportResult {
  date: string;
  announcementNo: string | null;
  imported: { currency: string; buy: string; sell: string }[];
  skipped: string[];
}

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

  const importRates = useCMutation(
    (v: { source: 'kktcmb'; date?: string } | { source: 'xml'; xml: string }, call) =>
      call<ImportResult>('/api/exchange-rates/import', { method: 'POST', body: v }),
    [['rates'], ['dashboard']],
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const onImported = (r: ImportResult) =>
    toast.success(
      t('settings.currencies.imported', {
        source: `KKTCMB${r.announcementNo ? ` ${r.announcementNo}` : ''}`,
        date: formatDateTR(r.date),
        summary: r.imported.map((i) => `${i.currency} ${money(i.buy, 4)}`).join(' · '),
      }),
    );
  const importFromBank = () =>
    importRates.mutate(
      { source: 'kktcmb', ...(date !== todayIso() ? { date } : {}) },
      { onSuccess: onImported, onError: (e) => toast.error(errorMessage(e)) },
    );
  const importFromFile = async (file: File) => {
    if (file.size > 500_000) return toast.error(t('errors.RATE_XML_INVALID'));
    importRates.mutate({ source: 'xml', xml: await file.text() }, { onSuccess: onImported, onError: (e) => toast.error(errorMessage(e)) });
  };

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
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button size="sm" loading={importRates.isPending} onClick={importFromBank}>
                    <Landmark className="size-3.5" aria-hidden />
                    {t('settings.currencies.importKktcmb')}
                  </Button>
                  <Button size="sm" disabled={importRates.isPending} onClick={() => fileRef.current?.click()}>
                    <FileUp className="size-3.5" aria-hidden />
                    {t('settings.currencies.importFile')}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xml,text/xml,application/xml"
                    className="sr-only"
                    aria-label={t('settings.currencies.importFile')}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void importFromFile(file);
                    }}
                  />
                  {company.reportingCurrency && (
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
                  )}
                </div>
              }
            />
            <div className="p-5">
              <div className="mb-5 flex flex-wrap items-end gap-x-6 gap-y-2">
                <Field label={t('settings.currencies.rateDate')} className="w-48">
                  {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
                </Field>
                <p className="max-w-xl pb-2 text-xs text-muted">{t('settings.currencies.importInfo')}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {foreign.map((code) => {
                  const last = latest[code];
                  return (
                    <div key={code} className="rounded-lg border border-border p-4">
                      <p className="mb-3 text-sm">
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
          <h2 className="mb-3 text-[15px]">{t('settings.currencies.history')}</h2>
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
                      <Td>
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
