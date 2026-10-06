import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  criticalPath,
  type OperationRow,
  type CalendarActivity,
  type ConstructionWorkflow,
} from '@erp/shared';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { Card, CardHeader } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Sheet';
import { Callout, EmptyState } from '../../components/ui/Feedback';
interface ProgramData {
  finish: string;
  activities: (CalendarActivity & {
    computedStart: string;
    computedEnd: string;
    duration: number;
    slack: number;
    critical: boolean;
    version: number;
  })[];
  baselines: ConstructionWorkflow[];
  calendar: { weekdays: number[]; holidays: string[] };
  lookahead: {
    activity: CalendarActivity;
    readiness: {
      title: string;
      computed: { ready: boolean; blockers: string[] };
      payload: { blocker: string };
      owner: string;
    } | null;
  }[];
}
export function ProgramPanel({ projectId }: { projectId: string }) {
  const can = useCan(),
    { call } = useCompanyApi(),
    data = useCQuery<ProgramData>(
      ['control', 'program', projectId],
      `/api/construction/program?projectId=${projectId}`,
    );
  const [edit, setEdit] = useState<ProgramData['activities'][number] | null>(null),
    [start, setStart] = useState(''),
    [end, setEnd] = useState(''),
    [milestone, setMilestone] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const rows = data.data?.activities ?? [],
    first = rows.reduce(
      (v, r) => (r.computedStart < v ? r.computedStart : v),
      rows[0]?.computedStart ?? '',
    ),
    last = data.data?.finish ?? '';
  const days =
    first && last
      ? Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1)
      : 1;
  const x = (date: string) =>
    180 + ((Date.parse(date) - Date.parse(first)) / 86400000 / days) * 700;
  const baseline = (data.data?.baselines[0]?.payload.snapshot ?? []) as {
    id: string;
    payload: { start: string; end: string };
  }[];
  async function save() {
    if (!edit) return;
    setBusy(true);
    setError('');
    try {
      const all = await call<{ items: OperationRow[] }>(
        `/api/workspace/operations?kind=schedule&projectId=${projectId}&id=${edit.id}`,
      );
      const row = all.items.find((r) => r.id === edit.id);
      if (!row || row.version !== edit.version)
        throw new Error('Program değişti; ekranı yenileyin.');
      await call(`/api/workspace/operations/${row.id}`, {
        method: 'PUT',
        body: {
          kind: row.kind,
          title: row.title,
          projectId: row.projectId,
          ownerId: row.ownerId,
          eventDate: start,
          dueDate: end,
          payload: { ...row.payload, start, end: milestone ? start : end, milestone },
          status: row.status,
          version: row.version,
        },
      });
      setEdit(null);
      await data.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader
        title="Gantt ve kritik yol"
        description={
          last
            ? `Takvim hesabına göre bitiş: ${last} · ${data.data?.baselines.length ? 'Son onaylı başlangıç planı karşılaştırılıyor.' : 'Başlangıç planı henüz onaylanmadı.'}`
            : 'İş programına tarihli ve bağımlı işler ekleyin.'
        }
      />
      {rows.length ? (
        <div className="overflow-x-auto p-4">
          <svg
            viewBox={`0 0 920 ${rows.length * 48 + 36}`}
            style={{ minWidth: 650 }}
            role="img"
            aria-label="İş programı; koyu çubuklar kritik işler, açık gri çubuklar başlangıç planı"
          >
            <text x="180" y="14" className="fill-current text-[11px]">
              {first}
            </text>
            <text x="790" y="14" className="fill-current text-[11px]">
              {last}
            </text>
            {rows.map((r, i) => {
              const b = baseline.find((b) => b.id === r.id);
              return (
                <g key={r.id}>
                  <text x="0" y={i * 48 + 53} className="fill-current text-[11px]">
                    {r.title.slice(0, 25)}
                  </text>
                  {b && (
                    <rect
                      x={x(b.payload.start)}
                      y={i * 48 + 31}
                      width={Math.max(4, x(b.payload.end) - x(b.payload.start) + 700 / days)}
                      height="6"
                      fill="#b4b4b4"
                    />
                  )}
                  <rect
                    x={x(r.computedStart)}
                    y={i * 48 + 41}
                    width={Math.max(4, x(r.computedEnd) - x(r.computedStart) + 700 / days)}
                    height="15"
                    rx="3"
                    className={r.critical ? 'fill-text' : 'fill-muted/50'}
                  />
                </g>
              );
            })}
          </svg>
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3 text-sm"
              >
                <span>{r.title}</span>
                <span className="text-xs text-muted">
                  {r.computedStart} → {r.computedEnd} · {r.duration} çalışma günü
                </span>
                <Badge>{r.critical ? 'Kritik yol' : `${r.slack} gün esneklik`}</Badge>
                {can('projects.manage') && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setEdit(r);
                      setStart(r.start);
                      setEnd(r.end);
                      setError('');
                      setMilestone(Boolean(r.milestone));
                    }}
                  >
                    Tarihleri düzenle
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState
          title="Programda iş yok"
          action={
            <Link
              to={`/workspace/operations?kind=schedule&projectId=${projectId}`}
              className="underline"
            >
              İş programına git
            </Link>
          }
        />
      )}
      <Sheet
        open={edit !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setEdit(null);
        }}
        title="Program tarihlerini düzenle"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p>{edit?.title}</p>
          <Field label="Başlangıç">
            {(id) => (
              <Input
                id={id}
                type="date"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            )}
          </Field>
          <Field label="Bitiş">
            {(id) => (
              <Input
                id={id}
                type="date"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            )}
          </Field>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={milestone}
              onChange={(e) => setMilestone(e.target.checked)}
            />
            Kilometre taşı (0 çalışma günü)
          </label>
          <Callout>
            Bağımlılık etkisi çalışma takvimine göre yeniden hesaplanır; onaylı başlangıç planı
            değişmez.
          </Callout>
          {edit && data.data && (
            <DateImpact
              rows={data.data.activities}
              calendar={data.data.calendar}
              id={edit.id}
              start={start}
              end={milestone ? start : end}
              milestone={milestone}
              previous={last}
            />
          )}
          {error && <Callout tone="danger">{error}</Callout>}
          <Button variant="primary" type="submit" disabled={busy}>
            Programı güncelle
          </Button>
        </form>
      </Sheet>
      {data.data?.lookahead.length ? (
        <div className="border-t border-border p-4">
          <h3 className="mb-3 text-sm font-medium">Üç haftalık saha hazırlığı</h3>
          {data.data.lookahead.map(({ activity, readiness }) => (
            <div
              key={activity.id}
              className="flex flex-wrap justify-between gap-2 border-t border-border py-3 text-sm"
            >
              <span>
                {activity.title} · {activity.start}
              </span>
              <Badge tone={readiness?.computed.ready ? 'success' : 'warning'}>
                {readiness?.computed.ready
                  ? 'Hazır'
                  : readiness
                    ? readiness.computed.blockers.join(', ')
                    : 'Hazırlık kaydı eksik'}
              </Badge>
              {readiness && !readiness.computed.ready && (
                <p className="w-full text-xs text-muted">
                  {readiness.payload.blocker} · {readiness.owner}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
function DateImpact({
  rows,
  calendar,
  id,
  start,
  end,
  milestone,
  previous,
}: {
  rows: CalendarActivity[];
  calendar: { weekdays: number[]; holidays: string[] };
  id: string;
  start: string;
  end: string;
  milestone: boolean;
  previous: string;
}) {
  try {
    if (!start || !end || end < start) return null;
    const result = criticalPath(
      rows.map((r) => (r.id === id ? { ...r, start, end, milestone } : r)),
      calendar.weekdays,
      calendar.holidays,
    );
    const delta = Math.round((Date.parse(result.finish) - Date.parse(previous)) / 86400000);
    return (
      <Callout>
        Değişiklik sonrası proje bitişi: {result.finish} ·{' '}
        {delta > 0
          ? `${delta} takvim günü gecikme`
          : delta < 0
            ? `${-delta} takvim günü erken`
            : 'Teslim tarihi değişmiyor'}
      </Callout>
    );
  } catch (e) {
    return <Callout tone="danger">{(e as Error).message}</Callout>;
  }
}
