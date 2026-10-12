import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addDaysIso, todayIso } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { displayQuantity, displayRecordCode } from '../../lib/presentation';
import { useCompany } from '../../lib/session';
import {
  OperationForm,
  Records,
  numberField,
  options,
  selectField,
  textField,
  type Values,
} from '../leather/common';

type Resource = { id: string; name?: string; code?: string; status?: string };
type Capacity = Resource & {
  capacityMinutes: number;
  loadMinutes: number;
  loadPct: number | null;
  noCalendar: boolean;
};
type Scenario = {
  id: string;
  code?: string;
  version?: number;
  parentId?: string;
  reason?: string;
  previewOnly?: boolean;
  scenarioCost?: number | null;
  jobs?: { minutes: number }[];
  differences?: { previousEnd?: string; end: string }[];
};

const reason = textField('reason', 'Açıklama / işlem nedeni', true);
const command = (values: Values) => ({ requestKey: values._requestKey, reason: values.reason });
const defaultWeekdays = [1, 2, 3, 4, 5];
const weekdays = [
  { value: 1, label: 'Pazartesi' },
  { value: 2, label: 'Salı' },
  { value: 3, label: 'Çarşamba' },
  { value: 4, label: 'Perşembe' },
  { value: 5, label: 'Cuma' },
  { value: 6, label: 'Cumartesi' },
  { value: 0, label: 'Pazar' },
];

function duration(value: number) {
  if (!Number.isFinite(value)) return '—';
  const minutes = Math.max(0, Math.round(value));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours
    ? `${displayQuantity(hours, 0)} saat${remainder ? ` ${remainder} dk` : ''}`
    : `${minutes} dk`;
}

