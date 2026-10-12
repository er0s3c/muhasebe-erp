import { CalendarClock } from 'lucide-react';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { Switch } from '../../components/ui/Switch';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

export interface AutoFxStatus {
  enabled: boolean;
  provider: 'tcmb' | 'kktcmb' | null;
  providerLabel: string | null;
  enabledByName: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastImport: { date: string; fetchedAt: string | null; source: string } | null;
  publishAfter: string | null;
}

const timeTR = (iso: string) => new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

export function useAutoFxStatus(enabled = true) {
  return useCQuery<AutoFxStatus>(['rates', 'auto'], enabled ? '/api/exchange-rates/auto' : null, { staleTime: 60_000 });
}

/** Resmî kurları her iş günü yayın saatinden sonra otomatik çekme ayarı ve son durum. */
export function AutoFxCard() {
  const can = useCan();
  const toast = useToast();
  const { data, error } = useAutoFxStatus();
  const save = useCMutation((enabled: boolean, call) => call<AutoFxStatus>('/api/exchange-rates/auto', { method: 'PUT', body: { enabled } }), [['rates'], ['dashboard']]);
  const canManage = can('rates.manage');
  if (error) return <Callout tone="danger">{errorMessage(error)}</Callout>;
  if (!data) return null;
  return (
    <Card>
      <CardHeader
        title="Otomatik kur çekimi"
        help={{
          title: 'Otomatik kur çekimi',
          description: 'Açıkken şirketinizin resmî kur kaynağı her iş günü yoklanır; bülten tarihi bugüne eşit olduğunda kurlar kendiliğinden kaydedilir. Yayın saati varsayılmaz. Elle girdiğiniz kurların üzerine yazılmaz; resmî tatilde yeni bülten yoksa o gün atlanır.',
          example: 'Örnek: Sabah ayarı açarsınız; merkez bankası günün bültenini yayımladıktan sonraki ilk turda kurlar kaydedilir ve yeni faturalar güncel kurla açılır.',
        }}
        description={
          data.provider
            ? `${data.providerLabel} · hafta içi, yeni bülten yayımlandıktan sonraki ilk turda${data.publishAfter && data.publishAfter !== '00:00' ? ` (${data.publishAfter} sonrası)` : ''}`
            : 'Önce şirket çalışma ülkesini seçin.'
        }
        action={
          <Switch
            checked={data.enabled}
            label="Kurları her iş günü otomatik çek"
            disabled={!canManage || !data.provider}
            loading={save.isPending}
            onChange={next =>
              save.mutate(next, {
                onSuccess: r => toast.success(r.enabled ? 'Otomatik kur çekimi açıldı.' : 'Otomatik kur çekimi kapatıldı.'),
                onError: e => toast.error(errorMessage(e)),
              })
            }
          />
        }
      />
      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 px-5 py-4 text-sm">
        <div className="flex items-center gap-2 text-muted">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          <span>
            Son resmî kur:{' '}
            <span className="text-text">
              {data.lastImport ? `${formatDateTR(data.lastImport.date)} · ${data.lastImport.source}` : 'henüz alınmadı'}
            </span>
            {data.lastImport?.fetchedAt && <span> ({timeTR(data.lastImport.fetchedAt)})</span>}
          </span>
        </div>
        {data.enabled && data.enabledByName && (
          <p className="text-muted">
            Açan: <span className="text-text">{data.enabledByName}</span>
          </p>
        )}
        {!canManage && <p className="text-xs text-muted">Ayarı yalnız kur yönetme yetkisi olan kullanıcılar değiştirebilir.</p>}
      </div>
      {data.enabled && data.lastError && (
        <div className="px-5 pb-4">
          <Callout tone="warning" title={`Son deneme başarısız${data.lastAttemptAt ? ` · ${timeTR(data.lastAttemptAt)}` : ''}`}>
            {data.lastError} Sistem bir sonraki turda yeniden dener; isterseniz yukarıdan elle indirebilirsiniz.
          </Callout>
        </div>
      )}
    </Card>
  );
}
