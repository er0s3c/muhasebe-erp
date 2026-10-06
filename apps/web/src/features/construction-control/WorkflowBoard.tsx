import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Printer, ArrowUpRight, History } from 'lucide-react';
import {
  WORKFLOW_GROUPS,
  WORKFLOW_LABELS,
  WORKFLOW_KINDS,
  measureDrawing,
  type WorkflowKind,
  type ConstructionWorkflow,
  type ConstructionLocation,
  type ConstructionDrawing,
  type Point,
} from '@erp/shared';
import { useCan, useCQuery, useCompanyApi, useNavigation } from '../../lib/queries';
import { apiBlob } from '../../lib/api';
import { Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Badge } from '../../components/ui/Badge';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { DrawingCanvas } from './DrawingCanvas';
import { EDITOR_FIELDS, fieldDefaults, type EditorField } from './fields';
import { ProgramPanel } from './ProgramPanel';
import QRCode from 'qrcode';
import { saveBlob } from '../../lib/download';
type Option = {
  id: string;
  label: string;
  kind?: string;
  unit?: string;
  subcontractId?: string;
  wbsId?: string;
  unitId?: string;
};
type Options = Record<string, Option[]>;
const statuses: Record<string, string> = {
  draft: 'Taslak',
  submitted: 'Onay bekliyor',
  approved: 'Onaylı',
  rejected: 'Reddedildi',
  closed: 'Kapalı',
  cancelled: 'İptal',
  contacted: 'Görüşüldü',
  visited: 'Ziyaret',
  offered: 'Teklif',
  reserved: 'Rezervasyon',
  contracted: 'Sözleşmeli',
  lost: 'Kaybedildi',
};
function area(kind: WorkflowKind) {
  return ['feasibility', 'lead', 'buyer_option', 'warranty', 'passport'].includes(kind)
    ? 'realestate'
    : ['rate_analysis', 'tender', 'material_need', 'submittal'].includes(kind)
      ? 'procurement'
      : ['production', 'change_event', 'delay_claim'].includes(kind)
        ? 'subcontracts'
        : 'projects';
}
function linkFor(kind: string, id: string) {
  return kind === 'project'
    ? `/projects/${id}`
    : kind === 'sales_contract'
      ? `/real-estate/contracts/${id}`
      : kind === 'purchase_request'
        ? `/purchasing/requests/${id}`
        : kind === 'variation_order'
          ? `/variation-orders/${id}`
          : kind === 'progress_payment'
            ? `/progress-payments/${id}`
            : kind === 'quality_check'
              ? `/workspace/operations?kind=quality_check&open=${id}`
              : '#';
}

