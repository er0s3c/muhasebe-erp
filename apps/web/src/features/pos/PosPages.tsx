import Decimal from 'decimal.js';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout, ErrorState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { moneyIn } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { Camera } from 'lucide-react';
import { BarcodeCameraSheet } from './BarcodeCameraSheet';
import type { InvoiceDetail } from '../../lib/types';
import {
  OperationForm,
  Records,
  Status,
  numberField,
  options,
  selectField,
  textField,
  useFocusedRecord,
  useLeatherActions,
} from '../leather/common';

interface Till {
  id: string;
  name: string;
  warehouseId: string;
  currencyCode: string;
  cashAccountId: string;
  cardAccountId: string | null;
  maxDiscountPct: string;
  isActive: boolean;
  assignedUserIds: string[];
}
interface Session {
  id: string;
  tillId: string;
  userId: string;
  openedAt: string;
  closedAt: string | null;
  status: string;
  openingCash: string;
  expectedCash: string;
  countedCash: string | null;
  variance: string | null;
}
interface CatalogItem {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  unit: string;
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
  vatRate: string;
  grossUnitPrice: string;
  available: string;
}
interface BasketLine {
  item: CatalogItem;
  quantity: string;
  discountPct: string;
}
interface SaleLine {
  id: string;
  invoiceLineId?: string;
  itemId: string;
  description?: string;
  name?: string;
  quantity: string;
  returnedQuantity?: string;
  gross: string;
  total?: string;
  lineTotal?: string;
}
interface Sale {
  id: string;
  invoiceId: string;
  sessionId: string;
  kind: 'sale' | 'return';
  total: string;
  date: string;
  lines: SaleLine[];
  sourceSaleId?: string;
  payments?: { method: 'cash' | 'card'; amount: string }[];
}
interface SessionDetail {
  session: Session;
  till: Till;
  sales: Sale[];
}
interface Bootstrap {
  warehouses: { id: string; name: string }[];
  accounts: { id: string; name: string; kind: string; currencyCode: string }[];
  customers: { id: string; name: string }[];
  members: { id?: string; userId: string; fullName: string }[];
}

