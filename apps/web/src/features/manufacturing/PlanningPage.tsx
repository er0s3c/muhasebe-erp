import { errorMessage } from '../../lib/errors';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@erp/shared';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Stat } from '../../components/ui/Stat';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Select } from '../../components/ui/Field';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import {
  displayDateTime,
  displayQuantity,
  displayRecordCode,
  domainLabels,
} from '../../lib/presentation';
import {
  OperationForm,
  Records,
  Status,
  textField,
  numberField,
  selectField,
  options,
  type FormField,
  type Values,
} from '../leather/common';
import { CustomValuesPanel } from './SupportPanels';
import { ScheduleBuilder, type PlanningOrder } from './ScheduleBuilder';
import {
  PlanningCapacityPanel,
  PlanningCalendarTemplateForm,
  PlanningScenarioPanel,
} from './PlanningPanels';

type Resource = {
  id: string;
  code: string;
  name: string;
  type: string;
  capacity: number;
  status: string;
};
type Operation = {
  orderId: string;
  operationKey: string;
  resourceId: string;
  start: string;
  end: string;
};
type Plan = {
  id: string;
  code: string;
  status: string;
  anchor?: string;
  direction?: string;
  previewOnly?: boolean;
  operations: Operation[];
  jobs: { orderId: string; operationKey: string; resourceId: string; minutes: number }[];
};
const dateFields = (prefix: string, label: string, value?: string): FormField[] => {
  const date = value ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
  return [
    {
      name: prefix + 'Date',
      label: label + ' tarihi',
      type: 'date',
      required: true,
      value: valid
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : todayIso(),
    },
    {
      name: prefix + 'Time',
      label: label + ' saati',
      type: 'time',
      required: true,
      value: valid
        ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        : '08:00',
    },
  ];
};
const timestamp = (values: Values, prefix: string) =>
  new Date(values[prefix + 'Date'] + 'T' + values[prefix + 'Time']).toISOString();

