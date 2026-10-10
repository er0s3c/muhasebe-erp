import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Image, MessageSquare } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@ui/Badge';
import { Button } from '@ui/Button';
import { Card, PageHeader } from '@ui/Card';
import { Callout, EmptyState, PageLoading } from '@ui/Feedback';
import { Field, Input, Select, Textarea } from '@ui/Field';
import { Sheet } from '@ui/Sheet';
import { SegmentedTabs } from '@ui/Tabs';
import { useToast } from '@ui/Toast';
import { markFormSaved, useUnsavedChanges } from '@ui/UnsavedChanges';
import { SavedViews } from '@ui/SavedViews';
import {
  api,
  errorText,
  type CustomerFeedbackDetail,
  type FeedbackInbox,
  type FeedbackStatus,
} from '../api';
import { fmtDateTime } from '../format';
import { usePanelAdmin } from '../session';

const PAGE_SIZE = 50;
const labels: Record<FeedbackStatus, string> = {
  new: 'Yeni',
  in_review: 'İncelemede',
  resolved: 'Çözüldü',
};
const tones = { new: 'warning', in_review: 'neutral', resolved: 'success' } as const;
type Filter = 'all' | FeedbackStatus;

function FeedbackText({ label, value }: { label: string; value?: string | null }) {
  return (
    <section className="min-w-0 space-y-1.5">
      <h3 className="text-sm">{label}</h3>
      <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm [overflow-wrap:anywhere]">
        {value || 'Belirtilmedi'}
      </p>
    </section>
  );
}

function Screenshot({ feedback }: { feedback: CustomerFeedbackDetail }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  if (!feedback.screenshot)
    return <p className="text-sm text-muted">Ekran görüntüsü eklenmemiş.</p>;
  const url = `/admin/api/feedback/${encodeURIComponent(feedback.id)}/screenshot`;
  return (
    <figure className="min-w-0 space-y-2">
      <h3 className="text-sm">Ekran görüntüsü</h3>
      {state === 'loading' && (
        <p role="status" className="text-sm text-muted">
          Ekran görüntüsü yükleniyor…
        </p>
      )}
      {state === 'error' ? (
        <Callout tone="warning">
          Ekran görüntüsü yüklenemedi. Tam boy açarak yeniden deneyebilirsiniz.
        </Callout>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Ekran görüntüsünü tam boy aç"
        >
          <img
            src={url}
            alt={`${feedback.pageTitle || 'Bildirilen sayfa'} ekran görüntüsü`}
            onLoad={() => setState('ready')}
            onError={() => setState('error')}
            className="max-h-96 w-full rounded-lg border border-border bg-surface-2 object-contain"
          />
        </a>
      )}
      <figcaption className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {feedback.screenshot.name} ·{' '}
          {Math.ceil(feedback.screenshot.size / 1024).toLocaleString('tr-TR')} KB
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-text underline underline-offset-4"
        >
          Tam boy aç
        </a>
      </figcaption>
    </figure>
  );
}

