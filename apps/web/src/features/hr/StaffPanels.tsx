import { useState } from 'react';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { formatDateTR } from '../../lib/format';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';

const DAY_LABEL: Record<string, string> = {
  worked: 'Çalışıldı',
  absent: 'Devamsız',
  annual_leave: 'Yıllık izin',
  sick_leave: 'Rapor',
  unpaid_leave: 'Ücretsiz izin',
  public_holiday: 'Resmî tatil',
  weekly_rest: 'Hafta tatili',
};

interface Correction {
  id: string;
  employeeCode: string;
  employeeName: string;
  workDate: string;
  dayType: string;
  normalHours: string;
  overtimeHours: string;
  reason: string;
  requestedBy: string | null;
  createdAt: string;
}

/** Bekleyen puantaj düzeltme talepleri (öneri 94): onay puantaja yazar; kapalı ayda onay reddedilir. */
export function CorrectionRequestsPanel() {
  const can = useCan();
  const toast = useToast();
  const key = ['attendance', 'corrections', 'pending'];
  const q = useCQuery<{ corrections: Correction[] }>(key, '/api/attendance-corrections?status=pending');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const decide = useCMutation(
    (v: { id: string; decision: 'approve' | 'reject' }, c) => c(`/api/attendance-corrections/${v.id}/decision`, { method: 'POST', body: { decision: v.decision, ...(note.trim() ? { note: note.trim() } : {}) } }),
    [key, ['attendance']],
  );
  const rows = q.data?.corrections ?? [];
  if (!rows.length) return null;
  return (
    <Card className="mb-5">
      <CardHeader title={`Puantaj düzeltme talepleri (${rows.length})`} description="Onaylanan talep ilgili günün puantajına yazılır. Kapalı aydaki talep için önce ay yeniden açılmalıdır." />
      <div className="space-y-3 p-4">
        {can('hr.manage') && <Field label="Karar notu (isteğe bağlı)">{(id) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>}
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>Personel</Th>
                <Th>Tarih</Th>
                <Th>İstenen</Th>
                <Th>Gerekçe</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    {r.employeeCode} · {r.employeeName}
                  </Td>
                  <Td>{formatDateTR(r.workDate)}</Td>
                  <Td>
                    {DAY_LABEL[r.dayType] ?? r.dayType}
                    {Number(r.normalHours) + Number(r.overtimeHours) > 0 && ` · ${Number(r.normalHours)} + ${Number(r.overtimeHours)} sa`}
                  </Td>
                  <Td className="text-xs">
                    {r.reason}
                    {r.requestedBy && <span className="text-muted"> · {r.requestedBy}</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {can('hr.manage') && (
                      <>
                        <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: r.id, decision: 'approve' }, { onSuccess: () => { setError(null); toast.success('Puantaja işlendi'); }, onError: setError })}>
                          Onayla
                        </Button>{' '}
                        <Button size="sm" onClick={() => decide.mutate({ id: r.id, decision: 'reject' }, { onSuccess: () => { setError(null); toast.success('Talep reddedildi'); }, onError: setError })}>
                          Reddet
                        </Button>
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {error ? <ErrorCallout error={error} /> : null}
      </div>
    </Card>
  );
}

/** Personel kartına çalışan portalı için kullanıcı hesabı bağlama (öneri 93). */
export function EmployeeUserLink({ employeeId, userId }: { employeeId: string; userId: string | null }) {
  const can = useCan();
  const toast = useToast();
  const users = useCQuery<{ users: { id: string; name: string; email: string }[] }>(['hr', 'portal-users'], can('hr.manage') ? '/api/hr/portal-users' : null);
  const [value, setValue] = useState(userId ?? '');
  const [error, setError] = useState<unknown>(null);
  const save = useCMutation((v: string, c) => c(`/api/employees/${employeeId}/user`, { method: 'PUT', body: { userId: v || null } }), [['employee'], ['employees']]);
  if (!can('hr.manage')) return null;
  const options = (users.data?.users ?? []).map((u) => ({ id: u.id, name: `${u.name} (${u.email})` }));
  return (
    <Card className="mt-5">
      <CardHeader title="Çalışan portalı" description="Bağlanan kullanıcı yalnız bu personelin bordro pusulalarını, puantajını ve kendi taleplerini görür." />
      <div className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Kullanıcı hesabı">
          {(id) => (
            <Select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Bağlı değil</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button loading={save.isPending} disabled={value === (userId ?? '')} onClick={() => save.mutate(value, { onSuccess: () => { setError(null); toast.success('Portal bağlantısı kaydedildi'); }, onError: setError })}>
          Kaydet
        </Button>
        {error ? <ErrorCallout error={error} /> : null}
      </div>
    </Card>
  );
}

type Kind = 'onboarding' | 'offboarding';
const KIND_LABEL: Record<Kind, string> = { onboarding: 'İşe giriş', offboarding: 'İşten ayrılış' };
interface Checklist {
  id: string;
  kind: Kind;
  status: 'open' | 'completed';
  items: { key: string; label: string; done: boolean; doneBy: string | null; doneAt: string | null; note: string | null }[];
  createdAt: string;
  completedAt: string | null;
}

/** İşe giriş/ayrılış kontrol listeleri (öneri 97): şablondan başlatılır; tüm maddeler tamamlanınca kapanır ve değişmez. */
export function EmployeeChecklists({ employeeId }: { employeeId: string }) {
  const can = useCan();
  const toast = useToast();
  const key = ['employee', employeeId, 'checklists'];
  const q = useCQuery<{ checklists: Checklist[] }>(key, `/api/employees/${employeeId}/checklists`);
  const [error, setError] = useState<unknown>(null);
  const [tplKind, setTplKind] = useState<Kind | null>(null);
  const tpl = useCQuery<{ items: { label: string }[] }>(['hr', 'checklist-template', tplKind ?? ''], tplKind ? `/api/employee-checklist-templates/${tplKind}` : null);
  const [tplText, setTplText] = useState('');
  const start = useCMutation((kind: Kind, c) => c(`/api/employees/${employeeId}/checklists`, { method: 'POST', body: { kind } }), [key]);
  const tick = useCMutation((v: { id: string; key: string; done: boolean }, c) => c(`/api/employee-checklists/${v.id}/items`, { method: 'POST', body: { key: v.key, done: v.done } }), [key]);
  const saveTpl = useCMutation(
    (_: void, c) => c(`/api/employee-checklist-templates/${tplKind}`, { method: 'PUT', body: { items: tplText.split('\n').map((l) => l.trim()).filter(Boolean).map((label) => ({ label })) } }),
    [['hr', 'checklist-template']],
  );
  const manage = can('hr.manage');
  const lists = q.data?.checklists ?? [];
  return (
    <Card className="mt-5">
      <CardHeader title="İşe giriş / ayrılış kontrol listeleri" />
      <div className="space-y-4 p-4 text-sm">
        {manage && (
          <div className="flex flex-wrap gap-2">
            {(['onboarding', 'offboarding'] as const).map((k) => (
              <Button key={k} disabled={lists.some((l) => l.kind === k && l.status === 'open')} onClick={() => start.mutate(k, { onSuccess: () => setError(null), onError: setError })}>
                {KIND_LABEL[k]} listesi başlat
              </Button>
            ))}
            {(['onboarding', 'offboarding'] as const).map((k) => (
              <Button key={'t' + k} size="sm" onClick={() => { setTplText(''); setTplKind(k); }}>
                {KIND_LABEL[k]} şablonu
              </Button>
            ))}
          </div>
        )}
        {lists.length === 0 && <p className="text-muted">Başlatılmış liste yok.</p>}
        {lists.map((l) => (
          <div key={l.id} className="rounded-md border border-border p-3">
            <p className="mb-2 font-medium">
              {KIND_LABEL[l.kind]} <Badge tone={l.status === 'completed' ? 'success' : 'info'}>{l.status === 'completed' ? `Tamamlandı ${l.completedAt ? fmtDateTime(l.completedAt) : ''}` : `${l.items.filter((i) => i.done).length}/${l.items.length}`}</Badge>
            </p>
            <ul className="space-y-1">
              {l.items.map((i) => (
                <li key={i.key}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={i.done}
                      disabled={!manage || l.status === 'completed' || tick.isPending}
                      onChange={(e) => tick.mutate({ id: l.id, key: i.key, done: e.target.checked }, { onError: setError })}
                    />
                    <span>
                      {i.label}
                      {i.done && i.doneBy && <span className="text-xs text-muted"> · {i.doneBy}{i.doneAt ? ` · ${fmtDateTime(i.doneAt)}` : ''}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {error ? <ErrorCallout error={error} /> : null}
      </div>
      <Modal
        open={tplKind !== null}
        onOpenChange={(o) => !o && setTplKind(null)}
        title={tplKind ? `${KIND_LABEL[tplKind]} şablonu` : ''}
        description="Her satır bir madde. Değişiklik yeni başlatılacak listelere uygulanır."
        footer={
          <>
            <Button onClick={() => setTplKind(null)}>Vazgeç</Button>
            <Button variant="primary" loading={saveTpl.isPending} onClick={() => saveTpl.mutate(undefined, { onSuccess: () => { toast.success('Şablon kaydedildi'); setTplKind(null); }, onError: setError })}>
              Kaydet
            </Button>
          </>
        }
      >
        <Field label="Maddeler">
          {(id) => <Textarea id={id} rows={8} value={tplText || (tpl.data?.items ?? []).map((i) => i.label).join('\n')} onChange={(e) => setTplText(e.target.value)} />}
        </Field>
      </Modal>
    </Card>
  );
}
