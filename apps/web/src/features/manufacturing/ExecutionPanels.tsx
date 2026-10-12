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
import { Callout, ErrorState } from '../../components/ui/Feedback';
import { displayDateTime, displayQuantity } from '../../lib/presentation';
import { moneyIn } from '../../lib/format';
import { useCompany } from '../../lib/session';
import { errorMessage } from '../../lib/errors';
type Ref = { id: string; name?: string; code?: string };
const reason = textField('reason', 'İşlem nedeni', true),
  cmd = (v: Values) => ({ requestKey: v._requestKey, reason: v.reason });

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
    status: string;
    lastCheck?: { adaQuantity: number; channelQuantity: number; difference: number; at: string };
    health?: { ok: boolean; issues: string[]; lastErrorKind: string | null };
  };
  const ISSUE: Record<string, string> = {
    paused: 'Duraklatıldı',
    retired: 'Emekli',
    item_inactive: 'Ürün pasif',
    warehouse_inactive: 'Depo pasif',
    connection_not_configured: 'Bağlantı yapılandırılmamış',
    last_send_failed: 'Son gönderim başarısız',
    stock_difference: 'Stok farkı var',
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
      errorHint?: string;
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
        loading={mappings.isPending} onRetry={() => void mappings.refetch()} retrying={mappings.isFetching}
        error={mappings.error}
        columns={[
          {
            label: 'Kanal',
            render: (r) => connections.find((c) => c.id === r.connectionId)?.name ?? 'Kanal',
          },
          { label: 'Ada ürünü', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Kanal ürün kodu', render: (r) => r.channelSku },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
          {
            label: 'Sağlık',
            render: (r) => (r.health?.ok ? 'Sorun yok' : (r.health?.issues ?? []).map((i) => ISSUE[i] ?? i).join(', ')),
          },
          {
            label: 'Son kontrol (Ada / kanal)',
            render: (r) => (r.lastCheck ? `${r.lastCheck.adaQuantity} / ${r.lastCheck.channelQuantity}${r.lastCheck.difference ? ` (fark ${r.lastCheck.difference})` : ''}` : '—'),
          },
        ]}
        action={
          can('core.integrations.manage')
            ? (r) =>
                r.status !== 'retired' && (
                  <div className="flex flex-wrap gap-1">
                    {r.status === 'active' && (
                      <OperationForm
                        title="Kanal stok farkını kontrol et"
                        description="Kanaldaki miktar okunur ve Ada'nın kullanılabilir miktarıyla karşılaştırılır. Seçerseniz Ada miktarı yayın kuyruğuna alınır."
                        fields={[selectField('queue', 'Fark varsa', [{ value: 'no', label: 'Yalnız kontrol et' }, { value: 'yes', label: 'Ada miktarını kuyruğa al' }])]}
                        submit={(v) => save(`/api/integrations/channel-mappings/${r.id}/check`, { requestKey: crypto.randomUUID(), queue: v.queue === 'yes' })}
                      />
                    )}
                    <OperationForm
                      title="Eşleme durumunu değiştir"
                      description="Duraklatılan eşleme stok yayını yapmaz. Emekli eşleme yeniden açılamaz."
                      fields={[
                        selectField(
                          'status',
                          'Yeni durum',
                          [
                            { value: 'active', label: 'Etkin' },
                            { value: 'paused', label: 'Duraklat' },
                            { value: 'retired', label: 'Emekliye ayır' },
                          ].filter((o) => o.value !== r.status),
                        ),
                        reason,
                      ]}
                      submit={(v) => save(`/api/integrations/channel-mappings/${r.id}/status`, { status: v.status, reason: v.reason })}
                    />
                  </div>
                )
            : undefined
        }
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
        loading={outbox.isPending} onRetry={() => void outbox.refetch()} retrying={outbox.isFetching}
        error={outbox.error}
        columns={[
          { label: 'Stok', render: (r) => r.itemName },
          { label: 'Depo', render: (r) => r.warehouseName },
          { label: 'Kullanılabilir adet', numeric: true, render: (r) => r.quantity },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
          { label: 'Deneme', numeric: true, render: (r) => r.attempts },
          { label: 'Sonraki deneme', render: (r) => displayDateTime(r.retryAfter) },
          { label: 'Sonuç', render: (r) => (r.error ? `${r.error}${r.errorHint ? ` — ${r.errorHint}` : ''}` : '—') },
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
    variance?: {
      material: { standard: string; actual: string; price: string; usage: string; total: string; traceDifference: string; items: { itemId: string; code: string | null; name: string | null; standardQty: string; standardUnitCost: string; actualQty: string; actualValue: string; priceVariance: string; usageVariance: string }[] };
      labor: { operations: { operationKey: string; name: string; standardMinutes: string; actualMinutes: string; minuteVariance: string; hourlyCost: string | null; efficiencyVariance: string | null }[]; minuteVariance: string; efficiencyVariance: string | null };
      other: { kind: string; actual: string }[];
    };
  }>(
    ['manufacturing', 'cost-close', orderId],
    `/api/manufacturing/production/orders/${orderId}/cost-close`,
    { enabled: can('manufacturing.costs.read') },
  );
  if (!can('manufacturing.costs.read')) return null;
  return (
    <section className="my-6 space-y-4">
      <h2 className="text-subheading">Maliyet kapanış kontrolü</h2>
      {report.error && <ErrorState description={errorMessage(report.error)} onRetry={() => void report.refetch()} retrying={report.isFetching} />}
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
          {report.data.variance && (
            <details className="text-sm" open>
              <summary className="cursor-pointer py-1 font-medium">Sapma bileşenleri</summary>
              <p className="my-2 text-xs text-muted">
                Fiyat sapması = (gerçek birim − tahmini birim) × gerçek miktar; miktar sapması = (gerçek − tahmini miktar) × tahmini birim. Gerçek değer üretim çıkış/iade belgelerinden;
                maliyet izi farkı {moneyIn(report.data.variance.material.traceDifference, company.baseCurrency)}. Fason ve genel gider için tahmin tutulmaz.
              </p>
              <Records
                rows={report.data.variance.material.items.map((m) => ({ id: m.itemId, ...m }))}
                columns={[
                  { label: 'Malzeme', render: (r) => `${r.code ?? ''} ${r.name ?? ''}`.trim() },
                  { label: 'Tahmini miktar', numeric: true, render: (r) => r.standardQty },
                  { label: 'Gerçek miktar', numeric: true, render: (r) => r.actualQty },
                  { label: 'Fiyat sapması', numeric: true, render: (r) => moneyIn(r.priceVariance, company.baseCurrency) },
                  { label: 'Miktar sapması', numeric: true, render: (r) => moneyIn(r.usageVariance, company.baseCurrency) },
                ]}
              />
              <Records
                rows={report.data.variance.labor.operations.map((o) => ({ id: o.operationKey, ...o }))}
                columns={[
                  { label: 'Operasyon', render: (r) => r.name },
                  { label: 'Tahmini dk', numeric: true, render: (r) => r.standardMinutes },
                  { label: 'Gerçek dk', numeric: true, render: (r) => r.actualMinutes },
                  { label: 'Dakika farkı', numeric: true, render: (r) => r.minuteVariance },
                  { label: 'Verimlilik sapması', numeric: true, render: (r) => (r.efficiencyVariance === null ? 'Saatlik maliyet yok' : moneyIn(r.efficiencyVariance, company.baseCurrency)) },
                ]}
              />
              {report.data.variance.other.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  Diğer gerçekleşen: {report.data.variance.other.map((o) => `${o.kind} ${moneyIn(o.actual, company.baseCurrency)}`).join(' · ')}
                </p>
              )}
            </details>
          )}
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
        loading={data.isPending} onRetry={() => void data.refetch()} retrying={data.isFetching}
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