function ActionSheet({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: (done: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {title}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={title} description={description} wide>
        {open && children(() => setOpen(false))}
      </Sheet>
    </>
  );
}

function FormAction({
  title,
  description,
  fields,
  submit,
  action,
  successMessage,
}: {
  title: string;
  description?: string;
  fields: FormField[];
  submit: (values: Values) => Promise<unknown>;
  action?: string;
  successMessage?: string;
}) {
  return (
    <ActionSheet title={title} description={description}>
      {(done) => (
        <OperationForm
          title={title}
          description={description}
          fields={fields}
          submit={submit}
          action={action}
          onDone={done}
          successMessage={successMessage}
        />
      )}
    </ActionSheet>
  );
}

export function PlanningPage() {
  const can = useCan(),
    { call, company } = useCompanyApi(),
    queries = useQueryClient();
  const [tab, setTab] = useState('plans'),
    [filter, setFilter] = useState('active');
  const plans = useCQuery<{ records: Plan[] }>(
    ['manufacturing', 'schedules'],
    '/api/manufacturing/planning/schedules',
  );
  const resources = useCQuery<{ records: Resource[] }>(
    ['manufacturing', 'resources'],
    '/api/manufacturing/resources',
  );
  const orders = useCQuery<{ orders: PlanningOrder[] }>(
    ['manufacturing', 'orders'],
    '/api/manufacturing/production/orders',
    { enabled: can('manufacturing.production.read') },
  );
  const save = async (path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') => {
    await call(path, { method, body });
    await queries.invalidateQueries();
  };
  const all = plans.data?.records ?? [],
    availableResources = resources.data?.records ?? [];
  const visible = all.filter(
    (plan) =>
      filter === 'all' ||
      (filter === 'active' ? ['draft', 'published'].includes(plan.status) : plan.status === filter),
  );
  const canCreate =
    can('manufacturing.production.read') &&
    !orders.isPending &&
    !orders.error &&
    !resources.isPending &&
    !resources.error;
  return (
    <>
      <PageHeader
        title="Kapasite ve termin planlama"
        description="Üretim emirlerinin ne zaman başlayıp biteceğini planlayın, ardından uygun planı yayımlayın."
        actions={
          can('manufacturing.planning.manage') && (
            <ScheduleBuilder
              key={company.id}
              orders={orders.data?.orders ?? []}
              resources={availableResources.filter((resource) => resource.status === 'active')}
              disabled={!canCreate}
            />
          )
        }
      />
      {can('manufacturing.planning.manage') && !can('manufacturing.production.read') && (
        <div className="mb-4">
          <Callout>
            Yeni plan oluşturmak için üretim emirlerini görüntüleme yetkisi de gerekir.
          </Callout>
        </div>
      )}
      {orders.error && (
        <div className="mb-4">
          <Callout tone="danger">Üretim emirleri yüklenemedi: {orders.error.message}</Callout>
        </div>
      )}
      {resources.error && (
        <div className="mb-4">
          <Callout tone="danger">Kaynaklar yüklenemedi: {resources.error.message}</Callout>
        </div>
      )}
      <div className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
        <Stat
          className="p-3 sm:p-5"
          label="Yayımlanmış"
          sub={<span className="hidden sm:inline">Kapasite ayıran planlar</span>}
        >
          {plans.data ? all.filter((plan) => plan.status === 'published').length : '—'}
        </Stat>
        <Stat
          className="p-3 sm:p-5"
          label="Taslak"
          sub={<span className="hidden sm:inline">Kontrol edilip yayımlanmayı bekleyen</span>}
        >
          {plans.data
            ? all.filter((plan) => plan.status === 'draft' && !plan.previewOnly).length
            : '—'}
        </Stat>
        <Stat
          className="p-3 sm:p-5"
          label="Aktif kaynak"
          sub={
            <span className="hidden sm:inline">Planlamada kullanılabilen makine ve ekipler</span>
          }
        >
          {resources.data
            ? availableResources.filter((resource) => resource.status === 'active').length
            : '—'}
        </Stat>
      </div>
      <SegmentedTabs id="manufacturing-planningpage-tabs" panelId={() => 'manufacturing-planningpage-tabs-panel'}
        className="mb-5"
        items={[
          { key: 'plans', label: 'Planlar' },
          { key: 'capacity', label: 'Kapasite' },
          { key: 'setup', label: 'Takvim ve kaynaklar' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <TabPanel id="manufacturing-planningpage-tabs-panel" labelledBy={`manufacturing-planningpage-tabs-${tab}`}>
      {tab === 'plans' && (
        <section aria-label="Planlar" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-subheading">Üretim planları</h2>
              <p className="mt-1 text-sm text-muted">
                Taslağı kontrol edin; yayımladığınızda işler kaynak takvimine yerleşir.
              </p>
            </div>
            <Field label="Gösterilecek planlar" className="w-full sm:w-56">
              {(id) => (
                <Select id={id} value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="active">Aktif planlar</option>
                  <option value="draft">Taslaklar</option>
                  <option value="published">Yayımlanmış planlar</option>
                  <option value="all">Tüm planlar ve geçmiş</option>
                </Select>
              )}
            </Field>
          </div>
          {plans.error ? (<ErrorState description={errorMessage(plans.error)} onRetry={() => void plans.refetch()} retrying={plans.isFetching} />) : plans.isPending ? (
            <PageLoading />
          ) : !visible.length ? (
            <Card>
              <EmptyState
                title={all.length ? 'Bu filtrede plan yok' : 'İlk üretim planınızı oluşturun'}
                description={
                  all.length
                    ? 'Diğer planları görmek için filtreyi değiştirebilirsiniz.'
                    : '“Yeni plan oluştur” ile emirleri ve tarihi seçin. Sistem çalışma takvimine göre başlangıç ve bitişleri hesaplar.'
                }
              />
            </Card>
          ) : (
            visible.map((plan) => {
              const start = plan.operations?.reduce(
                (first, op) => (!first || op.start < first ? op.start : first),
                '',
              );
              const end = plan.operations?.reduce(
                (last, op) => (op.end > last ? op.end : last),
                '',
              );
              return (
                <article key={plan.id} aria-label={displayRecordCode(plan.code, 'Üretim planı')}>
                  <Card>
                    <CardHeader
                      title={displayRecordCode(plan.code, 'Üretim planı')}
                      action={
                        <>
                          {plan.previewOnly && <Badge>Deneme planı</Badge>}
                          <Status value={plan.status} />
                        </>
                      }
                    />
                    <div className="space-y-4 p-5">
                      <dl className="grid gap-4 sm:grid-cols-3">
                        <div>
                          <dt className="text-xs text-muted">Başlangıç</dt>
                          <dd className="mt-1 text-sm">{displayDateTime(start)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">Planlanan bitiş</dt>
                          <dd className="mt-1 text-sm">{displayDateTime(end)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted">Plan kapsamı</dt>
                          <dd className="mt-1 text-sm">
                            {new Set((plan.jobs ?? []).map((job) => job.orderId)).size} emir ·{' '}
                            {plan.operations?.length ?? 0} işlem
                          </dd>
                        </div>
                      </dl>
                      {plan.previewOnly && (
                        <p className="text-sm text-muted">
                          Karşılaştırma için hazırlanmış deneme planıdır. Yayımlamak için gerçek
                          takvimle yeni plan oluşturun.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {plan.status === 'draft' &&
                          !plan.previewOnly &&
                          can('manufacturing.planning.approve') && (
                            <FormAction
                              title="Planı yayımla"
                              description="Tarihler yeniden kontrol edilir ve plan kaynak kapasitesine eklenir."
                              fields={[]}
                              action="Planı yayımla"
                              submit={(values) =>
                                save(`/api/manufacturing/planning/schedules/${plan.id}/publish`, {
                                  action: 'publish',
                                  date: todayIso(),
                                  requestKey: values._requestKey,
                                })
                              }
                            />
                          )}
                        {plan.status === 'draft' &&
                          !plan.previewOnly &&
                          can('manufacturing.planning.manage') && (
                            <FormAction
                              title="Tarihi değiştir"
                              description="Yeni tarihe göre bir taslak sürüm hesaplanır; önceki plan geçmişte korunur."
                              fields={[
                                ...dateFields('anchor', 'Yeni referans', plan.anchor),
                                selectField(
                                  'direction',
                                  'Planlama yöntemi',
                                  [
                                    { value: 'forward', label: 'Başlangıçtan itibaren' },
                                    { value: 'backward', label: 'Teslim tarihinden geriye' },
                                  ],
                                  true,
                                  plan.direction ?? 'forward',
                                ),
                                textField('reason', 'Değişiklik nedeni', true),
                              ]}
                              action="Yeniden hesapla"
                              submit={(values) =>
                                save(
                                  `/api/manufacturing/planning/schedules/${plan.id}`,
                                  {
                                    anchor: timestamp(values, 'anchor'),
                                    direction: values.direction,
                                    jobs: plan.jobs,
                                    requestKey: values._requestKey,
                                    reason: values.reason,
                                  },
                                  'PUT',
                                )
                              }
                            />
                          )}
                        {plan.status === 'published' && can('manufacturing.planning.approve') && (
                          <FormAction
                            title="Planı iptal et"
                            description="Bu planın ayırdığı kapasite serbest bırakılır."
                            fields={[]}
                            action="Kapasiteyi serbest bırak"
                            submit={() =>
                              save(`/api/manufacturing/planning/schedules/${plan.id}/cancel`, {})
                            }
                          />
                        )}
                      </div>
                      <details className="text-sm">
                        <summary className="cursor-pointer py-1">İşlem tarihlerini göster</summary>
                        <div className="mt-3">
                          <Records
                            rows={(plan.operations ?? []).map((op, index) => ({
                              ...op,
                              id: `${plan.id}:${index}`,
                            }))}
                            empty="Planlanmış işlem bulunamadı"
                            columns={[
                              {
                                label: 'Üretim emri',
                                render: (op) =>
                                  displayRecordCode(
                                    orders.data?.orders.find((order) => order.id === op.orderId)
                                      ?.code,
                                    'Üretim emri',
                                  ),
                              },
                              {
                                label: 'İşlem',
                                render: (op) =>
                                  displayRecordCode(
                                    orders.data?.orders
                                      .find((order) => order.id === op.orderId)
                                      ?.operations.find(
                                        (operation) => operation.key === op.operationKey,
                                      )?.name ?? op.operationKey,
                                    'İşlem',
                                  ),
                              },
                              {
                                label: 'Kaynak',
                                render: (op) =>
                                  availableResources.find(
                                    (resource) => resource.id === op.resourceId,
                                  )?.name ?? 'Kaynak',
                              },
                              { label: 'Başlangıç', render: (op) => displayDateTime(op.start) },
                              { label: 'Bitiş', render: (op) => displayDateTime(op.end) },
                            ]}
                          />
                        </div>
                      </details>
                    </div>
                  </Card>
                </article>
              );
            })
          )}
          <PlanningScenarioPanel />
        </section>
      )}
      {tab === 'capacity' && (
        <section aria-label="Kapasite" className="space-y-5">
          <PlanningCapacityPanel />
          <DurationHistory />
        </section>
      )}
      {tab === 'setup' && (
        <PlanningSetup resources={availableResources} loading={resources.isPending} />
      )}
      </TabPanel>
    </>
  );
}

function DurationHistory() {
  const can = useCan();
  const report = useCQuery<{
    history: {
      days: number;
      goodQty: string;
      minutes: number;
      minutesPerUnit: number;
      source: string;
    }[];
  }>(['manufacturing', 'reports'], '/api/manufacturing/reports', {
    enabled: can('manufacturing.production.read'),
  });
  if (!can('manufacturing.production.read')) return null;
  return (
    <details className="rounded-xl border border-border bg-surface p-5">
      <summary className="cursor-pointer text-sm">Süre tahminleri nasıl hesaplanıyor?</summary>
      <p className="my-3 text-sm text-muted">
        Geçmiş üretim süreleri ve standart süreler, yeni planın işlem süresini tahmin etmekte
        kullanılır.
      </p>
      <Records
        rows={report.data?.history.map((row) => ({ ...row, id: String(row.days) })) ?? []}
        loading={report.isPending} onRetry={() => void report.refetch()} retrying={report.isFetching}
        error={report.error}
        columns={[
          { label: 'İncelenen gün', render: (row) => displayQuantity(row.days, 0) },
          { label: 'Üretilen sağlam adet', render: (row) => displayQuantity(row.goodQty) },
          { label: 'Gerçek süre (dk)', render: (row) => displayQuantity(row.minutes) },
          { label: 'Adet başına dakika', render: (row) => displayQuantity(row.minutesPerUnit) },
          { label: 'Veri kaynağı', render: (row) => domainLabels[row.source] ?? 'Veri yok' },
        ]}
      />
    </details>
  );
}

function PlanningSetup({ resources, loading }: { resources: Resource[]; loading: boolean }) {
  const can = useCan(),
    { call } = useCompanyApi(),
    queries = useQueryClient();
  const manage = can('manufacturing.planning.manage');
  const employees = useCQuery<{ employees: { id: string; name: string }[] }>(
    ['manufacturing', 'planning-lookups'],
    '/api/manufacturing/planning/lookups',
    { enabled: manage },
  );
  const departments = useCQuery<{ records: { id: string; name: string }[] }>(
    ['manufacturing', 'departments'],
    '/api/manufacturing/departments',
    { enabled: manage },
  );
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <section aria-label="Takvim ve kaynaklar" className="space-y-5">
      <Card>
        <CardHeader
          title="Çalışma takvimi"
          description="Önce kaynakları ekleyin, sonra hangi gün ve saatlerde çalışacaklarını belirleyin."
        />
        <div className="space-y-4 p-5">
          <p className="text-sm text-muted">
            Düzenli vardiyalar için günleri seçin. Tek günlük devamsızlık ve fazla mesaileri ayrıca
            kaydedin; bakım ve arızalar makine bakım ekranından gelir.
          </p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <ActionSheet title="Vardiya günlerini belirle">
                {(done) => <PlanningCalendarTemplateForm onDone={done} />}
              </ActionSheet>
              <FormAction
                title="Devamsızlık veya ek çalışma"
                fields={[
                  selectField(
                    'resourceId',
                    'Kaynak',
                    options(resources, (resource) => resource.name),
                  ),
                  ...dateFields('start', 'Başlangıç'),
                  ...dateFields('end', 'Bitiş'),
                  selectField('reason', 'Takvim türü', [
                    { value: 'absence', label: 'Devamsızlık' },
                    { value: 'overtime', label: 'Fazla mesai' },
                    { value: 'shift', label: 'Tek seferlik vardiya' },
                  ]),
                ]}
                submit={async (values) => {
                  const start = timestamp(values, 'start'),
                    end = timestamp(values, 'end');
                  if (end <= start) throw new Error('Bitiş, başlangıçtan sonra olmalıdır.');
                  await save('/api/manufacturing/calendars', {
                    resourceId: values.resourceId,
                    start,
                    end,
                    reason: values.reason,
                    available: values.reason !== 'absence',
                  });
                }}
              />
            </div>
          )}
        </div>
      </Card>
      <CalendarRecords resources={resources} />
      <Card>
        <CardHeader
          title="Makine ve ekipler"
          description="Her kaynak, bir makineyi, personeli veya iş merkezini temsil eder."
          action={
            manage && (
              <FormAction
                title="Kaynak ekle"
                fields={[
                  textField('code', 'Kod'),
                  textField('name', 'Kaynak adı'),
                  selectField('type', 'Tür', [
                    { value: 'machine', label: 'Makine' },
                    { value: 'person', label: 'Personel' },
                    { value: 'center', label: 'İş merkezi' },
                  ]),
                  {
                    ...numberField('capacity', 'Aynı anda çalışabilecek iş sayısı', '1'),
                    min: 1,
                    hint: 'Çoğu makine için 1 olarak bırakabilirsiniz.',
                  },
                  selectField(
                    'employeeId',
                    'Personel (isteğe bağlı)',
                    options(employees.data?.employees ?? [], (employee) => employee.name),
                    false,
                  ),
                  selectField(
                    'department',
                    'Departman (isteğe bağlı)',
                    (departments.data?.records ?? []).map((department) => ({
                      value: department.name,
                      label: department.name,
                    })),
                    false,
                  ),
                ]}
                submit={(values) =>
                  save('/api/manufacturing/resources', {
                    ...values,
                    employeeId: values.employeeId || undefined,
                    capacity: Number(values.capacity),
                  })
                }
              />
            )
          }
        />
        <div className="p-5">
          <Records
            rows={resources}
            loading={loading}
            columns={[
              { label: 'Kod', render: (resource) => displayRecordCode(resource.code, 'Kaynak') },
              { label: 'Kaynak', render: (resource) => resource.name },
              { label: 'Tür', render: (resource) => domainLabels[resource.type] ?? 'Kaynak' },
              {
                label: 'Aynı anda iş',
                numeric: true,
                render: (resource) => displayQuantity(resource.capacity, 0),
              },
              { label: 'Durum', render: (resource) => <Status value={resource.status} /> },
            ]}
            action={
              manage
                ? (resource) => <CustomValuesPanel entity="resource" id={resource.id} />
                : undefined
            }
          />
        </div>
      </Card>
      {manage && (
        <details className="rounded-xl border border-border bg-surface p-5">
          <summary className="cursor-pointer text-sm">
            Diğer ayarlar: departmanlar ve özel alanlar
          </summary>
          <div className="mt-4 flex flex-wrap gap-2">
            <FormAction
              title="Şube ve departman ekle"
              fields={[
                textField('code', 'Kod'),
                textField('name', 'Departman'),
                textField('branch', 'Şube'),
              ]}
              submit={(values) => save('/api/manufacturing/departments', values)}
            />
            <FormAction
              title="Özel alan tanımla"
              fields={[
                textField('code', 'Alan kodu'),
                textField('name', 'Görünen ad'),
                selectField('entity', 'Kayıt türü', [
                  { value: 'resource', label: 'Kaynak' },
                  { value: 'production', label: 'Üretim emri' },
                  { value: 'model', label: 'Model' },
                  { value: 'item', label: 'Stok' },
                ]),
                selectField('type', 'Veri türü', [
                  { value: 'text', label: 'Metin' },
                  { value: 'number', label: 'Sayı' },
                  { value: 'date', label: 'Tarih' },
                  { value: 'choice', label: 'Seçim' },
                ]),
                selectField('required', 'Zorunlu', [
                  { value: 'no', label: 'Hayır' },
                  { value: 'yes', label: 'Evet' },
                ]),
                textField('choices', 'Seçenekler (virgülle)', false),
              ]}
              submit={(values) =>
                save('/api/manufacturing/custom-fields', {
                  ...values,
                  required: values.required === 'yes',
                  choices: values.choices
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
        </details>
      )}
    </section>
  );
}

function CalendarRecords({ resources }: { resources: Resource[] }) {
  const [open, setOpen] = useState(false),
    [resourceId, setResourceId] = useState('');
  const calendars = useCQuery<{
    records: {
      id: string;
      resourceId: string;
      start: string;
      end: string;
      reason: string;
      available: boolean;
    }[];
  }>(['manufacturing', 'calendars'], '/api/manufacturing/calendars', { enabled: open });
  return (
    <details
      className="rounded-xl border border-border bg-surface p-5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm">Tanımlı çalışma aralıklarını göster</summary>
      {open && (
        <div className="mt-4 space-y-4">
          <Field label="Kaynağa göre süz" className="max-w-sm">
            {(id) => (
              <Select
                id={id}
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
              >
                <option value="">Tüm kaynaklar</option>
                {resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Records
            loading={calendars.isPending} onRetry={() => void calendars.refetch()} retrying={calendars.isFetching}
            error={calendars.error}
            rows={(calendars.data?.records ?? []).filter(
              (calendar) => !resourceId || calendar.resourceId === resourceId,
            )}
            empty="Bu görünümde çalışma aralığı yok"
            columns={[
              {
                label: 'Kaynak',
                render: (calendar) =>
                  resources.find((resource) => resource.id === calendar.resourceId)?.name ??
                  'Kaynak',
              },
              {
                label: 'Kayıt türü',
                render: (calendar) =>
                  domainLabels[calendar.reason] ??
                  (calendar.available ? 'Çalışma' : 'Çalışılmayacak süre'),
              },
              { label: 'Başlangıç', render: (calendar) => displayDateTime(calendar.start) },
              { label: 'Bitiş', render: (calendar) => displayDateTime(calendar.end) },
            ]}
          />
        </div>
      )}
    </details>
  );
}