function PosHeader({ title, description }: { title: string; description?: string }) {
  const can = useCan();
  const { pathname } = useLocation();
  const tabs = [
    ['/pos', 'Satış ekranı'],
    ['/pos/sessions', 'Kasa oturumları'],
    ...(can('pos.manage') ? [['/pos/settings', 'Satış noktası ayarları']] : []),
  ];
  return (
    <>
      <PageHeader title={title} description={description} />
      <nav
        aria-label="Mağaza ekranları"
        className="mb-5 flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1 text-sm"
      >
        {tabs.map(([path, label]) => {
          const active = pathname === path || (path !== '/pos' && pathname.startsWith(path + '/'));
          return (
            <Link
              key={path}
              to={path!}
              aria-current={active ? 'page' : undefined}
              className={
                'rounded-md px-4 py-1.5 transition-colors ' +
                (active
                  ? 'bg-brand text-brand-contrast'
                  : 'text-muted hover:bg-surface-2 hover:text-text')
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function decimal(value: string) {
  return new Decimal(value || '0');
}
function lineTotal(line: BasketLine) {
  const net = decimal(line.item.unitPrice)
    .mul(decimal(line.quantity))
    .mul(new Decimal(1).sub(decimal(line.discountPct).div(100)))
    .toDecimalPlaces(2);
  return net.add(net.mul(decimal(line.item.vatRate)).div(100).toDecimalPlaces(2));
}
function usePosLists() {
  const tills = useCQuery<{ tills: Till[] }>(['pos', 'tills'], '/api/pos/tills');
  const sessions = useCQuery<{ sessions: Session[] }>(['pos', 'sessions'], '/api/pos/sessions');
  return { tills, sessions };
}

export function PosSettingsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const data = useCQuery<Bootstrap>(['pos', 'bootstrap'], '/api/pos/bootstrap', {
    enabled: can('pos.manage'),
  });
  const tills = useCQuery<{ tills: Till[] }>(['pos', 'tills'], '/api/pos/tills');
  const save = useLeatherActions();
  const [assigned, setAssigned] = useState<string[]>([]);
  return (
    <>
      <PosHeader
        title={t('pos.settings')}
        description="Depoyu, nakit ve kart tahsilat hesaplarını ve satış yapacak çalışanları belirleyin."
      />
      {can('pos.manage') && (
        <OperationForm
          title="Yeni satış noktası"
          disabled={!assigned.length}
          fields={[
            textField('name', 'Satış noktası adı', true),
            selectField(
              'warehouseId',
              'Satış deposu',
              options(data.data?.warehouses, (row) => row.name),
            ),
            selectField(
              'cashAccountId',
              'Nakit hesabı',
              options(
                data.data?.accounts.filter((row) => row.kind === 'cash'),
                (row) => row.name,
              ),
            ),
            selectField(
              'cardAccountId',
              'Kart tahsilat hesabı',
              options(
                data.data?.accounts.filter((row) => row.kind === 'bank'),
                (row) => row.name,
              ),
              false,
            ),
            selectField(
              'walkInPartyId',
              'Mağaza müşterisi',
              options(data.data?.customers, (row) => row.name),
              false,
            ),
            numberField('maxDiscountPct', 'En yüksek indirim (%)', '0'),
          ]}
          submit={(values) =>
            save('/api/pos/tills', {
              name: values.name,
              warehouseId: values.warehouseId,
              cashAccountId: values.cashAccountId,
              maxDiscountPct: values.maxDiscountPct,
              cardAccountId: values.cardAccountId || null,
              walkInPartyId: values.walkInPartyId || undefined,
              assignedUserIds: assigned,
            })
          }
          onDone={() => setAssigned([])}
        >
          <fieldset>
            <legend className="mb-2 text-sm">Yetkili çalışanlar</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {data.data?.members.map((member) => (
                <label className="flex items-center gap-2 text-sm" key={member.userId}>
                  <input
                    type="checkbox"
                    checked={assigned.includes(member.userId)}
                    onChange={(event) =>
                      setAssigned((old) =>
                        event.target.checked
                          ? [...old, member.userId]
                          : old.filter((id) => id !== member.userId),
                      )
                    }
                  />
                  {member.fullName}
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">En az bir yetkili çalışan seçin.</p>
          </fieldset>
        </OperationForm>
      )}
      {data.error && <ErrorState description={errorMessage(data.error)} onRetry={() => void data.refetch()} retrying={data.isFetching} />}
      <Records
        rows={tills.data?.tills}
        loading={tills.isPending} onRetry={() => void tills.refetch()} retrying={tills.isFetching}
        error={tills.error}
        columns={[
          { label: 'Satış noktası', render: (row) => row.name },
          { label: 'Para birimi', render: (row) => row.currencyCode },
          { label: 'İndirim sınırı', render: (row) => `%${row.maxDiscountPct}` },
          { label: 'Çalışan', render: (row) => row.assignedUserIds.length },
          {
            label: 'Durum',
            render: (row) => <Status value={row.isActive ? 'active' : 'inactive'} />,
          },
        ]}
      />
    </>
  );
}

export function PosSessionsPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const can = useCan();
  const { tills, sessions } = usePosLists();
  const [selected, setSelected] = useState('');
  useFocusedRecord(sessions.data?.sessions, (row) => setSelected(row.id));
  const detail = useCQuery<SessionDetail>(
    ['pos', 'session', selected],
    selected ? `/api/pos/sessions/${selected}` : null,
  );
  const save = useLeatherActions();
  return (
    <>
      <PosHeader
        title={t('pos.sessions')}
        description="Açılış tutarını kaydedin; gün sonunda sayılan nakdi beklenen tutarla karşılaştırın."
      />
      {can('pos.sell') && (
        <OperationForm
          title="Kasayı aç"
          fields={[
            selectField(
              'tillId',
              'Satış noktası',
              options(
                tills.data?.tills.filter((row) => row.isActive),
                (row) => row.name,
              ),
            ),
            numberField('openingCash', 'Açılış nakdi', '0'),
          ]}
          action="Kasayı aç"
          submit={(values) =>
            save('/api/pos/sessions', { tillId: values.tillId, openingCash: values.openingCash })
          }
        />
      )}
      <Records
        rows={sessions.data?.sessions}
        loading={sessions.isPending} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching}
        error={sessions.error}
        columns={[
          {
            label: 'Satış noktası',
            render: (row) => tills.data?.tills.find((till) => till.id === row.tillId)?.name ?? '—',
          },
          { label: 'Açılış', render: (row) => new Date(row.openedAt).toLocaleString('tr-TR') },
          {
            label: 'Açılış nakdi',
            render: (row) => moneyIn(row.openingCash, company.baseCurrency),
            numeric: true,
          },
          {
            label: 'Beklenen nakit',
            render: (row) =>
              row.status === 'open'
                ? 'Oturumu inceleyin'
                : moneyIn(row.expectedCash, company.baseCurrency),
            numeric: true,
          },
          {
            label: 'Fark',
            render: (row) =>
              row.variance === null ? '—' : moneyIn(row.variance, company.baseCurrency),
            numeric: true,
          },
          { label: 'Durum', render: (row) => <Status value={row.status} /> },
        ]}
        action={(row) => (
          <Button size="sm" onClick={() => setSelected(row.id)}>
            İncele
          </Button>
        )}
      />
      {detail.data && (
        <div className="mt-5">
          <Card className="mb-5 p-5">
            <h2>{detail.data.till.name}</h2>
            <p className="mt-2 text-sm">
              Beklenen nakit:{' '}
              {moneyIn(detail.data.session.expectedCash, detail.data.till.currencyCode)}
            </p>
          </Card>
          {detail.data.session.status === 'open' && can('pos.sell') && (
            <OperationForm
              key={selected}
              title="Kasayı kapat"
              fields={[
                numberField('countedCash', 'Sayılan nakit', detail.data.session.expectedCash),
                textField('reason', 'Kasa farkı açıklaması'),
              ]}
              action="Kasayı kapat"
              submit={(values) =>
                save(`/api/pos/sessions/${selected}/close`, {
                  countedCash: values.countedCash,
                  reason: values.reason || undefined,
                })
              }
            />
          )}
          <Records
            rows={detail.data.sales}
            columns={[
              {
                label: 'Belge',
                render: (row) => (
                  <Link className="link" to={`/pos/sales/${row.id}`}>
                    {row.kind === 'return' ? 'İade belgesi' : 'Satış belgesi'}
                  </Link>
                ),
              },
              { label: 'Tarih', render: (row) => row.date },
              {
                label: 'Tutar',
                render: (row) => moneyIn(row.total, detail.data!.till.currencyCode),
                numeric: true,
              },
            ]}
          />
        </div>
      )}
      {detail.error && <ErrorState description={errorMessage(detail.error)} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />}
    </>
  );
}

export function PosPage() {
  const { t } = useTranslation();
  const can = useCan();
  const { company, call } = useCompanyApi();
  const { tills, sessions } = usePosLists();
  const [sessionId, setSessionId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const customers = useCQuery<{ customers: { id: string; name: string; code: string }[] }>(
    ['pos', 'customers'],
    '/api/pos/customers',
  );
  const session = sessions.data?.sessions.find((row) => row.id === sessionId);
  const till = tills.data?.tills.find((row) => row.id === session?.tillId);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [cash, setCash] = useState('');
  const [card, setCard] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const [cameraOpen, setCameraOpen] = useState(false);
  const scanScope = `${company.id}:${sessionId}:${customerId}:${saving}`;
  const currentScanScope = useRef({ key: scanScope, generation: 0 });
  if (currentScanScope.current.key !== scanScope) {
    currentScanScope.current = { key: scanScope, generation: currentScanScope.current.generation + 1 };
  }
  useEffect(() => () => { currentScanScope.current.generation += 1; }, []);
  const toast = useToast();
  const save = useLeatherActions();
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!sessionId && sessions.data?.sessions.some((row) => row.status === 'open'))
      setSessionId(sessions.data.sessions.find((row) => row.status === 'open')!.id);
  }, [sessions.data, sessionId]);
  const catalog = useCQuery<{ items: CatalogItem[] }>(
    ['pos', 'catalog', till?.id, query, customerId],
    till
      ? `/api/pos/catalog?tillId=${till.id}&query=${encodeURIComponent(query)}${customerId ? `&customerId=${customerId}` : ''}`
      : null,
  );
  const total = basket.reduce((sum, line) => sum.add(lineTotal(line)), new Decimal(0));
  const paid = decimal(cash).add(decimal(card));
  const add = (item: CatalogItem) => {
    setError('');
    setBasket((old) => {
      const line = old.find((row) => row.item.id === item.id);
      return line
        ? old.map((row) =>
            row.item.id === item.id
              ? { ...row, quantity: decimal(row.quantity).add(1).toString() }
              : row,
          )
        : [...old, { item, quantity: '1', discountPct: item.discountPct || '0' }];
    });
  };
  const scan = async (value = search) => {
    const barcode = value.trim();
    if (!till || !barcode || saving || !can('pos.sell')) return;
    const generation = currentScanScope.current.generation;
    setError('');
    try {
      const result = await call<{ items: CatalogItem[] }>(
        `/api/pos/catalog?tillId=${till.id}&barcode=${encodeURIComponent(barcode)}${customerId ? `&customerId=${customerId}` : ''}`,
      );
      if (currentScanScope.current.generation !== generation) return;
      if (result.items.length !== 1) {
        setError(
          result.items.length
            ? 'Birden çok ürün bulundu. Listeden seçin.'
            : 'Bu barkodla ürün bulunamadı.',
        );
        return;
      }
      add(result.items[0]!);
      setSearch('');
    } catch (cause) {
      if (currentScanScope.current.generation !== generation) return;
      setError(cause instanceof Error ? cause.message : 'Barkod sorgulanamadı');
    }
  };
  const invalid =
    basket.some(
      (line) =>
        decimal(line.quantity).lte(0) ||
        decimal(line.discountPct).lt(0) ||
        decimal(line.discountPct).gt(
          can('pos.approve')
            ? '100'
            : Decimal.max(till?.maxDiscountPct ?? '0', line.item.discountPct || '0'),
        ),
    ) ||
    decimal(cash).lt(0) ||
    decimal(card).lt(0);
  return (
    <>
      <PosHeader title={t('pos.title')} description={t('pos.subtitle')} />
      {sessions.error || tills.error ? (
        <ErrorState description={errorMessage(sessions.error ?? tills.error)} onRetry={() => { void sessions.refetch(); void tills.refetch(); }} retrying={sessions.isFetching || tills.isFetching} />
      ) : sessions.isPending || tills.isPending ? (
        <PageLoading />
      ) : (
        <>
          {!sessions.data?.sessions.some((row) => row.status === 'open') ? (
            <Callout
              title="Açık kasa oturumu bulunmuyor"
              action={
                <Link to="/pos/sessions" className="link">
                  Kasa oturumlarını aç
                </Link>
              }
            >
              Satışa başlamadan önce açılış nakdiyle kasayı açın.
            </Callout>
          ) : (
            <div className="mb-5 max-w-md">
              <Field label="Aktif kasa oturumu">
                {(id) => (
                  <Select
                    id={id}
                    value={sessionId}
                    disabled={basket.length > 0 || saving}
                    onChange={(event) => setSessionId(event.target.value)}
                  >
                    {sessions.data?.sessions
                      .filter((row) => row.status === 'open')
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {tills.data?.tills.find((item) => item.id === row.tillId)?.name ??
                            row.id.slice(0, 8)}{' '}
                          · {new Date(row.openedAt).toLocaleDateString('tr-TR')}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          {till && session?.status === 'open' && (
            <>
              <div className="mb-5 max-w-lg">
                <Field label="Satış müşterisi">
                  {(id) => (
                    <Select
                      id={id}
                      value={customerId}
                      disabled={basket.length > 0 || saving}
                      onChange={(event) => setCustomerId(event.target.value)}
                    >
                      <option value="">Mağaza müşterisi</option>
                      {customers.data?.customers.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.code} · {row.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
                <div className="min-w-0">
                  <Card className="mb-4 p-5">
                    <form
                      aria-label="Barkodla ürün ekle"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void scan();
                      }}
                      className="flex flex-wrap items-end gap-3"
                    >
                      <Field
                        label="Barkod veya ürün ara"
                        className="min-w-0 basis-full sm:basis-48 sm:flex-1"
                      >
                        {(id) => (
                          <Input
                            id={id}
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            autoComplete="off"
                            placeholder="Barkodu okutun veya ürün adı yazın"
                            disabled={saving}
                          />
                        )}
                      </Field>
                      <Button type="submit" disabled={saving || !can('pos.sell')}>
                        Barkodu ekle
                      </Button>
                      <Button disabled={saving || !can('pos.sell')} onClick={() => setCameraOpen(true)}><Camera className="size-4" aria-hidden />Kamerayla okut</Button>
                    </form>
                  </Card>
                  <BarcodeCameraSheet key={scanScope} open={cameraOpen} onOpenChange={setCameraOpen} onDetected={barcode => { setSearch(barcode); void scan(barcode); }} />
                  <Records
                    rows={catalog.data?.items}
                    loading={catalog.isPending} onRetry={() => void catalog.refetch()} retrying={catalog.isFetching}
                    error={catalog.error}
                    empty="Ürün bulunamadı"
                    columns={[
                      {
                        label: 'Ürün',
                        render: (row) => (
                          <>
                            <p>{row.name}</p>
                            <span className="text-xs text-muted">
                              {row.code} · {row.barcode}
                            </span>
                          </>
                        ),
                      },
                      {
                        label: 'Stok',
                        render: (row) => `${row.available} ${row.unit}`,
                        numeric: true,
                      },
                      {
                        label: 'KDV dahil',
                        render: (row) => moneyIn(row.grossUnitPrice, till.currencyCode),
                        numeric: true,
                      },
                    ]}
                    action={(row) => (
                      <Button
                        size="sm"
                        disabled={!can('pos.sell') || saving}
                        onClick={() => add(row)}
                      >
                        Sepete ekle
                      </Button>
                    )}
                  />
                </div>
                <Card>
                  <CardHeader
                    title="Satış sepeti"
                    description="Miktarı ve izin verilen indirimi kontrol edin. Tutarlar KDV dahildir."
                  />
                  <div className="space-y-4 p-5">
                    {!basket.length && (
                      <p className="text-sm text-muted">
                        Ürün listesinden veya barkodla ürün ekleyin.
                      </p>
                    )}
                    {basket.map((line, index) => (
                      <div key={line.item.id} className="space-y-3 border-b border-border pb-4">
                        <div className="flex justify-between gap-3">
                          <p className="min-w-0 break-words">{line.item.name}</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${line.item.name} ürününü kaldır`}
                            disabled={saving}
                            onClick={() =>
                              setBasket((old) => old.filter((row) => row.item.id !== line.item.id))
                            }
                          >
                            Kaldır
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-3">
                          <Field label={`Miktar ${index + 1}`}>
                            {(id) => (
                              <Input
                                id={id}
                                type="number"
                                min="0.001"
                                step="any"
                                value={line.quantity}
                                disabled={saving}
                                onChange={(event) =>
                                  setBasket((old) =>
                                    old.map((row) =>
                                      row.item.id === line.item.id
                                        ? { ...row, quantity: event.target.value }
                                        : row,
                                    ),
                                  )
                                }
                              />
                            )}
                          </Field>
                          <Field label={`İndirim (%) ${index + 1}`}>
                            {(id) => (
                              <Input
                                id={id}
                                type="number"
                                min="0"
                                max={
                                  can('pos.approve')
                                    ? '100'
                                    : Decimal.max(
                                        till.maxDiscountPct,
                                        line.item.discountPct || '0',
                                      ).toString()
                                }
                                step="any"
                                value={line.discountPct}
                                disabled={saving}
                                onChange={(event) =>
                                  setBasket((old) =>
                                    old.map((row) =>
                                      row.item.id === line.item.id
                                        ? { ...row, discountPct: event.target.value }
                                        : row,
                                    ),
                                  )
                                }
                              />
                            )}
                          </Field>
                          <p className="col-span-2 break-words pb-2 text-right text-sm tabular-nums sm:col-span-1">
                            {moneyIn(lineTotal(line).toFixed(2), till.currencyCode)}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div className="break-words border-b border-border pb-3 text-heading tabular-nums">
                      {moneyIn(total.toFixed(2), till.currencyCode)}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Nakit ödeme">
                        {(id) => (
                          <Input
                            id={id}
                            type="number"
                            min="0"
                            step="0.01"
                            value={cash}
                            disabled={saving}
                            onChange={(event) => setCash(event.target.value)}
                          />
                        )}
                      </Field>
                      <Field label="Kart ödemesi">
                        {(id) => (
                          <Input
                            id={id}
                            type="number"
                            min="0"
                            step="0.01"
                            value={card}
                            disabled={saving || !till.cardAccountId}
                            onChange={(event) => setCard(event.target.value)}
                          />
                        )}
                      </Field>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setCash(total.toFixed(2));
                          setCard('');
                        }}
                      >
                        Tümünü nakit
                      </Button>
                      <Button
                        size="sm"
                        disabled={saving || !till.cardAccountId}
                        onClick={() => {
                          setCard(total.toFixed(2));
                          setCash('');
                        }}
                      >
                        Tümünü kart
                      </Button>
                    </div>
                    <p className="text-sm text-muted">
                      Kalan ödeme: {moneyIn(total.sub(paid).toFixed(2), till.currencyCode)}
                    </p>
                    {invalid && (
                      <Callout tone="warning">
                        Miktar sıfırdan büyük, indirim %{till.maxDiscountPct} sınırında olmalıdır.
                      </Callout>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}
                    <Button
                      variant="primary"
                      loading={saving}
                      disabled={
                        !can('pos.sell') ||
                        !basket.length ||
                        invalid ||
                        !paid.eq(total) ||
                        paid.lte(0)
                      }
                      onClick={async () => {
                        setSaving(true);
                        setError('');
                        try {
                          const result = (await save(`/api/pos/sessions/${sessionId}/sales`, {
                            requestId: requestId.current,
                            customerId: customerId || undefined,
                            lines: basket.map((line) => ({
                              itemId: line.item.id,
                              quantity: line.quantity,
                              discountPct: line.discountPct,
                            })),
                            payments: [
                              ...(decimal(cash).gt(0)
                                ? [{ method: 'cash', amount: decimal(cash).toFixed(2) }]
                                : []),
                              ...(decimal(card).gt(0)
                                ? [{ method: 'card', amount: decimal(card).toFixed(2) }]
                                : []),
                            ],
                          })) as { sale: Sale };
                          toast.success(
                            `Satış kaydedildi · ${moneyIn(result.sale.total, company.baseCurrency)}`,
                          );
                          setBasket([]);
                          setCash('');
                          setCard('');
                          requestId.current = crypto.randomUUID();
                        } catch (cause) {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : 'Satış kaydedilemedi. Aynı sepetle yeniden deneyebilirsiniz.',
                          );
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {t('pos.sale')}
                    </Button>
                  </div>
                </Card>
              </div>
            </>
          )}
          {error && !basket.length && (
            <div className="mt-4">
              <Callout tone="danger">{error}</Callout>
            </div>
          )}
          {session && till && can('pos.approve') && (
            <PosReturns
              session={session}
              till={till}
              onExchange={() => {
                setBasket([]);
                setCash('');
                setCard('');
                toast.success('İade kaydedildi. Değişim ürünlerini yeni satış sepetine ekleyin.');
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function PosReturns({
  session,
  till,
  onExchange,
}: {
  session: Session;
  till: Till;
  onExchange: () => void;
}) {
  const { t } = useTranslation();
  const { sessions } = usePosLists();
  const [params] = useSearchParams();
  const [historySessionId, setHistorySessionId] = useState(
    params.get('returnSession') || session.id,
  );
  const data = useCQuery<SessionDetail>(
    ['pos', 'session', historySessionId],
    historySessionId ? `/api/pos/sessions/${historySessionId}` : null,
  );
  const [saleId, setSaleId] = useState(params.get('returnSale') || '');
  const sale = data.data?.sales.find((row) => row.id === saleId && row.kind === 'sale');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [cash, setCash] = useState('');
  const [card, setCard] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [exchange, setExchange] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const save = useLeatherActions();
  const toast = useToast();
  const returnTotal =
    sale?.lines.reduce(
      (sum, line) =>
        sum.add(
          decimal(line.gross)
            .mul(decimal(quantities[line.id] ?? ''))
            .div(line.quantity)
            .toDecimalPlaces(2),
        ),
      new Decimal(0),
    ) ?? new Decimal(0);
  return (
    <Card className="mt-6">
      <CardHeader
        title={t('pos.return')}
        description="İlk satıştaki ürünleri seçin. İade stoku ve ters belge aynı işlemde kaydedilir."
      />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="İlk satışın kasa oturumu">
            {(id) => (
              <Select
                id={id}
                value={historySessionId}
                onChange={(event) => {
                  setHistorySessionId(event.target.value);
                  setSaleId('');
                  setQuantities({});
                }}
              >
                <option value="">Seçiniz</option>
                {sessions.data?.sessions.map((row) => (
                  <option key={row.id} value={row.id}>
                    {new Date(row.openedAt).toLocaleString('tr-TR')} · {row.id.slice(0, 8)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="İade edilecek satış">
            {(id) => (
              <Select
                id={id}
                value={saleId}
                onChange={(event) => {
                  setSaleId(event.target.value);
                  setQuantities({});
                  requestId.current = crypto.randomUUID();
                }}
              >
                <option value="">Seçiniz</option>
                {data.data?.sales
                  .filter((row) => row.kind === 'sale')
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.date} · {moneyIn(row.total, till.currencyCode)} · {row.id.slice(0, 8)}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
        {data.error && <ErrorState description={errorMessage(data.error)} onRetry={() => void data.refetch()} retrying={data.isFetching} />}
        {sale && (
          <form
            aria-label="Satış iadesi"
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              setPending(true);
              try {
                await save(`/api/pos/sales/${saleId}/returns`, {
                  requestId: requestId.current,
                  sessionId: session.id,
                  lines: sale.lines
                    .filter((line) => decimal(quantities[line.id] ?? '').gt(0))
                    .map((line) => ({
                      sourceLineId: line.invoiceLineId ?? line.id,
                      quantity: quantities[line.id],
                    })),
                  refunds: [
                    ...(decimal(cash).gt(0)
                      ? [{ method: 'cash', amount: decimal(cash).toFixed(2) }]
                      : []),
                    ...(decimal(card).gt(0)
                      ? [{ method: 'card', amount: decimal(card).toFixed(2) }]
                      : []),
                  ],
                  reason,
                });
                toast.success('İade kaydedildi');
                setSaleId('');
                setQuantities({});
                setCash('');
                setCard('');
                setReason('');
                requestId.current = crypto.randomUUID();
                if (exchange) onExchange();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'İade kaydedilemedi');
              } finally {
                setPending(false);
              }
            }}
          >
            {sale.lines.map((line, index) => (
              <div
                key={line.id}
                className="grid grid-cols-2 items-center gap-4 border-b border-border pb-3"
              >
                <p className="text-sm">
                  {line.description ?? line.name ?? line.itemId}{' '}
                  <span className="text-muted">
                    · İade edilebilir{' '}
                    {decimal(line.quantity)
                      .sub(line.returnedQuantity ?? '0')
                      .toString()}
                  </span>
                </p>
                <Field label={`İade miktarı ${index + 1}`}>
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      min="0"
                      max={decimal(line.quantity)
                        .sub(line.returnedQuantity ?? '0')
                        .toString()}
                      step="any"
                      value={quantities[line.id] ?? ''}
                      onChange={(event) =>
                        setQuantities({ ...quantities, [line.id]: event.target.value })
                      }
                    />
                  )}
                </Field>
              </div>
            ))}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="İade nedeni" required>
                {(id) => (
                  <Input
                    id={id}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Nakit iadesi">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min="0"
                    step="0.01"
                    value={cash}
                    onChange={(event) => setCash(event.target.value)}
                  />
                )}
              </Field>
              <Field label="Kart iadesi">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={!till.cardAccountId}
                    value={card}
                    onChange={(event) => setCard(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={exchange}
                onChange={(event) => setExchange(event.target.checked)}
              />
              İadeden sonra değişim ürünleriyle yeni satış hazırla
            </label>
            <p className="text-sm">
              İade tutarı: {moneyIn(returnTotal.toFixed(2), till.currencyCode)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setCash(returnTotal.toFixed(2));
                  setCard('');
                }}
              >
                İadeyi nakit öde
              </Button>
              <Button
                size="sm"
                disabled={!till.cardAccountId}
                onClick={() => {
                  setCard(returnTotal.toFixed(2));
                  setCash('');
                }}
              >
                İadeyi karta öde
              </Button>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <Button
              type="submit"
              variant="primary"
              loading={pending}
              disabled={
                session.status !== 'open' ||
                !sale.lines.some((line) => decimal(quantities[line.id] ?? '').gt(0))
              }
            >
              İadeyi kaydet
            </Button>
          </form>
        )}
        {session.status !== 'open' && (
          <Callout>Kapanmış oturumda iade yapılamaz. Yeni kasa oturumu açın.</Callout>
        )}
      </div>
    </Card>
  );
}

export function PosSalePage() {
  const { id } = useParams();
  const company = useCompany();
  const can = useCan();
  const data = useCQuery<{ sale: Sale; invoice: InvoiceDetail; session: Session; till: Till }>(
    ['pos', 'sale', id],
    id ? `/api/pos/sales/${id}` : null,
  );
  return (
    <>
      <PosHeader
        title="Mağaza satış belgesi"
        description="Kaydedilen ürünler, ödemeler ve iade bağlantısı."
      />
      {data.error ? (
        <ErrorState description={errorMessage(data.error)} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : data.isPending ? (
        <PageLoading />
      ) : (
        data.data && (
          <>
            <Card className="mb-5 p-5">
              <h2 className="text-subheading">{company.name}</h2>
              <p className="mt-2">
                {data.data.invoice.invoice.invoiceNo ?? 'Satış belgesi'} · {data.data.till.name}
              </p>
              <p className="mt-1 text-sm text-muted">
                {data.data.sale.date} · {data.data.invoice.invoice.partyName}
              </p>
              <div className="mt-4 flex flex-wrap gap-3 print:hidden">
                <Button onClick={() => window.print()}>Belgeyi yazdır</Button>
                {data.data.sale.kind === 'sale' && can('pos.approve') && (
                  <Link
                    className="link self-center text-sm"
                    to={`/pos?returnSale=${data.data.sale.id}&returnSession=${data.data.sale.sessionId}`}
                  >
                    İade / değişim hazırla
                  </Link>
                )}
                {data.data.sale.sourceSaleId && (
                  <Link
                    className="link self-center text-sm"
                    to={`/pos/sales/${data.data.sale.sourceSaleId}`}
                  >
                    İlk satış belgesi
                  </Link>
                )}
              </div>
            </Card>
            <Records
              rows={data.data.sale.lines}
              columns={[
                { label: 'Ürün', render: (row) => row.description ?? row.name ?? 'Ürün' },
                { label: 'Miktar', render: (row) => row.quantity, numeric: true },
                {
                  label: 'İade edilen',
                  render: (row) => row.returnedQuantity ?? '0',
                  numeric: true,
                },
                {
                  label: 'KDV dahil',
                  render: (row) => moneyIn(row.gross, data.data!.till.currencyCode),
                  numeric: true,
                },
              ]}
            />
            <Card className="mt-5 p-5">
              <p className="text-heading">
                {moneyIn(data.data.sale.total, data.data.till.currencyCode)}
              </p>
              <div className="mt-3 space-y-2">
                {data.data.sale.payments?.map((payment, index) => (
                  <p className="text-sm" key={index}>
                    {payment.method === 'cash' ? 'Nakit' : 'Kart'} ·{' '}
                    {moneyIn(payment.amount, data.data!.till.currencyCode)}
                  </p>
                ))}
              </div>
            </Card>
          </>
        )
      )}
    </>
  );
}
