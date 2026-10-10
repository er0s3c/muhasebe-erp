import { Coins, FileUp, Landmark, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  CURRENCY_CODES,
  todayIso,
  FX_PURPOSES,
  FX_PURPOSE_LABELS,
  FX_PURPOSE_RATE_TYPES,
  FX_RATE_TYPES,
  FX_RATE_TYPE_LABELS,
  FX_PROVIDER_LABELS,
  type FxProvider,
  type FxPurpose,
  type FxRateType,
  type FxRateLookup,
} from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Select } from '../../components/ui/Select';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { AutoFxCard } from './AutoFxCard';
import type { Rate } from '../../lib/types';

type PublishedRate = Rate & {
  effectiveBuy: string | null;
  effectiveSell: string | null;
  provider: string;
  sourceUrl: string | null;
  fetchedAt: string | null;
};
type RateList = {
  rates: PublishedRate[];
  provider: FxProvider | null;
  providerLabel: string | null;
  sourceUrl: string | null;
  timeZone: string;
};
type ImportResult = {
  date: string;
  source: string;
  provider: FxProvider;
  imported: { currency: string }[];
  skipped: string[];
};
type ManualValues = { buy: string; sell: string; effectiveBuy: string; effectiveSell: string };
const emptyValues: ManualValues = { buy: '', sell: '', effectiveBuy: '', effectiveSell: '' };
const fieldNames = {
  forex_buy: 'buy',
  forex_sell: 'sell',
  effective_buy: 'effectiveBuy',
  effective_sell: 'effectiveSell',
} as const;

