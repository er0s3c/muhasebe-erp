import { todayIso } from '@erp/shared';
import { useEffect, useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { displayDateTime } from '../../lib/presentation';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

type Resource = {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  defaultSetupMinutes?: number;
  setupMatrix?: { from: string; to: string; minutes: number }[];
  requiredSkills?: string[];
  hourlyCost?: string;
};

interface PlanActualRow {
  scheduleCode: string;
  orderId: string;
  orderCode: string | null;
  operationKey: string;
  resourceId: string;
  plannedStart: string;
  plannedEnd: string;
  plannedMinutes: number;
  actualStart: string | null;
  actualEnd: string | null;
  actualMinutes: number;
  goodQty: number;
  scrapQty: number;
  status: 'not_started' | 'running' | 'done';
  startDelayMinutes: number | null;
  endDelayMinutes: number | null;
  late: boolean;
}
const STATUS = { not_started: 'Başlamadı', running: 'Sürüyor', done: 'Bitti' } as const;
const delay = (m: number | null) => (m === null ? '—' : m > 0 ? `+${m} dk` : `${m} dk`);

/** Planlanan–gerçekleşen (öneri 14): yayımlanmış plan işleri canlı çalışma oturumlarıyla karşılaştırılır. */
export function PlanActualPanel({ resources }: { resources: Resource[] }) {
  const today = todayIso();
  const [from, setFrom] = useState(new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const q = useCQuery<{ rows: PlanActualRow[]; summary: { operations: number; done: number; onTimePct: number | null; late: number; plannedMinutes: number; actualMinutes: number } }>(
    ['manufacturing', 'plan-actual', from, to],
    `/api/manufacturing/reports/plan-actual?from=${from}&to=${to}`,
  );
  const name = (id: string) => resources.find((r) => r.id === id)?.name ?? '—';
  return (
    <Card>
      <CardHeader title="Planlanan ve gerçekleşen" description="Yayımlanmış plan işleri, aynı emir ve operasyondaki çalışma oturumlarıyla karşılaştırılır. Gecikme pozitif dakikadır." />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Başlangıç">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Bitiş">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          {q.data && (
            <p className="text-sm text-muted">
              {q.data.summary.operations} iş · {q.data.summary.done} bitti · zamanında %{q.data.summary.onTimePct ?? '—'} · {q.data.summary.late} gecikmiş · plan {q.data.summary.plannedMinutes} dk / gerçek{' '}
              {q.data.summary.actualMinutes} dk
            </p>
          )}
        </div>
        {q.error ? (
          <ErrorCallout error={q.error} />
        ) : !q.data ? (
          <PageLoading />
        ) : q.data.rows.length === 0 ? (
          <p className="text-sm text-muted">Bu aralıkta yayımlanmış plan işi yok.</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Emir / operasyon</Th>
                  <Th>Kaynak</Th>
                  <Th>Plan</Th>
                  <Th>Gerçekleşen</Th>
                  <Th num>Plan / gerçek dk</Th>
                  <Th num>Başlangıç farkı</Th>
                  <Th num>Bitiş farkı</Th>
                  <Th>Durum</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <Tr key={r.scheduleCode + r.orderId + r.operationKey}>
                    <Td>
                      {r.orderCode ?? '—'} · {r.operationKey}
                    </Td>
                    <Td>{name(r.resourceId)}</Td>
                    <Td className="text-xs">
                      {displayDateTime(r.plannedStart)} – {displayDateTime(r.plannedEnd)}
                    </Td>
                    <Td className="text-xs">{r.actualStart ? `${displayDateTime(r.actualStart)} – ${r.actualEnd ? displayDateTime(r.actualEnd) : '…'}` : '—'}</Td>
                    <Td num>
                      {r.plannedMinutes} / {r.actualMinutes}
                    </Td>
                    <Td num>{delay(r.startDelayMinutes)}</Td>
                    <Td num>{delay(r.endDelayMinutes)}</Td>
                    <Td>
                      <Badge tone={r.late ? 'warning' : r.status === 'done' ? 'success' : 'neutral'} dot>
                        {r.late ? `${STATUS[r.status]} · gecikmiş` : STATUS[r.status]}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}

/** Kaynak kuralları (63, 64, 65, 72), operatör becerileri (65) ve dondurma penceresi (66). */
export function PlanningRulesPanel({ resources }: { resources: Resource[] }) {
  const can = useCan();
  return (
    <section aria-label="Planlama kuralları" className="space-y-5">
      <FreezePolicyCard canEdit={can('manufacturing.planning.approve')} />
      <ResourceRulesCard resources={resources} canEdit={can('manufacturing.planning.manage')} />
      <OperatorSkillsCard canEdit={can('manufacturing.planning.manage')} />
    </section>
  );
}

function FreezePolicyCard({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const q = useCQuery<{ freezeHours: number }>(['manufacturing', 'planning-policy'], '/api/manufacturing/planning/policy');
  const [hours, setHours] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data) setHours(String(q.data.freezeHours));
  }, [q.data]);
  const save = useCMutation((_: void, c) => c('/api/manufacturing/planning/policy', { method: 'PUT', body: { freezeHours: Number(hours) || 0 } }), [['manufacturing', 'planning-policy']]);
  return (
    <Card>
      <CardHeader
        title="Yakın dönem plan koruması"
        description="Yayımlı planın yerine geçen yeni sürüm, şimdiden itibaren bu süre içindeki işleri taşıyamaz, çıkaramaz veya ekleyemez; gerekirse onay yetkilisi gerekçeyle yayımlar. 0 koruma yok demektir."
      />
      <div className="flex flex-wrap items-end gap-3 p-5">
        <Field label="Dondurma penceresi (saat)">{(id) => <Input id={id} type="number" min={0} max={720} className="w-32" disabled={!canEdit} value={hours} onChange={(e) => setHours(e.target.value)} />}</Field>
        {canEdit && (
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { setError(null); toast.success('Plan koruması kaydedildi'); }, onError: setError })}>
            Kaydet
          </Button>
        )}
        {error ? <ErrorCallout error={error} /> : null}
      </div>
    </Card>
  );
}

