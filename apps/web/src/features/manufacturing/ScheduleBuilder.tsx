import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso, type DurationEstimate } from '@erp/shared';
import { useCompanyApi } from '../../lib/queries';
import { Field, Input, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { OperationForm, selectField, textField } from '../leather/common';
import { Callout } from '../../components/ui/Feedback';
import { displayQuantity } from '../../lib/presentation';

type Order = {
  id: string;
  code?: string;
  quantity?: string;
  completedQty?: string;
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
export function ScheduleBuilder({
  orders,
  resources,
}: {
  orders: Order[];
  resources: { id: string; name?: string }[];
}) {
  const { call } = useCompanyApi(),
    queries = useQueryClient();
  const [selected, setSelected] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]);
  const [estimates, setEstimates] = useState<
    Record<
      string,
      { operationKey: string; resources: (DurationEstimate & { resourceId: string })[] }[]
    >
  >({});
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const add = async () => {
    const order = orders.find((o) => o.id === selected);
    if (!order) return;
    setLoading(true);
    setError('');
    try {
      const result = await call<{
        operations: {
          operationKey: string;
          resources: (DurationEstimate & { resourceId: string })[];
        }[];
      }>(`/api/manufacturing/production/orders/${order.id}/estimates`);
      setEstimates((old) => ({ ...old, [order.id]: result.operations }));
      setJobs((previous) => [
        ...previous,
        ...order.operations
          .filter((o) => !previous.some((j) => j.orderId === order.id && j.operationKey === o.key))
          .filter((op) => Number(order.quantity) - Number(op.goodQty ?? 0) > 0)
          .map<Job>((op) => {
            const i = order.operations.findIndex((o) => o.key === op.key);
            const estimate = result.operations.find((o) => o.operationKey === op.key)?.resources[0];
            return {
              orderId: order.id,
              operationKey: op.key,
              name: `${order.code} · ${op.name}`,
              resourceId: estimate?.resourceId ?? '',
              minutes: estimate?.minutes ?? 0,
              priority: 50,
              predecessor:
                i > 0 && Number(order.operations[i - 1]?.goodQty ?? 0) < Number(order.quantity)
                  ? order.operations[i - 1]?.key
                  : undefined,
              durationSource:
                estimate?.source && estimate.source !== 'no_data' ? estimate.source : 'manual',
              estimate,
            };
          }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Süre tahmini hesaplanamadı');
    } finally {
      setLoading(false);
    }
  };
  return (
    <OperationForm
      title="Üretim planı hesapla"
      description="Birden fazla emrin tüm rotasını aynı senaryoda planlayın; her operasyonda kaynak, süre ve öncelik değiştirilebilir."
      fields={[
        {
          name: 'anchorDate',
          label: 'Plan referans tarihi',
          type: 'date',
          value: todayIso(),
          required: true,
        },
        {
          ...textField('anchorTime', 'Plan referans saati'),
          type: 'time',
          required: true,
          value: '08:00',
        },
        selectField(
          'direction',
          'Yön',
          [
            { value: 'forward', label: 'İleri planla' },
            { value: 'backward', label: 'Teslimden geriye planla' },
          ],
          true,
          'forward',
        ),
      ]}
      disabled={!jobs.length || jobs.some((j) => j.minutes <= 0 || !j.resourceId)}
      action="Senaryo oluştur"
      submit={async (v) => {
        await call('/api/manufacturing/planning/schedules', {
          method: 'POST',
          body: {
            anchor: new Date(v.anchorDate + 'T' + v.anchorTime).toISOString(),
            direction: v.direction,
            jobs: jobs.map(({ name, estimate, ...job }) => {
              void name;
              void estimate;
              return job;
            }),
          },
        });
        setJobs([]);
        await queries.invalidateQueries();
      }}
    >
      <Field label="Senaryoya eklenecek üretim emri">
        {(id) => (
          <Select id={id} value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Seçin</option>
            {orders
              .filter((o) => !['completed', 'cancelled'].includes(o.status ?? ''))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.code}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <Button
        type="button"
        loading={loading}
        disabled={!selected || !resources.length}
        onClick={() => void add()}
      >
        Rotayı ekle
      </Button>
      {error && <Callout tone="danger">{error}</Callout>}
      {jobs.map((job, index) => (
        <div
          key={job.orderId + ':' + job.operationKey}
          className="rounded-xl border border-border bg-surface-2/30 p-4"
        >
          <p className="mb-2 font-medium">
            {job.name} ·{' '}
            {job.durationSource === 'actual'
              ? 'Gerçek süreden'
              : job.durationSource === 'standard'
                ? 'Standart süreden'
                : job.durationSource === 'blended'
                  ? 'Gerçek ve standart süreden'
                  : 'Elle girilen süre'}
          </p>
          {job.durationSource !== 'manual' && job.estimate && (
            <p className="mb-3 text-xs text-muted">
              {job.estimate.sampleCount} gerçekleşen kayıt ·{' '}
              {{ low: 'Düşük', medium: 'Orta', high: 'Yüksek' }[job.estimate.confidence]} güven ·{' '}
              {displayQuantity(job.estimate.lowerMinutes, 0)}–
              {displayQuantity(job.estimate.upperMinutes, 0)} dakika aralığı
            </p>
          )}
          {job.minutes <= 0 && (
            <p className="mb-3 text-sm text-warning">
              Bu operasyon için süre verisi yok. Planlamak için süre giriniz.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Kaynak">
              {(id) => (
                <Select
                  id={id}
                  required
                  value={job.resourceId}
                  onChange={(e) =>
                    setJobs((old) =>
                      old.map((j, i) => {
                        if (i !== index) return j;
                        const estimate = estimates[j.orderId]
                          ?.find((o) => o.operationKey === j.operationKey)
                          ?.resources.find((r) => r.resourceId === e.target.value);
                        return {
                          ...j,
                          resourceId: e.target.value,
                          estimate,
                          ...(j.durationSource === 'manual' && j.minutes > 0
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
                  <option value="">Seçin</option>
                  {resources
                    .filter((r) =>
                      estimates[job.orderId]
                        ?.find((op) => op.operationKey === job.operationKey)
                        ?.resources.some((estimate) => estimate.resourceId === r.id),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
            <Field label="Dakika">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  required
                  value={job.minutes}
                  onChange={(e) =>
                    setJobs((old) =>
                      old.map((j, i) =>
                        i === index
                          ? { ...j, minutes: Number(e.target.value), durationSource: 'manual' }
                          : j,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Field label="Öncelik">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={100}
                  required
                  value={job.priority}
                  onChange={(e) =>
                    setJobs((old) =>
                      old.map((j, i) =>
                        i === index ? { ...j, priority: Number(e.target.value) } : j,
                      ),
                    )
                  }
                />
              )}
            </Field>
          </div>
        </div>
      ))}
      {jobs.length > 0 && (
        <Button type="button" onClick={() => setJobs([])}>
          Seçimi temizle
        </Button>
      )}
    </OperationForm>
  );
}
