import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { useToast } from '../../components/ui/Toast';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

interface ReportJob {
  id: string;
  reportKey: string;
  format: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
  progress: number;
  rowCount: number | null;
  fileName: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
}
const STATUS: Record<ReportJob['status'], { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' | 'warning' }> = {
  queued: { label: 'Sırada', tone: 'info' },
  running: { label: 'Hazırlanıyor', tone: 'info' },
  completed: { label: 'Hazır', tone: 'success' },
  failed: { label: 'Başarısız', tone: 'danger' },
  cancelled: { label: 'İptal edildi', tone: 'neutral' },
  expired: { label: 'Süresi doldu', tone: 'warning' },
};

/**
 * Arka planda hazırlanan raporlar (öneri 20): ekranlardaki dışa aktarma menüsünden "Arka planda hazırla" ile kuyruğa alınır.
 * Dosya 24 saat saklanır ve yalnız isteyen kullanıcı indirir.
 */
export function ReportJobsPanel() {
  const toast = useToast();
  const company = useCompany();
  // Sırada ya da çalışan iş varken liste kısa aralıklarla yenilenir
  const [active, setActive] = useState(false);
  const q = useCQuery<{ jobs: ReportJob[] }>(['report-jobs'], '/api/report-jobs', active ? { refetchInterval: 2000 } : {});
  useEffect(() => {
    setActive((q.data?.jobs ?? []).some((j) => ['queued', 'running'].includes(j.status)));
  }, [q.data]);
  const cancel = useCMutation((id: string, c) => c(`/api/report-jobs/${id}/cancel`, { method: 'POST', body: {} }), [['report-jobs']]);
  const jobs = q.data?.jobs ?? [];
  if (!jobs.length) return null;
  const download = async (j: ReportJob) => {
    try {
      const { blob, filename } = await apiBlob(`/api/report-jobs/${j.id}/download`, { companyId: company.id });
      saveBlob(blob, filename ?? j.fileName ?? `rapor.${j.format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card className="mb-5">
      <CardHeader title="Hazırlanan raporlarım" description="Büyük raporlar arka planda hazırlanır; tamamlanınca 24 saat içinde indirin." />
      <ul className="divide-y divide-border">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{j.fileName ?? j.reportKey}</span>{' '}
              <span className="text-xs text-muted">
                {fmtDateTime(j.createdAt)}
                {j.rowCount !== null ? ` · ${j.rowCount} satır` : ''}
                {j.error ? ` · ${j.error}` : ''}
              </span>
            </span>
            <Badge tone={STATUS[j.status].tone} dot>
              {STATUS[j.status].label}
              {j.status === 'running' ? ` %${j.progress}` : ''}
            </Badge>
            {j.status === 'completed' && (
              <Button size="sm" onClick={() => void download(j)}>
                <Download className="size-4" aria-hidden /> İndir
              </Button>
            )}
            {['queued', 'running'].includes(j.status) && (
              <Button size="sm" onClick={() => cancel.mutate(j.id, { onError: (e) => toast.error(errorMessage(e)) })}>
                <X className="size-4" aria-hidden /> İptal
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
