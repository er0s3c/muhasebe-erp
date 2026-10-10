import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@erp/shared';
import { useCQuery, useCan, useCompanyApi } from '../../lib/queries';
import { Card, PageHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { Callout } from '../../components/ui/Feedback';
import { Status } from '../leather/common';
import { SegmentedTabs } from '../../components/ui/Tabs';
import {
  displayDateTime,
  displayQuantity,
  displayRecordCode,
  domainLabels,
} from '../../lib/presentation';
import {
  OperationForm,
  Records as BaseRecords,
  textField,
  numberField,
  selectField,
  options,
} from '../leather/common';
import { ChannelExecutionPanel } from './ExecutionPanels';
import { PlanningPage } from './PlanningPage';
export {
  LeatherModelsPage as ManufacturingCatalogPage,
  LeatherProductionPage as ManufacturingProductionPage,
  LeatherQualityPage as ManufacturingQualityPage,
  LeatherSubcontractsPage as ManufacturingSubcontractingPage,
  LeatherOverviewPage as ManufacturingOverviewPage,
} from '../leather/LeatherPages';

type Row = {
  id: string;
  code?: string;
  name?: string;
  status?: string;
  quantity?: string;
  resourceId?: string;
  start?: string;
  end?: string;
  itemName?: string;
  warehouseName?: string;
  operations?: {
    start: string;
    end: string;
    operationKey: string;
    orderId?: string;
    key?: string;
    name?: string;
  }[];
  [key: string]: unknown;
};
function Records({
  title,
  rows,
  columns,
  actions,
  loading,
  error,
}: {
  title: string;
  rows: Row[];
  columns: { key: string; label: string }[];
  actions?: (r: Row) => ReactNode;
  loading?: boolean;
  error?: Error | null;
}) {
  return (
    <>
      <h2 className="mb-3 mt-6 text-subheading">{title}</h2>
      <BaseRecords<Row>
        rows={rows}
        loading={loading}
        error={error}
        columns={columns.map((c) => ({
          label: c.label,
          formatted: true,
          numeric:
            /^(gross|available|net|quantity|remainingQty|capacity|days|goodQty|minutes|minutesPerUnit|plannedMinutes|downtimeMinutes|mttrMinutes|mtbfMinutes|oee|attempts)$/.test(
              c.key,
            ),
          render: (r: Row) => {
            const value = r[c.key];
            if (c.key === 'end' && r.recordKind === 'maintenance' && r.status === 'open')
              return <span className="text-muted">Devam ediyor</span>;
            if (value == null || value === '') return '—';
            if (c.key === 'status') return <Status value={String(value)} />;
            if (['start', 'end', 'createdAt', 'updatedAt', 'retryAfter'].includes(c.key))
              return displayDateTime(value);
            if (['code', 'scenario'].includes(c.key))
              return displayRecordCode(value, String(r.name ?? r.description ?? 'Kayıt'));
            if (c.key === 'oee') return `${displayQuantity(Number(value) * 100, 1)} %`;
            if (
              /^(gross|available|net|quantity|remainingQty|capacity|days|goodQty|minutes|minutesPerUnit|plannedMinutes|downtimeMinutes|mttrMinutes|mtbfMinutes|attempts)$/.test(
                c.key,
              )
            )
              return displayQuantity(
                value,
                ['days', 'attempts', 'capacity'].includes(c.key) ? 0 : 2,
              );
            return domainLabels[String(value)] ?? displayRecordCode(value, 'Kayıt seçilmedi');
          },
        }))}
        action={actions}
      />
    </>
  );
}
const time = (v: Record<string, string>, prefix: string) =>
  new Date(v[prefix + 'Date'] + 'T' + v[prefix + 'Time']).toISOString();
const timeFields = (prefix: string, label: string, value?: Date) => [
  {
    name: prefix + 'Date',
    label: label + ' tarihi',
    type: 'date' as const,
    value: value
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
      : todayIso(),
    required: true,
  },
  {
    ...textField(prefix + 'Time', label + ' saati'),
    type: 'time' as const,
    value: value
      ? `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
      : '08:00',
    required: true,
  },
];

export function ManufacturingMrpPage() {
  const { call } = useCompanyApi(),
    can = useCan();
  const queries = useQueryClient();
  const [needs, setNeeds] = useState<Row[]>([]),
    [proposals, setProposals] = useState<Row[]>([]),
    [requestId, setRequestId] = useState(''),
    [last, setLast] = useState<Record<string, string>>({});
  const lookups = useCQuery<{ items: Row[]; warehouses: Row[] }>(
    ['manufacturing', 'lookups'],
    '/api/manufacturing/lookups',
  );
  return (
    <>
      <PageHeader
        title="Malzeme ihtiyaç planlama"
        description="Kullanılabilir stok düşülür; onaylı reçeteden üretim ve satın alma ihtiyacı hesaplanır."
      />
      <OperationForm
        title="İhtiyaç hesapla"
        fields={[
          selectField(
            'itemId',
            'Ürün',
            options(lookups.data?.items ?? [], (r) => `${r.code} · ${r.name}`),
          ),
          numberField('quantity', 'Talep adedi', '500'),
          selectField(
            'warehouseId',
            'Depo',
            options(lookups.data?.warehouses ?? [], (r) => String(r.name)),
          ),
        ]}
        submit={async (v) => {
          const r = await call<{ needs: Row[] }>('/api/manufacturing/mrp', {
            method: 'POST',
            body: v,
          });
          setLast(v);
          setNeeds(r.needs);
          setRequestId('');
          const supply = await call<{ proposals: Row[] }>('/api/manufacturing/mrp/proposals', {
            method: 'POST',
            body: { needs: r.needs, anchor: new Date().toISOString() },
          });
          setProposals(
            supply.proposals.map((p) => {
              const supplier = (
                p.suppliers as { supplierName: string; quantity: string; expectedDate: string }[]
              )[0];
              return {
                ...p,
                supplierSummary: supplier
                  ? supplier.supplierName +
                    ' · ' +
                    supplier.quantity +
                    ' · ' +
                    supplier.expectedDate
                  : 'Tedarikçi profili gerekli',
              };
            }),
          );
        }}
        action="Hesapla"
      />
      <Records
        title="Net ihtiyaçlar"
        rows={needs.map((n, i) => ({ ...n, id: String(i) }))}
        columns={[
          { key: 'name', label: 'Ürün' },
          { key: 'gross', label: 'Brüt ihtiyaç' },
          { key: 'available', label: 'Kullanılan stok' },
          { key: 'net', label: 'Net ihtiyaç' },
          { key: 'action', label: 'Karşılama' },
        ]}
      />
      <Records
        title="Satın alma önerileri"
        rows={proposals.map((p, i) => ({ ...p, id: String(i) }))}
        columns={[
          { key: 'name', label: 'Malzeme' },
          { key: 'incoming', label: 'Açık satın alma arzı' },
          { key: 'purchaseQty', label: 'Kalan alım ihtiyacı' },
          { key: 'supplierSummary', label: 'Önerilen tedarikçi / MOQ adedi / termin' },
        ]}
      />
      {proposals.some((p) => Number(p.purchaseQty) > 0) &&
        can('manufacturing.mrp.manage') &&
        can('procurement.manage') && (
          <OperationForm
            title="İhtiyaçtan ortak satın alma talebi aç"
            fields={[{ ...textField('dueDate', 'İhtiyaç tarihi'), type: 'date', required: false }]}
            submit={async (v) => {
              const r = await call<{ requestId: string }>(
                '/api/manufacturing/mrp/purchase-request',
                {
                  method: 'POST',
                  body: { ...last, requestKey: v._requestKey, dueDate: v.dueDate || undefined },
                },
              );
              setRequestId(r.requestId);
              await queries.invalidateQueries();
            }}
            action="Satın alma talebi oluştur"
          />
        )}
      {requestId && (
        <Callout>
          <Link className="link" to={'/purchasing/requests/' + requestId}>
            Oluşturulan satın alma talebini aç
          </Link>
        </Callout>
      )}
      {needs.length > 0 && can('manufacturing.mrp.manage') && (
        <Card>
          <OperationForm
            title="İhtiyacı üretime aktar"
            fields={[
              selectField(
                'outputWarehouseId',
                'Mamul deposu',
                options(lookups.data?.warehouses ?? [], (r) => String(r.name)),
              ),
            ]}
            submit={async (v) => {
              await call('/api/manufacturing/mrp/orders', {
                method: 'POST',
                body: { ...last, ...v, requestKey: v._requestKey },
              });
              await queries.invalidateQueries();
            }}
            action="Üretim emirlerini aç"
          />
        </Card>
      )}
    </>
  );
}

export function ManufacturingOperationsPage() {
  return useLocation().pathname.endsWith('/maintenance') ? <MaintenanceOperationsPage /> : <PlanningPage />;
}

function MaintenanceOperationsPage() {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const save = async (p: string, body: unknown) => {
    await call(p, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  const resources = useCQuery<{ records: Row[] }>(
    ['manufacturing', 'resources'],
    '/api/manufacturing/maintenance/resources',
  );
  const records = useCQuery<{ records: Row[] }>(
    ['manufacturing', 'maintenance'],
    '/api/manufacturing/maintenance',
  );
  const resourceOptions = options(resources.data?.records ?? [], (r) => String(r.name));
  const lookups = useCQuery<{ items: Row[]; warehouses: Row[] }>(
    ['manufacturing', 'lookups', true],
    '/api/manufacturing/maintenance/lookups',
  );
  const metrics = useCQuery<{ metrics: Row[] }>(
    ['manufacturing', 'metrics', todayIso()],
    `/api/manufacturing/maintenance/metrics?from=${todayIso().slice(0, 7)}-01&to=${todayIso()}`,
  );
  const report = useCQuery<{ history: Row[] }>(
    ['manufacturing', 'reports'],
    '/api/manufacturing/reports',
    { enabled: can('manufacturing.production.read') },
  );
  return (
    <>
      <PageHeader
        title="Makine bakım ve arıza"
        description="Vardiya, bakım ve devamsızlık takvimleri kaynak kapasitesine birlikte uygulanır."
      />
      <Records
        title="Bakım kayıtları"
        loading={records.isPending}
        error={records.error}
        rows={(records.data?.records ?? []).map((r) => ({
          ...r,
          name: `${resources.data?.records.find((p) => p.id === r.resourceId)?.name ?? 'Kaynak'} · ${r.description ?? 'Bakım'}`,
          start:
            r.start ??
            r.operations?.reduce((first, o) => (!first || o.start < first ? o.start : first), ''),
          end: r.end ?? r.operations?.reduce((last, o) => (o.end > last ? o.end : last), ''),
        }))}
        columns={[
          { key: 'code', label: 'Kayıt' },
          { key: 'name', label: 'Kaynak ve açıklama' },
          { key: 'status', label: 'Durum' },
          { key: 'start', label: 'Başlangıç' },
          { key: 'end', label: 'Gerçekleşen bitiş' },
        ]}
        actions={(r) =>
          can('manufacturing.maintenance.manage') && r.status === 'open' ? (
            <OperationForm
              title="Kaydı tamamla"
              description="Makine yeniden çalışabilir olduğunda gerçekleşen bitişi girin. Kaydı tamamlamak bakım nedeniyle kapalı kapasiteyi bu saatten itibaren açar."
              fields={[
                ...timeFields('end', 'Gerçekleşen bitiş', new Date()),
                ...(Array.isArray(r.spareParts) && r.spareParts.length
                  ? [
                      {
                        name: 'date',
                        label: 'Yedek parça sarf tarihi',
                        type: 'date' as const,
                        value: todayIso(),
                        required: true,
                      },
                    ]
                  : []),
              ]}
              submit={(v) =>
                save(`/api/manufacturing/maintenance/${r.id}/complete`, {
                  action: 'complete',
                  date: v.date ?? todayIso(),
                  end: time(v, 'end'),
                  requestKey: v._requestKey,
                })
              }
              action="Kaydı tamamla"
            />
          ) : null
        }
      />
      <Records
        title="Bakım ve verimlilik göstergeleri"
        rows={metrics.data?.metrics.map((r) => ({ ...r, id: String(r.resourceId) })) ?? []}
        columns={[
          { key: 'name', label: 'Kaynak' },
          { key: 'plannedMinutes', label: 'Vardiya (dk)' },
          { key: 'downtimeMinutes', label: 'Arıza (dk)' },
          { key: 'mttrMinutes', label: 'MTTR (dk)' },
          { key: 'mtbfMinutes', label: 'MTBF (dk)' },
          { key: 'oee', label: 'OEE' },
          { key: 'source', label: 'Veri kaynağı' },
        ]}
      />
      {report.data && (
        <Records
          title="Gerçek ve standart operasyon süreleri"
          rows={report.data.history.map((r) => ({ ...r, id: String(r.days) }))}
          columns={[
            { key: 'days', label: 'Son gün' },
            { key: 'goodQty', label: 'İyi adet' },
            { key: 'minutes', label: 'Gerçek dakika' },
            { key: 'minutesPerUnit', label: 'Operasyon dk / iyi adet' },
            { key: 'source', label: 'Tahmin kaynağı' },
          ]}
        />
      )}
      {can('manufacturing.maintenance.manage') && (
        <OperationForm
          title="Bakım veya arıza kaydı"
          description="Başlangıcı kaydedin; bitiş saati gerekmez. Makine, kaydı gerçekleşen bitişiyle tamamlayana kadar üretim planlamasında kapalı kalır. Yedek parçalar tamamlandığında sarf edilir."
          fields={[
            selectField('resourceId', 'Makine', resourceOptions),
            selectField('kind', 'Tür', [
              { value: 'planned', label: 'Planlı bakım' },
              { value: 'breakdown', label: 'Arıza' },
            ]),
            textField('description', 'Açıklama'),
            ...timeFields('start', 'Başlangıç', new Date()),
            {
              ...selectField(
                'warehouseId',
                'Yedek parça deposu',
                options(lookups.data?.warehouses ?? [], (r) => String(r.name)),
              ),
              required: false,
            },
            {
              ...selectField(
                'spareItemId',
                'Yedek parça',
                options(lookups.data?.items ?? [], (r) => String(r.name)),
              ),
              required: false,
            },
            { ...numberField('spareQty', 'Parça miktarı', '1'), required: false },
          ]}
          submit={(v) =>
            save('/api/manufacturing/maintenance', {
              resourceId: v.resourceId,
              kind: v.kind,
              description: v.description,
              start: time(v, 'start'),
              warehouseId: v.warehouseId || undefined,
              spareParts: v.spareItemId
                ? [{ itemId: v.spareItemId, quantity: v.spareQty }]
                : [],
            })
          }
        />
      )}
      {records.error && <Callout tone="danger">{records.error.message}</Callout>}
    </>
  );
}

export function ManufacturingWarehousePage() {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const [selection, setSelection] = useState('lots');
  const lookups = useCQuery<{ items: Row[]; warehouses: Row[]; documents: Row[] }>(
    ['wms', 'lookups'],
    '/api/wms/lookups',
  );
  const bins = useCQuery<{ records: Row[] }>(['wms', 'bins'], '/api/wms/bins');
  const lots = useCQuery<{ records: Row[] }>(['wms', 'lots'], '/api/wms/lots');
  const placements = useCQuery<{ records: Row[] }>(['wms', 'placements'], '/api/wms/placements');
  const save = async (p: string, body: unknown) => {
    await call(p, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <>
      <PageHeader
        title="Depo ve raf yönetimi"
        description="Partiler stok kabul belgesine bağlanır; raf yerleştirmesi yeni stok değeri yaratmaz."
      />
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Stat label="Parti">{lots.data?.records.length ?? '—'}</Stat>
        <Stat label="Raf">{bins.data?.records.length ?? '—'}</Stat>
        <Stat label="Yerleştirme">{placements.data?.records.length ?? '—'}</Stat>
      </div>
      <SegmentedTabs
        className="mb-4"
        items={[
          { key: 'lots', label: 'Partiler' },
          { key: 'bins', label: 'Raflar' },
          { key: 'placements', label: 'Yerleştirmeler' },
        ]}
        value={selection}
        onChange={setSelection}
      />
      <Records
        title="Depo kayıtları"
        loading={
          (selection === 'bins' ? bins : selection === 'placements' ? placements : lots).isPending
        }
        error={(selection === 'bins' ? bins : selection === 'placements' ? placements : lots).error}
        rows={(
          (selection === 'bins' ? bins : selection === 'placements' ? placements : lots).data
            ?.records ?? []
        ).map((r) => ({
          ...r,
          name: r.itemName ?? lookups.data?.items.find((i) => i.id === r.itemId)?.name ?? r.name,
          remainingQty: r.remainingQty ?? r.quantity,
          warehouseName:
            r.warehouseName ?? lookups.data?.warehouses.find((w) => w.id === r.warehouseId)?.name,
          lotCode: lots.data?.records.find((l) => l.id === r.lotId)?.code,
          binCode: bins.data?.records.find((b) => b.id === r.binId)?.code,
        }))}
        columns={[
          { key: 'code', label: 'Kod' },
          { key: 'name', label: 'Ad' },
          ...(selection === 'placements'
            ? [
                { key: 'lotCode', label: 'Parti' },
                { key: 'binCode', label: 'Raf' },
              ]
            : [{ key: 'warehouseName', label: 'Depo' }]),
          {
            key: selection === 'bins' ? 'capacity' : 'quantity',
            label:
              selection === 'bins'
                ? 'Kapasite'
                : selection === 'placements'
                  ? 'Yerleştirilen miktar'
                  : 'Başlangıç miktarı',
          },
          ...(selection === 'lots' ? [{ key: 'remainingQty', label: 'Kalan miktar' }] : []),
          { key: 'status', label: 'Durum' },
        ]}
        actions={(r) =>
          selection === 'lots' &&
          can('manufacturing.quality.approve') &&
          can('inventory.wms.manage') ? (
            <OperationForm
              title="Kalite kararı"
              fields={[
                numberField('releasedQty', 'Serbest miktar', String(r.releasedQty ?? '0')),
                numberField('damagedQty', 'Hasarlı miktar', String(r.damagedQty ?? '0')),
                textField('reason', 'Kalite karar nedeni', true),
              ]}
              submit={(v) =>
                save(`/api/wms/lots/${r.id}/quality-quantity`, {
                  releasedQty: v.releasedQty,
                  damagedQty: v.damagedQty,
                  reason: v.reason,
                  requestKey: v._requestKey,
                })
              }
            />
          ) : null
        }
      />
      {can('inventory.wms.manage') && (
        <>
          {selection === 'bins' && (
            <OperationForm
              title="Raf ekle"
              fields={[
                textField('code', 'Raf kodu'),
                textField('name', 'Raf adı'),
                selectField(
                  'warehouseId',
                  'Depo',
                  options(lookups.data?.warehouses ?? [], (r) => String(r.name)),
                ),
                numberField('capacity', 'Kapasite', '0'),
              ]}
              submit={(v) => save('/api/wms/bins', v)}
            />
          )}
          {selection === 'lots' && (
            <OperationForm
              title="Kabul partisi ekle"
              fields={[
                textField('code', 'Parti kodu'),
                selectField(
                  'itemId',
                  'Stok',
                  options(lookups.data?.items ?? [], (r) => String(r.name)),
                ),
                selectField(
                  'warehouseId',
                  'Depo',
                  options(lookups.data?.warehouses ?? [], (r) => String(r.name)),
                ),
                selectField(
                  'sourceDocumentId',
                  'Stok kabul belgesi',
                  options(lookups.data?.documents ?? [], (r) => String(r.code)),
                ),
                numberField('quantity', 'Miktar'),
              ]}
              submit={(v) => save('/api/wms/lots', v)}
            />
          )}
          {selection === 'placements' && (
            <OperationForm
              title="Rafa yerleştir"
              fields={[
                selectField(
                  'lotId',
                  'Parti',
                  options(lots.data?.records ?? [], (r) => String(r.code)),
                ),
                selectField(
                  'binId',
                  'Raf',
                  options(bins.data?.records ?? [], (r) => String(r.code)),
                ),
                numberField('quantity', 'Miktar'),
              ]}
              submit={(v) => save('/api/wms/placements', { ...v, requestKey: v._requestKey })}
            />
          )}
        </>
      )}
    </>
  );
}

export function ManufacturingLogisticsPage() {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const records = useCQuery<{ records: Row[] }>(
    ['logistics', 'shipments'],
    '/api/logistics/shipments',
  );
  const lookups = useCQuery<{
    notes: (Row & { warehouseId: string; lines: { itemId: string; quantity: string }[] })[];
  }>(['logistics', 'lookups'], '/api/logistics/lookups');
  const save = async (p: string, b: unknown) => {
    await call(p, { method: 'POST', body: b });
    await queries.invalidateQueries();
  };
  return (
    <>
      <PageHeader title="Paketleme ve sevkiyat" />
      <Records
        title="Sevkiyatlar"
        loading={records.isPending}
        error={records.error}
        rows={records.data?.records ?? []}
        columns={[
          { key: 'code', label: 'Kayıt' },
          { key: 'carrier', label: 'Taşıyıcı' },
          { key: 'trackingNo', label: 'Takip no' },
          { key: 'status', label: 'Durum' },
        ]}
        actions={(r) =>
          can('sales.logistics.manage') && ['packed', 'dispatched'].includes(r.status ?? '') ? (
            <OperationForm
              title="Sevkiyat durumu"
              fields={[
                selectField('action', 'İşlem', [
                  ...(r.status === 'packed'
                    ? [{ value: 'publish', label: 'Sevk et' }]
                    : [{ value: 'deliver', label: 'Teslim edildi' }]),
                ]),
              ]}
              submit={(v) =>
                save(`/api/logistics/shipments/${r.id}/actions`, {
                  ...v,
                  requestKey: v._requestKey,
                })
              }
            />
          ) : null
        }
      />
      {can('sales.logistics.manage') && (
        <OperationForm
          title="İrsaliyeyi paketle"
          fields={[
            selectField(
              'deliveryNoteId',
              'Satış irsaliyesi',
              options(lookups.data?.notes ?? [], (r) => String(r.code)),
            ),
            textField('carrier', 'Taşıyıcı'),
            textField('vehicle', 'Araç'),
            textField('trackingNo', 'Takip no'),
            textField('packageCode', 'Koli barkodu'),
          ]}
          submit={(v) => {
            const n = lookups.data?.notes.find((n) => n.id === v.deliveryNoteId);
            return save('/api/logistics/shipments', {
              deliveryNoteId: v.deliveryNoteId,
              warehouseId: n?.warehouseId,
              carrier: v.carrier,
              vehicle: v.vehicle,
              trackingNo: v.trackingNo,
              packages: [{ code: v.packageCode, type: 'box', lines: n?.lines }],
            });
          }}
        />
      )}
    </>
  );
}

export function ManufacturingIntegrationsPage() {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const records = useCQuery<{ records: Row[] }>(
    ['integrations', 'connections'],
    '/api/integrations/connections',
  );
  const events = useCQuery<{ records: Row[] }>(
    ['integrations', 'events'],
    '/api/integrations/events',
  );
  const lookups = useCQuery<{ parties: Row[]; warehouses: Row[] }>(
    ['integrations', 'lookups'],
    '/api/integrations/lookups',
  );
  const save = async (p: string, b: unknown) => {
    await call(p, { method: 'POST', body: b });
    await queries.invalidateQueries();
  };
  const webhookFields = (r?: Row) => [
    {
      ...textField('webhookSecret', 'Shopify bildirim imza anahtarı'),
      type: 'password' as const,
      required: false,
      hint: 'Boş bırakıldığında mevcut imza sırrı korunur.',
    },
    {
      ...selectField(
        'webhookPartyId',
        'Bildirim müşterisi eşlemesi',
        options(lookups.data?.parties ?? [], (p) => String(p.name)),
      ),
      required: false,
      value: String(r?.webhookPartyId ?? ''),
    },
    {
      ...selectField(
        'webhookWarehouseId',
        'Bildirim sipariş deposu',
        options(lookups.data?.warehouses ?? [], (p) => String(p.name)),
      ),
      required: false,
      value: String(r?.webhookWarehouseId ?? ''),
    },
    {
      ...textField('shippingSku', 'Kargo hizmeti ürün kodu'),
      required: false,
      value: String(r?.shippingSku ?? ''),
    },
  ];
  return (
    <>
      <PageHeader
        title="Entegrasyonlar"
        description="Bağlantı bilgileri girilene kadar kanallar bağlı değil görünür. Demo şirketi dış sistemlere veri göndermez."
      />
      <ChannelExecutionPanel connections={records.data?.records ?? []} />
      <Records
        title="Bağlantılar"
        loading={records.isPending}
        error={records.error}
        rows={records.data?.records ?? []}
        columns={[
          { key: 'name', label: 'Ad' },
          { key: 'provider', label: 'Sağlayıcı' },
          { key: 'status', label: 'Durum' },
        ]}
        actions={(r) =>
          can('core.integrations.manage') ? (
            <>
              <OperationForm
                title={`${r.name} · bağlantıyı düzenle`}
                fields={[
                  { ...textField('name', 'Ad'), value: r.name },
                  {
                    ...textField('shop', 'Shopify mağaza alanı'),
                    value: String(r.shop ?? ''),
                    required: false,
                  },
                  {
                    ...textField('endpoint', 'Servis adresi'),
                    value: String(r.endpoint ?? ''),
                    required: false,
                  },
                  ...webhookFields(r),
                  {
                    ...textField('token', 'Yeni erişim anahtarı'),
                    type: 'password',
                    required: false,
                    hint: 'Boş bırakıldığında mevcut anahtar korunur.',
                  },
                ]}
                submit={async (v) => {
                  await call(`/api/integrations/connections/${r.id}`, {
                    method: 'PUT',
                    body: {
                      provider: r.provider,
                      name: v.name,
                      shop: v.shop || undefined,
                      endpoint: v.endpoint || undefined,
                      token: v.token || undefined,
                      webhookSecret: v.webhookSecret || undefined,
                      webhookPartyId: v.webhookPartyId || undefined,
                      webhookWarehouseId: v.webhookWarehouseId || undefined,
                      shippingSku: v.shippingSku || undefined,
                    },
                  });
                  await queries.invalidateQueries();
                }}
              />
              {['shopify', 'ticimax'].includes(String(r.provider)) && (
                <OperationForm
                  title={`${r.name} · siparişleri al`}
                  fields={[
                    selectField(
                      'partyId',
                      'Müşteri eşlemesi',
                      options(lookups.data?.parties ?? [], (p) => String(p.name)),
                    ),
                    selectField(
                      'warehouseId',
                      'Depo',
                      options(lookups.data?.warehouses ?? [], (p) => String(p.name)),
                    ),
                    { ...textField('cursor', 'Sonraki sayfa anahtarı'), required: false },
                    ...(r.provider === 'ticimax'
                      ? [
                          textField('priceField', 'Fiyat alanı'),
                          selectField('priceBasis', 'Fiyat türü', [
                            { value: 'unit', label: 'Birim fiyat' },
                            { value: 'line', label: 'Satır tutarı' },
                          ]),
                        ]
                      : []),
                  ]}
                  submit={(v) =>
                    save(`/api/integrations/connections/${r.id}/pull-orders`, {
                      ...v,
                      cursor: v.cursor || undefined,
                    })
                  }
                  action="Kuyruğa al"
                />
              )}
            </>
          ) : null
        }
      />
      {can('core.integrations.manage') && (
        <OperationForm
          title="Bağlantı ekle"
          fields={[
            textField('name', 'Ad'),
            selectField('provider', 'Sağlayıcı', [
              { value: 'shopify', label: 'Shopify' },
              { value: 'ticimax', label: 'Ticimax' },
              { value: 'bank', label: 'Banka' },
              { value: 'pdks', label: 'PDKS' },
              { value: 'edocument', label: 'E-belge' },
            ]),
            { ...textField('shop', 'Shopify mağaza alanı'), required: false },
            { ...textField('endpoint', 'Servis adresi'), required: false },
            { ...textField('token', 'Erişim anahtarı'), type: 'password', required: false },
            ...webhookFields(),
          ]}
          submit={(v) =>
            save('/api/integrations/connections', {
              ...v,
              shop: v.shop || undefined,
              endpoint: v.endpoint || undefined,
              token: v.token || undefined,
              webhookSecret: v.webhookSecret || undefined,
              webhookPartyId: v.webhookPartyId || undefined,
              webhookWarehouseId: v.webhookWarehouseId || undefined,
              shippingSku: v.shippingSku || undefined,
            })
          }
        />
      )}
      <Records
        title="İşlem kuyruğu"
        rows={events.data?.records ?? []}
        columns={[
          { key: 'code', label: 'Kaynak' },
          { key: 'status', label: 'Durum' },
          { key: 'error', label: 'Sonuç' },
          { key: 'attempts', label: 'Deneme' },
          { key: 'retryAfter', label: 'Sonraki deneme' },
        ]}
        actions={(r) =>
          can('core.integrations.manage') &&
          can('invoices.manage') &&
          ['queued', 'failed', 'dead_letter'].includes(r.status ?? '') ? (
            <OperationForm
              title="Siparişi yeniden dene"
              fields={[textField('reason', 'Tekrar nedeni', true)]}
              submit={(v) =>
                save('/api/integrations/events/' + r.id + '/retry', {
                  force: r.status === 'dead_letter',
                  reason: v.reason,
                })
              }
            />
          ) : null
        }
      />
    </>
  );
}
