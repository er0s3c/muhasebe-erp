import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, CloudDownload, FileText, Plus, Camera, ShieldAlert } from 'lucide-react';
import type {
  ConstructionCockpit,
  ConstructionDrawing,
  ConstructionLocation,
  DrawingPin,
  ProgressPhoto,
} from '@erp/shared';
import { todayIso } from '@erp/shared';
import { useCan, useCQuery, useCompanyApi } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { apiBlob } from '../../lib/api';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Stat } from '../../components/ui/Stat';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { WorkflowBoard } from './WorkflowBoard';
import { AssistantPanel } from './AssistantPanel';
import { JobsPanel } from './JobsPanel';
const PanoramaViewer = lazy(() =>
  import('./ModelViewer').then((m) => ({ default: m.PanoramaViewer })),
);
import { DrawingCanvas } from './DrawingCanvas';
import { fileBase64, prepareOfflineShell, prepareFieldPackage } from './offline';

const tabs = [
  { key: 'overview', label: 'Özet' },
  { key: 'drawings', label: 'Planlar' },
  { key: 'field', label: 'Saha' },
  { key: 'program', label: 'Program' },
  { key: 'commercial', label: 'Ticari' },
  { key: 'customer', label: 'Müşteri' },
];
export function ProjectControlPage() {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? '';
  const tab = params.get('tab') ?? 'overview';
  const can = useCan(),
    { call, company } = useCompanyApi(),
    session = useSession();
  const writable = can('projects.manage');
  const projects = useCQuery<{ projects: { id: string; code: string; name: string }[] }>(
    ['control', 'projects'],
    '/api/projects?limit=200',
  );
  const cockpit = useCQuery<ConstructionCockpit>(
    ['control', 'cockpit', projectId],
    projectId ? `/api/construction/cockpit?projectId=${projectId}` : null,
  );
  const drawings = useCQuery<{ items: ConstructionDrawing[] }>(
    ['control', 'drawings', projectId],
    projectId ? `/api/construction/drawings?projectId=${projectId}` : null,
  );
  const locations = useCQuery<{ items: ConstructionLocation[] }>(
    ['control', 'locations', projectId],
    projectId ? `/api/construction/locations?projectId=${projectId}` : null,
  );
  const photos = useCQuery<{ items: ProgressPhoto[] }>(
    ['control', 'photos', projectId],
    projectId ? `/api/construction/photos?projectId=${projectId}` : null,
  );
  const pinOptions = useCQuery<{ operations: { id: string; label: string; kind: string }[] }>(
    ['control', 'options', projectId],
    projectId ? `/api/construction/options?projectId=${projectId}` : null,
  );
  const [selectedId, setSelectedId] = useState(params.get('drawingId') ?? ''),
    [compareId, setCompareId] = useState(''),
    [page, setPage] = useState(Math.max(1, Number(params.get('page')) || 1));
  const selected = drawings.data?.items.find((d) => d.id === selectedId);
  const compared = drawings.data?.items.find((d) => d.id === compareId);
  const pins = useCQuery<{ items: DrawingPin[] }>(
    ['control', 'pins', selectedId],
    selected ? `/api/construction/drawings/${selected.id}/pins` : null,
  );
  const [bytes, setBytes] = useState<Uint8Array | null>(null),
    [oldBytes, setOldBytes] = useState<Uint8Array | undefined>();
  const [panel, setPanel] = useState<'drawing' | 'location' | 'pin' | 'photo' | 'offline' | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [form, setForm] = useState<Record<string, string>>({}),
    [file, setFile] = useState<File | null>(null),
    [point, setPoint] = useState<{ x: number; y: number } | null>(null),
    [pinMode, setPinMode] = useState(false);
  useEffect(() => {
    let active = true;
    if (!selected) {
      setBytes(null);
      return;
    }
    void apiBlob(`/api/construction/assets/${selected.assetId}/download`, { companyId: company.id })
      .then(async (r) => {
        const b = new Uint8Array(await r.blob.arrayBuffer());
        if (active) setBytes(b);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selected?.assetId, company.id, selected]);
  useEffect(() => {
    let active = true;
    setOldBytes(undefined);
    if (compared)
      void apiBlob(`/api/construction/assets/${compared.assetId}/download`, {
        companyId: company.id,
      })
        .then(async (r) => {
          const b = new Uint8Array(await r.blob.arrayBuffer());
          if (active) setOldBytes(b);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [compared, company.id]);
  const projectName = projects.data?.projects.find((p) => p.id === projectId)?.name ?? '';
  const update = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  function open(kind: typeof panel) {
    setPanel(kind);
    setForm({
      discipline: 'architecture',
      revision: '01',
      kind: 'building',
      date: todayIso(),
      dueDate: todayIso(),
      locationId: '',
      parentId: '',
      caption: '',
      clientId: crypto.randomUUID(),
    });
    setFile(null);
    setError('');
  }
  async function refresh() {
    await Promise.all([
      drawings.refetch(),
      locations.refetch(),
      photos.refetch(),
      cockpit.refetch(),
      pins.refetch(),
    ]);
  }
  async function upload() {
    if (!file) throw new Error('Dosya seçin.');
    if (file.size > 25 * 1024 * 1024) throw new Error('Dosya en fazla 25 MB olabilir.');
    return call<{ item: { id: string } }>('/api/construction/assets', {
      method: 'POST',
      body: { projectId, filename: file.name, mime: file.type, base64: await fileBase64(file) },
    });
  }
  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (panel === 'location')
        await call('/api/construction/locations', {
          method: 'POST',
          body: { projectId, name: form.name, kind: form.kind, parentId: form.parentId || null },
        });
      if (panel === 'drawing') {
        const f = await upload();
        await call('/api/construction/drawings', {
          method: 'POST',
          body: {
            projectId,
            assetId: f.item.id,
            code: form.code,
            title: form.title,
            discipline: form.discipline,
            revision: form.revision,
            previousId: form.previousId || null,
          },
        });
      }
      if (panel === 'photo') {
        const f = await upload();
        await call('/api/construction/photos', {
          method: 'POST',
          body: {
            projectId,
            assetId: f.item.id,
            locationId: form.locationId,
            date: form.date,
            caption: form.caption,
            panorama: form.panorama === 'true',
            operationId: form.operationId || null,
          },
        });
      }
      if (panel === 'pin' && selected && point) {
        if (file && !form.locationId) throw new Error('Fotoğraf için konum seçin.');
        const existing = pinOptions.data?.operations.find((o) => o.id === form.recordId);
        const op = existing
          ? { item: { id: existing.id } }
          : await call<{ item: { id: string } }>('/api/workspace/operations', {
              method: 'POST',
              body: {
                id: form.clientId,
                kind: 'rfi',
                projectId,
                title: form.title,
                eventDate: todayIso(),
                dueDate: form.dueDate,
                payload: {
                  discipline: 'other',
                  reference: `${selected.code} / ${selected.revision}`,
                  question: form.question,
                },
              },
            });
        await call('/api/construction/pins', {
          method: 'POST',
          body: {
            drawingId: selected.id,
            page,
            ...point,
            recordKind: existing?.kind ?? 'rfi',
            recordId: op.item.id,
            locationId: form.locationId || null,
            label: existing?.label ?? form.title,
            clientId: form.clientId,
          },
        });
        if (file) {
          if (!form.locationId) throw new Error('Fotoğraf için konum seçin.');
          const image = await upload();
          await call('/api/construction/photos', {
            method: 'POST',
            body: {
              projectId,
              assetId: image.item.id,
              locationId: form.locationId,
              date: todayIso(),
              caption: existing?.label ?? form.title,
              operationId: op.item.id,
              clientId: form.clientId,
            },
          });
        }
        setPinMode(false);
      }
      if (panel === 'offline') {
        if (!session.user) throw new Error('Oturum gerekli.');
        if (selected && selected.status !== 'approved')
          throw new Error('Çevrimdışı paket için onaylı çizim seçin.');
        await prepareOfflineShell();
        await prepareFieldPackage(
          {
            companyId: company.id,
            userId: session.user.id,
            projectId,
            projectName,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            locations: locations.data?.items ?? [],
            drawing: selected ?? null,
            drawingBase64: bytes
              ? await fileBase64(
                  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
                )
              : null,
            pins: pins.data?.items ?? [],
            queue: [],
          },
          form.password ?? '',
        );
        setMessage(
          'Saha paketi indirildi. Çevrimdışı şantiye ekranını cihaz koduyla açabilirsiniz.',
        );
      }
      setPanel(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function approve(d: ConstructionDrawing) {
    setBusy(true);
    setError('');
    try {
      await call(`/api/construction/drawings/${d.id}/decision`, {
        method: 'POST',
        body: {
          version: d.version,
          status: 'approved',
          note: 'Yetkili tarafından kullanım için kontrol edildi.',
        },
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function switchProject(id: string) {
    setSelectedId('');
    setCompareId('');
    setPage(1);
    setPinMode(false);
    setPanel(null);
    setParams({ projectId: id, tab });
  }
  return (
    <>
      <PageHeader
        title="Proje 360"
        description="Plan, saha ve ticari kayıtlar aynı proje üzerinde."
        actions={
          <Link to="/workspace/construction" className="text-sm underline">
            İnşaat kontrol merkezi
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap gap-3">
        <Select
          aria-label="Proje 360 kapsamı"
          value={projectId}
          onChange={(e) => switchProject(e.target.value)}
          className="max-w-sm"
        >
          <option value="">Proje seçin</option>
          {projects.data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code} · {p.name}
            </option>
          ))}
        </Select>
        {projectId && writable && (
          <Button onClick={() => open('offline')}>
            <CloudDownload className="size-4" />
            Saha paketini indir
          </Button>
        )}
        <Link to="/field-offline" className="self-center text-sm underline">
          Çevrimdışı şantiye
        </Link>
      </div>
      {error && (
        <div className="mb-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}
      {message && (
        <div className="mb-4">
          <Callout>{message}</Callout>
        </div>
      )}
      {!projectId ? (
        <Card>
          <EmptyState
            icon={<FileText className="size-5" />}
            title="Projenizi seçin"
            description="Çizim, saha ve risk bilgileri proje kapsamıyla açılır."
          />
        </Card>
      ) : (
        <>
          <SegmentedTabs
            items={tabs}
            value={tab}
            onChange={(value) => setParams({ projectId, tab: value })}
            className="mb-5 max-w-full overflow-x-auto"
          />
          {tab === 'overview' &&
            (cockpit.isPending ? (
              <PageLoading />
            ) : (
              <>
                <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat label="Gerçekleşen maliyet" sub={cockpit.data?.currency}>
                    {cockpit.data?.metrics
                      ? Number(cockpit.data.metrics.actual).toLocaleString('tr-TR')
                      : '—'}
                  </Stat>
                  <Stat label="Tahmini toplam maliyet" sub="Tamamlanma maliyeti tahmini">
                    {cockpit.data?.metrics
                      ? Number(cockpit.data.metrics.eac).toLocaleString('tr-TR')
                      : '—'}
                  </Stat>
                  <Stat label="İlerleme" sub="Bütçe ağırlıklı">
                    {cockpit.data?.metrics?.percent ? `%${cockpit.data.metrics.percent}` : '—'}
                  </Stat>
                  <Stat
                    label="Açık / geciken"
                    sub={
                      cockpit.data?.previous
                        ? `${cockpit.data.previous.date}: ${cockpit.data.previous.counts.open} açık`
                        : 'Önceki hafta görüntüsü henüz yok'
                    }
                  >
                    {cockpit.data
                      ? `${cockpit.data.counts.open} / ${cockpit.data.counts.overdue}`
                      : '—'}
                  </Stat>
                </div>
                <Card>
                  <CardHeader
                    title="Risk radarı"
                    description="Kaynak kayda bağlı, açıklanabilir uyarılar."
                  />
                  {cockpit.data?.risks.length ? (
                    cockpit.data.risks.map((r) => (
                      <Link
                        key={r.key}
                        to={r.path}
                        className="flex gap-3 border-t border-border p-5 hover:bg-surface-2"
                      >
                        <ShieldAlert className="mt-1 size-4 shrink-0 text-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p>{r.title}</p>
                            <Badge tone={r.severity === 'critical' ? 'danger' : 'warning'}>
                              {r.severity === 'critical' ? 'Kritik' : 'Takip gerekli'}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm text-muted">{r.reason}</p>
                          <p className="mt-2 text-xs">
                            {r.action}
                            {r.owner ? ` · ${r.owner}` : ''}
                          </p>
                        </div>
                        <ArrowUpRight className="size-4 shrink-0" />
                      </Link>
                    ))
                  ) : (
                    <EmptyState title="İncelenen kayıtlarda açık risk bulunmadı" />
                  )}
                </Card>
                <div className="mt-4 space-y-2">
                  {cockpit.data?.dataNotes.map((n) => (
                    <p key={n} className="text-xs text-muted">
                      {n}
                    </p>
                  ))}
                </div>
                {writable && (
                  <Button
                    className="mt-4"
                    onClick={() =>
                      void call('/api/construction/snapshots', {
                        method: 'POST',
                        body: { projectId },
                      })
                        .then(() => {
                          setMessage('Bugünün değişmez operasyon özeti kaydedildi.');
                          return cockpit.refetch();
                        })
                        .catch((e) => setError(e.message))
                    }
                  >
                    Bugünkü özeti sakla
                  </Button>
                )}
              </>
            ))}
          {tab === 'drawings' && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                {writable && (
                  <Button variant="primary" disabled={busy} onClick={() => open('drawing')}>
                    <Plus className="size-4" />
                    Çizim / revizyon ekle
                  </Button>
                )}
                <Select
                  aria-label="Çizim seç"
                  value={selectedId}
                  onChange={(e) => {
                    setSelectedId(e.target.value);
                    setPage(1);
                    setCompareId('');
                  }}
                  className="max-w-sm"
                >
                  <option value="">Çizim seçin</option>
                  {drawings.data?.items.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} · {d.title} · Rev {d.revision} ·{' '}
                      {d.status === 'approved'
                        ? 'Onaylı'
                        : d.status === 'draft'
                          ? 'Taslak'
                          : 'Kullanım dışı'}
                    </option>
                  ))}
                </Select>
              </div>
              {selected ? (
                <>
                  <Card className="p-4">
                    <div className="mb-4 flex flex-wrap items-center gap-3">
                      <Badge tone={selected.status === 'approved' ? 'success' : 'warning'}>
                        {selected.status === 'approved'
                          ? 'Kullanım için onaylı'
                          : selected.status === 'obsolete'
                            ? 'Kullanım dışı revizyon'
                            : 'Taslak çizim'}
                      </Badge>
                      {selected.status === 'draft' && can('projects.budget') && (
                        <Button onClick={() => void approve(selected)} disabled={busy}>
                          Kullanım için onayla
                        </Button>
                      )}
                      <Input
                        aria-label="PDF sayfa"
                        type="number"
                        min="1"
                        max="10000"
                        className="w-24"
                        value={page}
                        onChange={(e) => setPage(Math.max(1, Number(e.target.value) || 1))}
                      />
                      <Select
                        aria-label="Karşılaştırma revizyonu"
                        className="max-w-xs"
                        value={compareId}
                        onChange={(e) => setCompareId(e.target.value)}
                      >
                        <option value="">Revizyon karşılaştırması yok</option>
                        {drawings.data?.items
                          .filter((d) => d.code === selected.code && d.id !== selected.id)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              Rev {d.revision}
                            </option>
                          ))}
                      </Select>
                      {selected.status === 'approved' && writable && (
                        <Button onClick={() => setPinMode(!pinMode)}>
                          {pinMode ? 'İşaretlemeyi bitir' : 'Plana sorun işaretle'}
                        </Button>
                      )}
                    </div>
                    {selected.status !== 'approved' && (
                      <div className="mb-4">
                        <Callout tone="warning">
                          Bu çizim sahada kullanım için geçerli değildir.
                        </Callout>
                      </div>
                    )}
                    {bytes ? (
                      <DrawingCanvas
                        data={bytes}
                        previous={oldBytes}
                        page={page}
                        pins={pins.data?.items ?? []}
                        onPoint={
                          pinMode
                            ? (p) => {
                                setPoint(p);
                                open('pin');
                              }
                            : undefined
                        }
                      />
                    ) : (
                      <PageLoading />
                    )}
                  </Card>
                  <p className="text-xs text-muted">
                    Revizyon karşılaştırması sayfa genişliğine göre hizalanır. Farklı ölçek veya
                    sayfa düzeninde teknik kontrol gerekir.
                  </p>
                </>
              ) : (
                <Card>
                  <EmptyState title="Çizim seçin veya ilk PDF’yi yükleyin" />
                </Card>
              )}
            </div>
          )}
          {tab === 'field' && (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-3">
                {writable && (
                  <>
                    <Button variant="primary" onClick={() => open('photo')}>
                      <Camera className="size-4" />
                      İlerleme fotoğrafı
                    </Button>
                    <Button onClick={() => open('location')}>
                      <Plus className="size-4" />
                      Konum ekle
                    </Button>
                  </>
                )}
                <Link
                  to={`/workspace/operations?kind=site_report&projectId=${projectId}`}
                  className="self-center text-sm underline"
                >
                  Günlük saha raporları
                </Link>
              </div>
              <Card>
                <CardHeader title="Proje konumları" />
                {locations.data?.items.length ? (
                  <div className="flex flex-wrap gap-2 p-4">
                    {locations.data.items.map((l) => (
                      <Badge key={l.id}>
                        {l.kind === 'building' ? 'Yapı' : l.kind === 'level' ? 'Seviye' : 'Mahal'} ·{' '}
                        {l.name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="Önce yapı, seviye ve mahal ekleyin" />
                )}
              </Card>
              <PhotoTimeline photos={photos.data?.items ?? []} companyId={company.id} />
            </div>
          )}
          {['program', 'commercial', 'customer'].includes(tab) && (
            <Card>
              <CardHeader
                title={tabs.find((t) => t.key === tab)?.label ?? ''}
                description="Mevcut ERP süreçlerine proje bağlantıları."
              />
              <div className="flex flex-wrap gap-4 p-5">
                {tab === 'program' ? (
                  <Link
                    to={`/workspace/operations?kind=schedule&projectId=${projectId}`}
                    className="underline"
                  >
                    İş programı
                  </Link>
                ) : tab === 'commercial' ? (
                  <>
                    <Link to={`/projects/${projectId}`} className="underline">
                      Bütçe ve maliyet
                    </Link>
                    <Link to="/subcontracts" className="underline">
                      Sözleşme ve hakediş
                    </Link>
                    <Link to="/purchasing/requests" className="underline">
                      Satın alma
                    </Link>
                  </>
                ) : (
                  <>
                    <Link to="/real-estate/units" className="underline">
                      Birim envanteri
                    </Link>
                    <Link to={`/workspace/handover?projectId=${projectId}`} className="underline">
                      Teslim ve kusur
                    </Link>
                  </>
                )}
              </div>
            </Card>
          )}
          {['drawings', 'field', 'program', 'commercial', 'customer'].includes(tab) && (
            <WorkflowBoard
              key={projectId + tab}
              projectId={projectId}
              group={tab as 'drawings' | 'field' | 'program' | 'commercial' | 'customer'}
            />
          )}
          {tab === 'drawings' && <JobsPanel key={projectId} projectId={projectId} />}
          {tab === 'overview' && <AssistantPanel key={projectId} projectId={projectId} />}
        </>
      )}
      <Sheet
        open={panel !== null}
        onOpenChange={(v) => {
          if (!busy && !v) setPanel(null);
        }}
        title={
          panel === 'drawing'
            ? 'Çizim / revizyon ekle'
            : panel === 'location'
              ? 'Konum ekle'
              : panel === 'pin'
                ? 'Plan üzerinde sorun ve fotoğraf'
                : panel === 'photo'
                  ? 'İlerleme fotoğrafı'
                  : 'Çevrimdışı saha paketi'
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {panel === 'drawing' && (
            <>
              <Field label="Çizim kodu">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={form.code ?? ''}
                    onChange={(e) => update('code', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Başlık">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={form.title ?? ''}
                    onChange={(e) => update('title', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Disiplin">
                {(id) => (
                  <Select
                    id={id}
                    value={form.discipline}
                    onChange={(e) => update('discipline', e.target.value)}
                  >
                    <option value="architecture">Mimari</option>
                    <option value="civil">İnşaat</option>
                    <option value="mechanical">Mekanik</option>
                    <option value="electrical">Elektrik</option>
                    <option value="other">Diğer</option>
                  </Select>
                )}
              </Field>
              <Field label="Revizyon">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={form.revision ?? ''}
                    onChange={(e) => update('revision', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Önceki revizyon">
                {(id) => (
                  <Select
                    id={id}
                    value={form.previousId ?? ''}
                    onChange={(e) => {
                      const d = drawings.data?.items.find((d) => d.id === e.target.value);
                      setForm((f) => ({
                        ...f,
                        previousId: e.target.value,
                        ...(d ? { code: d.code, title: d.title, discipline: d.discipline } : {}),
                      }));
                    }}
                  >
                    <option value="">İlk revizyon</option>
                    {drawings.data?.items.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code} / {d.revision}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </>
          )}
          {panel === 'location' && (
            <>
              <Field label="Konum adı">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={form.name ?? ''}
                    onChange={(e) => update('name', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Konum türü">
                {(id) => (
                  <Select
                    id={id}
                    value={form.kind}
                    onChange={(e) => {
                      update('kind', e.target.value);
                      update('parentId', '');
                    }}
                  >
                    <option value="building">Yapı / blok</option>
                    <option value="level">Seviye / kat</option>
                    <option value="zone">Mahal / bölge</option>
                  </Select>
                )}
              </Field>
              {form.kind !== 'building' && (
                <Field label="Üst konum">
                  {(id) => (
                    <Select
                      id={id}
                      required
                      value={form.parentId ?? ''}
                      onChange={(e) => update('parentId', e.target.value)}
                    >
                      <option value="">Seçin</option>
                      {locations.data?.items
                        .filter((l) => l.kind === (form.kind === 'level' ? 'building' : 'level'))
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              )}
            </>
          )}
          {panel === 'pin' && (
            <>
              <Field label="Bağlanacak saha kaydı">
                {(id) => (
                  <Select
                    id={id}
                    value={form.recordId ?? ''}
                    onChange={(e) => update('recordId', e.target.value)}
                  >
                    <option value="">Yeni teknik talep oluştur</option>
                    {pinOptions.data?.operations
                      .filter((o) =>
                        [
                          'rfi',
                          'quality_check',
                          'safety',
                          'defect',
                          'site_report',
                          'site_instruction',
                        ].includes(o.kind),
                      )
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              {!form.recordId && (
                <>
                  <Field label="Talep başlığı">
                    {(id) => (
                      <Input
                        id={id}
                        required
                        value={form.title ?? ''}
                        onChange={(e) => update('title', e.target.value)}
                      />
                    )}
                  </Field>
                </>
              )}
              <Field label="Sorun fotoğrafı (isteğe bağlı)">
                {(id) => (
                  <Input
                    id={id}
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                )}
              </Field>
              {!form.recordId && (
                <>
                  <Field label="Teknik soru">
                    {(id) => (
                      <Textarea
                        id={id}
                        required
                        value={form.question ?? ''}
                        onChange={(e) => update('question', e.target.value)}
                      />
                    )}
                  </Field>
                </>
              )}
              <Field label="Termin">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    required
                    value={form.dueDate}
                    onChange={(e) => update('dueDate', e.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {(panel === 'pin' || panel === 'photo') && (
            <Field label="Konum">
              {(id) => (
                <Select
                  id={id}
                  required={panel === 'photo' || Boolean(file)}
                  value={form.locationId ?? ''}
                  onChange={(e) => update('locationId', e.target.value)}
                >
                  <option value="">Seçin</option>
                  {locations.data?.items.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {panel === 'photo' && (
            <>
              <Field label="Saha raporu / saha aksiyonu">
                {(id) => (
                  <Select
                    id={id}
                    value={form.operationId ?? ''}
                    onChange={(e) => update('operationId', e.target.value)}
                  >
                    <option value="">Bağımsız ilerleme fotoğrafı</option>
                    {pinOptions.data?.operations
                      .filter((o) =>
                        [
                          'site_report',
                          'rfi',
                          'quality_check',
                          'safety',
                          'site_instruction',
                        ].includes(o.kind),
                      )
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label="Çekim tarihi">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    required
                    value={form.date}
                    onChange={(e) => update('date', e.target.value)}
                  />
                )}
              </Field>
              <Field label="Fotoğraf açıklaması">
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={form.caption ?? ''}
                    onChange={(e) => update('caption', e.target.value)}
                  />
                )}
              </Field>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.panorama === 'true'}
                  onChange={(e) => update('panorama', String(e.target.checked))}
                />
                360° equirectangular fotoğraf
              </label>
            </>
          )}
          {(panel === 'photo' || panel === 'drawing') && (
            <Field label="Dosya (en fazla 25 MB)">
              {(id) => (
                <input
                  id={id}
                  required
                  aria-label="Dosya"
                  type="file"
                  accept={panel === 'drawing' ? 'application/pdf' : 'image/png,image/jpeg'}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              )}
            </Field>
          )}
          {panel === 'offline' && (
            <>
              <Callout>
                Seçili çizim ve konumlar 24 saat için cihazınıza şifrelenerek indirilir. Yeni paket,
                önceki paketin yerini alır; bekleyenleri önce eşitleyin.
              </Callout>
              <Field label="Cihaz kodu (en az 8 karakter)">
                {(id) => (
                  <Input
                    id={id}
                    required
                    type="password"
                    minLength={8}
                    value={form.password ?? ''}
                    onChange={(e) => update('password', e.target.value)}
                    autoComplete="new-password"
                  />
                )}
              </Field>
            </>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Kaydediliyor…' : panel === 'offline' ? 'Paketi indir' : 'Kaydet'}
          </Button>
        </form>
      </Sheet>
    </>
  );
}

function PhotoTimeline({ photos, companyId }: { photos: ProgressPhoto[]; companyId: string }) {
  const [panoramaId, setPanoramaId] = useState('');
  const [locationId, setLocationId] = useState(''),
    [chosen, setChosen] = useState<string[]>([]),
    [urls, setUrls] = useState<Record<string, string>>({});
  const displayed = useMemo(
    () => photos.filter((p) => !locationId || p.locationId === locationId),
    [photos, locationId],
  );
  useEffect(() => {
    let stopped = false;
    const made: string[] = [];
    void Promise.all(
      displayed.slice(0, 30).map(async (p) => {
        const r = await apiBlob(`/api/construction/assets/${p.assetId}/download`, { companyId });
        const u = URL.createObjectURL(r.blob);
        made.push(u);
        return [p.id, u] as const;
      }),
    )
      .then((rows) => {
        if (!stopped) setUrls(Object.fromEntries(rows));
      })
      .catch(() => {});
    return () => {
      stopped = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [displayed, companyId]);
  const places = [...new Map(photos.map((p) => [p.locationId, p.locationName])).entries()];
  return (
    <Card>
      <CardHeader
        title="Fotoğraflı ilerleme"
        description="Aynı konumdan iki tarihi seçerek karşılaştırın."
      />
      <div className="p-4">
        <Select
          aria-label="Fotoğraf konumu"
          value={locationId}
          onChange={(e) => {
            setLocationId(e.target.value);
            setChosen([]);
          }}
        >
          <option value="">Tüm konumlar</option>
          {places.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        {chosen.length === 2 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {chosen.map((id) => {
              const p = photos.find((p) => p.id === id)!;
              return (
                <div key={id}>
                  <img
                    src={urls[id]}
                    alt={p.caption}
                    className="h-64 w-full rounded-lg object-contain"
                  />
                  <p className="mt-2 text-sm">
                    {p.date} · {p.caption}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {displayed.slice(0, 30).map((p) => (
            <div key={p.id} className="overflow-hidden rounded-xl border border-border">
              <img
                src={urls[p.id]}
                alt={p.caption}
                loading="lazy"
                className="h-44 w-full bg-surface-2 object-cover"
              />
              <div className="space-y-2 p-3">
                <p>{p.caption}</p>
                <p className="text-xs text-muted">
                  {p.date} · {p.locationName}
                  {p.panorama ? ' · 360° kaynak' : ''}
                </p>
                {p.panorama && urls[p.id] && (
                  <Button size="sm" onClick={() => setPanoramaId(p.id)}>
                    360° görüntüyü aç
                  </Button>
                )}
                <label className="flex gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) =>
                      setChosen(
                        e.target.checked
                          ? [
                              ...chosen
                                .filter(
                                  (id) =>
                                    photos.find((x) => x.id === id)?.locationId === p.locationId,
                                )
                                .slice(-1),
                              p.id,
                            ]
                          : chosen.filter((id) => id !== p.id),
                      )
                    }
                  />
                  Karşılaştırmaya ekle
                </label>
              </div>
            </div>
          ))}
        </div>
        <Sheet
          open={Boolean(panoramaId)}
          onOpenChange={(v) => {
            if (!v) setPanoramaId('');
          }}
          title="360° saha fotoğrafı"
        >
          {urls[panoramaId] && (
            <Suspense fallback={<PageLoading />}>
              <PanoramaViewer url={urls[panoramaId]!} />
            </Suspense>
          )}
        </Sheet>
        {photos.length === 0 && <EmptyState title="İlk saha fotoğrafını ekleyin" />}
        {displayed.length > 30 && (
          <p className="mt-3 text-xs text-muted">
            İlk 30 fotoğraf gösteriliyor; konum seçerek kapsamı daraltın.
          </p>
        )}
      </div>
    </Card>
  );
}
