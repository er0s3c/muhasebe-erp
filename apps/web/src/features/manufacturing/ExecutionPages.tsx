import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso, CURRENCY_CODES, currencySymbol } from '@erp/shared';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Callout, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Select } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import {
  OperationForm,
  Records,
  Status,
  selectField,
  textField,
  numberField,
  options,
  type Values,
} from '../leather/common';
import { displayDateTime, displayQuantity } from '../../lib/presentation';
import { errorMessage } from '../../lib/errors';
import { ProductionCostClosePanel, ReworkExecutionPanel } from './ExecutionPanels';

type Ref = { id: string; name?: string; code?: string };
type Operation = {
  key: string;
  name: string;
  status?: string;
  goodQty?: string;
  actualMinutes?: string;
  resources?: { resourceId: string }[];
};
type Order = Ref & { status: string; quantity: string; operations: Operation[]; phase?: string };
type Batch = Ref & { orderId: string; quantity: string };
const reason = textField('reason', 'İşlem nedeni', true);
const command = (v: Values) => ({ requestKey: v._requestKey, reason: v.reason });

export function ManufacturingPromisePage() {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const lookups = useCQuery<{ orders: Ref[]; warehouses: Ref[] }>(
    ['manufacturing', 'promise-lookups'],
    '/api/manufacturing/promise/lookups',
  );
  type Line = Ref & {
    itemName: string;
    demand: string;
    atp: string;
    productionQty: string;
    openProductionQty: string;
    newProductionQty: string;
    expectedAt: string | null;
    reasons: string[];
    stock: {
      physical: string;
      qualityHold: string;
      productionReserved: string;
      salesAllocated: string;
    };
  };
  const [result, setResult] = useState<{ orderCode: string; lines: Line[] } | null>(null),
    [warehouse, setWarehouse] = useState('');
  const allocations = useCQuery<{
    records: (Ref & {
      orderCode: string;
      itemName: string;
      warehouseName: string;
      quantity: string;
      fulfilledQty: string;
      priority: number;
      reason: string;
    })[];
  }>(['manufacturing', 'allocations'], '/api/manufacturing/allocations');
  return (
    <>
      <PageHeader
        title="Sipariş taahhüdü ve tahsis"
        description="Stoktan karşılanabilir miktarı ve üretim kapasitesiyle beklenen teslim tarihini hesaplayın."
      />
      <OperationForm
        title="Stok ve kapasiteye göre teslim hesapla"
        action="Taahhüt hesapla"
        successMessage="Karşılama önerisi hesaplandı"
        fields={[
          selectField(
            'salesOrderId',
            'Onaylı sipariş',
            options(lookups.data?.orders ?? [], (r) => r.code ?? 'Sipariş'),
          ),
          selectField(
            'warehouseId',
            'Mamul deposu',
            options(lookups.data?.warehouses ?? [], (r) => r.name ?? 'Depo'),
          ),
          {
            name: 'date',
            label: 'Plan başlangıç tarihi',
            type: 'date',
            required: true,
            value: todayIso(),
          },
          {
            name: 'time',
            label: 'Plan başlangıç saati',
            type: 'time',
            required: true,
            value: '08:00',
          },
        ]}
        submit={async (v) => {
          setWarehouse(v.warehouseId);
          setResult(
            await call('/api/manufacturing/promise', {
              method: 'POST',
              body: {
                salesOrderId: v.salesOrderId,
                warehouseId: v.warehouseId,
                anchor: new Date(v.date + 'T' + v.time).toISOString(),
              },
            }),
          );
        }}
      />
      {result && (
        <>
          <h2 className="mb-3 text-subheading">{result.orderCode} · Karşılama önerisi</h2>
          <Callout>
            Bu hesap bir öneridir. Stok, tahsis komutunu kaydettiğinizde siparişe ayrılır; veri
            eksikse teslim tarihi gösterilmez.
            Bu siparişin mevcut tahsisi stoktan karşılanabilir miktara dahildir.
          </Callout>
          <Records
            rows={result.lines}
            columns={[
              { label: 'Ürün', render: (r) => r.itemName },
              { label: 'Açık talep', numeric: true, render: (r) => r.demand },
              { label: 'Stoktan karşılanabilir', numeric: true, render: (r) => r.atp },
              { label: 'Açık üretimden', numeric: true, render: (r) => r.openProductionQty },
              { label: 'Yeni üretim / tedarik', numeric: true, render: (r) => r.newProductionQty },
              { label: 'Beklenen teslim', render: (r) => displayDateTime(r.expectedAt) },
              { label: 'Eksik veri', render: (r) => r.reasons.join(' · ') || '—' },
            ]}
            action={
              can('invoices.manage')
                ? (r) => (
                    <OperationForm
                      title="Stok tahsis et"
                      fields={[
                        numberField('quantity', 'Tahsis miktarı', r.atp),
                        numberField('priority', 'Öncelik (0–100)', '50'),
                        reason,
                      ]}
                      submit={async (v) => {
                        await call('/api/manufacturing/allocations', {
                          method: 'POST',
                          body: {
                            ...command(v),
                            salesOrderLineId: r.id,
                            warehouseId: warehouse,
                            quantity: v.quantity,
                            priority: Number(v.priority),
                          },
                        });
                        setResult(null);
                        await queries.invalidateQueries({ queryKey: ['manufacturing'] });
                        await queries.invalidateQueries();
                      }}
                    />
                  )
                : undefined
            }
          />
          {result.lines.map((r) => (
            <Card key={r.id} className="my-4">
              <CardHeader title={r.itemName} description="Kullanılabilirlik hesabının dayanağı" />
              <div className="grid gap-4 p-5 sm:grid-cols-4">
                <Stat label="Fiziksel stok">{displayQuantity(r.stock.physical)}</Stat>
                <Stat label="Kalite bekleyen / blokeli">
                  {displayQuantity(r.stock.qualityHold)}
                </Stat>
                <Stat label="Üretime rezerve">{displayQuantity(r.stock.productionReserved)}</Stat>
                <Stat label="Diğer siparişlere tahsis">{displayQuantity(r.stock.salesAllocated)}</Stat>
              </div>
            </Card>
          ))}
        </>
      )}
      <h2 className="mb-3 mt-6 text-subheading">Kayıtlı tahsisler</h2>
      <Records
        rows={allocations.data?.records ?? []}
        loading={allocations.isPending} onRetry={() => void allocations.refetch()} retrying={allocations.isFetching}
        error={allocations.error}
        columns={[
          { label: 'Sipariş', render: (r) => r.orderCode },
          { label: 'Ürün', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Ayrılmış miktar', numeric: true, render: (r) => r.quantity },
          { label: 'Sevk edilen tahsis', numeric: true, render: (r) => r.fulfilledQty },
          { label: 'Öncelik', numeric: true, render: (r) => r.priority },
          { label: 'Neden', render: (r) => r.reason },
        ]}
      />
    </>
  );
}

export function ManufacturingShopFloorPage() {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const lookups = useCQuery<{ orders: Order[]; resources: Ref[]; batches: Batch[] }>(
    ['manufacturing', 'execution-lookups'],
    '/api/manufacturing/execution/lookups',
  );
  const [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('');
  const summary = useCQuery<{
    phase: string;
    order: Order & { itemName: string };
    sessions: (Ref & {
      operationKey: string;
      status: string;
      minutes: string;
      startedAt: string;
      endedAt?: string;
    })[];
    batches: Batch[];
    materials: (Ref & {
      itemId: string;
      itemName: string;
      issued: string;
      returned: string;
      net: string;
      handed: string;
      unusedReturned: string;
      stagedBalance: string;
    })[];
    handoffs: (Ref & {
      itemId: string;
      quantity: string;
      consumedQty: string;
      returnedQty: string;
      status: string;
    })[];
    operations: (Operation & {
      queuedQty: string;
      inTransitQty: string;
      averageQueueMinutes: number | null;
      processingQueue: {
        averageMinutes: number | null;
        measuredQty: number;
        unmeasuredQty: number;
      };
    })[];
  }>(
    ['manufacturing', 'execution', selected],
    `/api/manufacturing/production/orders/${selected}/execution`,
    { enabled: !!selected },
  );
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  const order = summary.data?.order;
  return (
    <>
      <PageHeader
        title="Atölye iş ekranı"
        description="Atanmış işi kodla bulun, operasyonu başlatın ve üretim sonucunu kaydedin. Duraklama süresi çalışma süresine eklenmez."
      />
      <OperationForm
        title="İşi kodla bul"
        fields={[textField('code', 'İş kodu / okutulan kod')]}
        action="İşi bul"
        submit={async (v) => {
          setFilter(v.code);
          const found = lookups.data?.orders.find(
            (o) => o.code?.toLocaleLowerCase('tr-TR') === v.code.toLocaleLowerCase('tr-TR'),
          );
          if (found) setSelected(found.id);
          else throw new Error('Atanmış iş kodu bulunamadı');
        }}
      />
      <Field label="Atanmış üretim emri">
        {(id) => (
          <Select id={id} value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">İş seçin</option>
            {lookups.data?.orders
              .filter(
                (o) =>
                  o.status !== 'cancelled' &&
                  (!filter ||
                    o.code?.toLocaleLowerCase('tr-TR').includes(filter.toLocaleLowerCase('tr-TR'))),
              )
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code}
                </option>
              ))}
          </Select>
        )}
      </Field>
      {!summary.error && summary.isPending && selected && <PageLoading />}
      {summary.error && <ErrorState description={errorMessage(summary.error)} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />}
      {order && (
        <>
          <Card className="my-5">
            <CardHeader
              title={`${order.code} · ${order.itemName}`}
              description="Üretim hedefi ve güncel aşama"
            />
            <div className="flex flex-wrap items-center gap-8 p-5">
              <Stat label="Hedef adet">{displayQuantity(order.quantity, 0)}</Stat>
              <Status value={summary.data!.phase} />
              <Link className="link" to={'/manufacturing/production?focus=' + order.id}>
                Üretim ayrıntıları
              </Link>
            </div>
          </Card>
          <Records
            rows={order.operations.map((op) => ({ ...op, id: op.key }))}
            columns={[
              { label: 'Operasyon', render: (r) => r.name },
              { label: 'İyi adet', numeric: true, render: (r) => r.goodQty ?? '0' },
              { label: 'Çalışma (dk)', numeric: true, render: (r) => r.actualMinutes ?? '0' },
              { label: 'Durum', render: (r) => <Status value={r.status ?? 'planned'} /> },
            ]}
            action={
              can('manufacturing.production.manage') &&
              ['released', 'in_progress'].includes(order.status)
                ? (op) => {
                    const active = summary.data?.sessions.find(
                      (s) => s.operationKey === op.key && s.status === 'running',
                    );
                    return (
                      <>
                        <OperationForm
                          title={active ? 'İşi duraklat' : 'İşi başlat'}
                          fields={
                            active
                              ? [reason]
                              : [
                                  selectField(
                                    'resourceId',
                                    'Kaynak',
                                    options(
                                      (lookups.data?.resources ?? []).filter(
                                        (r) =>
                                          !op.resources?.length ||
                                          op.resources.some((x) => x.resourceId === r.id),
                                      ),
                                      (r) => r.name ?? 'Kaynak',
                                    ),
                                  ),
                                  selectField(
                                    'batchId',
                                    'Üretim partisi (isteğe bağlı)',
                                    options(
                                      summary.data?.batches ?? [],
                                      (r) => r.code ?? 'Üretim partisi',
                                    ),
                                    false,
                                  ),
                                  reason,
                                ]
                          }
                          action={active ? 'Duraklat' : 'Başlat'}
                          submit={(v) =>
                            save(`/api/manufacturing/production/orders/${order.id}/work`, {
                              ...command(v),
                              action: active ? 'pause' : 'start',
                              operationKey: op.key,
                              resourceId: v.resourceId || undefined,
                              batchId: v.batchId || undefined,
                              date: todayIso(),
                            })
                          }
                        />
                        {active && (
                          <OperationForm
                            title="Üretim sonucu"
                            fields={[
                              numberField('quantity', 'İşlenen adet'),
                              numberField('goodQty', 'İyi adet'),
                              numberField('scrapQty', 'Fire', '0'),
                              numberField('reworkQty', 'Yeniden işleme', '0'),
                              reason,
                            ]}
                            action="Operasyonu tamamla"
                            submit={(v) =>
                              save(`/api/manufacturing/production/orders/${order.id}/work`, {
                                ...command(v),
                                action: 'complete',
                                operationKey: op.key,
                                date: todayIso(),
                                quantity: v.quantity,
                                goodQty: v.goodQty,
                                scrapQty: v.scrapQty,
                                reworkQty: v.reworkQty,
                              })
                            }
                          />
                        )}
                      </>
                    );
                  }
                : undefined
            }
          />
          {can('manufacturing.production.manage') &&
            !['completed', 'cancelled'].includes(order.status) && (
              <OperationForm
                title="Üretim partisi oluştur"
                description="Üretim emrinin bir bölümünü ayrı takip etmek için parti açın."
                fields={[numberField('quantity', 'Parti hedef adedi'), reason]}
                submit={(v) =>
                  save('/api/manufacturing/batches', {
                    ...command(v),
                    orderId: order.id,
                    quantity: v.quantity,
                  })
                }
              />
            )}
          {can('manufacturing.production.approve') && (
            <OperationForm
              title="Üretim aşamasını değiştir"
              fields={[
                selectField('phase', 'Aşama', [
                  { value: 'material_waiting', label: 'Malzeme bekliyor' },
                  { value: 'ready', label: 'Hazır' },
                  { value: 'paused', label: 'Duraklatıldı' },
                  { value: 'quality_waiting', label: 'Kalite bekliyor' },
                  { value: 'rework', label: 'Yeniden işleme' },
                  { value: 'on_hold', label: 'Bekletildi' },
                  { value: 'closed', label: 'Maliyet kapandı' },
                ]),
                reason,
              ]}
              submit={(v) =>
                save(`/api/manufacturing/production/orders/${order.id}/phase`, {
                  ...command(v),
                  phase: v.phase,
                })
              }
            />
          )}
          <h2 className="mb-3 mt-6 text-subheading">Malzeme sarf ve iade mutabakatı</h2>
          <Records
            rows={summary.data?.materials.map((m) => ({ ...m, id: m.itemId })) ?? []}
            columns={[
              { label: 'Malzeme', render: (r) => r.itemName },
              { label: 'Atölyeye teslim', numeric: true, render: (r) => r.handed },
              { label: 'Kullanılmadan iade', numeric: true, render: (r) => r.unusedReturned },
              { label: 'Teslimde kalan', numeric: true, render: (r) => r.stagedBalance },
              { label: 'Gerçek sarf', numeric: true, render: (r) => r.issued },
              { label: 'Kaynak sarfa iade', numeric: true, render: (r) => r.returned },
              { label: 'Üretime net sarf', numeric: true, render: (r) => r.net },
            ]}
          />
          {can('manufacturing.production.manage') && (
            <>
              <OperationForm
                title="Atölyeye malzeme teslim et"
                fields={[
                  selectField(
                    'itemId',
                    'Malzeme',
                    options(
                      (summary.data?.materials ?? []).map((m) => ({
                        id: m.itemId,
                        name: m.itemName,
                      })),
                      (r) => r.name ?? 'Malzeme',
                    ),
                  ),
                  numberField('quantity', 'Teslim miktarı'),
                  reason,
                ]}
                submit={(v) =>
                  save(`/api/manufacturing/production/orders/${order.id}/material-handoff`, {
                    ...command(v),
                    action: 'deliver',
                    date: todayIso(),
                    itemId: v.itemId,
                    quantity: v.quantity,
                  })
                }
              >
                <p className="text-sm text-muted">
                  Aynı depo içindeki teslim kaydedilir. Malzeme, gerçek sarf belgesiyle üretim
                  maliyetine alınır.
                </p>
              </OperationForm>
              <Records
                rows={summary.data?.handoffs ?? []}
                columns={[
                  { label: 'Teslim', render: (r) => r.code },
                  {
                    label: 'Malzeme',
                    render: (r) =>
                      summary.data?.materials.find((m) => m.itemId === r.itemId)?.itemName,
                  },
                  { label: 'Adet / alan', numeric: true, render: (r) => r.quantity },
                  { label: 'Sarfa geçen', numeric: true, render: (r) => r.consumedQty },
                  { label: 'Kullanılmadan iade', numeric: true, render: (r) => r.returnedQty },
                ]}
                action={(r) =>
                  r.status === 'delivered' && (
                    <OperationForm
                      title="Kullanılmamış teslimi iade et"
                      fields={[numberField('quantity', 'İade miktarı'), reason]}
                      submit={(v) =>
                        save(`/api/manufacturing/production/orders/${order.id}/material-handoff`, {
                          ...command(v),
                          date: todayIso(),
                          action: 'return',
                          handoffId: r.id,
                          itemId: r.itemId,
                          quantity: v.quantity,
                        })
                      }
                    />
                  )
                }
              />
            </>
          )}
          <h2 className="mb-3 mt-6 text-subheading">Operasyon transfer ve bekleme</h2>
          <Records
            rows={summary.data?.operations.map((o) => ({ ...o, id: o.key })) ?? []}
            columns={[
              { label: 'Operasyon', render: (r) => r.name },
              { label: 'Kabul edilmiş kuyruk', numeric: true, render: (r) => r.queuedQty },
              { label: 'Yoldaki adet', numeric: true, render: (r) => r.inTransitQty },
              {
                label: 'Ortalama transfer beklemesi (dk)',
                numeric: true,
                render: (r) => displayQuantity(r.averageQueueMinutes),
              },
              {
                label: 'Kabulden işe başlama süresi (dk)',
                numeric: true,
                render: (r) => displayQuantity(r.processingQueue.averageMinutes),
              },
              {
                label: 'Ölçülen adet',
                numeric: true,
                render: (r) => displayQuantity(r.processingQueue.measuredQty),
              },
              {
                label: 'İşe başlama kaydı olmayan adet',
                numeric: true,
                render: (r) => displayQuantity(r.processingQueue.unmeasuredQty),
              },
            ]}
          />
          <h2 className="mb-3 mt-6 text-subheading">Çalışma oturumları</h2>
          <ReworkExecutionPanel
            orderId={order.id}
            operations={order.operations}
            resources={lookups.data?.resources ?? []}
          />
          <ProductionCostClosePanel orderId={order.id} />
          <Records
            rows={summary.data?.sessions ?? []}
            columns={[
              { label: 'Kayıt', render: (r) => r.code },
              { label: 'Başlangıç', render: (r) => displayDateTime(r.startedAt) },
              { label: 'Bitiş', render: (r) => displayDateTime(r.endedAt) },
              { label: 'Dakika', numeric: true, render: (r) => r.minutes ?? '0' },
              { label: 'Durum', render: (r) => <Status value={r.status} /> },
            ]}
          />
        </>
      )}
    </>
  );
}

