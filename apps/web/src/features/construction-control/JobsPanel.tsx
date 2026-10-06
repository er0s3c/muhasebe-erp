import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileScan, Box, Plus, RefreshCw } from 'lucide-react';
import { ITEM_UNITS } from '@erp/shared';
import type { ModelElement } from './ModelViewer';
import { useCan, useCQuery, useCompanyApi } from '../../lib/queries';
import { apiBlob } from '../../lib/api';
import { fileBase64 } from './offline';
import { DrawingCanvas } from './DrawingCanvas';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Sheet } from '../../components/ui/Sheet';
import { Callout, PageLoading, EmptyState } from '../../components/ui/Feedback';
const ModelViewer = lazy(() => import('./ModelViewer').then((m) => ({ default: m.ModelViewer })));
type Job = {
  id: string;
  assetId: string;
  projectId: string;
  filename: string;
  kind: 'ocr' | 'ifc';
  status: string;
  progress: number;
  version: number;
  error: string | null;
  reviewedRecordId: string | null;
  reviewedRecordKind: string | null;
  summary: { elements?: number; warnings?: string[]; suggestions?: Record<string, unknown> };
};
type Option = { id: string; label: string; kind?: string };
type Options = Record<string, Option[]>;
type ModelLink = {
  guid: string;
  wbsId: string | null;
  operationId: string | null;
  version: number;
};
const labels: Record<string, string> = {
  queued: 'Sırada',
  running: 'İşleniyor',
  completed: 'Hazır',
  failed: 'Başarısız',
};
export function JobsPanel({ projectId }: { projectId: string }) {
  const [params] = useSearchParams();
  const { call, company } = useCompanyApi(),
    can = useCan();
  const jobs = useCQuery<{ items: Job[] }>(
    ['control', 'jobs', projectId],
    `/api/construction/jobs?projectId=${projectId}`,
    { refetchInterval: 5000 },
  );
  const options = useCQuery<Options>(
    ['control', 'options', projectId],
    `/api/construction/options?projectId=${projectId}`,
  );
  const [chosen, setChosen] = useState(params.get('jobId') ?? ''),
    [upload, setUpload] = useState<'ocr' | 'ifc' | null>(null),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const selected = jobs.data?.items.find((j) => j.id === chosen);
  const result = useCQuery<{
    elements?: ModelElement[];
    text?: string;
    suggestions?: Record<string, unknown>;
    warnings?: string[];
  }>(
    ['control', 'job-result', chosen],
    selected?.status === 'completed' ? `/api/construction/jobs/${chosen}/result` : null,
  );
  const links = useCQuery<{ items: ModelLink[] }>(
    ['control', 'model-links', chosen],
    selected?.kind === 'ifc' && selected.status === 'completed'
      ? `/api/construction/jobs/${chosen}/model-links`
      : null,
  );
  const program = useCQuery<{
    activities: {
      id: string;
      wbsId: string | null;
      computedStart: string;
      computedEnd: string;
      progress: number;
    }[];
  }>(
    ['control', 'program', projectId],
    selected?.kind === 'ifc' ? `/api/construction/program?projectId=${projectId}` : null,
  );
  const [guid, setGuid] = useState(''),
    [storey, setStorey] = useState(''),
    [wbsId, setWbsId] = useState(''),
    [operationId, setOperationId] = useState(''),
    [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const activeLink = links.data?.items.find((x) => x.guid === guid),
    element = result.data?.elements?.find((e) => e.guid === guid);
  const [preview, setPreview] = useState<Uint8Array | null>(null),
    [previewUrl, setPreviewUrl] = useState('');
  useEffect(() => {
    let live = true,
      url = '';
    setPreview(null);
    setPreviewUrl('');
    if (selected?.kind === 'ocr') {
      void apiBlob(`/api/construction/assets/${selected.assetId}/download`, {
        companyId: company.id,
      })
        .then(async (r) => {
          url = URL.createObjectURL(r.blob);
          const bytes = new Uint8Array(await r.blob.arrayBuffer());
          if (live) {
            setPreview(bytes);
            setPreviewUrl(url);
          } else URL.revokeObjectURL(url);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected?.assetId, selected?.kind, company.id]);
  const elements = useMemo(
    () => (result.data?.elements ?? []).filter((e) => !storey || e.storey === storey),
    [result.data, storey],
  );
  const colors = useMemo(
    () =>
      Object.fromEntries(
        elements.map((e) => {
          const link = links.data?.items.find((l) => l.guid === e.guid),
            work = program.data?.activities.find(
              (a) => a.id === link?.operationId || (link?.wbsId && a.wbsId === link.wbsId),
            );
          return [
            e.guid,
            !work || date < work.computedStart
              ? '#a5b4c4'
              : date >= work.computedEnd && work.progress >= 100
                ? '#22a06b'
                : date >= work.computedEnd
                  ? '#df8a39'
                  : '#4387dd',
          ];
        }),
      ),
    [elements, links.data, program.data, date],
  );
  async function submit() {
    if (!file || !upload) return;
    setBusy(true);
    setError('');
    try {
      const asset = await call<{ item: { id: string } }>('/api/construction/assets', {
        method: 'POST',
        body: {
          projectId,
          filename: file.name,
          mime: upload === 'ifc' ? 'application/x-step' : file.type,
          base64: await fileBase64(file),
        },
      });
      const r = await call<{ item: Job }>('/api/construction/jobs', {
        method: 'POST',
        body: { assetId: asset.item.id, kind: upload },
      });
      setChosen(r.item.id);
      setUpload(null);
      setFile(null);
      await jobs.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveLink() {
    if (!selected || !guid) return;
    setBusy(true);
    setError('');
    try {
      await call(`/api/construction/jobs/${selected.id}/model-links`, {
        method: 'PUT',
        body: {
          guid,
          wbsId: wbsId || null,
          operationId: operationId || null,
          version: activeLink?.version ?? 0,
        },
      });
      await links.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function choose(id: string) {
    setGuid(id);
    const link = links.data?.items.find((l) => l.guid === id);
    setWbsId(link?.wbsId ?? '');
    setOperationId(link?.operationId ?? '');
  }
  return (
    <Card className="mt-5">
      <CardHeader
        title="BIM ve belge giriş yardımcısı"
        description="IFC geometrisi ve OCR yerel olarak hazırlanır; işlemler yeniden başlatma sonrası kuyrukta korunur."
        action={
          can('projects.manage') ? (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setUpload('ifc');
                  setError('');
                }}
              >
                <Box className="size-4" />
                IFC yükle
              </Button>
              <Button
                onClick={() => {
                  setUpload('ocr');
                  setError('');
                }}
              >
                <FileScan className="size-4" />
                Belge tara
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="space-y-5 p-5">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="İşlem sonucu">
          {(id) => (
            <Select
              id={id}
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                setGuid('');
                setStorey('');
              }}
            >
              <option value="">Sonuç seçin</option>
              {jobs.data?.items.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.filename} · {labels[j.status]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {jobs.data?.items.length === 0 && <EmptyState title="İlk model veya belgeyi yükleyin" />}
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge>{labels[selected.status]}</Badge>
              <span className="text-xs text-muted">
                {selected.filename} · %{selected.progress}
              </span>
              {selected.status === 'failed' && can('projects.manage') && (
                <Button
                  size="sm"
                  onClick={() =>
                    void call(`/api/construction/jobs/${selected.id}/retry`, {
                      method: 'POST',
                      body: { version: selected.version },
                    })
                      .then(() => jobs.refetch())
                      .catch((e) => setError(e.message))
                  }
                >
                  <RefreshCw className="size-4" />
                  Yeniden dene
                </Button>
              )}
            </div>
            {selected.error && <Callout tone="danger">{selected.error}</Callout>}
            {['queued', 'running'].includes(selected.status) && (
              <progress
                className="w-full"
                max={100}
                value={selected.progress}
                aria-label="İşlem ilerlemesi"
              />
            )}
            {selected.kind === 'ifc' && result.data?.elements && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Kat / seviye">
                    {(id) => (
                      <Select id={id} value={storey} onChange={(e) => setStorey(e.target.value)}>
                        <option value="">Tüm katlar</option>
                        {[...new Set(result.data!.elements!.map((e) => e.storey))].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field
                    label="Program tarihi"
                    hint="Gri: bağlı iş yok / başlamadı · mavi: programda · turuncu: termin geçti · yeşil: tamamlandı"
                  >
                    {(id) => (
                      <Input
                        id={id}
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                {program.data?.activities.length ? (
                  <Field label="İlerleme zaman çizgisi">
                    {(id) => {
                      const dates = program
                        .data!.activities.flatMap((a) => [a.computedStart, a.computedEnd])
                        .sort();
                      const first = Date.parse(dates[0]!);
                      const days = Math.max(
                        1,
                        Math.round((Date.parse(dates.at(-1)!) - first) / 86400000),
                      );
                      return (
                        <Input
                          id={id}
                          type="range"
                          min={0}
                          max={days}
                          step={1}
                          value={Math.max(
                            0,
                            Math.min(days, Math.round((Date.parse(date) - first) / 86400000)),
                          )}
                          onChange={(e) =>
                            setDate(
                              new Date(first + Number(e.target.value) * 86400000)
                                .toISOString()
                                .slice(0, 10),
                            )
                          }
                        />
                      );
                    }}
                  </Field>
                ) : null}
                <Suspense fallback={<PageLoading />}>
                  <ModelViewer
                    elements={elements}
                    selected={guid}
                    onSelect={choose}
                    colors={colors}
                  />
                </Suspense>
                <Field label="Model elemanı">
                  {(id) => (
                    <Select id={id} value={guid} onChange={(e) => choose(e.target.value)}>
                      <option value="">Modelden veya listeden seçin</option>
                      {elements.map((e) => (
                        <option key={e.guid} value={e.guid}>
                          {e.name} · {e.type}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {element && (
                  <div className="space-y-4 rounded-xl border border-border p-4">
                    <p className="text-sm">
                      {element.name} · {element.storey}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="İş kalemi bağlantısı">
                        {(id) => (
                          <Select
                            id={id}
                            value={wbsId}
                            disabled={!can('projects.manage')}
                            onChange={(e) => setWbsId(e.target.value)}
                          >
                            <option value="">Bağlantı yok</option>
                            {options.data?.wbs?.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="RFI / saha / program bağlantısı">
                        {(id) => (
                          <Select
                            id={id}
                            value={operationId}
                            disabled={!can('projects.manage')}
                            onChange={(e) => setOperationId(e.target.value)}
                          >
                            <option value="">Bağlantı yok</option>
                            {options.data?.operations
                              ?.filter((o) =>
                                [
                                  'rfi',
                                  'quality_check',
                                  'safety',
                                  'site_report',
                                  'site_instruction',
                                  'schedule',
                                ].includes(o.kind ?? ''),
                              )
                              .map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                          </Select>
                        )}
                      </Field>
                    </div>
                    {can('projects.manage') && (
                      <Button disabled={busy} onClick={() => void saveLink()}>
                        Elemanı bağla
                      </Button>
                    )}
                    {activeLink?.operationId && (
                      <Link
                        className="ml-3 text-sm underline"
                        to={`/workspace/operations?kind=${options.data?.operations?.find((o) => o.id === activeLink.operationId)?.kind ?? 'rfi'}&open=${activeLink.operationId}`}
                      >
                        Kaynak operasyonu aç
                      </Link>
                    )}
                    {activeLink?.wbsId && (
                      <Link className="ml-3 text-sm underline" to={`/projects/${projectId}`}>
                        Bağlı işin maliyet raporunu aç
                      </Link>
                    )}
                  </div>
                )}
                {result.data.warnings?.map((w, i) => (
                  <Callout key={i}>{w}</Callout>
                ))}
              </>
            )}
            {selected.kind === 'ocr' && result.data && (
              <div className="grid gap-5 xl:grid-cols-2">
                <div className="min-w-0">
                  {preview && selected.filename.toLowerCase().endsWith('.pdf') ? (
                    <DrawingCanvas data={preview} />
                  ) : previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Doğrulanacak kaynak belge"
                      className="max-h-[600px] w-full object-contain"
                    />
                  ) : null}
                  <Textarea
                    aria-label="OCR metni"
                    value={result.data.text ?? ''}
                    readOnly
                    rows={8}
                    className="mt-4"
                  />
                </div>
                <OcrReview
                  job={selected}
                  result={result.data}
                  options={options.data ?? {}}
                  onDone={() => void jobs.refetch()}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <Sheet
        open={upload !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setUpload(null);
        }}
        title={upload === 'ifc' ? 'IFC modelini işle' : 'OCR belgesi yükle'}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Callout>
            {upload === 'ifc'
              ? 'IFC dosyası en fazla 25 MB. Geometri ve katlar yerel işleyicide hazırlanır.'
              : 'PDF, PNG veya JPEG, en fazla 25 MB. Çıkarılan alanlar sizin doğrulamanızdan sonra taslağa aktarılır.'}
          </Callout>
          <Field label="Dosya">
            {(id) => (
              <input
                id={id}
                type="file"
                required
                accept={upload === 'ifc' ? '.ifc' : 'application/pdf,image/png,image/jpeg'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
          <Button type="submit" variant="primary" disabled={busy || !file}>
            <Plus className="size-4" />
            {busy ? 'Gönderiliyor…' : 'İşlem kuyruğuna al'}
          </Button>
        </form>
      </Sheet>
    </Card>
  );
}
function OcrReview({
  job,
  result,
  options,
  onDone,
}: {
  job: Job;
  result: { text?: string; suggestions?: Record<string, unknown> };
  options: Options;
  onDone: () => void;
}) {
  const { call } = useCompanyApi(),
    can = useCan(),
    [type, setType] = useState<'invoice' | 'delivery' | 'report'>('report'),
    [partyId, setPartyId] = useState(''),
    [date, setDate] = useState(String(result.suggestions?.date ?? '')),
    [externalNo, setExternalNo] = useState(String(result.suggestions?.externalNo ?? '')),
    [currency, setCurrency] = useState(String(result.suggestions?.currency ?? '')),
    [fx, setFx] = useState(''),
    [title, setTitle] = useState(job.filename),
    [text, setText] = useState((result.text ?? '').slice(0, 4000)),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [lines, setLines] = useState([
    { itemId: '', description: '', quantity: '', unit: 'adet', unitPrice: '', vatCode: '' },
  ]);
  const update = (i: number, key: string, value: string) =>
    setLines((rows) => rows.map((r, n) => (n === i ? { ...r, [key]: value } : r)));
  async function transfer() {
    setBusy(true);
    setError('');
    try {
      const input =
        type === 'report'
          ? { title, workDone: text, date }
          : type === 'invoice'
            ? {
                type: 'purchase',
                partyId,
                invoiceDate: date,
                externalNo,
                currency,
                ...(fx ? { fxRate: fx } : {}),
                lines: lines.map((l) => ({
                  ...l,
                  itemId: l.itemId || null,
                  ...(!l.itemId ? { projectId: job.projectId } : {}),
                })),
                post: false,
              }
            : {
                type: 'purchase',
                partyId,
                noteDate: date,
                externalNo,
                lines: lines.map((l) => ({
                  itemId: l.itemId,
                  description: l.description,
                  quantity: l.quantity,
                  unit: l.unit,
                  unitCost: l.unitPrice,
                  currency,
                  ...(fx ? { fxRate: fx } : {}),
                })),
                post: false,
              };
      await call(`/api/construction/jobs/${job.id}/review`, {
        method: 'POST',
        body: { version: job.version, type, input, confirmation: confirmed },
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (job.reviewedRecordId)
    return (
      <Callout>
        Doğrulanarak aktarılmış taslak:{' '}
        <Link
          className="underline"
          to={
            job.reviewedRecordKind === 'invoice'
              ? `/invoices/${job.reviewedRecordId}`
              : job.reviewedRecordKind === 'delivery'
                ? `/delivery-notes/${job.reviewedRecordId}`
                : `/workspace/operations?kind=site_report&open=${job.reviewedRecordId}`
          }
        >
          Kaydı aç
        </Link>
      </Callout>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void transfer();
      }}
    >
      <Callout>
        Alan önerileri: {String(result.suggestions?.warning ?? 'Belgeyi kontrol edin.')}
        <p className="mt-2">
          Belgede okunan toplam: {String(result.suggestions?.totalText ?? 'Bulunamadı')} · Kaynak
          metin soldadır.
        </p>
      </Callout>
      <Field label="Taslak türü">
        {(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="report">Saha raporu</option>
            {can('invoices.manage') && <option value="invoice">Alış faturası</option>}
            {can('deliveries.manage') && <option value="delivery">Alış irsaliyesi</option>}
          </Select>
        )}
      </Field>
      <Field label="Doğrulanmış belge tarihi">
        {(id) => (
          <Input
            id={id}
            required
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        )}
      </Field>
      {type === 'report' ? (
        <>
          <Field label="Rapor başlığı">
            {(id) => (
              <Input id={id} required value={title} onChange={(e) => setTitle(e.target.value)} />
            )}
          </Field>
          <Field label="Doğrulanmış rapor içeriği">
            {(id) => (
              <Textarea
                id={id}
                required
                maxLength={4000}
                rows={10}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
        </>
      ) : (
        <>
          <Field label="Cari">
            {(id) => (
              <Select id={id} required value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                <option value="">Cari seçin</option>
                {options.parties?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Tedarikçi belge numarası">
            {(id) => (
              <Input
                id={id}
                required
                value={externalNo}
                onChange={(e) => setExternalNo(e.target.value)}
              />
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Para birimi">
              {(id) => (
                <Select
                  id={id}
                  required
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  <option value="">Doğrulayın</option>
                  {['TRY', 'EUR', 'USD', 'GBP'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Kur (boşsa kayıtlı tarih kuru)">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  step="any"
                  min=".00000001"
                  value={fx}
                  onChange={(e) => setFx(e.target.value)}
                />
              )}
            </Field>
          </div>
          {lines.map((l, i) => (
            <fieldset key={i} className="space-y-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm">Satır {i + 1}</legend>
              <Field label="Stok kartı">
                {(id) => (
                  <Select
                    id={id}
                    required={type === 'delivery'}
                    value={l.itemId}
                    onChange={(e) => update(i, 'itemId', e.target.value)}
                  >
                    <option value="">Serbest hizmet satırı</option>
                    {options.items?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Açıklama">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={l.description}
                    onChange={(e) => update(i, 'description', e.target.value)}
                  />
                )}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Miktar">
                  {(id) => (
                    <Input
                      id={id}
                      required
                      type="number"
                      min=".0001"
                      step="any"
                      value={l.quantity}
                      onChange={(e) => update(i, 'quantity', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Birim">
                  {(id) => (
                    <Select
                      id={id}
                      value={l.unit}
                      onChange={(e) => update(i, 'unit', e.target.value)}
                    >
                      {ITEM_UNITS.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Birim fiyat">
                  {(id) => (
                    <Input
                      id={id}
                      required
                      type="number"
                      min="0"
                      step="any"
                      value={l.unitPrice}
                      onChange={(e) => update(i, 'unitPrice', e.target.value)}
                    />
                  )}
                </Field>
                {type === 'invoice' && (
                  <Field label="KDV kodu (boşsa KDV yok)">
                    {(id) => (
                      <Input
                        id={id}
                        value={l.vatCode}
                        onChange={(e) => update(i, 'vatCode', e.target.value)}
                      />
                    )}
                  </Field>
                )}
              </div>
              {lines.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setLines((v) => v.filter((_, n) => n !== i))}
                >
                  Satırı kaldır
                </Button>
              )}
            </fieldset>
          ))}
          <Button
            type="button"
            onClick={() =>
              setLines((v) => [
                ...v,
                {
                  itemId: '',
                  description: '',
                  quantity: '',
                  unit: 'adet',
                  unitPrice: '',
                  vatCode: '',
                },
              ])
            }
          >
            Satır ekle
          </Button>
        </>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Kaynak belgeyi, alanları ve satırları kontrol ettim.
      </label>
      {can('projects.manage') && (
        <Button type="submit" variant="primary" disabled={busy || !confirmed}>
          {busy ? 'Aktarılıyor…' : 'Doğrulanmış taslağı oluştur'}
        </Button>
      )}
    </form>
  );
}
