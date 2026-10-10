import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso, type DurationEstimate } from '@erp/shared';
import { useCompanyApi } from '../../lib/queries';
import { Field, Input, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Card } from '../../components/ui/Card';
import { Callout, EmptyState } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { displayDateTime, displayQuantity } from '../../lib/presentation';
import { errorMessage } from '../../lib/errors';

export type PlanningOrder = {
  id: string;
  code?: string;
  quantity?: string;
  status?: string;
  operations: {
    key: string;
    name: string;
    plannedMinutes?: string;
    actualMinutes?: string;
    goodQty?: string;
  }[];
};
type Job = {
  orderId: string;
  operationKey: string;
  name: string;
  resourceId: string;
  minutes: number;
  priority: number;
  predecessor?: string;
  durationSource: 'actual' | 'blended' | 'standard' | 'manual';
  estimate?: DurationEstimate;
};
type EstimateOperations = {
  operationKey: string;
  resources: (DurationEstimate & { resourceId: string })[];
}[];

export function ScheduleBuilder({
  orders,
  resources,
  disabled,
}: {
  orders: PlanningOrder[];
  resources: { id: string; name?: string }[];
  disabled?: boolean;
}) {
  const { call } = useCompanyApi();
  const queries = useQueryClient(),
    toast = useToast(),
    formId = useId();
  const [open, setOpen] = useState(false),
    [step, setStep] = useState(0);
  const [selected, setSelected] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]);
  const [estimates, setEstimates] = useState<Record<string, EstimateOperations>>({});
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [anchorDate, setAnchorDate] = useState(todayIso()),
    [anchorTime, setAnchorTime] = useState('08:00');
  const [direction, setDirection] = useState('forward');
  const orderIds = [...new Set(jobs.map((job) => job.orderId))];
  const availableOrders = orders.filter(
    (order) =>
      !['completed', 'cancelled'].includes(order.status ?? '') &&
      !orderIds.includes(order.id) &&
      order.operations.some((op) => Number(order.quantity) > Number(op.goodQty ?? 0)),
  );
  const validDate =
    Boolean(anchorDate && anchorTime) &&
    Number.isFinite(new Date(anchorDate + 'T' + anchorTime).getTime());
  const ready =
    jobs.length > 0 &&
    jobs.every(
      (job) =>
        job.resourceId &&
        Number.isInteger(job.minutes) &&
        job.minutes > 0 &&
        job.minutes <= 525600 &&
        Number.isInteger(job.priority) &&
        job.priority >= 0 &&
        job.priority <= 100,
    );
  const reset = () => {
    setStep(0);
    setSelected('');
    setJobs([]);
    setEstimates({});
    setError('');
    setAnchorDate(todayIso());
    setAnchorTime('08:00');
    setDirection('forward');
  };
  const add = async () => {
    const order = availableOrders.find((item) => item.id === selected);
    if (!order) return;
    setLoading(true);
    setError('');
    try {
      const result = await call<{ operations: EstimateOperations }>(
        `/api/manufacturing/production/orders/${order.id}/estimates`,
      );
      setEstimates((old) => ({ ...old, [order.id]: result.operations }));
      setJobs((previous) => [
        ...previous,
        ...order.operations
          .filter((op) => Number(order.quantity) > Number(op.goodQty ?? 0))
          .map<Job>((op) => {
            const index = order.operations.findIndex((item) => item.key === op.key);
            const estimate = result.operations
              .find((item) => item.operationKey === op.key)
              ?.resources.find((item) =>
                resources.some((resource) => resource.id === item.resourceId),
              );
            return {
              orderId: order.id,
              operationKey: op.key,
              name: op.name,
              resourceId: estimate?.resourceId ?? '',
              minutes: estimate?.minutes ?? 0,
              priority: 50,
              predecessor:
                index > 0 &&
                Number(order.operations[index - 1]?.goodQty ?? 0) < Number(order.quantity)
                  ? order.operations[index - 1]?.key
                  : undefined,
              durationSource:
                estimate?.source && estimate.source !== 'no_data' ? estimate.source : 'manual',
              estimate,
            };
          }),
      ]);
      setSelected('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <Button
        variant="primary"
        disabled={disabled}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Yeni plan oluştur
      </Button>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!loading && !saving) setOpen(value);
        }}
        title="Yeni plan oluştur"
        description="Emirleri seçin, tarihi belirleyin ve hesaplanacak planı kontrol edin."
        wide
        footer={
          <>
            {step > 0 && (
              <Button
                disabled={saving}
                onClick={() => {
                  setError('');
                  setStep(step - 1);
                }}
              >
                Geri
              </Button>
            )}
            {step === 0 && (
              <Button
                variant="primary"
                disabled={!jobs.length || loading}
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
              >
                Tarihe geç
              </Button>
            )}
            {step === 1 && (
              <Button
                variant="primary"
                disabled={!validDate}
                onClick={() => {
                  setError('');
                  setStep(2);
                }}
              >
                Planı kontrol et
              </Button>
            )}
            {step === 2 && (
              <Button
                variant="primary"
                type="submit"
                form={formId}
                disabled={!ready || !validDate}
                loading={saving}
              >
                Taslak plan oluştur
              </Button>
            )}
          </>
        }
      >
        <ol className="mb-6 grid grid-cols-3 gap-2" aria-label="Plan oluşturma adımları">
          {['Üretim emirleri', 'Tarih ve yön', 'Kontrol et'].map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? 'step' : undefined}
              className={`min-w-0 border-b-2 pb-3 text-sm ${step === index ? 'border-text text-text' : 'border-border text-muted'}`}
            >
              <span className="mb-1 block text-xs">Adım {index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {error && (
          <div className="mb-4">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}
        {step === 0 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Her emrin kalan işlemleri sırasıyla plana eklenir. Birden fazla emir seçebilirsiniz.
            </p>
            {!resources.length && (
              <Callout tone="warning">
                Önce “Takvim ve kaynaklar” sekmesinden bir kaynak ve çalışma takvimi ekleyin.
              </Callout>
            )}
            {availableOrders.length > 0 ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Üretim emri" className="flex-1 basis-60">
                  {(id) => (
                    <Select
                      id={id}
                      value={selected}
                      disabled={loading}
                      onChange={(event) => setSelected(event.target.value)}
                    >
                      <option value="">Emir seçin</option>
                      {availableOrders.map((order) => (
                        <option key={order.id} value={order.id}>
                          {order.code ?? 'Üretim emri'}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Button
                  loading={loading}
                  disabled={!selected || !resources.length}
                  onClick={() => void add()}
                >
                  Ekle
                </Button>
              </div>
            ) : !jobs.length ? (
              <EmptyState
                title="Planlanacak üretim emri yok"
                description="Üretim ve atölye ekranında açık bir üretim emri oluşturduktan sonra buraya ekleyebilirsiniz."
              />
            ) : (
              <p className="text-sm text-muted">Planlanabilecek tüm emirler eklendi.</p>
            )}
            <ul className="space-y-3">
              {orderIds.map((orderId) => (
                <li
                  key={orderId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
                >
                  <div className="min-w-0">
                    <p>{orders.find((order) => order.id === orderId)?.code ?? 'Üretim emri'}</p>
                    <p className="mt-1 text-sm text-muted">
                      {jobs.filter((job) => job.orderId === orderId).length} işlem eklendi
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={loading}
                    onClick={() =>
                      setJobs((previous) => previous.filter((job) => job.orderId !== orderId))
                    }
                  >
                    Emri çıkar
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {step === 1 && (
          <div className="space-y-5">
            <Field
              label="Planlama yöntemi"
              hint="Başlangıçtan planlama en erken bitişi; teslimden planlama ise işe başlamanız gereken zamanı hesaplar."
            >
              {(id) => (
                <Select
                  id={id}
                  value={direction}
                  onChange={(event) => setDirection(event.target.value)}
                >
                  <option value="forward">Başlangıç tarihinden itibaren planla</option>
                  <option value="backward">Teslim tarihine yetişecek şekilde planla</option>
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={direction === 'forward' ? 'Başlangıç tarihi' : 'Hedef teslim tarihi'}
                required
              >
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    required
                    value={anchorDate}
                    onChange={(event) => setAnchorDate(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label={direction === 'forward' ? 'Başlangıç saati' : 'Hedef teslim saati'}
                required
              >
                {(id) => (
                  <Input
                    id={id}
                    type="time"
                    required
                    value={anchorTime}
                    onChange={(event) => setAnchorTime(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <Callout>
              Çalışma takvimi, mevcut yayımlanmış işler, bakım ve devamsızlıklar hesaplamaya dahil
              edilir.
            </Callout>
          </div>
        )}
        {step === 2 && (
          <form
            id={formId}
            aria-label="Taslak plan oluştur"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!ready || !validDate || saving) return;
              setSaving(true);
              setError('');
              try {
                await call('/api/manufacturing/planning/schedules', {
                  method: 'POST',
                  body: {
                    anchor: new Date(anchorDate + 'T' + anchorTime).toISOString(),
                    direction,
                    jobs: jobs.map(({ name, estimate, ...job }) => {
                      void name;
                      void estimate;
                      return job;
                    }),
                  },
                });
                await queries.invalidateQueries();
                toast.success('Taslak plan hazır. Tarihleri kontrol edip yayımlayabilirsiniz.');
                setOpen(false);
              } catch (cause) {
                setError(errorMessage(cause));
              } finally {
                setSaving(false);
              }
            }}
          >
            <fieldset disabled={saving} className="space-y-4">
              <Callout title="Plan özeti">
                <p>
                  {orderIds.length} üretim emri · {jobs.length} işlem.
                </p>
                <p className="mt-1">
                  {direction === 'forward' ? 'Başlangıç' : 'Hedef teslim'}:{' '}
                  {displayDateTime(anchorDate + 'T' + anchorTime)}.
                </p>
                <p className="mt-1">Taslak, yayımlayana kadar kapasite ayırmaz.</p>
              </Callout>
              {!ready && (
                <Callout tone="warning">
                  Her işlem için kaynak ve sıfırdan büyük tam dakika girin. Öncelik 0–100 arasında
                  olmalıdır.
                </Callout>
              )}
              {jobs.map((job, index) => (
                <Card key={job.orderId + ':' + job.operationKey} className="space-y-4 p-4">
                  <div>
                    <p>
                      {orders.find((order) => order.id === job.orderId)?.code ?? 'Üretim emri'} ·{' '}
                      {job.name}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {job.durationSource === 'actual'
                        ? 'Gerçekleşen sürelerden hesaplandı'
                        : job.durationSource === 'standard'
                          ? 'Standart süre kullanıldı'
                          : job.durationSource === 'blended'
                            ? 'Gerçek ve standart sürelerden hesaplandı'
                            : 'Süreyi elle belirleyebilirsiniz'}
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="Kaynak"
                      required
                      hint={
                        resources.some((resource) =>
                          estimates[job.orderId]
                            ?.find((op) => op.operationKey === job.operationKey)
                            ?.resources.some((estimate) => estimate.resourceId === resource.id),
                        )
                          ? undefined
                          : 'Bu işleme uygun aktif kaynak yok. Katalog ve reçetedeki kaynak atamalarını kontrol edin.'
                      }
                    >
                      {(id) => (
                        <Select
                          id={id}
                          required
                          value={job.resourceId}
                          onChange={(event) =>
                            setJobs((old) =>
                              old.map((item, i) => {
                                if (i !== index) return item;
                                const estimate = estimates[item.orderId]
                                  ?.find((op) => op.operationKey === item.operationKey)
                                  ?.resources.find(
                                    (resource) => resource.resourceId === event.target.value,
                                  );
                                return {
                                  ...item,
                                  resourceId: event.target.value,
                                  estimate,
                                  ...(item.durationSource === 'manual' && item.minutes > 0
                                    ? {}
                                    : {
                                        minutes: estimate?.minutes ?? 0,
                                        durationSource:
                                          estimate?.source && estimate.source !== 'no_data'
                                            ? estimate.source
                                            : 'manual',
                                      }),
                                };
                              }),
                            )
                          }
                        >
                          <option value="">Kaynak seçin</option>
                          {resources
                            .filter((resource) =>
                              estimates[job.orderId]
                                ?.find((op) => op.operationKey === job.operationKey)
                                ?.resources.some((estimate) => estimate.resourceId === resource.id),
                            )
                            .map((resource) => (
                              <option key={resource.id} value={resource.id}>
                                {resource.name ?? 'Kaynak'}
                              </option>
                            ))}
                        </Select>
                      )}
                    </Field>
                    <Field
                      label="Süre (dakika)"
                      required
                      hint={
                        job.minutes > 0
                          ? `${displayQuantity(job.minutes / 60, 1)} saat`
                          : 'Tahmin yok; bu işlemin süresini girin.'
                      }
                    >
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={1}
                          max={525600}
                          step={1}
                          required
                          value={job.minutes || ''}
                          onChange={(event) =>
                            setJobs((old) =>
                              old.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      minutes: Number(event.target.value),
                                      durationSource: 'manual',
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      )}
                    </Field>
                  </div>
                  <details className="text-sm">
                    <summary className="cursor-pointer py-1 text-muted">
                      Öncelik ve süre ayrıntıları
                    </summary>
                    <div className="mt-3 space-y-3">
                      <Field
                        label="Öncelik"
                        hint="0–100 arasında; büyük değer daha önce planlanır."
                      >
                        {(id) => (
                          <Input
                            id={id}
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            required
                            value={job.priority}
                            onChange={(event) =>
                              setJobs((old) =>
                                old.map((item, i) =>
                                  i === index
                                    ? { ...item, priority: Number(event.target.value) }
                                    : item,
                                ),
                              )
                            }
                          />
                        )}
                      </Field>
                      {job.durationSource !== 'manual' && job.estimate && (
                        <p className="text-xs text-muted">
                          {job.estimate.sampleCount} gerçekleşen kayıt ·{' '}
                          {
                            { low: 'Düşük', medium: 'Orta', high: 'Yüksek' }[
                              job.estimate.confidence
                            ]
                          }{' '}
                          güven · {displayQuantity(job.estimate.lowerMinutes, 0)}–
                          {displayQuantity(job.estimate.upperMinutes, 0)} dakika aralığı
                        </p>
                      )}
                    </div>
                  </details>
                </Card>
              ))}
            </fieldset>
          </form>
        )}
      </Sheet>
    </>
  );
}
