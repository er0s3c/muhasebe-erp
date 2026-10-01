import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';

type UpdateStatus = 'offered' | 'requested' | 'downloading' | 'applying' | 'done' | 'failed' | 'rolled_back' | 'cancelled';
interface UpdateRow {
  id: string;
  version: string;
  notes: string;
  status: UpdateStatus;
  offeredAt: string;
  scheduledFor: string | null;
  finishedAt: string | null;
  fromVersion: string | null;
  message: string | null;
}
interface Overview {
  currentVersion: string;
  platform: string | null;
  updaterReady: boolean;
  licenseServer: boolean;
  offer: UpdateRow | null;
  history: UpdateRow[];
}

const TONE: Record<UpdateStatus, 'neutral' | 'warning' | 'success' | 'danger' | 'brand'> = {
  offered: 'brand',
  requested: 'warning',
  downloading: 'warning',
  applying: 'warning',
  done: 'success',
  failed: 'danger',
  rolled_back: 'danger',
  cancelled: 'neutral',
};
const RUNNING: UpdateStatus[] = ['requested', 'downloading', 'applying'];

/** Uzaktan güncelleme (yalnızca kurulum sahibi): satıcının gönderdiği sürümü onaylama, durum ve geçmiş. */
export function UpdateCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['system-update'],
    queryFn: () => api<Overview>('/api/system/update'),
    // Güncelleme sürerken durum (indirme, uygulama, bitti) kendiliğinden yenilenir
    refetchInterval: (q) => (q.state.data?.offer && RUNNING.includes(q.state.data.offer.status) ? 5000 : false),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['system-update'] });
  const check = useMutation({
    mutationFn: () => api<Overview>('/api/system/update/check', { method: 'POST' }),
    onSuccess: (d) => {
      qc.setQueryData(['system-update'], d);
      toast.success(d.offer ? t('license.update.found', { version: d.offer.version }) : t('license.update.none'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const request = useMutation({
    mutationFn: (v: { id: string; when: 'now' | 'tonight' }) => api(`/api/system/update/${v.id}/request`, { method: 'POST', body: { when: v.when } }),
    onSuccess: () => {
      toast.success(t('license.update.requested'));
      void done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/system/update/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => void done(),
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (error) return null;
  const o = data?.offer;
  const canRequest = o && data.updaterReady && ['offered', 'failed', 'rolled_back', 'cancelled'].includes(o.status);
  return (
    <Card>
      <CardHeader
        title={t('license.update.title')}
        description={data ? t('license.update.current', { version: data.currentVersion }) : undefined}
        action={
          data?.licenseServer ? (
            <Button size="sm" loading={check.isPending} onClick={() => check.mutate()}>
              {t('license.update.check')}
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">
        {!o && <p className="text-muted">{t('license.update.upToDate')}</p>}
        {o && (
          <div className="flex flex-col gap-2" data-testid="update-offer">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base">{t('license.update.newVersion', { version: o.version })}</span>
              <Badge tone={TONE[o.status]}>{t(`license.update.status.${o.status}`)}</Badge>
            </div>
            {o.notes && <p className="whitespace-pre-line text-muted">{o.notes}</p>}
            {o.status === 'requested' && o.scheduledFor && <p>{t('license.update.scheduled', { at: fmtDateTime(o.scheduledFor) })}</p>}
            {(o.status === 'downloading' || o.status === 'applying') && <Callout tone="warning">{t('license.update.applyingHint')}</Callout>}
            {o.message && (o.status === 'failed' || o.status === 'rolled_back') && <Callout tone="danger">{o.message}</Callout>}
            <div className="flex flex-wrap gap-2">
              {canRequest && (
                <>
                  <Button variant="primary" loading={request.isPending && request.variables?.when === 'now'} onClick={() => request.mutate({ id: o.id, when: 'now' })}>
                    {t('license.update.now')}
                  </Button>
                  <Button loading={request.isPending && request.variables?.when === 'tonight'} onClick={() => request.mutate({ id: o.id, when: 'tonight' })}>
                    {t('license.update.tonight')}
                  </Button>
                </>
              )}
              {o.status === 'requested' && (
                <Button loading={cancel.isPending} onClick={() => cancel.mutate(o.id)}>
                  {t('license.update.cancel')}
                </Button>
              )}
            </div>
            {!data.updaterReady && <Callout>{t('license.update.noUpdater')}</Callout>}
            {canRequest && <p className="text-xs text-muted">{t('license.update.backupNote')}</p>}
          </div>
        )}
        {data && data.history.length > 0 && (
          <details>
            <summary className="cursor-pointer select-none text-muted">{t('license.update.history')}</summary>
            <ul className="mt-2 divide-y divide-border">
              {data.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-mono text-[13px]">{h.fromVersion ? `${h.fromVersion} → ${h.version}` : h.version}</span>
                  <Badge tone={TONE[h.status]}>{t(`license.update.status.${h.status}`)}</Badge>
                  <span className="text-muted">{h.finishedAt ? fmtDateTime(h.finishedAt) : ''}</span>
                  {h.message && <span className="w-full text-xs text-muted">{h.message}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}