export function ManufacturingExceptionsPage() {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const [includeResolved, setIncludeResolved] = useState(false);
  const rows = useCQuery<{
    records: (Ref & {
      status?: string;
      sourceKey: string;
      message: string;
      severity: string;
      path: string;
      assignedUserId?: string;
    })[];
  }>(
    ['manufacturing', 'exceptions', includeResolved],
    `/api/manufacturing/exceptions?includeResolved=${includeResolved}`,
  );
  const people = useCQuery<{ users: Ref[] }>(
    ['manufacturing', 'exception-users'],
    '/api/manufacturing/exceptions/lookups',
  );
  return (
    <>
      <PageHeader
        title="Müdahale bekleyen işler"
        description="Gecikme, arıza, kalite, fason ve transfer sorunlarını kaynak kayda giderek çözün."
      />
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeResolved}
          onChange={(e) => setIncludeResolved(e.target.checked)}
        />
        Çözülen ve kaynağında hâlâ görünen işleri göster
      </label>
      <Records
        rows={rows.data?.records ?? []}
        loading={rows.isPending} onRetry={() => void rows.refetch()} retrying={rows.isFetching}
        error={rows.error}
        columns={[
          {
            label: 'Kaynak',
            render: (r) => (
              <Link className="link" to={r.path}>
                {r.code}
              </Link>
            ),
          },
          { label: 'Sorun', render: (r) => r.message },
          { label: 'Önem', render: (r) => (r.severity === 'high' ? 'Yüksek' : 'Orta') },
          { label: 'Durum', render: (r) => <Status value={r.status ?? 'open'} /> },
          {
            label: 'Sorumlu',
            render: (r) =>
              people.data?.users.find((u) => u.id === r.assignedUserId)?.name ?? 'Atanmadı',
          },
        ]}
        action={
          can('manufacturing.production.approve')
            ? (r) => (
                <OperationForm
                  title="Müdahale kararı"
                  fields={[
                    selectField('action', 'İşlem', [
                      { value: 'assign', label: 'Sorumlu ata' },
                      { value: 'resolve', label: 'Çözüldü' },
                      { value: 'reopen', label: 'Yeniden aç' },
                    ]),
                    selectField(
                      'assignedUserId',
                      'Sorumlu',
                      options(people.data?.users ?? [], (r) => r.name ?? 'Kullanıcı'),
                      false,
                    ),
                    reason,
                  ]}
                  submit={async (v) => {
                    await call('/api/manufacturing/exceptions', {
                      method: 'POST',
                      body: {
                        ...command(v),
                        sourceKey: r.sourceKey,
                        action: v.action,
                        assignedUserId: v.assignedUserId || undefined,
                      },
                    });
                    await queries.invalidateQueries();
                  }}
                />
              )
            : undefined
        }
      />
    </>
  );
}