function FeedbackDetailSheet({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: (status: FeedbackStatus) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const detailKey = ['feedback', 'detail', id];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () =>
      api<{ feedback: CustomerFeedbackDetail }>(`/admin/api/feedback/${encodeURIComponent(id)}`),
  });
  const [edit, setEdit] = useState<{ status: FeedbackStatus; internalNote: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const { confirmLeave } = useUnsavedChanges();
  const feedback = detail.data?.feedback;
  const values = edit ?? {
    status: feedback?.status ?? 'new',
    internalNote: feedback?.internalNote ?? '',
  };
  const changed =
    feedback &&
    (values.status !== feedback.status || values.internalNote !== (feedback.internalNote ?? ''));
  const save = async () => {
    if (!feedback || pending.current || !changed) return;
    pending.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await api<{
        feedback: { id: string; status: FeedbackStatus; internalNote: string; updatedAt: string };
      }>(`/admin/api/feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: values });
      markFormSaved(editRef.current);
      queryClient.setQueryData<{ feedback: CustomerFeedbackDetail }>(detailKey, (previous) =>
        previous ? { feedback: { ...previous.feedback, ...result.feedback } } : previous,
      );
      setEdit(null);
      toast.success('Geri bildirim güncellendi.');
      onSaved(result.feedback.status);
      await queryClient.invalidateQueries({ queryKey: ['feedback'] });
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={feedback ? `Geri bildirim · ${feedback.reference}` : 'Geri bildirim ayrıntısı'}
      description="Müşterinin bildirimini inceleyin; durumunu ve yönetici notunu güncelleyin."
      footer={
        <>
          <Button disabled={busy} onClick={() => { void confirmLeave(onClose); }}>
            Listeye dön
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!changed || !feedback}
            onClick={() => void save()}
          >
            Değişiklikleri kaydet
          </Button>
        </>
      }
    >
      {detail.isPending ? (
        <>
          <PageLoading />
          <p role="status" className="text-center text-sm text-muted">
            Geri bildirim yükleniyor…
          </p>
        </>
      ) : detail.error && !feedback ? (
        <Callout
          tone="danger"
          action={
            <Button size="sm" onClick={() => void detail.refetch()}>
              Yeniden dene
            </Button>
          }
        >
          {errorText(detail.error)}
        </Callout>
      ) : feedback ? (
        <div className="space-y-5">
          {detail.error && (
            <Callout tone="warning">Güncel ayrıntılar alınamadı: {errorText(detail.error)}</Callout>
          )}
          <dl className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {[
              ['Müşteri', feedback.customerName],
              ['Şirket', feedback.companyName],
              ['Gönderen', feedback.reporterName],
              ['Gönderen e-postası', feedback.reporterEmail],
              ['Gönderilme', fmtDateTime(feedback.createdAt)],
              ['Uygulama sürümü', feedback.appVersion],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="mt-1 [overflow-wrap:anywhere]">{value || 'Belirtilmedi'}</dd>
              </div>
            ))}
          </dl>
          <FeedbackText
            label="Bildirilen sayfa"
            value={`${feedback.pageTitle || 'Sayfa adı belirtilmedi'}\n${feedback.pagePath}`}
          />
          <FeedbackText label="Sorun veya öneri" value={feedback.message} />
          <FeedbackText label="Sorunun oluştuğu adımlar" value={feedback.steps} />
          <FeedbackText label="Beklenen sonuç" value={feedback.expected} />
          <Screenshot feedback={feedback} />
          <div ref={editRef} className="space-y-4 border-t border-border pt-5">
            <Field label="Durum">
              {(fieldId) => (
                <Select
                  id={fieldId}
                  disabled={busy}
                  value={values.status}
                  onChange={(event) =>
                    setEdit({ ...values, status: event.target.value as FeedbackStatus })
                  }
                >
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Yönetici notu" hint="Bu not yalnızca yönetici panelinde görünür.">
              {(fieldId) => (
                <Textarea
                  id={fieldId}
                  rows={4}
                  maxLength={4000}
                  disabled={busy}
                  value={values.internalNote}
                  onChange={(event) => setEdit({ ...values, internalNote: event.target.value })}
                />
              )}
            </Field>
            <p className="text-right text-xs text-muted">
              {values.internalNote.length.toLocaleString('tr-TR')} / 4.000 karakter
            </p>
            {saveError && <Callout tone="danger">{saveError}</Callout>}
          </div>
          <p className="text-xs text-muted [overflow-wrap:anywhere]">
            Kurulum: {feedback.installationId}
          </p>
        </div>
      ) : null}
    </Sheet>
  );
}

export function FeedbackPage() {
  const admin = usePanelAdmin();
  const [filter, setFilter] = useState<Filter>('new');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const inbox = useQuery({
    queryKey: ['feedback', 'list', filter, q, offset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (q) params.set('q', q);
      if (filter !== 'all') params.set('status', filter);
      return api<FeedbackInbox>(`/admin/api/feedback?${params}`);
    },
  });
  const counts = inbox.data?.counts;
  const count = (value: number | undefined) =>
    value === undefined ? '—' : value.toLocaleString('tr-TR');
  return (
    <>
      <PageHeader
        title="Geri bildirimler"
        description="Müşterilerin uygulamadan gönderdiği sorunlar ve öneriler. Bildirimleri inceleyip durumlarını buradan takip edin."
      />
      <div className="mb-5 space-y-4">
        <SegmentedTabs<Filter>
          variant="filter"
          label="Geri bildirim durumu"
          className="w-full sm:w-fit"
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setOffset(0);
          }}
          items={[
            { key: 'new', label: `Yeni (${count(counts?.new)})` },
            { key: 'in_review', label: `İncelemede (${count(counts?.in_review)})` },
            { key: 'resolved', label: `Çözüldü (${count(counts?.resolved)})` },
            {
              key: 'all',
              label: `Tümü (${count(counts ? counts.new + counts.in_review + counts.resolved : undefined)})`,
            },
          ]}
        />
        <SavedViews key={admin.id} scope={['license-admin', admin.id, 'feedback']} description="Yalnızca bu tarayıcıdaki yönetici hesabınız için saklanır. Arama metni ve müşteri bilgileri kaydedilmez." filters={{ status: filter }} onApply={(filters) => {
          const status = String(filters.status);
          if (status === 'all' || status in labels) { setFilter(status as Filter); setOffset(0); }
        }} />
        <form
          role="search"
          aria-label="Geri bildirim arama"
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(search.trim());
            setOffset(0);
          }}
        >
          <Input
            type="search"
            className="min-w-0 flex-1 basis-48 sm:max-w-md"
            aria-label="Geri bildirim ara"
            placeholder="Referans, müşteri, sayfa veya mesaj ara…"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit">Ara</Button>
          {(search || q) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setQ('');
                setOffset(0);
              }}
            >
              Temizle
            </Button>
          )}
        </form>
      </div>
      {inbox.isPending ? (
        <>
          <PageLoading />
          <p role="status" className="text-center text-sm text-muted">
            Geri bildirimler yükleniyor…
          </p>
        </>
      ) : inbox.error && !inbox.data ? (
        <Callout
          tone="danger"
          action={
            <Button size="sm" onClick={() => void inbox.refetch()}>
              Yeniden dene
            </Button>
          }
        >
          {errorText(inbox.error)}
        </Callout>
      ) : inbox.data ? (
        <>
          {inbox.error && (
            <div className="mb-4">
              <Callout tone="warning">Liste güncellenemedi: {errorText(inbox.error)}</Callout>
            </div>
          )}
          <Card>
            {inbox.data.feedback.length === 0 ? (
              <EmptyState
                icon={<MessageSquare className="size-5" />}
                title={
                  q
                    ? 'Aramayla eşleşen geri bildirim yok'
                    : filter === 'all'
                      ? 'Henüz geri bildirim yok'
                      : 'Bu durumda geri bildirim yok'
                }
                description={
                  q
                    ? 'Başka bir kelimeyle arayın veya aramayı temizleyin.'
                    : 'Yeni bildirimler burada listelenir; diğer kayıtlar için durum filtresini değiştirebilirsiniz.'
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {inbox.data.feedback.map((feedback) => (
                  <li key={feedback.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(feedback.id)}
                      aria-label={`Geri bildirimi aç: ${feedback.reference}`}
                      className="grid w-full min-w-0 gap-3 px-4 py-4 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5"
                    >
                      <span className="min-w-0 space-y-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm">{feedback.reference}</span>
                          <Badge tone={tones[feedback.status]}>{labels[feedback.status]}</Badge>
                          {feedback.hasScreenshot && (
                            <span className="inline-flex items-center gap-1 text-xs text-muted">
                              <Image className="size-3.5" aria-hidden />
                              Ekran görüntüsü
                            </span>
                          )}
                        </span>
                        <span className="block text-sm [overflow-wrap:anywhere]">
                          {feedback.pageTitle || 'Sayfa adı belirtilmedi'}
                        </span>
                        <span className="line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]">
                          {feedback.message}
                        </span>
                        <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted [overflow-wrap:anywhere]">
                          <span>{feedback.customerName || 'Müşteri belirtilmedi'}</span>
                          <span>{feedback.companyName || 'Şirket belirtilmedi'}</span>
                          <span>{feedback.reporterName || 'Gönderen belirtilmedi'}</span>
                        </span>
                      </span>
                      <span className="text-xs text-muted sm:text-right">
                        {fmtDateTime(feedback.createdAt)}
                        <span className="mt-1 hidden text-text sm:block">Ayrıntıyı aç →</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p aria-live="polite" className="text-sm text-muted">
              {inbox.data.total === 0
                ? '0 kayıt'
                : `${offset + 1}–${Math.min(offset + PAGE_SIZE, inbox.data.total)} / ${inbox.data.total.toLocaleString('tr-TR')} kayıt`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={offset === 0 || inbox.isFetching}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="size-4" aria-hidden />
                Önceki
              </Button>
              <Button
                disabled={offset + PAGE_SIZE >= inbox.data.total || inbox.isFetching}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Sonraki
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </>
      ) : null}
      {selected && (
        <FeedbackDetailSheet
          key={selected}
          id={selected}
          onClose={() => setSelected(null)}
          onSaved={(status) => {
            if (
              filter !== 'all' &&
              status !== filter &&
              offset > 0 &&
              inbox.data?.feedback.length === 1
            )
              setOffset(Math.max(0, offset - PAGE_SIZE));
          }}
        />
      )}
    </>
  );
}