export function PlanningCapacityPanel() {
  const firstDay = todayIso();
  const from = `${firstDay}T00:00:00+03:00`;
  const to = new Date(Date.parse(from) + 7 * 86400000).toISOString();
  const capacity = useCQuery<{ resources: Capacity[] }>(
    ['manufacturing', 'capacity', from],
    `/api/manufacturing/planning/capacity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  const rows = capacity.data?.resources ?? [];
  return (
    <section className="space-y-4" aria-label="Önümüzdeki 7 günün kapasitesi">
      <div>
        <h2 className="text-subheading">Önümüzdeki 7 gün</h2>
        <p className="mt-1 text-sm text-muted">
          {formatDateTR(firstDay)} – {formatDateTR(addDaysIso(firstDay, 6))}. Yalnızca yayımlanmış
          planlar iş yüküne eklenir. Taslak ve deneme planları kapasiteyi ayırmaz.
        </p>
      </div>
      {capacity.isPending ? (
        <PageLoading />
      ) : capacity.error ? (
        <Callout tone="danger">{errorMessage(capacity.error)}</Callout>
      ) : !rows.length ? (
        <Card>
          <EmptyState
            title="Henüz planlanacak kaynak yok"
            description="Takvim ve kaynaklar bölümünden makine, personel veya iş merkezi ekleyin."
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((resource) => {
            const noCapacity = resource.noCalendar || resource.capacityMinutes <= 0;
            const overloaded = !noCapacity && resource.loadMinutes > resource.capacityMinutes;
            const full = !noCapacity && resource.loadMinutes === resource.capacityMinutes;
            const percent = resource.loadPct;
            const name = resource.name || displayRecordCode(resource.code, 'Kaynak');
            return (
              <Card key={resource.id}>
                <CardHeader
                  title={name}
                  action={
                    <Badge
                      tone={
                        noCapacity
                          ? 'warning'
                          : overloaded
                            ? 'danger'
                            : full
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {noCapacity
                        ? 'Çalışma süresi yok'
                        : overloaded
                          ? 'Kapasite aşılıyor'
                          : full
                            ? 'Kapasite dolu'
                            : resource.loadMinutes > 0
                              ? 'Boş kapasite var'
                              : 'Planlanmış iş yok'}
                    </Badge>
                  }
                />
                <div className="space-y-4 p-5">
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-muted">Planlanabilir süre</dt>
                      <dd className="mt-1 text-base tabular-nums">
                        {duration(resource.capacityMinutes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Yayımlanmış iş</dt>
                      <dd className="mt-1 text-base tabular-nums">
                        {duration(resource.loadMinutes)}
                      </dd>
                    </div>
                  </dl>
                  {noCapacity ? (
                    <p className="text-sm text-muted">
                      Bu dönem için çalışma süresi bulunamadı. Takvimi, izin ve bakım kayıtlarını
                      kontrol edin.
                    </p>
                  ) : (
                    <>
                      <div>
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="text-muted">Doluluk</span>
                          <span
                            className={overloaded ? 'text-danger tabular-nums' : 'tabular-nums'}
                          >
                            %{displayQuantity(percent, 0)}
                          </span>
                        </div>
                        <div
                          role="progressbar"
                          aria-label={`${name} kapasite doluluğu`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.min(100, Math.max(0, percent ?? 0))}
                          aria-valuetext={`Yüzde ${displayQuantity(percent, 0)} dolu`}
                          className="h-2.5 overflow-hidden rounded-sm bg-surface-2"
                        >
                          <div
                            className={`h-full rounded-sm ${overloaded ? 'bg-danger' : 'bg-text'}`}
                            style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
                          />
                        </div>
                      </div>
                      <p className={`text-sm ${overloaded ? 'text-danger' : 'text-muted'}`}>
                        {overloaded
                          ? `${duration(resource.loadMinutes - resource.capacityMinutes)} kapasite fazlası var. İşleri başka kaynağa veya tarihe taşıyın.`
                          : `${duration(resource.capacityMinutes - resource.loadMinutes)} daha iş planlanabilir.`}
                      </p>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted">
        Planlanabilir süre; çalışma takvimi, eşzamanlı kapasite, bakım ve devamsızlık kayıtlarıyla
        hesaplanır.
      </p>
    </section>
  );
}

export function PlanningCalendarTemplateForm({ onDone }: { onDone?: () => void } = {}) {
  const can = useCan();
  const { call, company } = useCompanyApi();
  const queries = useQueryClient();
  const [selectedDays, setSelectedDays] = useState(defaultWeekdays);
  const resources = useCQuery<{ records: Resource[] }>(
    ['manufacturing', 'resources'],
    '/api/manufacturing/resources',
    { enabled: can('manufacturing.planning.manage') },
  );
  if (!can('manufacturing.planning.manage')) return null;
  if (resources.isPending) return <PageLoading />;
  if (resources.error) return <Callout tone="danger">{errorMessage(resources.error)}</Callout>;
  return (
    <OperationForm
      title="Haftalık çalışma takvimi"
      description="Bir kaynağın çalışma günlerini ve saatlerini seçin. Seçtiğiniz düzen, başlangıç ve bitiş tarihleri arasında uygulanır."
      action="Takvimi oluştur"
      successMessage="Çalışma takvimi oluşturuldu"
      onDone={onDone}
      fields={[
        selectField(
          'resourceId',
          'Hangi kaynak çalışacak?',
          options(
            resources.data?.records.filter((r) => r.status === 'active') ?? [],
            (r) => r.name || displayRecordCode(r.code, 'Kaynak'),
          ),
        ),
        {
          name: 'from',
          label: 'Başlangıç tarihi',
          type: 'date',
          required: true,
          value: todayIso(),
        },
        {
          name: 'to',
          label: 'Bitiş tarihi',
          type: 'date',
          required: true,
          value: addDaysIso(todayIso(), 29),
          hint: 'En fazla bir yıllık takvim oluşturabilirsiniz.',
        },
        {
          name: 'startTime',
          label: 'Çalışma başlangıcı',
          type: 'time',
          required: true,
          value: '08:00',
        },
        {
          name: 'endTime',
          label: 'Çalışma bitişi',
          type: 'time',
          required: true,
          value: '17:00',
          hint: 'Başlangıç ve bitiş aynı gün içinde olmalıdır.',
        },
        reason,
        textField(
          'holidays',
          'Tatil günleri (isteğe bağlı)',
          false,
          'Çalışılmayacak tarihleri yıl-ay-gün biçiminde virgülle ayırın. Örnek: 2026-10-29, 2027-01-01',
        ),
      ]}
      submit={async (values) => {
        if (!selectedDays.length) throw new Error('En az bir çalışma günü seçin.');
        if (values.from > values.to)
          throw new Error('Bitiş tarihi başlangıç tarihinden önce olamaz.');
        if (Date.parse(values.to) - Date.parse(values.from) > 366 * 86400000)
          throw new Error('Takvimi en fazla bir yıllık dönem için oluşturabilirsiniz.');
        if (values.startTime >= values.endTime)
          throw new Error('Çalışma bitişi, başlangıçtan sonra ve aynı gün içinde olmalıdır.');
        const holidays = values.holidays
          ? values.holidays.split(',').map((date) => date.trim())
          : [];
        if (
          holidays.some(
            (date) =>
              !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              Number.isNaN(Date.parse(date)) ||
              new Date(date).toISOString().slice(0, 10) !== date,
          )
        )
          throw new Error('Tatil tarihlerini yıl-ay-gün biçiminde yazın ve virgülle ayırın.');
        await call('/api/manufacturing/planning/calendar-template', {
          method: 'POST',
          body: {
            ...command(values),
            resourceId: values.resourceId,
            from: values.from,
            to: values.to,
            weekdays: selectedDays,
            startTime: values.startTime,
            endTime: values.endTime,
            utcOffset: '+03:00',
            holidays,
          },
        });
        await queries.invalidateQueries({ queryKey: [company.id, 'manufacturing'] });
        setSelectedDays(defaultWeekdays);
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm">Çalışılacak günler</legend>
        <p className="text-xs text-muted">
          Yukarıdaki çalışma saatleri, seçtiğiniz günlere uygulanır.
        </p>
        <div className="flex flex-wrap gap-2">
          {weekdays.map((day) => (
            <label
              key={day.value}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm"
            >
              <input
                type="checkbox"
                className="size-4 accent-text"
                checked={selectedDays.includes(day.value)}
                onChange={(event) =>
                  setSelectedDays((current) =>
                    event.target.checked
                      ? [...current, day.value]
                      : current.filter((value) => value !== day.value),
                  )
                }
              />
              {day.label}
            </label>
          ))}
        </div>
      </fieldset>
    </OperationForm>
  );
}

export function PlanningScenarioPanel() {
  const can = useCan();
  const company = useCompany();
  const { call } = useCompanyApi();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const resources = useCQuery<{ records: Resource[] }>(
    ['manufacturing', 'resources'],
    '/api/manufacturing/resources',
    { enabled: open && can('manufacturing.planning.manage') },
  );
  const schedules = useCQuery<{ records: Scenario[] }>(
    ['manufacturing', 'schedules'],
    '/api/manufacturing/planning/schedules',
    { enabled: open },
  );
  return (
    <details
      className="rounded-2xl border border-border bg-surface"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-5 py-4 text-sm">
        Alternatif planlar ve maliyet karşılaştırması
      </summary>
      {open && (
        <div className="space-y-4 border-t border-border p-5">
          <p className="text-sm text-muted">
            Bir planın yeni sürümünü veya farklı çalışma koşullarını deneyin. Sürüm, süre ve tahmini
            maliyet bilgileri burada karşılaştırılır.
          </p>
          <Records
            rows={schedules.data?.records ?? []}
            loading={schedules.isPending} onRetry={() => void schedules.refetch()} retrying={schedules.isFetching}
            error={schedules.error}
            empty="Karşılaştırılacak plan yok"
            columns={[
              {
                label: 'Plan / sürüm',
                render: (row) =>
                  `${displayRecordCode(row.code, 'Plan')} · ${row.version ?? 1}. sürüm`,
              },
              { label: 'Açıklama', render: (row) => row.reason || 'İlk plan' },
              {
                label: 'Hesaplama',
                render: (row) => (row.previewOnly ? 'Deneme koşulları' : 'Mevcut takvim'),
              },
              {
                label: 'Toplam iş süresi',
                render: (row) =>
                  row.jobs
                    ? duration(row.jobs.reduce((total, job) => total + Number(job.minutes), 0))
                    : '—',
              },
              {
                label: 'Önceki sürüme göre bitiş',
                render: (row) => {
                  const differences = row.differences
                    ?.filter((difference) => difference.previousEnd)
                    .map(
                      (difference) =>
                        (Date.parse(difference.end) - Date.parse(difference.previousEnd!)) / 60000,
                    );
                  if (!differences?.length) return 'Karşılaştırma yok';
                  const latestDifference = Math.max(...differences);
                  return latestDifference === 0
                    ? 'Aynı zamanda'
                    : `${duration(Math.abs(latestDifference))} ${latestDifference > 0 ? 'daha geç' : 'daha erken'}`;
                },
              },
              {
                label: 'Tahmini kaynak maliyeti',
                numeric: true,
                render: (row) =>
                  row.scenarioCost == null
                    ? 'Maliyet tanımlanmamış'
                    : moneyIn(String(row.scenarioCost), company.baseCurrency),
              },
            ]}
          />
          <p className="text-xs text-muted">
            Maliyet yalnızca saat ücreti tanımlanmış kaynakları kapsar. Bitiş farkı, önceki sürümle
            eşleşen işler arasındaki en büyük farktır.
          </p>
          {can('manufacturing.planning.manage') && (
            <>
              {resources.error && <Callout tone="danger">{errorMessage(resources.error)}</Callout>}
              <OperationForm
                title="Alternatif plan oluştur"
                description="Kaynak seçmezseniz planı mevcut takvimle yeni bir sürüme kopyalarsınız. Kaynak seçtiğinizde çalışma veya hız varsayımını değiştirebilirsiniz."
                action="Alternatif planı hesapla"
                disabled={
                  resources.isPending ||
                  schedules.isPending ||
                  !!resources.error ||
                  !!schedules.error
                }
                fields={[
                  selectField(
                    'parentId',
                    'Hangi planı kopyalayalım?',
                    options(
                      schedules.data?.records ?? [],
                      (row) =>
                        `${displayRecordCode(row.code, 'Plan')} · ${row.version ?? 1}. sürüm`,
                    ),
                  ),
                  selectField(
                    'resourceId',
                    'Koşulları değişecek kaynak (isteğe bağlı)',
                    options(
                      resources.data?.records ?? [],
                      (row) => row.name || displayRecordCode(row.code, 'Kaynak'),
                    ),
                    false,
                  ),
                  { name: 'date', label: 'Deneme tarihi', type: 'date', value: todayIso() },
                  { name: 'start', label: 'Deneme başlangıcı', type: 'time', value: '08:00' },
                  { name: 'end', label: 'Deneme bitişi', type: 'time', value: '10:00' },
                  {
                    ...selectField('available', 'Denenecek çalışma durumu', [
                      { value: 'no', label: 'Kaynak çalışmayacak' },
                      { value: 'yes', label: 'Ek çalışma süresi' },
                    ]),
                    value: 'no',
                  },
                  {
                    ...numberField('capacity', 'Aynı anda yapılabilecek iş sayısı', '', 1),
                    required: false,
                    step: '1',
                  },
                  {
                    ...numberField('speedFactor', 'Çalışma hızı çarpanı', '1', 0.1),
                    hint: '1 = mevcut hız, 2 = iki kat hızlı.',
                  },
                  { ...numberField('hourlyCost', 'Saat başına maliyet'), required: false },
                  reason,
                ]}
                submit={async (values) => {
                  if (
                    values.resourceId &&
                    (!values.date || !values.start || !values.end || values.start >= values.end)
                  )
                    throw new Error(
                      'Kaynak için geçerli bir tarih ve aynı gün içinde başlangıçtan sonraki bir bitiş saati seçin.',
                    );
                  await call('/api/manufacturing/planning/scenarios', {
                    method: 'POST',
                    body: {
                      ...command(values),
                      parentId: values.parentId,
                      calendarOverrides: values.resourceId
                        ? [
                            {
                              resourceId: values.resourceId,
                              start: new Date(
                                `${values.date}T${values.start}:00+03:00`,
                              ).toISOString(),
                              end: new Date(`${values.date}T${values.end}:00+03:00`).toISOString(),
                              available: values.available === 'yes',
                            },
                          ]
                        : [],
                      resourceOverrides:
                        values.resourceId &&
                        (values.capacity || values.hourlyCost || Number(values.speedFactor) !== 1)
                          ? [
                              {
                                resourceId: values.resourceId,
                                capacity: values.capacity ? Number(values.capacity) : undefined,
                                speedFactor: Number(values.speedFactor),
                                hourlyCost: values.hourlyCost || undefined,
                              },
                            ]
                          : [],
                    },
                  });
                  await queries.invalidateQueries({ queryKey: [company.id, 'manufacturing'] });
                }}
              />
              <Callout>
                Deneme koşulları gerçek takvimi, kaynak hızını veya muhasebe kayıtlarını
                değiştirmez. Varsayım içeren planlar yayımlanamaz; üretim için mevcut takvimle plan
                hazırlayın.
              </Callout>
            </>
          )}
        </div>
      )}
    </details>
  );
}