export function ManufacturingSupplyPage() {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  type Profile = Ref & {
    itemName: string;
    supplierName: string;
    leadDays: number;
    minOrderQty: string;
    packQty: string;
    supplierCode: string;
  };
  const lookups = useCQuery<{
    items: Ref[];
    parties: Ref[];
    warehouses: Ref[];
    profiles: Profile[];
    policies: (Ref & {
      itemName: string;
      warehouseName: string;
      minimum: string;
      target: string;
    })[];
  }>(['manufacturing', 'supply-lookups'], '/api/manufacturing/supply/lookups');
  const replenishment = useCQuery<{
    recommendations: (Ref & {
      policyId: string;
      itemName: string;
      warehouseName: string;
      stock: { available: string };
      needs: { net: string }[];
    })[];
  }>(['manufacturing', 'replenishment'], '/api/manufacturing/replenishment');
  const [itemId, setItemId] = useState('');
  const supply = useCQuery<{
    open: (Ref & { quantity: string; expectedDate: string | null })[];
    profiles: (Profile & {
      performance: { samples: number; days: string; average_price: string } | null;
    })[];
  }>(['manufacturing', 'supply', itemId], itemId ? '/api/manufacturing/supply/' + itemId : null);
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <>
      <PageHeader
        title="Tedarik ve stok politikaları"
        description="Malzeme tedarik süresini, minimum alım ve paket miktarını malzeme ihtiyaç planına bağlayın."
      />
      <Records
        rows={lookups.data?.profiles ?? []}
        loading={lookups.isPending} onRetry={() => void lookups.refetch()} retrying={lookups.isFetching}
        error={lookups.error}
        columns={[
          { label: 'Malzeme', render: (r) => r.itemName },
          { label: 'Tedarikçi', render: (r) => r.supplierName },
          { label: 'Tedarikçi ürün kodu', render: (r) => r.supplierCode },
          { label: 'Termin (gün)', numeric: true, render: (r) => r.leadDays },
          { label: 'Minimum alım', numeric: true, render: (r) => r.minOrderQty },
          { label: 'Paket miktarı', numeric: true, render: (r) => r.packQty },
        ]}
      />
      <h2 className="text-subheading mt-6">Minimum stok politikaları</h2>
      <Records
        rows={lookups.data?.policies ?? []}
        columns={[
          { label: 'Malzeme', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Minimum', numeric: true, render: (r) => displayQuantity(r.minimum) },
          { label: 'Hedef', numeric: true, render: (r) => displayQuantity(r.target) },
        ]}
      />
      <h2 className="text-subheading mt-6">Stok yenileme önerileri</h2>
      <Records
        rows={(replenishment.data?.recommendations ?? []).map((r) => ({ ...r, id: r.policyId }))}
        loading={replenishment.isPending} onRetry={() => void replenishment.refetch()} retrying={replenishment.isFetching}
        error={replenishment.error}
        columns={[
          { label: 'Malzeme', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          {
            label: 'Kullanılabilir stok',
            numeric: true,
            render: (r) => displayQuantity(r.stock.available),
          },
        ]}
      />
      <Field label="Tedarik geçmişi malzemesi">
        {(id) => (
          <Select id={id} value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Malzeme seçin</option>
            {lookups.data?.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} · {i.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {itemId && (
        <>
          <h2 className="text-subheading mt-6">Açık satın alma arzı</h2>
          <Records
            rows={(supply.data?.open ?? []).map((o) => ({ ...o, id: o.code ?? 'Arz' }))}
            loading={supply.isPending} onRetry={() => void supply.refetch()} retrying={supply.isFetching}
            error={supply.error}
            columns={[
              { label: 'Sipariş', render: (r) => r.code },
              {
                label: 'Bekleyen miktar',
                numeric: true,
                render: (r) => displayQuantity(r.quantity),
              },
              {
                label: 'Beklenen tarih',
                render: (r) =>
                  r.expectedDate
                    ? displayDateTime(r.expectedDate)
                    : 'Tedarikçi termin bilgisi gerekli',
              },
            ]}
          />
          <h2 className="text-subheading mt-6">Tedarikçi gerçekleşen teslim performansı</h2>
          <Records
            rows={supply.data?.profiles ?? []}
            columns={[
              { label: 'Tedarikçi', render: (r) => r.supplierName },
              { label: 'Kabul örneği', numeric: true, render: (r) => r.performance?.samples ?? 0 },
              {
                label: 'Gerçekleşen ortalama gün',
                numeric: true,
                render: (r) => displayQuantity(r.performance?.days),
              },
              { label: 'Planlanan gün', numeric: true, render: (r) => r.leadDays },
            ]}
          />
        </>
      )}
      {can('manufacturing.mrp.manage') && (
        <>
          <OperationForm
            title="Tedarikçi planlama profili"
            fields={[
              selectField(
                'itemId',
                'Malzeme',
                options(lookups.data?.items ?? [], (r) => `${r.code} · ${r.name}`),
              ),
              selectField(
                'partyId',
                'Tedarikçi',
                options(lookups.data?.parties ?? [], (r) => r.name ?? 'Tedarikçi'),
              ),
              textField('supplierCode', 'Tedarikçi ürün kodu', false),
              selectField('preferred', 'Tercih edilen tedarikçi', [
                { value: 'false', label: 'Hayır' },
                { value: 'true', label: 'Evet' },
              ]),
              numberField('leadDays', 'Tedarik süresi (gün)', '0'),
              numberField('minOrderQty', 'Minimum alım', '0'),
              numberField('packQty', 'Paket miktarı', '1'),
              numberField('unitPrice', 'Birim fiyat', '0'),
              {
                ...selectField(
                  'currency',
                  'Para birimi',
                  CURRENCY_CODES.map((c) => ({ value: c, label: currencySymbol(c) })),
                ),
                value: 'TRY',
              },
              reason,
            ]}
            submit={(v) =>
              save('/api/manufacturing/supplier-profiles', {
                ...command(v),
                itemId: v.itemId,
                partyId: v.partyId,
                supplierCode: v.supplierCode,
                preferred: v.preferred === 'true',
                leadDays: Number(v.leadDays),
                minOrderQty: v.minOrderQty,
                packQty: v.packQty,
                unitPrice: v.unitPrice,
                currency: v.currency,
              })
            }
          />
          <OperationForm
            title="Minimum stok politikası"
            fields={[
              selectField(
                'itemId',
                'Stok',
                options(lookups.data?.items ?? [], (r) => `${r.code} · ${r.name}`),
              ),
              selectField(
                'warehouseId',
                'Depo',
                options(lookups.data?.warehouses ?? [], (r) => r.name ?? 'Depo'),
              ),
              numberField('minimum', 'Minimum stok'),
              numberField('target', 'Hedef stok'),
              reason,
            ]}
            submit={(v) =>
              save('/api/manufacturing/demand-policies', {
                ...command(v),
                itemId: v.itemId,
                warehouseId: v.warehouseId,
                minimum: v.minimum,
                target: v.target,
              })
            }
          />
        </>
      )}
    </>
  );
}
