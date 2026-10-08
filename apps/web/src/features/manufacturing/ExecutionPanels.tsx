import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@erp/shared';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import {
  OperationForm,
  Records,
  Status,
  numberField,
  textField,
  selectField,
  options,
  type Values,
} from '../leather/common';
import { Callout } from '../../components/ui/Feedback';
import { displayDateTime, displayQuantity } from '../../lib/presentation';
import { moneyIn } from '../../lib/format';
import { useCompany } from '../../lib/session';
import { errorMessage } from '../../lib/errors';
type Ref = { id: string; name?: string; code?: string };
const reason = textField('reason', 'İşlem nedeni', true),
  cmd = (v: Values) => ({ requestKey: v._requestKey, reason: v.reason });

export function PlanningExecutionPanel() {
  const company = useCompany();
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const resources = useCQuery<{ records: Ref[] }>(
    ['manufacturing', 'resources'],
    '/api/manufacturing/resources',
  );
  const schedules = useCQuery<{
    records: (Ref & {
      version?: number;
      parentId?: string;
      reason?: string;
      previewOnly?: boolean;
      scenarioCost?: number | null;
      jobs?: { minutes: number }[];
      differences?: { previousEnd?: string; end: string }[];
    })[];
  }>(['manufacturing', 'schedules'], '/api/manufacturing/planning/schedules');
  const from = todayIso() + 'T00:00:00+03:00',
    to = new Date(Date.parse(from) + 7 * 86400000).toISOString();
  const capacity = useCQuery<{
    resources: (Ref & {
      capacityMinutes: number;
      loadMinutes: number;
      loadPct: number | null;
      noCalendar: boolean;
    })[];
  }>(
    ['manufacturing', 'capacity', from],
    `/api/manufacturing/planning/capacity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <section className="my-6 space-y-5">
      <h2 className="text-subheading">Net kapasite ve darboğazlar · Önümüzdeki 7 gün</h2>
      <Records
        rows={capacity.data?.resources ?? []}
        loading={capacity.isPending}
        error={capacity.error}
        columns={[
          { label: 'Kaynak', render: (r) => r.name },
          { label: 'Net kapasite (dk)', numeric: true, render: (r) => r.capacityMinutes },
          { label: 'Yayımlanmış yük (dk)', numeric: true, render: (r) => r.loadMinutes },
          { label: 'Yük oranı (%)', numeric: true, render: (r) => displayQuantity(r.loadPct) },
          {
            label: 'Takvim',
            render: (r) => (r.noCalendar ? 'Çalışma takvimi yok' : 'Vardiya ve istisnalardan'),
          },
        ]}
      />
      <Records
        rows={schedules.data?.records ?? []}
        columns={[
          { label: 'Plan', render: (r) => r.code },
          { label: 'Sürüm', numeric: true, render: (r) => r.version ?? 1 },
          { label: 'Değişiklik nedeni', render: (r) => r.reason ?? 'İlk plan' },
          { label: 'Varsayım', render: (r) => (r.previewOnly ? 'Simülasyon' : 'Gerçek takvim') },
          {
            label: 'İş yükü (dk)',
            numeric: true,
            render: (r) => r.jobs?.reduce((s, j) => s + Number(j.minutes), 0) ?? '—',
          },
          {
            label: 'Termin farkı (dk)',
            numeric: true,
            render: (r) =>
              r.differences?.length
                ? displayQuantity(
                    Math.max(
                      ...r.differences.map((d) =>
                        d.previousEnd ? (Date.parse(d.end) - Date.parse(d.previousEnd)) / 60000 : 0,
                      ),
                    ),
                  )
                : '—',
          },
          {
            label: 'Fiyatı tanımlı kaynaklar (tahmin)',
            numeric: true,
            render: (r) =>
              r.scenarioCost == null
                ? 'Tanımlı değil'
                : moneyIn(String(r.scenarioCost), company.baseCurrency),
          },
        ]}
      />
      {can('manufacturing.planning.manage') && (
        <>
          <OperationForm
            title="Tekrar eden vardiya ve tatiller"
            fields={[
              selectField(
                'resourceId',
                'Kaynak',
                options(resources.data?.records ?? [], (r) => r.name ?? 'Kaynak'),
              ),
              { name: 'from', label: 'İlk gün', type: 'date', required: true, value: todayIso() },
              { name: 'to', label: 'Son gün', type: 'date', required: true, value: todayIso() },
              textField(
                'weekdays',
                'Hafta günleri (1=Pazartesi, 0=Pazar)',
                true,
                'Örnek: 1,2,3,4,5',
              ),
              {
                name: 'startTime',
                label: 'Vardiya başlangıcı',
                type: 'time',
                required: true,
                value: '08:00',
              },
              {
                name: 'endTime',
                label: 'Vardiya bitişi',
                type: 'time',
                required: true,
                value: '17:00',
              },
              textField(
                'holidays',
                'Tatil tarihleri',
                false,
                'Yıl-ay-gün biçiminde virgülle ayırın. Örnek: 2026-10-29, 2027-01-01',
              ),
              reason,
            ]}
            submit={(v) =>
              save('/api/manufacturing/planning/calendar-template', {
                ...cmd(v),
                resourceId: v.resourceId,
                from: v.from,
                to: v.to,
                weekdays: v.weekdays.split(',').map((x) => Number(x.trim())),
                startTime: v.startTime,
                endTime: v.endTime,
                utcOffset: '+03:00',
                holidays: v.holidays ? v.holidays.split(',').map((x) => x.trim()) : [],
              })
            }
          />
          <OperationForm
            title="Planı yeni sürüm / simülasyon olarak çoğalt"
            fields={[
              selectField(
                'parentId',
                'Kaynak plan',
                options(schedules.data?.records ?? [], (r) => r.code ?? 'Plan'),
              ),
              selectField(
                'resourceId',
                'Varsayım kaynağı (isteğe bağlı)',
                options(resources.data?.records ?? [], (r) => r.name ?? 'Kaynak'),
                false,
              ),
              { name: 'date', label: 'Varsayım günü', type: 'date', value: todayIso() },
              { name: 'start', label: 'Varsayım başlangıcı', type: 'time', value: '08:00' },
              { name: 'end', label: 'Varsayım bitişi', type: 'time', value: '10:00' },
              selectField('available', 'Varsayım', [
                { value: 'no', label: 'Kaynak çalışmayacak' },
                { value: 'yes', label: 'Ek çalışma aralığı' },
              ]),
              { ...numberField('capacity', 'Varsayılan eşzamanlı kapasite'), required: false },
              { ...numberField('speedFactor', 'Varsayılan hız çarpanı', '1'), min: 0.1 },
              { ...numberField('hourlyCost', 'Varsayılan saat maliyeti'), required: false },
              reason,
            ]}
            submit={(v) =>
              save('/api/manufacturing/planning/scenarios', {
                ...cmd(v),
                parentId: v.parentId,
                calendarOverrides: v.resourceId
                  ? [
                      {
                        resourceId: v.resourceId,
                        start: new Date(v.date + 'T' + v.start + ':00+03:00').toISOString(),
                        end: new Date(v.date + 'T' + v.end + ':00+03:00').toISOString(),
                        available: v.available === 'yes',
                      },
                    ]
                  : [],
                resourceOverrides:
                  v.resourceId && (v.capacity || v.hourlyCost || Number(v.speedFactor) !== 1)
                    ? [
                        {
                          resourceId: v.resourceId,
                          capacity: v.capacity ? Number(v.capacity) : undefined,
                          speedFactor: Number(v.speedFactor),
                          hourlyCost: v.hourlyCost || undefined,
                        },
                      ]
                    : [],
              })
            }
          />
          <Callout>
            Simülasyon takvimi, kaynak hızını veya muhasebe değerini değiştirmez. Varsayımlı plan
            karşılaştırma içindir; yayım için gerçek kapasiteyle yeni plan hazırlayın.
          </Callout>
        </>
      )}
    </section>
  );
}

export function ChannelExecutionPanel({
  connections,
}: {
  connections: (Ref & { provider?: string })[];
}) {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  type Mapping = Ref & {
    itemName: string;
    warehouseName: string;
    channelSku: string;
    connectionId: string;
  };
  const mappings = useCQuery<{ records: Mapping[]; items: Ref[]; warehouses: Ref[] }>(
    ['integrations', 'mappings'],
    '/api/integrations/channel-mappings',
  );
  const outbox = useCQuery<{
    records: (Ref & {
      itemName: string;
      warehouseName: string;
      quantity: number;
      status: string;
      attempts: number;
      error?: string;
      retryAfter?: string;
    })[];
  }>(['integrations', 'outbox'], '/api/integrations/inventory-outbox');
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <section className="my-6 space-y-5">
      <h2 className="text-subheading">Ada ana stok kaynağı · Kanal eşlemeleri</h2>
      <Callout>
        Stok, rezervasyon ve kalite hareketleri kullanılabilir miktarı yayın kuyruğuna yazar. Dış
        gönderim bağlantı bilgileriyle çalışır; demo şirketinde kapalıdır.
      </Callout>
      <Records
        rows={mappings.data?.records ?? []}
        loading={mappings.isPending}
        error={mappings.error}
        columns={[
          {
            label: 'Kanal',
            render: (r) => connections.find((c) => c.id === r.connectionId)?.name ?? 'Kanal',
          },
          { label: 'Ada ürünü', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Kanal ürün kodu', render: (r) => r.channelSku },
        ]}
      />
      {can('core.integrations.manage') && (
        <OperationForm
          title="Kanal ürünü ve depo eşlemesi"
          fields={[
            selectField(
              'connectionId',
              'Kanal',
              options(
                connections.filter((c) => ['shopify', 'ticimax'].includes(c.provider ?? '')),
                (c) => c.name ?? 'Kanal',
              ),
            ),
            selectField(
              'itemId',
              'Ada ürünü',
              options(mappings.data?.items ?? [], (c) => `${c.code} · ${c.name}`),
            ),
            selectField(
              'warehouseId',
              'Ada deposu',
              options(mappings.data?.warehouses ?? [], (c) => c.name ?? 'Depo'),
            ),
            textField('channelSku', 'Kanal ürün kodu'),
            textField('inventoryItemId', 'Shopify stok kaydı kimliği', false),
            textField('locationId', 'Shopify depo kimliği', false),
            { ...numberField('variantId', 'Ticimax varyasyon kimliği'), required: false },
            reason,
          ]}
          submit={(v) =>
            save('/api/integrations/channel-mappings', {
              ...cmd(v),
              connectionId: v.connectionId,
              itemId: v.itemId,
              warehouseId: v.warehouseId,
              channelSku: v.channelSku,
              inventoryItemId: v.inventoryItemId || undefined,
              locationId: v.locationId || undefined,
              variantId: v.variantId ? Number(v.variantId) : undefined,
            })
          }
        />
      )}
      <h2 className="text-subheading">Stok yayın geçmişi</h2>
      <Records
        rows={outbox.data?.records ?? []}
        loading={outbox.isPending}
        error={outbox.error}
        columns={[
          { label: 'Stok', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Kullanılabilir adet', numeric: true, render: (r) => r.quantity },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
          { label: 'Deneme', numeric: true, render: (r) => r.attempts },
          { label: 'Sonraki deneme', render: (r) => displayDateTime(r.retryAfter) },
          { label: 'Sonuç', render: (r) => r.error ?? '—' },
        ]}
        action={
          can('core.integrations.manage')
            ? (r) =>
                !['processed', 'superseded'].includes(r.status) && (
                  <OperationForm
                    title="Stok yayınını yeniden dene"
                    fields={[reason]}
                    submit={(v) =>
                      save(`/api/integrations/inventory-outbox/${r.id}/retry`, {
                        force: r.status === 'dead_letter',
                        reason: v.reason,
                      })
                    }
                  />
                )
            : undefined
        }
      />
    </section>
  );
}

export function ProductionCostClosePanel({ orderId }: { orderId: string }) {
  const can = useCan(),
    company = useCompany();
  const report = useCQuery<{
    canClose: boolean;
    reasons: string[];
    wipValue: string;
    actualValue: string;
    materialStandardValue: string;
    materialActualValue: string;
    materialVariance: string;
    standardSource: string;
  }>(
    ['manufacturing', 'cost-close', orderId],
    `/api/manufacturing/production/orders/${orderId}/cost-close`,
    { enabled: can('manufacturing.costs.read') },
  );
  if (!can('manufacturing.costs.read')) return null;
  return (
    <section className="my-6 space-y-4">
      <h2 className="text-subheading">Maliyet kapanış kontrolü</h2>
      {report.error && <Callout tone="danger">{errorMessage(report.error)}</Callout>}
      {report.data && (
        <>
          <Callout tone={report.data.canClose ? 'info' : 'warning'}>
            {report.data.canClose ? 'Maliyet kapanışına uygun' : report.data.reasons.join(' · ')}
          </Callout>
          <p className="text-sm text-muted">
            Malzeme tahmini yeni emirlerde açılış anında sabitlenir. Eski emirlerde güncel ortalama
            kaynak olarak gösterilir. Gerçekleşen tutar, geç farkları içeren maliyet pay izinden
            hesaplanır; sapma yalnız malzeme bileşenini karşılaştırır.
          </p>
          <Records
            rows={[{ id: orderId, ...report.data }]}
            columns={[
              {
                label: 'Devam eden üretim maliyeti',
                numeric: true,
                render: (r) => moneyIn(r.wipValue, company.baseCurrency),
              },
              {
                label: 'Gerçekleşen toplam',
                numeric: true,
                render: (r) => moneyIn(r.actualValue, company.baseCurrency),
              },
              {
                label: 'Malzeme tahmini',
                numeric: true,
                render: (r) => moneyIn(r.materialStandardValue, company.baseCurrency),
              },
              {
                label: 'Gerçek malzeme',
                numeric: true,
                render: (r) => moneyIn(r.materialActualValue, company.baseCurrency),
              },
              {
                label: 'Malzeme sapması',
                numeric: true,
                render: (r) => moneyIn(r.materialVariance, company.baseCurrency),
              },
              {
                label: 'Tahmin kaynağı',
                render: (r) =>
                  r.standardSource === 'order_creation_sku_average_material_only'
                    ? 'Emir açılışında ürün maliyet ortalaması'
                    : 'Eski emir · güncel ürün maliyet ortalaması',
              },
            ]}
          />
        </>
      )}
    </section>
  );
}

export function ReworkExecutionPanel({
  orderId,
  operations,
  resources,
  quality = false,
  prefix = 'manufacturing',
}: {
  quality?: boolean;
  prefix?: 'manufacturing' | 'leather';
  orderId: string;
  operations: { key: string; name: string }[];
  resources: Ref[];
}) {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const data = useCQuery<{
    records: (Ref & {
      orderId: string;
      status: string;
      quantity: string;
      defectCode: string;
      recheckStatus?: string;
      operationKey: string;
    })[];
    checks: (Ref & { orderId: string; orderCode: string; reworkQty: string })[];
  }>([prefix, 'rework', quality], `/api/${prefix}/${quality ? 'quality/' : ''}rework`);
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <section className="my-6 space-y-4">
      <h2 className="text-subheading">Yeniden işleme ve tekrar kalite</h2>
      <Records
        rows={(data.data?.records ?? []).filter((r) => r.orderId === orderId)}
        loading={data.isPending}
        error={data.error}
        columns={[
          { label: 'İş', render: (r) => r.code },
          { label: 'Hata', render: (r) => r.defectCode },
          {
            label: 'Hedef operasyon',
            render: (r) => operations.find((o) => o.key === r.operationKey)?.name ?? 'Operasyon',
          },
          { label: 'Adet', numeric: true, render: (r) => r.quantity },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
        ]}
        action={
          !quality && can('manufacturing.production.manage')
            ? (r) =>
                (r.status === 'planned' || r.recheckStatus === 'rejected') && (
                  <OperationForm
                    title="Yeniden işleme sonucu"
                    fields={[
                      selectField(
                        'resourceId',
                        'Çalışılan kaynak',
                        options(resources, (r) => r.name ?? 'Kaynak'),
                      ),
                      numberField('minutes', 'Gerçek süre (dk)'),
                      numberField('passedQty', 'Kabul edilen adet'),
                      numberField('scrapQty', 'Hurda', '0'),
                      numberField('secondQty', 'İkinci kalite', '0'),
                      reason,
                    ]}
                    submit={(v) =>
                      save(`/api/manufacturing/rework/${r.id}/result`, {
                        ...cmd(v),
                        date: todayIso(),
                        resourceId: v.resourceId,
                        minutes: v.minutes,
                        passedQty: v.passedQty,
                        scrapQty: v.scrapQty,
                        secondQty: v.secondQty,
                      })
                    }
                  />
                )
            : undefined
        }
      />
      {can(
        `${prefix}.quality.approve` as 'manufacturing.quality.approve' | 'leather.quality.approve',
      ) && (
        <OperationForm
          title="Yeniden işleme işi aç"
          fields={[
            selectField(
              'qualityCheckId',
              'Kaynak kalite kontrolü',
              options(
                (data.data?.checks ?? []).filter((c) => c.orderId === orderId),
                (r) => `${r.orderCode} · ${displayQuantity(r.reworkQty)} adet`,
              ),
            ),
            selectField(
              'operationKey',
              'Geri dönüş operasyonu',
              operations.map((o) => ({ value: o.key, label: o.name })),
            ),
            numberField('quantity', 'İşlenecek adet'),
            textField('defectCode', 'Hata kodu'),
            reason,
          ]}
          submit={(v) =>
            save(`/api/${prefix}/rework`, {
              ...cmd(v),
              orderId,
              qualityCheckId: v.qualityCheckId,
              operationKey: v.operationKey,
              quantity: v.quantity,
              defectCode: v.defectCode,
            })
          }
        />
      )}
    </section>
  );
}