export function CurrenciesPage() {
  const { t } = useTranslation(),
    toast = useToast(),
    can = useCan(),
    company = useCompany();
  const query = useCQuery<RateList>(['rates'], '/api/exchange-rates?limit=200');
  const data = query.data,
    canEdit = can('rates.manage');
  const [date, setDate] = useState(todayIso());
  const [values, setValues] = useState<Record<string, ManualValues>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const foreign = CURRENCY_CODES.filter((c) => c !== company.baseCurrency);
  const latest = useMemo(() => {
    const result: Record<string, PublishedRate> = {};
    for (const rate of data?.rates ?? [])
      if (rate.quoteCode === company.baseCurrency && !result[rate.currencyCode])
        result[rate.currencyCode] = rate;
    return result;
  }, [data, company.baseCurrency]);
  const save = useCMutation(
    async (_: void, call) => {
      const entries = Object.entries(values).filter(([, v]) => v.buy !== '');
      for (const [code, value] of entries)
        await call('/api/exchange-rates', {
          method: 'PUT',
          body: {
            rateDate: date,
            currencyCode: code,
            quoteCode: company.baseCurrency,
            buy: value.buy,
            ...(value.sell ? { sell: value.sell } : {}),
            effectiveBuy: value.effectiveBuy || null,
            effectiveSell: value.effectiveSell || null,
          },
        });
      return entries.length;
    },
    [['rates'], ['dashboard'], ['rate-lookup']],
  );
  const remove = useCMutation(
    (id: string, call) => call(`/api/exchange-rates/${id}`, { method: 'DELETE' }),
    [['rates'], ['rate-lookup']],
  );
  const backfill = useCMutation(
    (_: void, call) =>
      call<{ updated: number; stillMissing: number }>('/api/ledger/backfill-reporting', {
        method: 'POST',
      }),
    [['trial-balance'], ['rates']],
  );
  const importRates = useCMutation(
    (
      input:
        | { source: 'company'; date?: string }
        | { source: 'xml'; xml: string; provider?: FxProvider },
      call,
    ) => call<ImportResult>('/api/exchange-rates/import', { method: 'POST', body: input }),
    [['rates'], ['dashboard'], ['rate-lookup']],
  );
  const onImported = (result: ImportResult) => {
    toast.success(
      `${result.source} · ${formatDateTR(result.date)} · ${result.imported.length} kur kaydedildi.${result.skipped.some((s) => s.includes('korundu')) ? ' Elle girilen kurlar korundu.' : ''}`,
    );
  };
  const importFile = async (file: File) => {
    if (file.size > 500000) {
      toast.error(t('errors.RATE_XML_INVALID'));
      return;
    }
    try {
      importRates.mutate(
        {
          source: 'xml',
          xml: await file.text(),
          ...(data?.provider ? { provider: data.provider } : {}),
        },
        { onSuccess: onImported, onError: (e) => toast.error(errorMessage(e)) },
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const anyFilled = Object.values(values).some((v) => v.buy !== '');
  return (
    <>
      <PageHeader
        title={t('settings.currencies.title')}
        description="Şirketin çalışma ülkesinden resmî kurları alın; döviz ve efektif alış/satış değerlerini ayrı izleyin."
      />
      <div className="flex min-w-0 flex-col gap-6">
        {query.error && <Callout tone="danger">{errorMessage(query.error)}</Callout>}
        <Callout title={data?.providerLabel ?? 'Kur sağlayıcısı seçilmedi'}>
          {data?.provider ? (
            <>
              <p>
                {data.provider === 'tcmb' ? 'Türkiye' : 'KKTC'} · {data.timeZone}. Resmî kurlar 1
                birim dövizin TRY karşılığıdır. Diğer para birimi çiftleri çapraz kurla hesaplanır.
              </p>
              {data.sourceUrl && (
                <a
                  className="link mt-2 inline-block break-all"
                  href={data.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Resmî XML kaynağını aç
                </a>
              )}
            </>
          ) : (
            <p>
              Resmî kur indirmek için{' '}
              <Link className="link" to="/settings/company">
                şirket çalışma ülkesini seçin
              </Link>
              . Elle girilen kurlar kullanılabilir.
            </p>
          )}
        </Callout>
        <AutoFxCard />
        {canEdit && (
          <Card>
            <CardHeader
              title={t('settings.currencies.quickEntry')}
              action={
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    loading={importRates.isPending}
                    disabled={!data?.provider}
                    onClick={() =>
                      importRates.mutate(
                        { source: 'company', ...(date !== todayIso() ? { date } : {}) },
                        { onSuccess: onImported, onError: (e) => toast.error(errorMessage(e)) },
                      )
                    }
                  >
                    <Landmark className="size-3.5" />
                    {data?.provider === 'tcmb'
                      ? 'TCMB’den indir'
                      : 'KKTC Merkez Bankası’ndan indir'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={importRates.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    <FileUp className="size-3.5" />
                    {t('settings.currencies.importFile')}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xml,text/xml,application/xml"
                    className="sr-only"
                    aria-label={t('settings.currencies.importFile')}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void importFile(file);
                    }}
                  />
                  {company.reportingCurrency && (
                    <Button
                      size="sm"
                      loading={backfill.isPending}
                      onClick={() =>
                        backfill.mutate(undefined, {
                          onSuccess: (r) =>
                            toast.success(
                              t('settings.currencies.backfilled', {
                                updated: r.updated,
                                missing: r.stillMissing,
                              }),
                            ),
                          onError: (e) => toast.error(errorMessage(e)),
                        })
                      }
                    >
                      <RefreshCw className="size-3.5" />
                      {t('settings.currencies.backfill')}
                    </Button>
                  )}
                </div>
              }
            />
            <div className="space-y-5 p-5">
              <Field label={t('settings.currencies.rateDate')} className="max-w-48">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
              </Field>
              <p className="text-xs text-muted">
                İndirilen bültenin gerçek tarihi saklanır. Manuel veya XML ile yüklenen aynı
                tarih/para birimi kaydı otomatik indirmeyle değiştirilmez.
              </p>
              <div className="grid min-w-0 gap-4 lg:grid-cols-3">
                {foreign.map((code) => {
                  const last = latest[code];
                  return (
                    <div key={code} className="min-w-0 rounded-lg border border-border p-4">
                      <p className="mb-3 text-sm">
                        1 {code} = {company.baseCurrency}
                      </p>
                      <div className="grid min-w-0 grid-cols-2 gap-3">
                        {FX_RATE_TYPES.map((type) => {
                          const field = fieldNames[type];
                          return (
                            <Field key={type} label={FX_RATE_TYPE_LABELS[type]}>
                              {(id) => (
                                <MoneyInput
                                  id={id}
                                  decimals={4}
                                  maxDecimals={8}
                                  value={values[code]?.[field] ?? ''}
                                  placeholder={last?.[field] ? money(last[field], 4) : '0,0000'}
                                  onChange={(value) =>
                                    setValues((current) => ({
                                      ...current,
                                      [code]: { ...emptyValues, ...current[code], [field]: value },
                                    }))
                                  }
                                />
                              )}
                            </Field>
                          );
                        })}
                      </div>
                      {last && (
                        <p className="mt-3 text-xs text-muted">
                          Son kayıt: {formatDateTR(last.rateDate)} · {last.source}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted">
                Döviz satış boşsa alış değeri kullanılır. Efektif değerler boş bırakılabilir; nakit
                kur sorgusunda döviz kuruyla tamamlanmaz.
              </p>
              <Button
                variant="primary"
                disabled={!anyFilled || !date}
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
          </Card>
        )}
        <RateLookupCard initialTo={company.baseCurrency} />
        <section className="min-w-0">
          <h2 className="mb-3 text-[15px]">{t('settings.currencies.history')}</h2>
          {query.isPending ? (
            <PageLoading />
          ) : !data?.rates.length ? (
            <Card>
              <EmptyState
                icon={<Coins className="size-5" />}
                title={t('settings.currencies.noRates')}
                description={t('settings.currencies.noRatesDesc')}
              />
            </Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <Tr>
                    <Th>Kur tarihi</Th>
                    <Th>{t('settings.currencies.pair')}</Th>
                    {FX_RATE_TYPES.map((type) => (
                      <Th key={type} num>
                        {FX_RATE_TYPE_LABELS[type]}
                      </Th>
                    ))}
                    <Th>Kaynak / indirme tarihi</Th>
                    {canEdit && <Th className="w-14" />}
                  </Tr>
                </thead>
                <tbody>
                  {data.rates.map((rate) => (
                    <Tr key={rate.id}>
                      <Td className="whitespace-nowrap">{formatDateTR(rate.rateDate)}</Td>
                      <Td>
                        {rate.currencyCode}/{rate.quoteCode}
                      </Td>
                      {FX_RATE_TYPES.map((type) => (
                        <Td key={type} num>
                          {rate[fieldNames[type]] ? money(rate[fieldNames[type]], 4) : '—'}
                        </Td>
                      ))}
                      <Td className="text-muted">
                        <p>
                          {rate.provider === 'manual'
                            ? t('settings.currencies.manual')
                            : rate.provider === 'xml'
                              ? `XML · ${rate.source}`
                              : rate.source}
                        </p>
                        {rate.sourceUrl && (
                          <a
                            className="link text-xs"
                            href={rate.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {rate.provider === 'tcmb' || rate.provider === 'kktcmb'
                              ? FX_PROVIDER_LABELS[rate.provider]
                              : 'Kaynağı aç'}
                          </a>
                        )}
                        {rate.fetchedAt && (
                          <p className="mt-1 whitespace-nowrap text-xs">
                            {new Date(rate.fetchedAt).toLocaleString('tr-TR', {
                              timeZone: data.timeZone,
                            })}
                          </p>
                        )}
                      </Td>
                      {canEdit && (
                        <Td>
                          <button
                            className="rounded-md p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                            aria-label={t('common.delete')}
                            onClick={() =>
                              remove.mutate(rate.id, {
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
function RateLookupCard({ initialTo }: { initialTo: string }) {
  const [from, setFrom] = useState(initialTo === 'GBP' ? 'USD' : 'GBP'),
    [to, setTo] = useState(initialTo),
    [date, setDate] = useState(todayIso());
  const [purpose, setPurpose] = useState<FxPurpose>('valuation'),
    [type, setType] = useState<FxRateType>('forex_buy');
  const lookup = useCQuery<FxRateLookup>(
    ['rate-lookup', from, to, date, purpose, type],
    date
      ? `/api/exchange-rates/lookup?from=${from}&to=${to}&date=${date}&purpose=${purpose}&rateType=${type}`
      : null,
  );
  return (
    <Card>
      <CardHeader
        title="Amaç ve kur türüyle sorgula"
        description="Amaç bir başlangıç seçimi sunar; işlemde kararlaştırılan kur farklı olabilir."
      />
      <div className="space-y-4 p-5">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Kaynak para birimi">
            {(id) => (
              <Select id={id} value={from} onChange={(e) => setFrom(e.target.value)}>
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Hedef para birimi">
            {(id) => (
              <Select id={id} value={to} onChange={(e) => setTo(e.target.value)}>
                {CURRENCY_CODES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="İşlem tarihi">
            {(id) => (
              <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Field label="Kullanım amacı">
            {(id) => (
              <Select
                id={id}
                value={purpose}
                onChange={(e) => {
                  const value = e.target.value as FxPurpose;
                  setPurpose(value);
                  setType(FX_PURPOSE_RATE_TYPES[value]);
                }}
              >
                {FX_PURPOSES.map((value) => (
                  <option key={value} value={value}>
                    {FX_PURPOSE_LABELS[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Kur türü">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as FxRateType)}>
                {FX_RATE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {FX_RATE_TYPE_LABELS[value]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {lookup.error ? (
          <Callout tone="danger">{errorMessage(lookup.error)}</Callout>
        ) : lookup.isPending && date ? (
          <p className="text-sm text-muted">Kur aranıyor…</p>
        ) : lookup.data?.rate ? (
          <div className="rounded-lg bg-surface-2 p-4">
            <p className="text-lg tabular-nums">
              1 {from} = {money(lookup.data.rate, 8)} {to}
            </p>
            <p className="mt-2 text-xs text-muted">
              {FX_RATE_TYPE_LABELS[lookup.data.rateType]} · Kur tarihi:{' '}
              {formatDateTR(lookup.data.rateDate)}
              {lookup.data.source ? ' · ' + lookup.data.source : ''}
              {lookup.data.method === 'cross'
                ? ' · Çapraz kur'
                : lookup.data.method === 'inverse'
                  ? ' · Ters kur'
                  : ''}
            </p>
            {lookup.data.legs.length > 1 && (
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {lookup.data.legs.map((leg, index) => (
                  <li key={index}>
                    {leg.currencyCode}/{leg.quoteCode} · {FX_RATE_TYPE_LABELS[leg.rateType]} ·{' '}
                    {formatDateTR(leg.rateDate)} · {leg.source}
                    {leg.inverted ? ' (ters)' : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          date && (
            <Callout>
              Seçilen tür için işlem tarihi ve önceki 10 gün içinde kur bulunamadı. Eksik efektif
              kur yerine döviz kuru kullanılmaz.
            </Callout>
          )
        )}
      </div>
    </Card>
  );
}
