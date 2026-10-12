import { AlertTriangle, CheckCircle2, Circle, Info, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Button } from '../../components/ui/Button';
import { ListSkeleton } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

interface Checklist {
  period: { id: string; year: number; month: number; status: string };
  checks: { key: string; label: string; severity: 'ok' | 'info' | 'warning' | 'blocker'; count?: number; link?: string; details?: string[] }[];
  tasks: { key: string; label: string; done: { by: string; at: string; note: string | null } | null }[];
  blockers: number; warnings: number; openTasks: number;
}
const ICON = {
  ok: <CheckCircle2 className="size-4 text-success" aria-label="Tamam" />,
  info: <Info className="size-4 text-muted" aria-label="Bilgi" />,
  warning: <AlertTriangle className="size-4 text-warning" aria-label="Uyarı" />,
  blocker: <XCircle className="size-4 text-danger" aria-label="Engel" />,
};

/**
 * Aylık kapanış kontrol listesi (öneri 9): otomatik kontroller kaynağına bağlantıyla, elle yapılan görevler kim ve ne zaman
 * tamamladığıyla. Engel varken dönem kapatılamaz; uyarılar kapanıştan önce gözden geçirilir.
 */
export function PeriodCloseSheet({ periodId, title, onOpenChange }: { periodId: string | null; title: string; onOpenChange: (open: boolean) => void }) {
  const can = useCan();
  const toast = useToast();
  const key = ['periods', periodId, 'checklist'];
  const query = useCQuery<Checklist>(key, periodId ? `/api/periods/${periodId}/checklist` : null);
  const toggle = useCMutation((v: { key: string; done: boolean }, call) => call<Checklist>(`/api/periods/${periodId}/tasks/${v.key}`, { method: v.done ? 'POST' : 'DELETE', body: v.done ? {} : undefined }), [key]);
  const data = query.data;
  const editable = data?.period.status === 'open' && can('ledger.close_period');

  return (
    <Sheet open={!!periodId} onOpenChange={onOpenChange} title={`Kapanış listesi · ${title}`}
      description={data ? `${data.blockers} engel · ${data.warnings} uyarı · ${data.openTasks} açık görev` : undefined}>
      {query.error ? <ErrorCallout error={query.error} /> : !data ? <ListSkeleton /> : (
        <div className="flex flex-col gap-6">
          <section aria-label="Otomatik kontroller">
            <h3 className="mb-2 text-sm font-semibold">Otomatik kontroller</h3>
            <ul className="flex flex-col gap-1.5">
              {data.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0">{ICON[c.severity]}</span>
                  <span className="min-w-0 flex-1">
                    {c.label}{c.count ? `: ${c.count}` : ''}{c.details?.length ? ` (${c.details.join(', ')})` : ''}
                    {c.link && c.severity !== 'ok' && <> · <Link to={c.link} className="link" onClick={() => onOpenChange(false)}>Aç</Link></>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Kapanış görevleri">
            <h3 className="mb-2 text-sm font-semibold">Kapanış görevleri</h3>
            <ul className="flex flex-col gap-2">
              {data.tasks.map((t) => (
                <li key={t.key} className="flex items-start justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-start gap-2">
                    <span className="mt-0.5 shrink-0">{t.done ? <CheckCircle2 className="size-4 text-success" aria-label="Tamamlandı" /> : <Circle className="size-4 text-muted" aria-label="Açık" />}</span>
                    <span>{t.label}{t.done && <span className="block text-xs text-muted">{t.done.by} · {fmtDateTime(t.done.at)}{t.done.note ? ` · ${t.done.note}` : ''}</span>}</span>
                  </span>
                  {editable && <Button size="sm" variant="ghost" loading={toggle.isPending && toggle.variables?.key === t.key}
                    onClick={() => toggle.mutate({ key: t.key, done: !t.done }, { onError: (e) => toast.error(errorMessage(e)) })}>
                    {t.done ? 'Geri al' : 'Tamamlandı'}
                  </Button>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Sheet>
  );
}
