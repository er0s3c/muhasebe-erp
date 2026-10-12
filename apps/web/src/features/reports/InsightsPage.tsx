import { useState } from 'react';
import { Plus, Pencil, Archive, RefreshCw, ChartNoAxesCombined, Users, Lock } from 'lucide-react';
import {
  todayIso,
  insightConfigSchema,
  type InsightConfig,
  type SavedInsight,
  type InsightResult,
  type InsightTable,
} from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input, Select } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Th, Td, Tr } from '../../components/ui/Table';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading, EmptyState } from '../../components/ui/Feedback';
import { useCQuery, useCMutation, useCan } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { useToast } from '../../components/ui/Toast';
import { formatDateTR, moneyIn, money } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
type Catalog = { items: { key: InsightConfig['reportKey']; title: string }[] };
const invalidate = [['saved-insights'], ['insight-result']];
const exportOptions = (options: InsightConfig['options']) =>
  Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
export function InsightsPage() {
  return <InsightsContent key={useCompany().id} />;
}
function InsightsContent() {
  const can = useCan(),
    toast = useToast();
  const query = useCQuery<{ items: SavedInsight[]; userId: string }>(
    ['saved-insights'],
    '/api/workspace/insights',
  );
  const catalog = useCQuery<Catalog>(['insights-catalog'], '/api/workspace/insights/catalog');
  const [editor, setEditor] = useState<SavedInsight | 'new' | null>(null);
  const archive = useCMutation(
    (view: SavedInsight, call) =>
      call(`/api/workspace/insights/${view.id}/archive`, {
        method: 'POST',
        body: { version: view.version },
      }),
    invalidate,
  );
  return (
    <>
      <PageHeader
        title="Analiz panosu"
        description="ERP raporlarını aynı panoda izleyin; dönem, kırılım ve grafik seçimlerinizi kaydedin."
        actions={
          !!catalog.data?.items.length && (
            <Button variant="primary" onClick={() => setEditor('new')}>
              <Plus className="size-4" />
              Rapor ekle
            </Button>
          )
        }
      />
      {query.error && <Callout tone="danger">{errorMessage(query.error)}</Callout>}
      {archive.error && <Callout tone="danger">{errorMessage(archive.error)}</Callout>}
      {query.isPending ? (
        <PageLoading />
      ) : !query.data?.items.length ? (
        <Card>
          <EmptyState
            icon={<ChartNoAxesCombined className="size-6" />}
            title="Panonuzu oluşturun"
            description="Satış, alış, stok, nakit veya proje kârlılığı raporlarından erişiminize açık olanları ekleyin."
            action={
              !!catalog.data?.items.length && (
                <Button onClick={() => setEditor('new')}>İlk raporu ekle</Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          {query.data.items.map((view) => (
            <InsightCard
              key={view.id + ':' + view.version}
              view={view}
              editable={view.createdBy === query.data.userId || can('members.manage')}
              onEdit={() => setEditor(view)}
              onArchive={() =>
                archive.mutate(view, {
                  onSuccess: () => toast.success('Rapor panodan kaldırıldı.'),
                })
              }
            />
          ))}
        </div>
      )}
      {editor && catalog.data && (
        <InsightEditor
          view={editor === 'new' ? null : editor}
          catalog={catalog.data}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
function InsightCard({
  view,
  editable,
  onEdit,
  onArchive,
}: {
  view: SavedInsight;
  editable: boolean;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const query = useCQuery<InsightResult>(
    ['insight-result', view.id, view.version],
    `/api/workspace/insights/${view.id}`,
    { refetchOnWindowFocus: true },
  );
  const [tableOpen, setTableOpen] = useState(false),
    data = query.data;
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader
        title={view.title}
        description={
          view.range === 'month'
            ? 'İçinde bulunduğumuz ay'
            : view.range === 'year'
              ? 'İçinde bulunduğumuz yıl'
              : `${formatDateTR(view.from)} — ${formatDateTR(view.to)}`
        }
        action={
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${view.title} yenile`}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${view.title} düzenle`}
                onClick={onEdit}
              >
                <Pencil className="size-3.5" />
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-4 p-5">
        <Badge>
          {view.shared ? (
            <>
              <Users className="size-3" />
              Şirketle paylaşılan
            </>
          ) : (
            <>
              <Lock className="size-3" />
              Kişisel
            </>
          )}
        </Badge>
        {query.error ? (
          <Callout tone="danger">{errorMessage(query.error)}</Callout>
        ) : !data ? (
          <PageLoading />
        ) : (
          <>
            <Chart data={data} />
            {!view.chart && (
              <p className="text-sm text-muted">
                {data.tables.map((t) => `${t.title}: ${t.rowCount} satır`).join(' · ')}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setTableOpen(true)}>
                Kaynak tabloyu aç
              </Button>
              <ExportMenu
                exportKey={view.reportKey}
                params={{
                  ...data.range,
                  asOf: data.range.to,
                  ...exportOptions(view.options),
                  view: 'accounts',
                }}
                print={false}
              />
              {editable && (
                <Button size="sm" variant="ghost" onClick={onArchive}>
                  <Archive className="size-3.5" />
                  Panodan kaldır
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">
              {formatDateTR(data.range.from)} — {formatDateTR(data.range.to)} · Grafik, kaynak
              raporun en büyük 20 grubunu gösterir.
            </p>
          </>
        )}
      </div>
      <Sheet
        wide
        open={tableOpen}
        onOpenChange={setTableOpen}
        title={view.title}
        description="Gösterilen ilk 200 satır. Tüm satırlar için Excel veya CSV alın."
      >
        {data && (
          <div className="space-y-5">
            {data.tables.map((table) => (
              <InsightDataTable key={table.key} table={table} />
            ))}
          </div>
        )}
      </Sheet>
    </Card>
  );
}
function Chart({ data }: { data: InsightResult }) {
  return data.chartError ? (
    <Callout tone="warning">{data.chartError}</Callout>
  ) : data.chartLabel ? (
    <div aria-label={`${data.chartLabel} grafiği`} className="space-y-3">
      <p className="text-xs text-muted">{data.chartLabel}</p>
      {!data.chart.length ? (
        <p className="py-4 text-sm text-muted">Bu dönemde grafik için kayıt yok.</p>
      ) : (
        data.chart.map((row) => (
          <div key={row.label}>
            <div className="mb-1 flex justify-between gap-3 text-xs">
              <span className="min-w-0 break-words">{row.label}</span>
              <span className="shrink-0 tabular-nums">
                {data.chartCurrency ? moneyIn(row.value, data.chartCurrency) : money(row.value)}
              </span>
            </div>
            <div className="h-2 rounded-sm bg-surface-2">
              <div
                className={`h-2 rounded-sm ${Number(row.value) < 0 ? 'bg-danger' : 'bg-brand'}`}
                style={{ width: `${row.share * 100}%` }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  ) : null;
}
function InsightDataTable({ table }: { table: InsightTable }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{table.title}</h3>
        <p className="mt-1 text-xs text-muted">
          {table.subtitle} · {table.rows.length} / {table.rowCount} satır
        </p>
      </div>
      <TableWrap>
        <Table>
          <thead>
            <Tr>
              {table.columns.map((c) => (
                <Th key={c.key} num={!['text', 'date'].includes(c.kind)}>
                  {c.label}
                </Th>
              ))}
            </Tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <Tr key={i}>
                {table.columns.map((c) => (
                  <Td key={c.key} num={!['text', 'date'].includes(c.kind)}>
                    {row[c.key] == null
                      ? '—'
                      : c.kind === 'money'
                        ? c.currency
                          ? moneyIn(String(row[c.key]), c.currency)
                          : money(String(row[c.key]))
                        : String(row[c.key])}
                  </Td>
                ))}
              </Tr>
            ))}
            {table.totals && (
              <Tr>
                {table.columns.map((c, i) => (
                  <Td key={c.key} className="font-medium" num={!['text', 'date'].includes(c.kind)}>
                    {table.totals?.[c.key] == null
                      ? i === 0
                        ? 'Toplam'
                        : ''
                      : c.kind === 'money'
                        ? money(String(table.totals[c.key]))
                        : String(table.totals[c.key])}
                  </Td>
                ))}
              </Tr>
            )}
          </tbody>
        </Table>
      </TableWrap>
    </section>
  );
}
function InsightEditor({
  view,
  catalog,
  onClose,
}: {
  view: SavedInsight | null;
  catalog: Catalog;
  onClose: () => void;
}) {
  const today = todayIso(),
    can = useCan(),
    toast = useToast();
  const [config, setConfig] = useState<InsightConfig>(
    view ?? {
      title: '',
      reportKey: catalog.items[0]!.key,
      range: 'month',
      from: today.slice(0, 8) + '01',
      to: today,
      options: {},
      chart: null,
      shared: false,
      position: 0,
    },
  );
  const [error, setError] = useState(''),
    [previewSignature, setPreviewSignature] = useState('');
  const signature = JSON.stringify({ ...config, chart: null });
  const preview = useCMutation((body: InsightConfig, call) =>
    call<InsightResult>('/api/workspace/insights/preview', { method: 'POST', body }),
  );
  const save = useCMutation(
    (body: InsightConfig, call) =>
      view
        ? call(`/api/workspace/insights/${view.id}`, {
            method: 'PUT',
            body: { config: body, version: view.version },
          })
        : call('/api/workspace/insights', { method: 'POST', body }),
    invalidate,
  );
  const change = <K extends keyof InsightConfig>(key: K, value: InsightConfig[K]) =>
    setConfig((s) => ({ ...s, [key]: value }));
  const validPreview = previewSignature === signature ? preview.data : undefined;
  const selectedTable = validPreview?.tables.find((t) => t.key === config.chart?.tableKey);
  function submit(previewOnly = false) {
    const parsed = insightConfigSchema.safeParse(config);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Alanları kontrol edin.');
      return;
    }
    setError('');
    if (previewOnly)
      preview.mutate(parsed.data, {
        onSuccess: (_, vars) => setPreviewSignature(JSON.stringify({ ...vars, chart: null })),
      });
    else
      save.mutate(parsed.data, {
        onSuccess: () => {
          toast.success('Rapor panoya kaydedildi.');
          onClose();
        },
      });
  }
  return (
    <Sheet
      wide
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={view ? 'Raporu düzenle' : 'Panoya rapor ekle'}
      description="Filtreleri seçin, raporu önizleyin ve grafiğin kaynak sütunlarını belirleyin."
      footer={
        <>
          <Button loading={preview.isPending} onClick={() => submit(true)}>
            Önizle
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!validPreview}
            onClick={() => submit()}
          >
            Panoya kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {(error || preview.error || save.error) && (
          <Callout tone="danger">{error || errorMessage(preview.error ?? save.error)}</Callout>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rapor adı" required>
            {(id) => (
              <Input
                id={id}
                value={config.title}
                maxLength={150}
                onChange={(e) => change('title', e.target.value)}
                placeholder="Aylık şantiye maliyetleri"
              />
            )}
          </Field>
          <Field label="Kaynak rapor">
            {(id) => (
              <Select
                id={id}
                value={config.reportKey}
                onChange={(e) =>
                  setConfig((s) => ({
                    ...s,
                    reportKey: e.target.value as InsightConfig['reportKey'],
                    chart: null,
                    options: {},
                  }))
                }
              >
                {catalog.items.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Dönem">
            {(id) => (
              <Select
                id={id}
                value={config.range}
                onChange={(e) => change('range', e.target.value as InsightConfig['range'])}
              >
                <option value="month">Bu ay — her gün güncellenir</option>
                <option value="year">Bu yıl — her gün güncellenir</option>
                <option value="fixed">Sabit tarih aralığı</option>
              </Select>
            )}
          </Field>
          <Field label="Pano sırası" hint="Küçük numaralar önce gösterilir.">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={10000}
                value={config.position}
                onChange={(e) => change('position', Number(e.target.value))}
              />
            )}
          </Field>
          {config.range === 'fixed' && (
            <>
              <Field label="Başlangıç">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={config.from}
                    onChange={(e) => change('from', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Bitiş">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={config.to}
                    onChange={(e) => change('to', e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {['sales-report', 'purchase-report'].includes(config.reportKey) && (
            <Field label="Kırılım">
              {(id) => (
                <Select
                  id={id}
                  value={config.options.groupBy ?? 'party'}
                  onChange={(e) =>
                    change('options', {
                      groupBy: e.target.value as NonNullable<InsightConfig['options']['groupBy']>,
                    })
                  }
                >
                  <option value="party">Cari</option>
                  <option value="month">Ay</option>
                  <option value="item">Stok / hizmet</option>
                  <option value="invoice">Fatura</option>
                </Select>
              )}
            </Field>
          )}
          {config.reportKey === 'party-aging' && (
            <Field label="Cari kalem yönü">
              {(id) => (
                <Select
                  id={id}
                  value={config.options.type ?? 'receivable'}
                  onChange={(e) =>
                    change('options', { type: e.target.value as 'receivable' | 'payable' })
                  }
                >
                  <option value="receivable">Alacaklar</option>
                  <option value="payable">Borçlar</option>
                </Select>
              )}
            </Field>
          )}
          {config.reportKey === 'stock-analytics' && (
            <Field label="Hareketsizlik eşiği">
              {(id) => (
                <Select
                  id={id}
                  value={config.options.inactiveDays ?? 90}
                  onChange={(e) => change('options', { inactiveDays: Number(e.target.value) })}
                >
                  {[30, 60, 90, 180, 365].map((days) => (
                    <option key={days} value={days}>
                      {days} gün
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {can('members.manage') && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.shared}
              onChange={(e) => change('shared', e.target.checked)}
            />
            Şirketle paylaş{' '}
            <span className="text-xs text-muted">Her kullanıcı kendi rapor yetkisiyle görür.</span>
          </label>
        )}
        {validPreview && (
          <>
            <Field label="Grafik kaynak tablosu">
              {(id) => (
                <Select
                  id={id}
                  value={config.chart?.tableKey ?? ''}
                  onChange={(e) => {
                    const table = validPreview.tables.find((t) => t.key === e.target.value);
                    const label = table?.columns.find((c) => ['text', 'date'].includes(c.kind)),
                      value =
                        table?.columns.find((c) => c.kind === 'money') ??
                        table?.columns.find((c) => ['int', 'qty'].includes(c.kind));
                    change(
                      'chart',
                      table && label && value
                        ? { tableKey: table.key, labelKey: label.key, valueKey: value.key }
                        : null,
                    );
                  }}
                >
                  <option value="">Yalnızca tablo</option>
                  {validPreview.tables
                    .filter((t) => t.columns.some((c) => ['money', 'qty', 'int'].includes(c.kind)))
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.title}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            {config.chart && selectedTable && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Grup / etiket">
                  {(id) => (
                    <Select
                      id={id}
                      value={config.chart!.labelKey}
                      onChange={(e) =>
                        change('chart', { ...config.chart!, labelKey: e.target.value })
                      }
                    >
                      {selectedTable.columns
                        .filter((c) => ['text', 'date'].includes(c.kind))
                        .map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
                <Field label="Grafik tutarı">
                  {(id) => (
                    <Select
                      id={id}
                      value={config.chart!.valueKey}
                      onChange={(e) =>
                        change('chart', { ...config.chart!, valueKey: e.target.value })
                      }
                    >
                      {selectedTable.columns
                        .filter((c) => ['money', 'qty', 'int'].includes(c.kind))
                        .map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              </div>
            )}
            <Chart data={validPreview} />
            {validPreview.tables.map((table) => (
              <InsightDataTable key={table.key} table={table} />
            ))}
          </>
        )}
      </div>
    </Sheet>
  );
}
