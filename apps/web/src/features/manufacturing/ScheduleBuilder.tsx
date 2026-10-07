import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@erp/shared';
import { useCompanyApi } from '../../lib/queries';
import { Field, Input, Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { OperationForm, selectField, textField } from '../leather/common';

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
  durationSource: 'actual' | 'standard' | 'manual';
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
  const add = () => {
    const order = orders.find((o) => o.id === selected);
    if (!order) return;
    const remaining = Math.max(0, Number(order.quantity) - Number(order.completedQty ?? 0));
    setJobs((previous) => [
      ...previous,
      ...order.operations
        .filter((o) => !previous.some((j) => j.orderId === order.id && j.operationKey === o.key))
        .map<Job>((op, i) => {
          const actual = Number(op.goodQty) > 0 && Number(op.actualMinutes) > 0;
          const unit = actual
            ? Number(op.actualMinutes) / Number(op.goodQty)
            : Number(op.plannedMinutes ?? 0);
          return {
            orderId: order.id,
            operationKey: op.key,
            name: `${order.code} · ${op.name}`,
            resourceId: resources[0]?.id ?? '',
            minutes: unit > 0 ? Math.max(1, Math.ceil(unit * remaining)) : 60,
            priority: 50,
            predecessor: i > 0 ? order.operations[i - 1]?.key : undefined,
            durationSource: actual ? 'actual' : unit > 0 ? 'standard' : 'manual',
          };
        }),
    ]);
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
        { ...textField('anchorTime', 'Plan referans saati'), value: '08:00' },
        selectField('direction', 'Yön', [
          { value: 'forward', label: 'İleri planla' },
          { value: 'backward', label: 'Teslimden geriye planla' },
        ],true,'forward'),
      ]}
      disabled={!jobs.length}
      action="Senaryo oluştur"
      submit={async (v) => {
        await call('/api/manufacturing/planning/schedules', {
          method: 'POST',
          body: {
            anchor: new Date(v.anchorDate + 'T' + v.anchorTime).toISOString(),
            direction: v.direction,
            jobs: jobs.map(({ name, ...job }) => {
              void name;
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
      <Button type="button" disabled={!selected} onClick={add}>
        Rotayı ekle
      </Button>
      {jobs.map((job, index) => (
        <div key={job.orderId + ':' + job.operationKey} className="rounded border p-3">
          <p className="mb-2 font-medium">
            {job.name} ·{' '}
            {job.durationSource === 'actual'
              ? 'Gerçek süreden'
              : job.durationSource === 'standard'
                ? 'Standart süreden'
                : 'Elle girilen süre'}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Kaynak">
              {(id) => (
                <Select
                  id={id}
                  required
                  value={job.resourceId}
                  onChange={(e) =>
                    setJobs((old) =>
                      old.map((j, i) => (i === index ? { ...j, resourceId: e.target.value } : j)),
                    )
                  }
                >
                  <option value="">Seçin</option>
                  {resources.map((r) => (
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
