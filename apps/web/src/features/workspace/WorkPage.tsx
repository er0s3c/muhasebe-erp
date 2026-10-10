import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Check, CalendarDays, FileText, ClipboardList, Pencil, ArrowRight, UserRound, Circle, CircleCheck, TriangleAlert } from 'lucide-react';
import { todayIso, type SearchHit, type WorkItem } from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Textarea, Select } from '../../components/ui/Field';
import { Callout, PageLoading, EmptyState } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Badge } from '../../components/ui/Badge';
import { useCMutation, useCQuery, useNavigation } from '../../lib/queries';
import { useCompany, useSession } from '../../lib/session';
import { formatDateTR } from '../../lib/format';
import { RecordPicker } from './RecordPicker';
import { Alerts } from './Alerts';
import { SearchBox, StatusBadge } from './WorkspaceUi';
import { TaskTimer, TimeTracking } from './TimeTracking';
export function WorkPage() {
  return <WorkContent key={useCompany().id} />;
}
function WorkContent() {
  const {user}=useSession();
  const nav = useNavigation();
  const canWrite =
    nav.data?.permissions.some(
      (p) => !p.endsWith('.read') && p !== 'workspace.use' && p !== 'data.export',
    ) ?? false;
  const [status, setStatus] = useState('open');
  const [due, setDue] = useState('all');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('mine');
  const [priorityFilter,setPriorityFilter]=useState('all');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<WorkItem | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState(todayIso());
  const [ownerId, setOwnerId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [record, setRecord] = useState<SearchHit | null>(null);
  const tasks = useCQuery<{
    items: WorkItem[];
    hasMore: boolean;
    today: string;
    counts: { open: number; today: number; overdue: number; done: number };
  }>(
    ['workspace-tasks', status, due, query, offset, scope,priorityFilter],
    '/api/workspace/tasks?' +
      new URLSearchParams({ status, due, q: query, offset: String(offset), scope,priority:priorityFilter }),
  );
  const members = useCQuery<{ items: { id: string; name: string }[] }>(
    ['workspace-members'],
    '/api/workspace/members',
  );
  const agenda = useCQuery<{ counts: { today: number; overdue: number; upcoming: number } }>(
    ['workspace-agenda'],
    '/api/workspace/agenda',
  );
  const save = useCMutation(
    (_v: void, call) =>
      call(editing ? '/api/workspace/tasks/' + editing.id : '/api/workspace/tasks', {
        method: editing ? 'PATCH' : 'POST',
        body: {
          title,
          description,
          dueDate,
          priority,
          ...(ownerId ? { ownerId } : {}),
          ...(record
            ? { record: { kind: record.kind, id: record.id } }
            : editing
              ? { record: null }
              : {}),
          ...(editing ? { version: editing.version } : {}),
        },
      }),
    [['workspace-tasks']],
  );
  const update = useCMutation(
    (v: { id: string; version: number; status: string }, call) =>
      call('/api/workspace/tasks/' + v.id, { method: 'PATCH', body: v }),
    [['workspace-tasks']],
  );
  function start(item?: WorkItem) {
    setEditing(item ?? null);
    setTitle(item?.title ?? '');
    setDescription(item?.description ?? '');
    setDueDate(item?.dueDate ?? todayIso());
    setPriority(item?.priority ?? 'normal');
    setOwnerId(item?.ownerId ?? '');
    setRecord(
      item?.recordKind && item.recordId
        ? { kind: item.recordKind, id: item.recordId, label: 'Bağlı kayıt', path: '' }
        : null,
    );
    save.reset();
    setOpen(true);
  }
  const error = tasks.error ?? update.error;
  return (
    <>
      <PageHeader
        title="Bugünkü işlerim"
        description="Günün öncelikleri, bekleyen kararlar ve ekibin işleri tek çalışma alanında."
        actions={
          <>
            <Link className="link inline-flex items-center gap-2 text-sm" to="/agenda">
              <CalendarDays className="size-4" />
              Ajanda
            </Link>
            {canWrite && (
              <Button variant="primary" disabled={save.isPending} onClick={() => start()}>
                <Plus className="size-4" />
                Yeni görev
              </Button>
            )}
          </>
        }
      />
      {error && <Callout tone="danger">{error.message}</Callout>}
      <section aria-label="İş özeti" className="mb-6 overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="grid grid-cols-2 divide-x divide-border lg:grid-cols-4">
          {[
            { label: 'Açık işler', hint: 'Tamamlanmayı bekleyen', value: tasks.data?.counts.open, icon: ClipboardList, filter: 'all', status: 'open' },
            { label: 'Bugün', hint: 'Bugün vadesi gelen', value: tasks.data?.counts.today, icon: CalendarDays, filter: 'today', status: 'open' },
            { label: 'Gecikmiş', hint: 'Öncelikle ele alınmalı', value: tasks.data?.counts.overdue, icon: TriangleAlert, filter: 'overdue', status: 'open' },
            { label: 'Tamamlanan', hint: 'Kapanan görevler', value: tasks.data?.counts.done, icon: CircleCheck, filter: 'all', status: 'done' },
          ].map((metric, index) => <button key={metric.label} type="button"
            className={`min-w-0 px-5 py-5 text-left transition-colors hover:bg-surface-2 ${index > 1 ? 'border-t border-border lg:border-t-0' : ''}`}
            onClick={() => { setStatus(metric.status); setDue(metric.filter); setOffset(0); }}>
            <span className="flex items-center justify-between gap-2 text-[12px] uppercase tracking-wider text-muted">{metric.label}<metric.icon className="size-4" aria-hidden /></span>
            <span className={`mt-2 block text-[28px] leading-tight tabular-nums ${index === 2 && metric.value ? 'text-danger' : ''}`}>{metric.value ?? '—'}</span>
            <span className="mt-1 block text-xs text-muted">{metric.hint}</span>
          </button>)}
        </div>
      </section>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Görevler" className="min-w-0 space-y-4">
          <Card className="overflow-hidden">
          <CardHeader title="Çalışma listesi" description={`${formatDateTR(tasks.data?.today ?? todayIso())} · ${scope === 'mine' ? 'Bana atanan işler' : 'Ekipteki tüm işler'}`}
            action={<Select aria-label="Görev kapsamı" className="w-auto" value={scope} onChange={e => { setScope(e.target.value); setOffset(0); }}><option value="mine">Benim işlerim</option><option value="team">Ekip işleri</option></Select>} />
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
            <SegmentedTabs
              items={[
                { key: 'open', label: 'Açık işler' },
                { key: 'done', label: 'Tamamlanan' },
                { key: 'all', label: 'Tümü' },
              ]}
              value={status}
              onChange={(v) => {
                setStatus(v);
                setOffset(0);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-3 px-5 pb-4 pt-3">
            <SearchBox
              value={query}
              onChange={(v) => {
                setQuery(v);
                setOffset(0);
              }}
            />
            <Select
              aria-label="Vade filtresi"
              className="w-auto"
              value={due}
              onChange={(e) => {
                setDue(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">Tüm vadeler</option>
              <option value="today">Bugün</option>
              <option value="overdue">Gecikmiş</option>
              <option value="upcoming">Yaklaşan</option>
            </Select>
            <Select aria-label="Öncelik filtresi" value={priorityFilter} onChange={e=>{setPriorityFilter(e.target.value);setOffset(0);}} className="w-full sm:w-36"><option value="all">Tüm öncelikler</option><option value="high">Yüksek öncelik</option><option value="normal">Normal öncelik</option></Select>
          </div>
          {tasks.isPending ? (
            <PageLoading />
          ) : !tasks.data?.items.length ? (
            <div className="border-t border-border">
              <EmptyState
                icon={<ClipboardList className="size-5" />}
                title="Bu görünümde görev yok"
                description="Filtreleri değiştirin veya takip etmek istediğiniz işi ekleyin."
                action={canWrite ? <Button onClick={() => start()}>Yeni görev</Button> : undefined}
              />
            </div>
          ) : (
            <div className="divide-y divide-border border-t border-border">
              {tasks.data.items.map((item) => (
                <article className="space-y-3 p-5 transition-colors hover:bg-surface-2/30" key={item.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap gap-2">
                        <StatusBadge status={item.status} dueDate={item.dueDate} />
                        {item.priority === 'high' && <Badge tone="warning">Yüksek öncelik</Badge>}
                      </div>
                      <h2 className="flex items-start gap-2.5 break-words text-base"><span className="mt-1 shrink-0 text-muted" aria-hidden>{item.status === 'done' ? <CircleCheck className="size-4 text-success" /> : <Circle className="size-4" />}</span><span>{item.title}</span></h2>
                    </div>
                    {canWrite && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={save.isPending}
                        onClick={() => start(item)}
                      >
                        <Pencil className="size-4" />
                        Düzenle
                      </Button>
                    )}
                  </div>
                  {item.description && (
                    <p className="whitespace-pre-wrap break-words text-sm text-muted">
                      {item.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
                      <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" aria-hidden />{formatDateTR(item.dueDate)}</span>
                      <span className="inline-flex items-center gap-1.5"><UserRound className="size-3.5" aria-hidden />{item.ownerName}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {item.status==='open' && (item.ownerId===user?.id || nav.data?.permissions.includes('members.manage')) && <TaskTimer taskId={item.id} />}
                      {item.recordKind && (
                        <Link
                          className="link inline-flex items-center gap-1 text-xs"
                          to={
                            '/workspace/documents?kind=' + item.recordKind + '&id=' + item.recordId
                          }
                        >
                          Bağlı kayıt / belgeler
                          <ArrowRight className="size-3.5" aria-hidden />
                        </Link>
                      )}
                      {canWrite && (
                        <>
                          <Button
                            size="sm"
                            disabled={update.isPending}
                            onClick={() =>
                              update.mutate({
                                id: item.id,
                                version: item.version,
                                status: item.status === 'open' ? 'done' : 'open',
                              })
                            }
                          >
                            <Check className="size-4" />
                            {item.status === 'open' ? 'Tamamla' : 'Yeniden aç'}
                          </Button>
                          {item.status === 'open' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={update.isPending}
                              onClick={() =>
                                update.mutate({
                                  id: item.id,
                                  version: item.version,
                                  status: 'cancelled',
                                })
                              }
                            >
                              İptal et
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          </Card>
          {(offset > 0 || tasks.data?.hasMore) && (
            <div className="flex justify-between">
              <Button
                size="sm"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 100))}
              >
                Önceki
              </Button>
              <Button
                size="sm"
                disabled={!tasks.data?.hasMore}
                onClick={() => setOffset(offset + 100)}
              >
                Sonraki
              </Button>
            </div>
          )}
        </section>
        <aside className="space-y-4">
          <TimeTracking />
          <Alerts compact />
          <Card>
            <CardHeader title="Ajanda ve belgeler" />
            <div className="space-y-4 p-5">
              <Link className="flex items-start gap-3" to="/agenda">
                <CalendarDays className="mt-0.5 size-4 text-muted" />
                <div>
                  <p className="text-sm">Ajandayı aç</p>
                  <p className="mt-1 text-xs text-muted">
                    {agenda.data
                      ? agenda.data.counts.today +
                        ' bugün · ' +
                        agenda.data.counts.upcoming +
                        ' yaklaşan'
                      : 'Görüşme ve randevular'}
                  </p>
                </div>
              </Link>
              <Link className="flex items-center gap-3 text-sm" to="/workspace/documents">
                <FileText className="size-4 text-muted" />
                Belge arşivi
              </Link>
            </div>
          </Card>
        </aside>
      </div>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Görevi düzenle' : 'Yeni görev'}
        description="Sorumlu, öncelik ve vade ile takip edilebilir bir iş oluşturun."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Vazgeç</Button>
            <Button variant="primary" loading={save.isPending} type="submit" form="task-form">
              {editing ? 'Değişiklikleri kaydet' : 'Görev oluştur'}
            </Button>
          </>
        }
      >
        <form
          id="task-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(undefined, { onSuccess: () => setOpen(false) });
          }}
        >
          {save.error && <Callout tone="danger">{save.error.message}</Callout>}
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
          <label className="block text-sm">
            Açıklama
            <Textarea
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              Vade
              <Input
                required
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Öncelik
              <Select
                aria-label="Öncelik"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="normal">Normal</option>
                <option value="high">Yüksek</option>
              </Select>
            </label>
          </div>
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
          <RecordPicker value={record} onChange={setRecord} />
        </form>
      </Sheet>
    </>
  );
}