function ResourceRulesCard({ resources, canEdit }: { resources: Resource[]; canEdit: boolean }) {
  const toast = useToast();
  const [resourceId, setResourceId] = useState('');
  const resource = resources.find((r) => r.id === resourceId);
  const [form, setForm] = useState({ defaultSetupMinutes: '0', matrix: '', skills: '', hourlyCost: '' });
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!resource) return;
    setForm({
      defaultSetupMinutes: String(resource.defaultSetupMinutes ?? 0),
      matrix: (resource.setupMatrix ?? []).map((m) => `${m.from} > ${m.to} = ${m.minutes}`).join('\n'),
      skills: (resource.requiredSkills ?? []).join(', '),
      hourlyCost: resource.hourlyCost ?? '',
    });
    setError(null);
  }, [resource]);
  const parseMatrix = () =>
    form.matrix
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(.+?)\s*>\s*(.+?)\s*=\s*(\d+)$/.exec(l);
        if (!m) throw new Error(`Hazırlık satırı anlaşılamadı: "${l}" (örnek: Açık > Koyu = 15)`);
        return { from: m[1]!, to: m[2]!, minutes: Number(m[3]) };
      });
  const save = useCMutation(
    (body: unknown, c) => c(`/api/manufacturing/resources/${resourceId}/rules`, { method: 'PUT', body }),
    [['manufacturing', 'resources']],
  );
  const isTool = resource?.type === 'tool';
  return (
    <Card>
      <CardHeader
        title="Kaynak kuralları"
        description="Sıraya bağlı hazırlık süresi, kaynakta çalışmak için gereken beceriler ve maliyet sapması için saatlik maliyet. Kalıp/takım kaynakları yalnız saatlik maliyet alır; plana iş satırında eklenir."
      />
      <div className="grid gap-3 p-5 sm:grid-cols-2">
        <Field label="Kaynak">
          {(id) => (
            <Select id={id} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">Seçin</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code} · {r.name}
                  {r.type === 'tool' ? ' (kalıp/takım)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Saatlik maliyet">{(id) => <Input id={id} inputMode="decimal" disabled={!resource || !canEdit} value={form.hourlyCost} onChange={(e) => setForm({ ...form, hourlyCost: e.target.value })} />}</Field>
        {!isTool && (
          <>
            <Field label="Varsayılan hazırlık (dk)" hint="Önceki iş farklı ailedeyse ve geçiş tanımlı değilse">
              {(id) => <Input id={id} type="number" min={0} disabled={!resource || !canEdit} value={form.defaultSetupMinutes} onChange={(e) => setForm({ ...form, defaultSetupMinutes: e.target.value })} />}
            </Field>
            <Field label="Gereken beceriler" hint="Virgülle ayırın; operatör geçerli beceriye sahip değilse iş başlamaz">
              {(id) => <Input id={id} disabled={!resource || !canEdit} value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} />}
            </Field>
            <Field label="Aileler arası hazırlık" hint="Her satır: önceki aile > sonraki aile = dakika; * her aile" className="sm:col-span-2">
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  disabled={!resource || !canEdit}
                  value={form.matrix}
                  onChange={(e) => setForm({ ...form, matrix: e.target.value })}
                />
              )}
            </Field>
          </>
        )}
        {canEdit && resource && (
          <div className="sm:col-span-2">
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() => {
                try {
                  save.mutate(
                    {
                      defaultSetupMinutes: isTool ? 0 : Number(form.defaultSetupMinutes) || 0,
                      setupMatrix: isTool ? [] : parseMatrix(),
                      requiredSkills: isTool ? [] : form.skills.split(',').map((s) => s.trim()).filter(Boolean),
                      ...(form.hourlyCost.trim() ? { hourlyCost: form.hourlyCost.trim() } : {}),
                    },
                    { onSuccess: () => { setError(null); toast.success('Kaynak kuralları kaydedildi'); }, onError: setError },
                  );
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Kaydet
            </Button>
          </div>
        )}
        {error ? <div className="sm:col-span-2"><ErrorCallout error={error} /></div> : null}
      </div>
    </Card>
  );
}

function OperatorSkillsCard({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const key = ['manufacturing', 'operator-skills'];
  const skills = useCQuery<{ skills: { id: string; userId: string; userName: string; skill: string; level: number; validUntil: string | null; note: string | null; expired: boolean }[] }>(key, '/api/manufacturing/operator-skills');
  const users = useCQuery<{ operators: { id: string; name: string }[] }>(['manufacturing', 'operators'], '/api/manufacturing/planning/operators');
  const [form, setForm] = useState({ userId: '', skill: '', level: '1', validUntil: '' });
  const [error, setError] = useState<unknown>(null);
  const save = useCMutation(
    (_: void, c) => c('/api/manufacturing/operator-skills', { method: 'PUT', body: { userId: form.userId, skill: form.skill.trim(), level: Number(form.level), validUntil: form.validUntil || null } }),
    [key],
  );
  const remove = useCMutation((id: string, c) => c(`/api/manufacturing/operator-skills/${id}`, { method: 'DELETE' }), [key]);
  return (
    <Card>
      <CardHeader title="Operatör becerileri" description="Beceri ve sertifika geçerlilik tarihi. Süresi geçmiş beceri iş başlangıcında sayılmaz." />
      <div className="space-y-4 p-5">
        {canEdit && (
          <div className="grid gap-3 sm:grid-cols-5">
            <Field label="Operatör">
              {(id) => (
                <Select id={id} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                  <option value="">Seçin</option>
                  {(users.data?.operators ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Beceri">{(id) => <Input id={id} value={form.skill} maxLength={60} onChange={(e) => setForm({ ...form, skill: e.target.value })} />}</Field>
            <Field label="Düzey (1–5)">{(id) => <Input id={id} type="number" min={1} max={5} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />}</Field>
            <Field label="Geçerlilik sonu">{(id) => <Input id={id} type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />}</Field>
            <div className="flex items-end">
              <Button
                variant="primary"
                disabled={!form.userId || !form.skill.trim()}
                loading={save.isPending}
                onClick={() => save.mutate(undefined, { onSuccess: () => { setError(null); toast.success('Beceri kaydedildi'); setForm({ ...form, skill: '', validUntil: '' }); }, onError: setError })}
              >
                Kaydet
              </Button>
            </div>
          </div>
        )}
        {error ? <ErrorCallout error={error} /> : null}
        {(skills.data?.skills ?? []).length === 0 ? (
          <p className="text-sm text-muted">Kayıtlı beceri yok.</p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Operatör</Th>
                  <Th>Beceri</Th>
                  <Th num>Düzey</Th>
                  <Th>Geçerlilik</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {(skills.data?.skills ?? []).map((s) => (
                  <Tr key={s.id}>
                    <Td>{s.userName}</Td>
                    <Td>{s.skill}</Td>
                    <Td num>{s.level}</Td>
                    <Td>{s.validUntil ? <Badge tone={s.expired ? 'danger' : 'neutral'}>{s.expired ? `Süresi doldu ${s.validUntil}` : s.validUntil}</Badge> : 'Süresiz'}</Td>
                    <Td className="text-right">
                      {canEdit && (
                        <Button size="sm" variant="danger" onClick={() => remove.mutate(s.id, { onError: setError })}>
                          Sil
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}
