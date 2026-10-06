import { Plus, Printer, ClipboardList, ArrowLeft, Paperclip, Pencil } from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Badge } from '../../components/ui/Badge';
import { CurrencyOptions } from '../../components/ui/CurrencyOptions';
import { SearchBox, StatusBadge } from './WorkspaceUi';
import { formatDateTR, moneyIn, currencySymbol } from '../../lib/format';
import type { OperationSummary } from '@erp/shared';
import { useState } from 'react';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  operationKindSchema,
  operationSchema,
  operationPayloads,
  isoDate,
  todayIso,
  type OperationKind,
  type OperationRow,
  type SearchHit,
} from '@erp/shared';
import { useCompany, useSession } from '../../lib/session';
import { useCan, useCMutation, useCQuery, useModuleEnabled } from '../../lib/queries';
import { PageHeader, Card } from '../../components/ui/Card';
import { Input, Textarea, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading, EmptyState } from '../../components/ui/Feedback';
import { RecordPicker } from './RecordPicker';
import {RecordLocationLinks} from '../construction-control/RecordLocationLinks';

import { labels, optionLabels, permissions, writePermissions, fields } from './config';
const siteDraftSchema = z.object({
  body: z.object({
    id: z.uuid(),
    kind: z.literal('site_report'),
    title: z.string().max(200),
    eventDate: isoDate,
    dueDate: isoDate,
    payload: operationPayloads.site_report,
    ownerId: z.uuid().optional(),
  }),
  record: z
    .object({
      id: z.uuid(),
      kind: z.literal('project'),
      label: z.string().max(500),
      path: z.string().max(500),
    })
    .nullable(),
});
function defaults(kind: OperationKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields[kind])
    out[field.key] =
      field.type === 'select'
        ? field.options![0]
        : field.type === 'date'
          ? todayIso()
          : field.numeric
            ? 0
            : field.type === 'number'
              ? '0'
              : '';
  if (kind === 'schedule') out.dependencies = [];
  return out;
}
export function OperationsPage() {
  const company = useCompany();
  const [params] = useSearchParams();
  const parsed = operationKindSchema.safeParse(params.get('kind'));
  return (
    <OperationsContent
      key={`${company.id}:${parsed.success ? parsed.data : 'site_report'}:${params.get('projectId') ?? ''}`}
      kind={parsed.success ? parsed.data : 'site_report'}
    />
  );
}
function OperationsContent({ kind }: { kind: OperationKind }) {
  const [params] = useSearchParams();
  const openId = params.get('open');
  const navigate = useNavigate();
  const [formOpen, setFormOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDue, setFilterDue] = useState('all');
  const [projectFilter, setProjectFilter] = useState(params.get('projectId') ?? '');
  const company = useCompany();
  const { user } = useSession();
  const can = useCan();
  const projectsOn = useModuleEnabled('construction.projects');
  const partiesOn = useModuleEnabled('core.parties');
  const realestateOn = useModuleEnabled('construction.realestate');
  const enabled = (k: OperationKind) =>
    can(permissions[k]) &&
    (k === 'collection' ? partiesOn : k === 'defect' ? realestateOn : projectsOn);
  const [offset, setOffset] = useState(0);
  const [title, setTitle] = useState('');
  const [eventDate, setEventDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(todayIso());
  const [record, setRecord] = useState<SearchHit | null>(
    params.get('projectId') && kind !== 'collection'
      ? { kind: 'project', id: params.get('projectId')!, label: 'Seçilen proje', path: '' }
      : null,
  );
  const [ownerId, setOwnerId] = useState('');
  const [related, setRelated] = useState<SearchHit | null>(null);
  const [payload, setPayload] = useState<Record<string, unknown>>(defaults(kind));
  const [editing, setEditing] = useState<OperationRow | null>(null);
  const [status, setStatus] = useState('open');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submissionId, setSubmissionId] = useState<string>(() => crypto.randomUUID());
  const list = useCQuery<{ items: OperationRow[]; hasMore: boolean; summary: OperationSummary }>(
    ['operations', kind, offset, openId, query, filterStatus, filterDue, projectFilter],
    enabled(kind)
      ? `/api/workspace/operations?kind=${kind}&offset=${offset}${openId ? `&id=${encodeURIComponent(openId)}` : ''}&q=${encodeURIComponent(query)}&status=${filterStatus}&due=${filterDue}${projectFilter ? `&projectId=${projectFilter}` : ''}`
      : null,
  );
  const projects = useCQuery<{ projects: { id: string; name: string; code: string }[] }>(
    ['workspace-projects'],
    '/api/projects?limit=200',
    { enabled: projectsOn && can('projects.read') },
  );
  const members = useCQuery<{ items: { id: string; name: string }[] }>(
    ['workspace-members'],
    '/api/workspace/members',
  );
  const wbs = useCQuery<{ wbs: { id: string; code: string; name: string }[] }>(
    ['workspace-wbs', record?.id],
    kind === 'schedule' && record ? `/api/projects/${record.id}/wbs` : null,
  );
  const equipment = useCQuery<{ items: OperationRow[] }>(
    ['operations', 'equipment', record?.id],
    kind === 'equipment_log' && record
      ? `/api/workspace/operations?kind=equipment&projectId=${record.id}`
      : null,
  );
  const schedules = useCQuery<{ items: OperationRow[] }>(
    ['operations', 'schedule', record?.id],
    kind === 'schedule' && record
      ? `/api/workspace/operations?kind=schedule&projectId=${record.id}`
      : null,
  );
  const impact = useCQuery<{ items: { id: string; forecastEnd: string; delayDays: number }[] }>(
    ['schedule-impact', record?.id],
    kind === 'schedule' && record ? `/api/workspace/schedule/${record.id}` : null,
  );
  const units = useCQuery<{ items: { id: string; name: string }[] }>(
    ['workspace-units', record?.id],
    kind === 'defect' && record ? `/api/workspace/units/${record.id}` : null,
  );
  const body = () => ({
    id: submissionId,
    kind,
    title,
    eventDate,
    dueDate,
    payload,
    ...(record ? (kind === 'collection' ? { partyId: record.id } : { projectId: record.id }) : {}),
    ...(ownerId ? { ownerId } : {}),
  });
  const draftKey = `ada-site-draft:${company.id}:${user?.id}:${kind}`;
  const save = useCMutation(
    async (_v: void, call) => {
      const parsed = operationSchema.parse(body());
      return editing
        ? call(`/api/workspace/operations/${editing.id}`, {
            method: 'PUT',
            body: { ...parsed, version: editing.version, status },
          })
        : call('/api/workspace/operations', { method: 'POST', body: parsed });
    },
    [['operations'], ['schedule-impact'], ['construction-summary'], ['work-alerts']],
  );
  function restore() {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) {
        setMessage('Kayıtlı taslak yok.');
        return;
      }
      const d = siteDraftSchema.parse(JSON.parse(raw));
      const parsed = d.body;
      setTitle(parsed.title);
      setEventDate(parsed.eventDate);
      setDueDate(parsed.dueDate);
      setPayload(parsed.payload);
      setSubmissionId(parsed.id ?? crypto.randomUUID());
      setRecord(d.record);
      setOwnerId(parsed.ownerId ?? '');
      setMessage('Taslak yüklendi. Göndermeden önce kontrol edin.');
    } catch {
      setError('Taslak okunamadı.');
    }
  }
  function edit(row: OperationRow) {
    setFormOpen(true);
    save.reset();
    setEditing(row);
    setTitle(row.title);
    setEventDate(row.eventDate);
    setDueDate(row.dueDate);
    setPayload(row.payload);
    setOwnerId(row.ownerId);
    const refId =
      kind === 'equipment_log' || kind === 'collection'
        ? row.payload.invoiceId
        : kind === 'defect'
          ? row.payload.contractorId
          : null;
    setRelated(
      typeof refId === 'string'
        ? {
            id: refId,
            kind: kind === 'equipment_log' || kind === 'collection' ? 'invoice' : 'party',
            label: 'Bağlı kayıt',
            path: '',
          }
        : null,
    );
    setStatus(row.status);
    setRecord({
      id: (row.projectId ?? row.partyId)!,
      kind: kind === 'collection' ? 'party' : 'project',
      label: 'Bağlı kayıt',
      path: '',
    });
    setSubmissionId(row.id);
  }
  function reset() {
    setEditing(null);
    setTitle('');
    setPayload(defaults(kind));
    setRelated(null);
    setOwnerId('');
    setStatus('open');
    setSubmissionId(crypto.randomUUID());
  }
  return (
    <>
      <PageHeader
        title={labels[kind]}
        description={
          kind === 'collection'
            ? 'Ödeme sözlerini ve sonraki görüşmeleri takip edin.'
            : kind === 'equipment_log'
              ? 'Operasyonel gider takibi. Muhasebe kaydı mevcut fatura / gider akışından yapılır.'
              : 'Sahadaki işi proje kayıtlarıyla birlikte takip edin.'
        }
        actions={
          <>
            <Button onClick={() => window.print()}>
              <Printer className="size-4" />
              Yazdır / PDF
            </Button>
            {enabled(kind) && can(writePermissions[kind]) && (
              <Button
                variant="primary"
                disabled={save.isPending}
                onClick={() => {
                  reset();
                  setError('');
                  save.reset();
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" />
                Yeni kayıt
              </Button>
            )}
          </>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-3 print:hidden">
        <Link className="link inline-flex items-center gap-2 text-sm" to="/workspace/construction">
          <ArrowLeft className="size-4" />
          İnşaat kontrol merkezi
        </Link>
        <Select
          aria-label="Operasyon ekranı"
          className="w-auto max-w-full"
          value={kind}
          onChange={(e) => navigate('/workspace/operations?kind=' + e.target.value)}
        >
          {(Object.keys(labels) as OperationKind[]).filter(enabled).map((k) => (
            <option key={k} value={k}>
              {labels[k]}
            </option>
          ))}
        </Select>
      </div>
      {!enabled(kind) ? (
        <Callout>Bu modül için erişiminiz bulunmuyor.</Callout>
      ) : (
        <>
          {(error || save.error || list.error) && (
            <Callout tone="danger">{error || save.error?.message || list.error?.message}</Callout>
          )}
          {message && (
            <p role="status" className="mb-4 text-sm">
              {message}
            </p>
          )}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Toplam kayıt">{list.data?.summary.counts.total ?? '—'}</Stat>
            <Stat label="Açık">{list.data?.summary.counts.open ?? '—'}</Stat>
            <Stat label="Gecikmiş">
              <span className="text-danger">{list.data?.summary.counts.overdue ?? '—'}</span>
            </Stat>
            <Stat label="Tamamlanan">{list.data?.summary.counts.done ?? '—'}</Stat>
          </div>
          {kind === 'collection' && !!list.data?.summary.promises.length && (
            <Card className="mb-5 flex flex-wrap items-center gap-5 p-5">
              <div>
                <p className="micro text-muted">Açık ödeme sözleri</p>
                <p className="mt-1 text-xs text-muted">
                  Para birimine göre; tahsilat kaydı oluşturmaz
                </p>
              </div>
              {list.data.summary.promises.map((p) => (
                <p className="text-subheading num" key={p.currency}>
                  {moneyIn(p.amount, p.currency)}
                </p>
              ))}
            </Card>
          )}
          <div className="mb-5 flex flex-wrap items-center gap-3 print:hidden">
            <SearchBox
              value={query}
              onChange={(v) => {
                setQuery(v);
                setOffset(0);
              }}
            />
            <Select
              aria-label="Durum filtresi"
              className="w-auto"
              value={filterStatus}
              onChange={(e) => {
                setFilterStatus(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">Tüm durumlar</option>
              <option value="open">Açık</option>
              <option value="done">Tamamlanan</option>
              <option value="cancelled">İptal edilen</option>
            </Select>
            <Select
              aria-label="Termin filtresi"
              className="w-auto"
              value={filterDue}
              onChange={(e) => {
                setFilterDue(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">Tüm terminler</option>
              <option value="overdue">Gecikmiş</option>
              <option value="today">Bugün</option>
            </Select>
            {kind !== 'collection' && (
              <Select
                aria-label="Proje filtresi"
                className="w-auto max-w-full"
                value={projectFilter}
                onChange={(e) => {
                  setProjectFilter(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">Tüm projeler</option>
                {projects.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <div>
            <section className="space-y-3">
              {list.isPending && <PageLoading />}
              {list.data?.items.length === 0 && (
                <Card>
                  <EmptyState
                    icon={<ClipboardList className="size-5" />}
                    title="Henüz kayıt yok"
                    description="Projedeki işleri, sorumluları ve terminleri kayıt altına alın."
                    action={
                      can(writePermissions[kind]) ? (
                        <Button
                          onClick={() => {
                            reset();
                            setFormOpen(true);
                          }}
                        >
                          Yeni kayıt
                        </Button>
                      ) : undefined
                    }
                  />
                </Card>
              )}
              {list.data?.items.map((row) => (
                <Card key={row.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="micro mb-2 text-muted">
                        {row.partyName ?? row.projectName ?? labels[kind]}
                      </p>
                      <h2 className="break-words text-base">{row.title}</h2>
                    </div>
                    <div className="flex gap-2">
                      <StatusBadge status={row.status} dueDate={row.dueDate} />
                      {row.kind === 'safety' && (
                        <Badge
                          tone={
                            ['critical', 'high'].includes(String(row.payload.severity))
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {optionLabels[String(row.payload.severity)]} risk
                        </Badge>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-muted">
                    {formatDateTR(row.eventDate)} · Termin: {formatDateTR(row.dueDate)} ·{' '}
                    {row.ownerName}
                  </p>
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    {fields[kind].map((f) => (
                      <div key={f.key}>
                        <dt className="text-muted">{f.label}</dt>
                        <dd className="whitespace-pre-wrap break-words">
                          {f.key === 'promiseAmount' || f.key === 'cost'
                            ? moneyIn(
                                String(row.payload[f.key] ?? '0'),
                                String(row.payload.currency ?? 'TRY'),
                              )
                            : f.key === 'currency'
                              ? currencySymbol(String(row.payload.currency))
                              : f.type === 'select'
                                ? (optionLabels[String(row.payload[f.key])] ??
                                  String(row.payload[f.key] || '—'))
                                : f.type === 'date' && row.payload[f.key]
                                  ? formatDateTR(String(row.payload[f.key]))
                                  : String(row.payload[f.key] ?? '—')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {impact.data?.items.find((i) => i.id === row.id) && (
                    <p className="text-sm">
                      Tahmini bitiş: {impact.data.items.find((i) => i.id === row.id)!.forecastEnd} ·{' '}
                      {impact.data.items.find((i) => i.id === row.id)!.delayDays} gün gecikme
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3 print:hidden">
                    <RecordLocationLinks id={row.id} kind={row.kind}/>
                    {can(writePermissions[kind]) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={save.isPending}
                        onClick={() => edit(row)}
                      >
                        <Pencil className="size-4" />
                        Düzenle / durum
                      </Button>
                    )}
                    <Link
                      className="link inline-flex items-center gap-1.5 text-sm"
                      to={`/workspace/documents?kind=${['defect', 'site_report', 'rfi', 'site_instruction', 'quality_check', 'safety'].includes(row.kind) ? row.kind : row.partyId ? 'party' : 'project'}&id=${['defect', 'site_report', 'rfi', 'site_instruction', 'quality_check', 'safety'].includes(row.kind) ? row.id : (row.partyId ?? row.projectId)}`}
                    >
                      <Paperclip className="size-3.5" /> Belgeler / fotoğraflar
                    </Link>
                    {row.partyId && (
                      <Link className="text-sm underline" to={`/parties/${row.partyId}`}>
                        Cari ve tahsilatlar
                      </Link>
                    )}
                  </div>
                </Card>
              ))}
              <div className="flex gap-2 print:hidden">
                <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>
                  Önceki
                </Button>
                <Button disabled={!list.data?.hasMore} onClick={() => setOffset(offset + 100)}>
                  Sonraki
                </Button>
              </div>
            </section>
            {can(writePermissions[kind]) && (
              <Sheet
                open={formOpen}
                onOpenChange={setFormOpen}
                title={editing ? 'Kaydı düzenle' : 'Yeni kayıt'}
                description={labels[kind]}
                footer={
                  <>
                    <Button onClick={() => setFormOpen(false)}>Vazgeç</Button>
                    <Button
                      variant="primary"
                      type="submit"
                      form="operation-form"
                      loading={save.isPending}
                      disabled={!record}
                    >
                      Kaydet
                    </Button>
                  </>
                }
              >
                <form
                  id="operation-form"
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setError('');
                    save.mutate(undefined, {
                      onSuccess: () => {
                        setMessage('Kayıt kaydedildi.');
                        try {
                          localStorage.removeItem(draftKey);
                        } catch {
                          /* storage unavailable */
                        }
                        reset();
                        setFormOpen(false);
                      },
                    });
                  }}
                >
                  {(error || save.error) && (
                    <Callout tone="danger">{error || save.error?.message}</Callout>
                  )}
                  {!!members.data?.items.length && (
                    <label className="block text-sm">
                      Sorumlu
                      <Select
                        aria-label="Sorumlu"
                        value={ownerId}
                        onChange={(e) => setOwnerId(e.target.value)}
                      >
                        <option value="">Kendim</option>
                        {members.data.items.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  <label className="block text-sm">
                    Başlık
                    <Input
                      required
                      minLength={2}
                      maxLength={200}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <RecordPicker
                    label={kind === 'collection' ? 'Cari' : 'Proje'}
                    value={record}
                    kind={kind === 'collection' ? 'party' : 'project'}
                    onChange={(r) => {
                      setRecord(r);
                      if (kind === 'schedule')
                        setPayload((p) => ({ ...p, dependencies: [], wbsId: undefined }));
                      if (kind === 'equipment_log')
                        setPayload((p) => ({ ...p, equipmentId: undefined }));
                      if (kind === 'defect') setPayload((p) => ({ ...p, unitId: undefined }));
                    }}
                  />
                  <label className="block text-sm">
                    Kayıt tarihi
                    <Input
                      type="date"
                      required
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm">
                    Sonraki takip / termin
                    <Input
                      type="date"
                      required
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                    />
                  </label>
                  {fields[kind].map((f) => (
                    <label className="block text-sm" key={f.key}>
                      {f.label}
                      {f.type === 'note' ? (
                        <Textarea
                          required={f.required}
                          value={String(payload[f.key] ?? '')}
                          maxLength={4000}
                          onChange={(e) => setPayload({ ...payload, [f.key]: e.target.value })}
                        />
                      ) : f.type === 'select' ? (
                        <Select
                          aria-label={f.label}
                          value={String(payload[f.key] ?? f.options![0])}
                          onChange={(e) => setPayload({ ...payload, [f.key]: e.target.value })}
                        >
                          {f.key === 'currency' ? (
                            <CurrencyOptions />
                          ) : (
                            f.options!.map((v) => (
                              <option key={v} value={v}>
                                {optionLabels[v] ?? v}
                              </option>
                            ))
                          )}
                        </Select>
                      ) : (
                        <Input
                          type={f.type}
                          required={f.required}
                          min={f.type === 'number' ? 0 : undefined}
                          step={f.type === 'number' ? 'any' : undefined}
                          value={String(payload[f.key] ?? '')}
                          onChange={(e) =>
                            setPayload({
                              ...payload,
                              [f.key]: f.numeric ? Number(e.target.value) : e.target.value,
                            })
                          }
                        />
                      )}
                    </label>
                  ))}
                  {kind === 'equipment_log' && (
                    <label className="block text-sm">
                      Ekipman
                      <Select
                        required
                        value={String(payload.equipmentId ?? '')}
                        onChange={(e) => setPayload({ ...payload, equipmentId: e.target.value })}
                      >
                        <option value="">Seçin</option>
                        {equipment.data?.items
                          .filter((i) => i.status === 'open')
                          .map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.title}
                            </option>
                          ))}
                      </Select>
                    </label>
                  )}
                  {(kind === 'equipment_log' || kind === 'collection') && can('invoices.read') && (
                    <RecordPicker
                      label="Muhasebe faturası (isteğe bağlı)"
                      kind="invoice"
                      value={related}
                      onChange={(r) => {
                        setRelated(r);
                        setPayload({ ...payload, invoiceId: r?.id });
                      }}
                    />
                  )}
                  {kind === 'defect' && can('parties.read') && (
                    <RecordPicker
                      label="Sorumlu taşeron (isteğe bağlı)"
                      kind="party"
                      value={related}
                      onChange={(r) => {
                        setRelated(r);
                        setPayload({ ...payload, contractorId: r?.id });
                      }}
                    />
                  )}
                  {kind === 'schedule' && (
                    <label className="block text-sm">
                      İş kırılımı kalemi (isteğe bağlı)
                      <Select
                        value={String(payload.wbsId ?? '')}
                        onChange={(e) =>
                          setPayload({ ...payload, wbsId: e.target.value || undefined })
                        }
                      >
                        <option value="">Proje geneli</option>
                        {wbs.data?.wbs.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} · {w.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  {kind === 'defect' && (
                    <label className="block text-sm">
                      Bağımsız birim
                      <Select
                        required
                        value={String(payload.unitId ?? '')}
                        onChange={(e) => setPayload({ ...payload, unitId: e.target.value })}
                      >
                        <option value="">Seçin</option>
                        {units.data?.items.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  {kind === 'schedule' && (
                    <label className="block text-sm">
                      Proje tahmini
                      <span className="block text-xs text-muted">
                        {impact.data?.items.length
                          ? `En geç tahmini bitiş: ${impact.data.items
                              .map((i) => i.forecastEnd)
                              .sort()
                              .at(-1)}`
                          : 'Tahmin için proje seçin.'}
                      </span>
                    </label>
                  )}
                  {kind === 'defect' && typeof payload.unitId === 'string' && (
                    <Link
                      className="block text-sm underline"
                      to={`/workspace/handover?unit=${payload.unitId}`}
                    >
                      Bu birimin teslim tutanağı →
                    </Link>
                  )}
                  {kind === 'schedule' && (
                    <fieldset className="space-y-2">
                      <legend className="text-sm">Önce tamamlanması gereken işler</legend>
                      {schedules.data?.items
                        .filter((i) => i.id !== editing?.id && i.status !== 'cancelled')
                        .map((i) => (
                          <label key={i.id} className="flex gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={((payload.dependencies as string[]) ?? []).includes(i.id)}
                              onChange={(e) => {
                                const d = (payload.dependencies as string[]) ?? [];
                                setPayload({
                                  ...payload,
                                  dependencies: e.target.checked
                                    ? [...d, i.id]
                                    : d.filter((id) => id !== i.id),
                                });
                              }}
                            />
                            {i.title}
                          </label>
                        ))}
                      <p className="text-xs text-muted">
                        Tahmin, kalan iş süresi ve bitiş-başlangıç bağımlılığına dayanır; takvim
                        günü kullanır.
                      </p>
                    </fieldset>
                  )}
                  {editing && (
                    <label className="block text-sm">
                      Durum
                      <Select
                        aria-label="Durum"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                      >
                        <option value="open">Açık</option>
                        <option value="done">Tamamlandı</option>
                        <option value="cancelled">İptal</option>
                      </Select>
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {editing && <Button onClick={reset}>Yeni kayıt</Button>}
                    {kind === 'site_report' && !editing && (
                      <>
                        <Button
                          onClick={() => {
                            try {
                              localStorage.setItem(
                                draftKey,
                                JSON.stringify({ body: body(), record }),
                              );
                              setMessage(
                                'Taslak bu cihazda saklandı. İnternet geldiğinde yükleyip kaydedebilirsiniz.',
                              );
                            } catch {
                              setError('Cihazda taslak saklanamadı.');
                            }
                          }}
                        >
                          Taslağı cihazda sakla
                        </Button>
                        <Button onClick={restore}>Taslağı yükle</Button>
                      </>
                    )}
                  </div>
                  {kind === 'site_report' && (
                    <div className="flex flex-wrap gap-3 pt-2 text-sm">
                      <Link to="/hr/attendance">Puantaj</Link>
                      <Link to="/delivery-notes/new?type=purchase">Mal kabul</Link>
                      <Link to="/purchasing/requests">Malzeme talebi</Link>
                    </div>
                  )}
                </form>
              </Sheet>
            )}
          </div>
        </>
      )}
    </>
  );
}
