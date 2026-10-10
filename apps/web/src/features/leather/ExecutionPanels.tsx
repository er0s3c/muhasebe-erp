import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIso } from '@erp/shared';
import { useCan, useCompanyApi, useCQuery } from '../../lib/queries';
import {
  OperationForm,
  Records,
  Status,
  numberField,
  textField,
  selectField,
  options,
  type Values,
} from './common';
import { Button } from '../../components/ui/Button';
import { Field, Select, Input } from '../../components/ui/Field';
import { displayDateTime, displayQuantity } from '../../lib/presentation';
type Ref = { id: string; name?: string; code?: string };
type Point = { x: number; y: number };
type Defect = {
  code: string;
  kind: 'hole' | 'scratch' | 'tone' | 'other';
  points: Point[];
  note: string;
};
const cmd = (v: Values) => ({ requestKey: v._requestKey, reason: v.reason }),
  reason = textField('reason', 'İşlem nedeni', true);
export function PieceGeometryPanel({
  piece,
}: {
  piece: Ref & { grainAngle?: number; outline?: Point[]; defects?: Defect[] };
}) {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const [outline, setOutline] = useState<Point[]>(
      piece.outline ?? [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    ),
    [defects, setDefects] = useState<Defect[]>(piece.defects ?? []);
  return (
    <section className="space-y-4">
      <h3 className="text-subheading">Parça çevresi, damar yönü ve kusur bölgeleri</h3>
      <svg
        aria-label="Deri parçası ve kusur haritası"
        viewBox="-2 -2 104 104"
        className="h-64 w-full rounded-xl border border-border bg-surface-2"
        onClick={(e) => {
          if (!can('leather.materials.manage')) return;
          const b = e.currentTarget.getBoundingClientRect(),
            scale = Math.min(b.width, b.height) / 104,
            ox = (b.width - scale * 104) / 2,
            oy = (b.height - scale * 104) / 2;
          const x = Math.min(1, Math.max(0, (e.clientX - b.left - ox) / scale / 100 - 0.02)),
            y = Math.min(1, Math.max(0, (e.clientY - b.top - oy) / scale / 100 - 0.02));
          setOutline((p) => [...p, { x, y }]);
        }}
      >
        <polygon
          points={outline.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
          className="fill-brand/15 stroke-brand"
          strokeWidth="0.6"
        />
        {defects.map((d, i) => (
          <g key={i}>
            <polygon
              points={d.points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              className="fill-danger/30 stroke-danger"
              strokeWidth="0.5"
            />
            <text x={d.points[0]!.x * 100} y={d.points[0]!.y * 100 + 3} fontSize="3">
              {d.code}
            </text>
          </g>
        ))}
      </svg>
      {can('leather.materials.manage') && (
        <>
          <p className="text-sm text-muted">
            Çevreyi yeniden çizerken köşelere sırayla tıklayın. Kusur konumları parça genişliği ve
            yüksekliğinin yüzdesidir; ölçülmüş kullanılabilir alanın yerini almaz.
          </p>
          <Button type="button" onClick={() => setOutline([])}>
            Çevreyi yeniden çiz
          </Button>
          <OperationForm
            title="Kusur bölgesi ekle"
            fields={[
              textField('code', 'Kusur kodu'),
              selectField('kind', 'Kusur', [
                { value: 'hole', label: 'Delik' },
                { value: 'scratch', label: 'Çizik' },
                { value: 'tone', label: 'Ton farkı' },
                { value: 'other', label: 'Diğer' },
              ]),
              numberField('x', 'Sol konum (%)', '0'),
              numberField('y', 'Üst konum (%)', '0'),
              numberField('width', 'Genişlik (%)', '10'),
              numberField('height', 'Yükseklik (%)', '10'),
              textField('note', 'Kusur notu', false),
            ]}
            submit={async (v) => {
              const x = Number(v.x) / 100,
                y = Number(v.y) / 100,
                w = Number(v.width) / 100,
                h = Number(v.height) / 100;
              if (w <= 0 || h <= 0 || x + w > 1 || y + h > 1)
                throw Error('Kusur bölgesi parça sınırları içinde olmalı');
              setDefects((old) => [
                ...old,
                {
                  code: v.code,
                  kind: v.kind as Defect['kind'],
                  points: [
                    { x, y },
                    { x: x + w, y },
                    { x: x + w, y: y + h },
                    { x, y: y + h },
                  ],
                  note: v.note,
                },
              ]);
            }}
          />
          <OperationForm
            title="Parça geometrisini kaydet"
            fields={[
              numberField('grainAngle', 'Damar yönü (0–359°)', String(piece.grainAngle ?? 0)),
              reason,
            ]}
            submit={async (v) => {
              await call(`/api/leather/materials/pieces/${piece.id}/geometry`, {
                method: 'POST',
                body: { ...cmd(v), grainAngle: Number(v.grainAngle), outline, defects },
              });
              await queries.invalidateQueries();
            }}
          />
        </>
      )}
      <Records
        rows={defects.map((d, i) => ({ ...d, id: String(i) }))}
        columns={[
          { label: 'Kusur', render: (r) => r.code },
          { label: 'Not', render: (r) => r.note },
        ]}
        action={
          can('leather.materials.manage')
            ? (r) => (
                <Button
                  onClick={() => setDefects((old) => old.filter((_, i) => String(i) !== r.id))}
                >
                  Kusuru kaldır
                </Button>
              )
            : undefined
        }
      />
    </section>
  );
}
export function LeatherCutPlanningPanel({
  pieces,
}: {
  pieces: (Ref & { status: string; remainingArea: string })[];
}) {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  type Pattern = Ref & { modelId: string; area: string; direction: string };
  const data = useCQuery<{
    models: Ref[];
    orders: Ref[];
    patterns: Pattern[];
    plans: (Ref & {
      status: string;
      sets: number;
      plannedYield: string;
      requiredArea: string;
      results?: { setsProduced: number }[];
    })[];
  }>(['leather', 'cut-lookups'], '/api/leather/materials/cutting/lookups');
  const [selected, setSelected] = useState<string[]>([]),
    [parts, setParts] = useState<{ patternId: string; perSet: number }[]>([
      { patternId: '', perSet: 1 },
    ]);
  const save = async (path: string, body: unknown) => {
    await call(path, { method: 'POST', body });
    await queries.invalidateQueries();
  };
  return (
    <section className="my-6 space-y-4">
      <h2 className="text-subheading">Kalıplar ve elle kesim planı</h2>
      <Records
        rows={data.data?.plans ?? []}
        loading={data.isPending} onRetry={() => void data.refetch()} retrying={data.isFetching}
        error={data.error}
        columns={[
          { label: 'Plan', render: (r) => r.code },
          { label: 'Hedef set', numeric: true, render: (r) => r.sets },
          { label: 'Gerekli alan (m²)', numeric: true, render: (r) => r.requiredArea },
          { label: 'Planlanan verim (%)', numeric: true, render: (r) => r.plannedYield },
          {
            label: 'Gerçek set',
            numeric: true,
            render: (r) => r.results?.reduce((s, p) => s + p.setsProduced, 0) ?? 0,
          },
          { label: 'Durum', render: (r) => <Status value={r.status} /> },
        ]}
        action={
          can('leather.production.manage')
            ? (r) =>
                ['planned', 'in_progress'].includes(r.status) && (
                  <OperationForm
                    title="Kesim planını iptal et"
                    fields={[reason]}
                    submit={(v) =>
                      save(`/api/leather/materials/cutting/plans/${r.id}/cancel`, cmd(v))
                    }
                  >
                    <p className="text-sm text-muted">
                      Kaydedilmiş kesimler korunur. Yalnız kullanılmamış parça seçimleri serbest
                      bırakılır.
                    </p>
                  </OperationForm>
                )
            : undefined
        }
      />
      {can('leather.catalog.manage') && (
        <OperationForm
          title="Kalıp kaydı oluştur"
          fields={[
            selectField(
              'modelId',
              'Model',
              options(data.data?.models ?? [], (r) => `${r.code} · ${r.name}`),
            ),
            textField('code', 'Kalıp kodu'),
            textField('name', 'Kalıp adı'),
            numberField('area', 'Tek parçanın alanı (m²)'),
            selectField('direction', 'Kesim yönü', [
              { value: 'any', label: 'Yön serbest' },
              { value: 'grain', label: 'Damar yönünde' },
            ]),
            reason,
          ]}
          submit={(v) =>
            save('/api/leather/catalog/patterns', {
              ...cmd(v),
              modelId: v.modelId,
              code: v.code,
              name: v.name,
              area: v.area,
              direction: v.direction,
            })
          }
        />
      )}
      {can('leather.production.manage') && (
        <OperationForm
          title="Elle kesim planı oluştur"
          fields={[
            selectField(
              'orderId',
              'Üretim emri',
              options(data.data?.orders ?? [], (r) => r.code ?? 'Emir'),
            ),
            numberField('sets', 'Hedef ürün seti'),
            reason,
          ]}
          submit={(v) =>
            save('/api/leather/materials/cutting/plans', {
              ...cmd(v),
              orderId: v.orderId,
              sets: Number(v.sets),
              pieces: selected,
              patterns: parts,
            })
          }
        >
          <fieldset className="space-y-2">
            <legend>Seçilen fiziksel deriler</legend>
            {pieces
              .filter((p) => ['available', 'second'].includes(p.status))
              .map((p) => (
                <label key={p.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked ? [...old, p.id] : old.filter((x) => x !== p.id),
                      )
                    }
                  />
                  {p.code} · {displayQuantity(p.remainingArea)} m²
                </label>
              ))}
          </fieldset>
          {parts.map((p, i) => (
            <div key={i} className="grid gap-3 sm:grid-cols-3">
              <Field label="Kalıp" required>
                {(id) => (
                  <Select
                    id={id}
                    required
                    value={p.patternId}
                    onChange={(e) =>
                      setParts((old) =>
                        old.map((x, j) => (i === j ? { ...x, patternId: e.target.value } : x)),
                      )
                    }
                  >
                    <option value="">Kalıp seçin</option>
                    {data.data?.patterns.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.code} · {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Ürün setindeki parça adedi" required>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min="1"
                    required
                    value={p.perSet}
                    onChange={(e) =>
                      setParts((old) =>
                        old.map((x, j) => (i === j ? { ...x, perSet: Number(e.target.value) } : x)),
                      )
                    }
                  />
                )}
              </Field>
              <Button
                type="button"
                onClick={() => setParts((old) => old.filter((_, j) => j !== i))}
              >
                Kalıbı kaldır
              </Button>
            </div>
          ))}
          <Button
            type="button"
            onClick={() => setParts((old) => [...old, { patternId: '', perSet: 1 }])}
          >
            Plana kalıp ekle
          </Button>
        </OperationForm>
      )}
    </section>
  );
}
export function ServiceTimePanel({ serviceId, members }: { serviceId: string; members: Ref[] }) {
  const { call } = useCompanyApi(),
    can = useCan(),
    queries = useQueryClient();
  const data = useCQuery<{
    records: (Ref & { serviceId: string; technicianId: string; minutes: string; date: string })[];
  }>(['leather', 'service-time'], '/api/leather/service/time');
  return (
    <section className="my-5 space-y-4">
      <h3 className="text-subheading">Teknisyen ve gerçek çalışma süresi</h3>
      <Records
        rows={(data.data?.records ?? []).filter((r) => r.serviceId === serviceId)}
        loading={data.isPending} onRetry={() => void data.refetch()} retrying={data.isFetching}
        error={data.error}
        columns={[
          {
            label: 'Teknisyen',
            render: (r) => members.find((m) => m.id === r.technicianId)?.name ?? 'Teknisyen',
          },
          { label: 'Tarih', render: (r) => displayDateTime(r.date) },
          { label: 'Dakika', numeric: true, render: (r) => r.minutes },
        ]}
      />
      {can('leather.service.manage') && (
        <OperationForm
          title="Servis çalışma süresi kaydet"
          fields={[
            selectField(
              'technicianId',
              'Teknisyen',
              options(members, (r) => r.name ?? 'Teknisyen'),
            ),
            numberField('minutes', 'Gerçek çalışma süresi (dk)'),
            { name: 'date', label: 'İş tarihi', type: 'date', required: true, value: todayIso() },
            reason,
          ]}
          submit={async (v) => {
            await call('/api/leather/service/time', {
              method: 'POST',
              body: {
                ...cmd(v),
                serviceId,
                technicianId: v.technicianId,
                minutes: v.minutes,
                date: v.date,
              },
            });
            await queries.invalidateQueries();
          }}
        />
      )}
    </section>
  );
}