export function WorkflowBoard({
  projectId,
  group,
}: {
  projectId: string;
  group: 'drawings' | 'field' | 'program' | 'commercial' | 'customer';
}) {
  const [params] = useSearchParams();
  const can = useCan(),
    { call, company } = useCompanyApi();
  const navigation = useNavigation();
  const kinds = WORKFLOW_KINDS.filter(
    (k) =>
      WORKFLOW_GROUPS[k] === group &&
      (navigation.data?.modules.includes(
        {
          projects: 'construction.projects',
          procurement: 'construction.procurement',
          subcontracts: 'construction.subcontracts',
          realestate: 'construction.realestate',
        }[area(k)]!,
      ) ??
        false) &&
      can(`${area(k)}.read`) &&
      (k !== 'forecast' || can('ledger.read')),
  );
  const [chosen, setChosen] = useState<WorkflowKind | null>(
    params.has('passport') ? 'passport' : null,
  );
  const records = useCQuery<{ items: ConstructionWorkflow[] }>(
    ['control', 'workflows', projectId],
    `/api/construction/workflows?projectId=${projectId}`,
  );
  const focusId = params.get('open') ?? params.get('passport');
  const focusKind = records.data?.items.find((r) => r.id === focusId)?.kind;
  const kind =
    chosen && kinds.includes(chosen)
      ? chosen
      : focusKind && kinds.includes(focusKind)
        ? focusKind
        : kinds[0];
  useEffect(() => {
    if (focusId && records.data)
      document.getElementById('workflow-' + focusId)?.scrollIntoView({ block: 'center' });
  }, [focusId, records.data, kind]);
  const opts = useCQuery<Options>(
    ['control', 'options', projectId],
    `/api/construction/options?projectId=${projectId}`,
  );
  const locations = useCQuery<{ items: ConstructionLocation[] }>(
    ['control', 'locations', projectId],
    `/api/construction/locations?projectId=${projectId}`,
  );
  const drawings = useCQuery<{ items: ConstructionDrawing[] }>(
    ['control', 'drawings', projectId],
    `/api/construction/drawings?projectId=${projectId}`,
  );
  const [editor, setEditor] = useState<{ row: ConstructionWorkflow | null } | null>(null),
    [title, setTitle] = useState(''),
    [payload, setPayload] = useState<Record<string, unknown>>({}),
    [locationId, setLocationId] = useState(''),
    [wbsId, setWbsId] = useState(''),
    [ownerId, setOwnerId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<{ row: ConstructionWorkflow; action: string } | null>(
      null,
    ),
    [note, setNote] = useState(''),
    [quantity, setQuantity] = useState(''),
    [contractId, setContractId] = useState(''),
    [historyId, setHistoryId] = useState<string | null>(null);
  const events = useCQuery<{
    items: { action: string; note: string; at: string; byName: string }[];
  }>(
    ['control', 'history', historyId],
    historyId ? `/api/construction/workflows/${historyId}/events` : null,
  );
  const editable =
    kind && can(`${area(kind)}.manage`) && (kind !== 'forecast' || can('projects.budget'));
  const approving =
    kind && can(area(kind) === 'projects' ? 'projects.budget' : `${area(kind)}.approve`);
  const sources = useMemo(() => {
    const o = { ...(opts.data ?? {}) };
    const ops = o.operations ?? [];
    o.schedule = ops.filter((x) => x.kind === 'schedule');
    o.equipment = o.equipment ?? ops.filter((x) => x.kind === 'equipment');
    o.changeOperation = ops.filter((x) => ['rfi', 'site_instruction'].includes(x.kind ?? ''));
    o.drawings = (drawings.data?.items ?? [])
      .filter((x) => x.status === 'approved')
      .map((x) => ({ id: x.id, label: `${x.code} / ${x.revision}` }));
    for (const k of WORKFLOW_KINDS)
      o[k] = (records.data?.items ?? [])
        .filter((x) => x.kind === k && (k === 'tender' || x.status === 'approved'))
        .map((x) => ({ id: x.id, label: x.title }));
    if (payload.subcontractId)
      o.boq = (o.boq ?? []).filter((x) => x.subcontractId === payload.subcontractId);
    if (payload.unitId)
      o.salesContracts = (o.salesContracts ?? []).filter((x) => x.unitId === payload.unitId);
    return o;
  }, [opts.data, drawings.data, records.data, payload.subcontractId, payload.unitId]);
  function start(row: ConstructionWorkflow | null) {
    if (!kind) return;
    setError('');
    setEditor({ row });
    setTitle(row?.title ?? '');
    setPayload(row?.payload ?? fieldDefaults(EDITOR_FIELDS[kind], company.baseCurrency));
    setLocationId(row?.locationId ?? '');
    setWbsId(row?.wbsId ?? '');
    setOwnerId(row?.ownerId ?? '');
  }
  const update = useCallback(
    (key: string, value: unknown) => {
      setPayload((p) => ({ ...p, [key]: value }));
      if (key === 'lineKey') {
        const b = sources.boq?.find((x) => x.id === value);
        if (b) {
          setWbsId(b.wbsId ?? '');
          setPayload((p) => ({ ...p, unit: b.unit ?? '' }));
        }
      }
      if (key === 'itemId') {
        const item = sources.items?.find((x) => x.id === value);
        if (item?.unit) setPayload((p) => ({ ...p, unit: item.unit }));
      }
    },
    [sources.boq, sources.items],
  );
  const serviceFields: EditorField[] = [
    ...EDITOR_FIELDS.warranty.filter((f) =>
      ['appointment', 'contractorId', 'coverage', 'customerConfirmation'].includes(f.key),
    ),
    { key: 'resolution', label: 'Çözüm / kapsam dışı açıklaması', type: 'note', optional: true },
  ];
  const serviceEdit = kind === 'warranty' && editor?.row?.status === 'approved';
  const labEdit = kind === 'concrete' && editor?.row?.status === 'approved';
  const labFields: EditorField[] = [
    {
      ...EDITOR_FIELDS.concrete.find((f) => f.key === 'samples')!,
      fixedRows: true,
      fields: EDITOR_FIELDS.concrete
        .find((f) => f.key === 'samples')!
        .fields!.map((f) => ({ ...f, readOnly: f.key !== 'strength' })),
    },
    { key: 'note', label: 'Laboratuvar sonucu / düzeltme gerekçesi', type: 'note' },
    {
      key: 'assetIds',
      label: 'Laboratuvar belgeleri',
      type: 'refs',
      source: 'assets',
      optional: true,
    },
  ];
  async function save() {
    if (!kind || !editor) return;
    setBusy(true);
    setError('');
    try {
      const clean = cleanFields(
        serviceEdit ? serviceFields : labEdit ? labFields : EDITOR_FIELDS[kind],
        payload,
      );
      if (kind === 'takeoff')
        for (const field of ['points', 'pageWidth', 'pageHeight', 'unitsPerPixel'])
          clean[field] = payload[field];
      const body = {
        projectId,
        kind,
        title,
        locationId: locationId || null,
        wbsId: wbsId || null,
        ...(ownerId ? { ownerId } : {}),
        payload: clean,
        ...(editor.row ? { version: editor.row.version } : {}),
      };
      if (serviceEdit) {
        await call(`/api/construction/workflows/${editor.row!.id}/service`, {
          method: 'POST',
          body: { version: editor.row!.version, ...clean },
        });
      } else if (labEdit)
        await call(`/api/construction/workflows/${editor.row!.id}/concrete-results`, {
          method: 'POST',
          body: { version: editor.row!.version, ...clean },
        });
      else
        await call(
          editor.row
            ? `/api/construction/workflows/${editor.row.id}`
            : '/api/construction/workflows',
          { method: editor.row ? 'PUT' : 'POST', body },
        );
      setEditor(null);
      await records.refetch();
      await opts.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decide() {
    if (!decision) return;
    setBusy(true);
    setError('');
    try {
      await call(
        `/api/construction/workflows/${decision.row.id}/${decision.action === 'transfer' ? 'transfer' : 'decision'}`,
        {
          method: 'POST',
          body:
            decision.action === 'transfer'
              ? {
                  version: decision.row.version,
                  ...(quantity ? { quantity: Number(quantity) } : {}),
                }
              : {
                  version: decision.row.version,
                  action: decision.action,
                  note,
                  ...(contractId ? { contractId } : {}),
                },
        },
      );
      setDecision(null);
      await records.refetch();
      await opts.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function action(row: ConstructionWorkflow, act: string) {
    setDecision({ row, action: act });
    setNote('');
    setError('');
    setQuantity('');
    setContractId('');
  }
  const rows = (records.data?.items ?? []).filter((r) => r.kind === kind);
  if (!kind) return null;
  return (
    <div className="mt-5 space-y-5">
      {group === 'program' && <ProgramPanel projectId={projectId} />}
      {group === 'commercial' && <Scorecards projectId={projectId} />}
      {group === 'customer' && <SalesPipeline projectId={projectId} />}
      {group === 'field' && can('hr.read') && <Productivity projectId={projectId} />}
      <Card>
        <CardHeader
          title="Proje süreçleri"
          description="Taslak, onay ve kaynak bağlantılarıyla izlenebilir kayıtlar."
        />
        <div className="flex flex-wrap gap-2 border-b border-border p-4">
          {kinds.map((k) => (
            <Button key={k} variant={k === kind ? 'primary' : 'ghost'} onClick={() => setChosen(k)}>
              {WORKFLOW_LABELS[k]}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <h2>{WORKFLOW_LABELS[kind]}</h2>
          <div className="flex flex-wrap gap-2">
            {kind === 'takeoff' && (
              <Button
                onClick={() =>
                  void apiBlob(`/api/construction/takeoff-export?projectId=${projectId}`, {
                    companyId: company.id,
                  })
                    .then((r) => saveBlob(r.blob, 'metraj.xlsx'))
                    .catch((e) => setError(e.message))
                }
              >
                Excel indir
              </Button>
            )}
            <Button onClick={() => window.print()}>
              <Printer className="size-4" />
              Yazdır
            </Button>
            {editable && (
              <Button variant="primary" onClick={() => start(null)}>
                <Plus className="size-4" />
                Yeni kayıt
              </Button>
            )}
          </div>
        </div>
        {records.isPending ? (
          <PageLoading />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Henüz kayıt yok"
            description="İlk kaydı oluşturup incelemeye gönderebilirsiniz."
          />
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              id={'workflow-' + r.id}
              className={`space-y-3 border-t border-border p-5 ${focusId === r.id ? 'bg-surface-raised ring-1 ring-inset ring-border' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p>{r.title}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge
                      tone={
                        r.status === 'approved'
                          ? 'success'
                          : r.status === 'rejected'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {statuses[r.status] ?? r.status}
                    </Badge>
                    <span className="text-xs text-muted">
                      {new Date(r.createdAt).toLocaleDateString('tr-TR')} · Rev {r.version}
                    </span>
                    {r.kind === 'permit' &&
                      String(r.payload.end) < new Date().toISOString().slice(0, 10) && (
                        <Badge tone="danger">Geçerlilik süresi doldu</Badge>
                      )}
                    {r.kind === 'lead' &&
                      r.status === 'reserved' &&
                      String(r.payload.reservationUntil) <
                        new Date().toISOString().slice(0, 10) && (
                        <Badge tone="warning">Rezervasyon süresi doldu</Badge>
                      )}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => setHistoryId(r.id)}>
                  <History className="size-4" />
                  Geçmiş
                </Button>
              </div>
              <RecordDetails row={r} sources={sources} />
              <ComputedDetails values={r.computed} />
              <RecordRows row={r} sources={sources} />
              {r.kind === 'warranty' && Boolean(r.payload.resolution) && (
                <p className="text-sm">Çözüm: {String(r.payload.resolution)}</p>
              )}
              {r.kind === 'passport' && ['approved', 'closed'].includes(r.status) && (
                <PassportQr projectId={projectId} id={r.id} />
              )}
              {r.kind === 'warranty' && r.status === 'approved' && editable && (
                <Button onClick={() => start(r)}>Servis ataması ve çözüm</Button>
              )}
              {r.kind === 'concrete' && r.status === 'approved' && approving && (
                <Button onClick={() => start(r)}>Laboratuvar sonuçları</Button>
              )}
              {r.kind === 'tender' && r.status === 'approved' && !r.linkedId && editable && (
                <Button variant="ghost" onClick={() => action(r, 'lost')}>
                  İhale kaybedildi
                </Button>
              )}
              {r.kind === 'lead' && r.status === 'reserved' && editable && (
                <Link
                  to={`/real-estate/contracts/new?unitId=${r.payload.unitId}&partyId=${r.payload.partyId ?? ''}&reservationLeadId=${r.id}&projectId=${projectId}`}
                  className="inline-block text-sm underline"
                >
                  Rezervasyondan satış sözleşmesi oluştur
                </Link>
              )}
              <div className="flex flex-wrap gap-2">
                {editable &&
                  (r.status === 'draft' ||
                    (r.kind === 'lead' &&
                      ['contacted', 'visited', 'offered'].includes(r.status))) && (
                    <Button onClick={() => start(r)}>Düzenle</Button>
                  )}
                {r.kind === 'lead' ? (
                  <>
                    {editable &&
                      ['draft', 'contacted', 'visited', 'offered', 'reserved'].includes(
                        r.status,
                      ) && (
                        <Button
                          onClick={() =>
                            action(
                              r,
                              ['contacted', 'visited', 'offered', 'reserved', 'contracted'][
                                ['draft', 'contacted', 'visited', 'offered', 'reserved'].indexOf(
                                  r.status,
                                )
                              ]!,
                            )
                          }
                        >
                          {
                            statuses[
                              ['contacted', 'visited', 'offered', 'reserved', 'contracted'][
                                ['draft', 'contacted', 'visited', 'offered', 'reserved'].indexOf(
                                  r.status,
                                )
                              ]!
                            ]
                          }
                        </Button>
                      )}
                    {editable && r.status !== 'contracted' && r.status !== 'lost' && (
                      <Button variant="ghost" onClick={() => action(r, 'lost')}>
                        Kaybedildi
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    {editable && r.status === 'draft' && (
                      <Button onClick={() => action(r, 'submit')}>Onaya gönder</Button>
                    )}
                    {approving && r.status === 'submitted' && (
                      <>
                        <Button onClick={() => action(r, 'approve')}>Onayla</Button>
                        <Button variant="ghost" onClick={() => action(r, 'reject')}>
                          Reddet
                        </Button>
                      </>
                    )}
                    {editable && r.status === 'approved' && (
                      <Button onClick={() => action(r, 'close')}>Kapat</Button>
                    )}
                    {editable &&
                      ['draft', 'submitted', 'approved'].includes(r.status) &&
                      !r.linkedId && (
                        <Button variant="ghost" onClick={() => action(r, 'cancel')}>
                          İptal
                        </Button>
                      )}
                  </>
                )}
                {editable &&
                  r.status === 'approved' &&
                  [
                    'production',
                    'material_need',
                    'change_event',
                    'tender',
                    'buyer_option',
                  ].includes(r.kind) &&
                  (!r.linkedId || r.kind === 'production') && (
                    <Button onClick={() => action(r, 'transfer')}>
                      {r.kind === 'production'
                        ? 'Hakediş taslağı'
                        : r.kind === 'change_event'
                          ? 'Değişiklik emri taslağı'
                          : r.kind === 'tender'
                            ? 'Kazanıldı: proje ve bütçe oluştur'
                            : 'Satın alma talebi oluştur'}
                    </Button>
                  )}
                {r.linkedId && (
                  <Link
                    className="inline-flex items-center gap-1 self-center text-sm underline"
                    to={linkFor(r.linkedKind!, r.linkedId)}
                  >
                    Bağlı ERP kaydı
                    <ArrowUpRight className="size-3" />
                  </Link>
                )}
                {r.kind === 'passport' && r.status === 'approved' && (
                  <Link
                    to={`/workspace/project-control?projectId=${projectId}&tab=customer&passport=${r.id}`}
                    className="text-sm underline"
                  >
                    Birim pasaportu bağlantısı
                  </Link>
                )}
              </div>
            </div>
          ))
        )}
        {records.data && records.data.items.length >= 500 && (
          <p className="p-4 text-xs text-muted">En son 500 süreç kaydı gösteriliyor.</p>
        )}
      </Card>
      <Sheet
        open={editor !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setEditor(null);
        }}
        title={`${WORKFLOW_LABELS[kind]} · ${editor?.row ? 'Düzenle' : 'Yeni kayıt'}`}
        wide
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Başlık">
            {(id) => (
              <Input
                id={id}
                required
                readOnly={serviceEdit || labEdit}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>
          {!serviceEdit && !labEdit && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Konum">
                {(id) => (
                  <Select
                    id={id}
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                  >
                    <option value="">Konum seçin</option>
                    {locations.data?.items.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="İş kalemi">
                {(id) => (
                  <Select id={id} value={wbsId} onChange={(e) => setWbsId(e.target.value)}>
                    <option value="">İş kalemi seçin</option>
                    {sources.wbs?.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Sorumlu">
                {(id) => (
                  <Select id={id} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">Ben</option>
                    {sources.owners?.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          <EditorFields
            fields={serviceEdit ? serviceFields : labEdit ? labFields : EDITOR_FIELDS[kind]}
            value={payload}
            onChange={update}
            sources={sources}
          />
          {kind === 'takeoff' && (
            <TakeoffEditor payload={payload} update={update} projectId={projectId} />
          )}
          {kind === 'baseline' && (
            <Callout>
              Kaydedildiği andaki iş programı kopyalanır. Onay sonrası başlangıç planı değişmez.
            </Callout>
          )}
          {kind === 'forecast' && (
            <Callout>
              Kalan maliyet tahmini taahhütler dahil tüm kalan işi kapsamalıdır. Gerçekleşen maliyet
              defterden alınır; taahhüt ikinci kez eklenmez.
            </Callout>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? 'Kaydediliyor…' : 'Taslağı kaydet'}
          </Button>
        </form>
      </Sheet>
      <Sheet
        open={decision !== null}
        onOpenChange={(v) => {
          if (!busy && !v) setDecision(null);
        }}
        title={decision?.action === 'transfer' ? 'ERP taslağı oluştur' : 'Durum değişikliği'}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void decide();
          }}
        >
          <p>{decision?.row.title}</p>
          {decision?.action !== 'transfer' && (
            <Field label="Gerekçe / açıklama">
              {(id) => (
                <Textarea
                  id={id}
                  required
                  minLength={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
          )}
          {decision?.action === 'contracted' && (
            <Field label="Satış sözleşmesi">
              {(id) => (
                <Select
                  id={id}
                  required
                  value={contractId}
                  onChange={(e) => setContractId(e.target.value)}
                >
                  <option value="">Seçin</option>
                  {sources.salesContracts?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {decision?.action === 'transfer' && decision.row.kind === 'production' && (
            <Field label="Aktarılacak miktar (boşsa tümü)">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min="0.0001"
                  step=".0001"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              )}
            </Field>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
          <Button variant="primary" type="submit" disabled={busy}>
            Uygula
          </Button>
        </form>
      </Sheet>
      <Sheet
        open={historyId !== null}
        onOpenChange={(v) => {
          if (!v) setHistoryId(null);
        }}
        title="İşlem geçmişi"
      >
        {events.data?.items.map((e, i) => (
          <div key={i} className="mb-4 border-b border-border pb-4">
            <p>{e.note}</p>
            <p className="mt-1 text-xs text-muted">
              {e.byName} · {new Date(e.at).toLocaleString('tr-TR')}
            </p>
          </div>
        ))}
      </Sheet>
    </div>
  );
}

function cleanFields(
  fields: EditorField[],
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const v = value[f.key];
      if (f.optional && (v === '' || v === undefined || (v === null && f.default !== null)))
        return [];
      if (f.type === 'rows')
        return [
          [f.key, ((v ?? []) as Record<string, unknown>[]).map((r) => cleanFields(f.fields!, r))],
        ];
      return [[f.key, v]];
    }),
  );
}
function EditorFields({
  fields,
  value,
  onChange,
  sources,
}: {
  fields: EditorField[];
  value: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  sources: Options;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        const v = value[f.key];
        if (f.type === 'rows') {
          const rows = (v ?? []) as Record<string, unknown>[];
          return (
            <div
              key={f.key}
              className="space-y-3 rounded-xl border border-border p-4 sm:col-span-2"
            >
              <div className="flex items-center justify-between">
                <p>{f.label}</p>
                <Button
                  type="button"
                  size="sm"
                  disabled={f.fixedRows}
                  onClick={() => onChange(f.key, [...rows, fieldDefaults(f.fields!)])}
                >
                  Satır ekle
                </Button>
              </div>
              {rows.map((row, i) => (
                <div key={i} className="space-y-2 border-t border-border pt-3">
                  <EditorFields
                    fields={f.fields!}
                    value={row}
                    onChange={(key, next) =>
                      onChange(
                        f.key,
                        rows.map((r, n) => (n === i ? { ...r, [key]: next } : r)),
                      )
                    }
                    sources={sources}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={f.fixedRows}
                    onClick={() =>
                      onChange(
                        f.key,
                        rows.filter((_, n) => n !== i),
                      )
                    }
                  >
                    Satırı kaldır
                  </Button>
                </div>
              ))}
            </div>
          );
        }
        if (f.type === 'refs' || f.type === 'days') {
          const ids = (v ?? []) as (string | number)[];
          const options =
            f.type === 'days'
              ? ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'].map(
                  (label, id) => ({ id, label }),
                )
              : (sources[f.source!] ?? []);
          return (
            <fieldset key={f.key} className="rounded-lg border border-border p-3">
              <legend className="px-1 text-sm">{f.label}</legend>
              <div className="max-h-44 space-y-2 overflow-auto">
                {options.map((o) => (
                  <label key={o.id} className="flex gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={ids.includes(o.id)}
                      onChange={(e) =>
                        onChange(
                          f.key,
                          e.target.checked ? [...ids, o.id] : ids.filter((id) => id !== o.id),
                        )
                      }
                    />
                    {o.label}
                  </label>
                ))}
                {options.length === 0 && (
                  <p className="text-xs text-muted">Seçilebilir kayıt yok.</p>
                )}
              </div>
            </fieldset>
          );
        }
        if (f.type === 'checkbox')
          return (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(v)}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
              {f.label}
            </label>
          );
        return (
          <Field
            key={f.key}
            label={f.label}
            hint={f.type === 'dates' ? 'Her satıra YYYY-AA-GG biçiminde bir tarih.' : undefined}
          >
            {(id) =>
              f.type === 'note' || f.type === 'dates' ? (
                <Textarea
                  id={id}
                  required={!f.optional}
                  value={f.type === 'dates' ? ((v ?? []) as string[]).join('\n') : String(v ?? '')}
                  onChange={(e) =>
                    onChange(
                      f.key,
                      f.type === 'dates'
                        ? e.target.value.split('\n').filter(Boolean)
                        : e.target.value,
                    )
                  }
                />
              ) : f.type === 'select' ? (
                <Select
                  id={id}
                  required={!f.optional}
                  value={String(v ?? '')}
                  onChange={(e) => onChange(f.key, e.target.value)}
                >
                  {f.source && <option value="">Seçin</option>}
                  {f.options?.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                  {(sources[f.source ?? ''] ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={id}
                  required={!f.optional}
                  type={
                    f.type === 'number' || f.type === 'money'
                      ? 'number'
                      : f.type === 'date'
                        ? 'date'
                        : 'text'
                  }
                  min={f.type === 'number' || f.type === 'money' ? 0 : undefined}
                  readOnly={f.readOnly}
                  step={f.type === 'number' || f.type === 'money' ? 'any' : undefined}
                  value={String(v ?? '')}
                  onChange={(e) =>
                    onChange(
                      f.key,
                      f.type === 'number'
                        ? e.target.value === ''
                          ? f.optional
                            ? null
                            : 0
                          : Number(e.target.value)
                        : e.target.value,
                    )
                  }
                />
              )
            }
          </Field>
        );
      })}
    </div>
  );
}
function RecordDetails({ row, sources }: { row: ConstructionWorkflow; sources: Options }) {
  const fields = EDITOR_FIELDS[row.kind];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted">
      {fields
        .filter(
          (f) =>
            !['rows', 'refs', 'days', 'dates'].includes(f.type ?? '') &&
            row.payload[f.key] !== undefined &&
            row.payload[f.key] !== '',
        )
        .map((f) => {
          const value = row.payload[f.key];
          const label =
            f.options?.find(([key]) => key === value)?.[1] ??
            sources[f.source ?? '']?.find((o) => o.id === value)?.label ??
            (typeof value === 'boolean' ? (value ? 'Hazır' : 'Bekliyor') : String(value));
          return (
            <span key={f.key}>
              {f.label}: {label}
            </span>
          );
        })}
    </div>
  );
}
function RecordRows({ row, sources }: { row: ConstructionWorkflow; sources: Options }) {
  const { company } = useCompanyApi(),
    [error, setError] = useState('');
  const render = (f: EditorField, v: unknown): string =>
    v === null
      ? 'Sonuç yok'
      : (f.options?.find(([key]) => key === v)?.[1] ??
        sources[f.source ?? '']?.find((o) => o.id === v)?.label ??
        (typeof v === 'boolean' ? (v ? 'Tamam' : 'Bekliyor') : String(v ?? '—')));
  const download = (assetId: string) =>
    void apiBlob(`/api/construction/assets/${assetId}/download`, { companyId: company.id })
      .then((r) => saveBlob(r.blob, r.filename ?? 'proje-belgesi'))
      .catch((e) => setError(e.message));
  return (
    <div className="space-y-3">
      {EDITOR_FIELDS[row.kind]
        .filter((f) => f.type === 'rows' || f.type === 'refs')
        .map((f) => {
          const values = row.payload[f.key] as unknown[] | undefined;
          if (!values?.length) return null;
          return (
            <details
              key={f.key}
              className="rounded-lg border border-border p-3"
              open={row.kind === 'passport' || row.kind === 'delay_claim'}
            >
              <summary className="cursor-pointer text-sm">
                {f.label} · {values.length} kayıt
              </summary>
              <div className="mt-3 space-y-3">
                {f.type === 'refs'
                  ? values.map((v, i) => (
                      <p key={i} className="text-xs">
                        {render(f, v)}
                        {f.source === 'assets' && (
                          <Button size="sm" variant="ghost" onClick={() => download(String(v))}>
                            Belgeyi aç
                          </Button>
                        )}
                      </p>
                    ))
                  : (values as Record<string, unknown>[]).map((v, i) => (
                      <div
                        key={i}
                        className="flex flex-wrap gap-3 border-t border-border pt-3 text-xs"
                      >
                        {f.fields?.map((field) =>
                          field.type === 'refs' ? (
                            <span key={field.key}>
                              {field.label}:{' '}
                              {((v[field.key] ?? []) as string[]).map((id, n) => (
                                <Button
                                  key={id}
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => download(id)}
                                >
                                  Belge {n + 1}
                                </Button>
                              ))}
                            </span>
                          ) : (
                            <span key={field.key}>
                              {field.label}: {render(field, v[field.key])}
                              {field.source === 'assets' && Boolean(v[field.key]) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => download(String(v[field.key]))}
                                >
                                  Kanıtı aç
                                </Button>
                              )}
                            </span>
                          ),
                        )}
                      </div>
                    ))}
              </div>
            </details>
          );
        })}
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}
function PassportQr({ projectId, id }: { projectId: string; id: string }) {
  const [src, setSrc] = useState('');
  const url = new URL(
    `/workspace/project-control?projectId=${projectId}&tab=customer&passport=${id}`,
    location.origin,
  ).href;
  useEffect(() => {
    void QRCode.toDataURL(url, {
      width: 160,
      margin: 2,
      color: { dark: '#191919', light: '#ffffff' },
    }).then(setSrc);
  }, [url]);
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border p-3">
      {src && <img src={src} alt="Birim pasaportu için QR bağlantısı" className="size-28" />}
      <div>
        <Link to={url} className="text-sm underline">
          Birim pasaportunu aç
        </Link>
        <p className="mt-2 text-xs text-muted">
          QR bağlantısı yetkili ERP oturumu gerektirir. Alıcı erişimi müşteri portalından
          paylaşılır.
        </p>
      </div>
    </div>
  );
}
const computedLabels: Record<string, string> = {
  operatingHours: 'Kayıtlı çalışma saati',
  hourRecords: 'Saat kaydı sayısı',
  hoursDue: 'Saat esaslı bakım gerekli',
  downtimeDays: 'Kullanılamama süresi (gün)',
  unitPrice: 'Hesaplanan birim fiyat',
  quantity: 'Ölçülen miktar',
  revenue: 'Beklenen gelir',
  totalCost: 'Toplam maliyet',
  profit: 'Tahmini kâr',
  fundingNeed: 'En yüksek nakit ihtiyacı',
  cost: 'Teklif maliyeti',
  offer: 'Teklif bedeli',
  actual: 'Gerçekleşen maliyet',
  budget: 'Bütçe',
  remaining: 'Kalan maliyet',
  eac: 'Tahmini toplam maliyet',
  stock: 'Eldeki stok',
  reserved: 'Ayrılan stok',
  available: 'Serbest stok',
  openOrder: 'Açık sipariş',
  shortage: 'Eksik miktar',
  orderBy: 'Sipariş için son tarih',
  overdue: 'Geciken numune',
  failed: 'Uygunsuz sonuç',
  ready: 'İşe hazır',
  currency: 'Para birimi',
  unit: 'Birim',
  method: 'Hesaplama yöntemi',
  blockers: 'Eksikler',
};
function ComputedDetails({ values }: { values: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(values)
        .filter(
          ([k, v]) =>
            computedLabels[k] && (v === null || typeof v !== 'object' || k === 'blockers'),
        )
        .map(([k, v]) => (
          <span key={k} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
            {computedLabels[k]}:{' '}
            {Array.isArray(v)
              ? v.join(', ')
              : typeof v === 'boolean'
                ? v
                  ? 'Evet'
                  : 'Hayır'
                : v === null
                  ? 'Veri eksik'
                  : String(v)}
          </span>
        ))}
    </div>
  );
}

function TakeoffEditor({
  payload,
  update,
  projectId,
}: {
  payload: Record<string, unknown>;
  update: (key: string, value: unknown) => void;
  projectId: string;
}) {
  const { company } = useCompanyApi();
  const drawings = useCQuery<{ items: ConstructionDrawing[] }>(
    ['control', 'drawings', projectId],
    `/api/construction/drawings?projectId=${projectId}`,
  );
  const drawing = drawings.data?.items.find((x) => x.id === payload.drawingId);
  const [bytes, setBytes] = useState<Uint8Array | null>(null),
    [calibrating, setCalibrating] = useState(true),
    [calibration, setCalibration] = useState<Point[]>([]),
    [distance, setDistance] = useState(''),
    [error, setError] = useState('');
  const callback = useCallback(
    (width: number, height: number) => {
      update('pageWidth', width);
      update('pageHeight', height);
    },
    [update],
  );
  useEffect(() => {
    let active = true;
    if (!drawing) return;
    void apiBlob(`/api/construction/assets/${drawing.assetId}/download`, { companyId: company.id })
      .then(async (r) => {
        const b = new Uint8Array(await r.blob.arrayBuffer());
        if (active) setBytes(b);
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [drawing, company.id]);
  const points = (payload.points ?? []) as Point[];
  let result: number | null = null;
  try {
    if (points.length)
      result = measureDrawing(
        points,
        payload.kind as 'length' | 'area' | 'count',
        Number(payload.pageWidth),
        Number(payload.pageHeight),
        Number(payload.unitsPerPixel),
      );
  } catch {
    /* Incomplete calibration. */
  }
  return (
    <div className="space-y-3">
      <Callout>
        Önce çizimde uzunluğu bilinen iki noktayı seçip ölçeği tanımlayın. Ardından ölçüm
        noktalarını yerleştirin.
      </Callout>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => {
            setCalibrating(true);
            setCalibration([]);
          }}
        >
          Ölçek çiz
        </Button>
        <Input
          aria-label="Bilinen uzunluk"
          type="number"
          min=".001"
          step="any"
          value={distance}
          onChange={(e) => setDistance(e.target.value)}
          className="max-w-36"
        />
        <Button
          type="button"
          disabled={calibration.length !== 2 || Number(distance) <= 0}
          onClick={() => {
            const [a, b] = calibration as [Point, Point];
            const px = Math.hypot(
              (a.x - b.x) * Number(payload.pageWidth),
              (a.y - b.y) * Number(payload.pageHeight),
            );
            if (px === 0) {
              setError('Ölçek noktaları farklı olmalı.');
              return;
            }
            update('unitsPerPixel', Number(distance) / px);
            setCalibrating(false);
          }}
        >
          Ölçeği uygula
        </Button>
        <Button type="button" onClick={() => update('points', [])}>
          Ölçümü temizle
        </Button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      {bytes && (
        <DrawingCanvas
          data={bytes}
          page={Number(payload.page) || 1}
          points={calibrating ? calibration : points}
          onDimensions={callback}
          onPoint={(p) =>
            calibrating
              ? setCalibration((v) => [...v.slice(-1), p])
              : update('points', [...points, p])
          }
        />
      )}
      <p className="text-sm">
        {calibrating
          ? 'Ölçek noktalarını seçin'
          : `Ölçüm: ${result ?? '—'} ${String(payload.unit ?? '')}`}
      </p>
    </div>
  );
}

function Productivity({ projectId }: { projectId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const data = useCQuery<{
    items: {
      wbsId: string;
      unit: string;
      quantity: string;
      hours: string;
      perHour: string | null;
      planVariance: string;
      note: string;
    }[];
  }>(
    ['control', 'productivity', projectId],
    `/api/construction/productivity?projectId=${projectId}&from=${today.slice(0, 8)}01&to=${today}`,
    { allowForbidden: true },
  );
  if (!data.data) return null;
  return (
    <Card>
      <CardHeader title="Bu ayın üretim verimliliği" />
      {data.data.items.length ? (
        data.data.items.map((r, i) => (
          <div key={i} className="border-t border-border p-4 text-sm">
            {r.quantity} {r.unit} · {r.hours} saat · {r.perHour ?? '—'} {r.unit}/saat
            <p className="mt-1 text-xs text-muted">
              Plan farkı: {r.planVariance} {r.unit} · {r.note}
            </p>
          </div>
        ))
      ) : (
        <p className="p-4 text-sm text-muted">
          Onaylı üretim ve etiketli puantaj eklendiğinde hesaplanır.
        </p>
      )}
    </Card>
  );
}
function Scorecards({ projectId }: { projectId: string }) {
  const can = useCan();
  const data = useCQuery<{
    method: string;
    items: {
      partyId: string;
      name: string;
      orders: number;
      timed: number;
      qualityRecords: number;
      deliveryScore: number | null;
      qualityScore: number | null;
      averageCorrectionDays: string | null;
      correctedRecords: number;
      production: { unit: string; achievement: string; count: number }[];
    }[];
  }>(
    ['control', 'scorecards', projectId],
    can('procurement.read') ? `/api/construction/scorecards?projectId=${projectId}` : null,
    { allowForbidden: true },
  );
  if (!data.data) return null;
  return (
    <Card>
      <CardHeader title="Taşeron ve tedarikçi performansı" />
      {data.data.items.map((p) => (
        <div
          key={p.partyId}
          className="flex flex-wrap justify-between gap-3 border-t border-border p-4 text-sm"
        >
          <span>{p.name}</span>
          <span>
            Teslim: {p.deliveryScore ?? '—'} / 100 · {p.timed} ölçüm
          </span>
          <span>
            Kalite: {p.qualityScore ?? '—'} / 100 · {p.qualityRecords} kontrol
          </span>
          <span>
            Düzeltme: {p.averageCorrectionDays ?? '—'} gün · {p.correctedRecords} kapanmış aksiyon
          </span>
          {p.production.map((r) => (
            <span key={r.unit}>
              Üretim: %{r.achievement} · {r.unit} · {r.count} kayıt
            </span>
          ))}
        </div>
      ))}
      <p className="p-4 text-xs text-muted">{data.data.method}</p>
    </Card>
  );
}
function SalesPipeline({ projectId }: { projectId: string }) {
  const data = useCQuery<{
    items: {
      source: string;
      owner: string;
      leads: number;
      visits: number;
      offers: number;
      reservations: number;
      contracts: number;
      lost: number;
      conversion: string;
    }[];
    method: string;
  }>(
    ['control', 'sales-pipeline', projectId],
    `/api/construction/sales-pipeline?projectId=${projectId}`,
    { allowForbidden: true },
  );
  if (!data.data) return null;
  return (
    <Card>
      <CardHeader title="Satış kaynakları ve dönüşüm" />
      {data.data.items.map((r, i) => (
        <div key={i} className="space-y-2 border-t border-border p-4 text-sm">
          <p>
            {r.source} · {r.owner}
          </p>
          <p className="text-xs text-muted">
            {r.leads} aday · {r.visits} ziyaret · {r.offers} teklif · {r.reservations} rezervasyon ·{' '}
            {r.contracts} sözleşme · {r.lost} kayıp
          </p>
          <Badge>Dönüşüm %{r.conversion}</Badge>
        </div>
      ))}
      {!data.data.items.length && <EmptyState title="Henüz satış adayı yok" />}
      <p className="p-4 text-xs text-muted">{data.data.method}</p>
    </Card>
  );
}
