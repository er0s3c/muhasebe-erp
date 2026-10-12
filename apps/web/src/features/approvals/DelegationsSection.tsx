import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Sheet } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { markFormSaved } from '../../components/ui/UnsavedChanges';
import { ErrorCallout } from '../../components/layout/Blocked';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useSession } from '../../lib/session';

interface Delegation {
  id: string; delegatorUserId: string; delegatorName: string; delegateUserId: string; delegateName: string;
  docTypes: string[]; maxAmount: string | null; startsAt: string; endsAt: string; reason: string;
  state: 'active' | 'scheduled' | 'expired' | 'revoked';
}
const TYPES: { key: string; label: string; permission: string }[] = [
  { key: 'invoice', label: 'Fatura', permission: 'invoices.post' },
  { key: 'sales_quote', label: 'Satış teklifi', permission: 'invoices.post' },
  { key: 'payment', label: 'Ödeme', permission: 'treasury.post' },
  { key: 'expense', label: 'Gider', permission: 'treasury.post' },
];
const LABEL = Object.fromEntries(TYPES.map((t) => [t.key, t.label])) as Record<string, string>;
const STATE: Record<Delegation['state'], { label: string; tone: 'success' | 'info' | 'neutral' }> = {
  active: { label: 'Geçerli', tone: 'success' }, scheduled: { label: 'Başlamadı', tone: 'info' },
  expired: { label: 'Süresi doldu', tone: 'neutral' }, revoked: { label: 'Geri alındı', tone: 'neutral' },
};
const KEY = [['approval-delegations'], ['document-approvals']];
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * Onay vekâletleri (öneri 98): izin/yokluk süresince onay hakkını süre, belge türü ve tutarla sınırlı devretme. Vekâlet yetki
 * genişletmez; bitince ya da geri alınınca hak kendiliğinden biter.
 */
export function DelegationsSection() {
  const can = useCan();
  const toast = useToast();
  const me = useSession().user?.id;
  const list = useCQuery<{ delegations: Delegation[] }>(['approval-delegations'], '/api/approval-delegations');
  const allowed = TYPES.filter((t) => can(t.permission));
  const [open, setOpen] = useState(false);
  const candidates = useCQuery<{ candidates: { userId: string; fullName: string }[] }>(['approval-delegations', 'candidates'], '/api/approval-delegations/candidates', { enabled: open });
  const [form, setForm] = useState({ delegateUserId: '', docTypes: [] as string[], startsAt: '', endsAt: '', maxAmount: '', reason: '' });
  const [error, setError] = useState<unknown>(null);
  const create = useCMutation((_: void, call) => call('/api/approval-delegations', {
    method: 'POST',
    body: { ...form, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), maxAmount: form.maxAmount || null },
  }), KEY);
  const revoke = useCMutation((id: string, call) => call(`/api/approval-delegations/${id}/revoke`, { method: 'POST', body: {} }), KEY);
  const rows = list.data?.delegations ?? [];
  if (allowed.length === 0 && rows.length === 0) return null;
  const valid = form.delegateUserId && form.docTypes.length > 0 && form.startsAt && form.endsAt && form.reason.trim().length >= 3;

  return (
    <Card className="my-5 flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base">Onay vekâletleri</h2>
          <p className="text-xs text-muted">Yokluğunuzda onaylarınızı süre ve tutarla sınırlı olarak bir çalışma arkadaşınıza devredin. Kararlar adınıza verildiği bilgisiyle kaydedilir.</p>
        </div>
        {allowed.length > 0 && <Button onClick={() => {
          const now = new Date();
          setForm({ delegateUserId: '', docTypes: allowed.map((t) => t.key), startsAt: localInput(now), endsAt: localInput(new Date(now.getTime() + 7 * 86_400_000)), maxAmount: '', reason: '' });
          setError(null); setOpen(true);
        }}>Vekâlet ver</Button>}
      </div>
      {list.error ? <ErrorCallout error={list.error} /> : rows.length === 0 ? <p className="text-sm text-muted">Vekâlet yok.</p> : rows.map((d) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <div className="min-w-0">
            <p>{d.delegatorUserId === me ? `Siz → ${d.delegateName}` : `${d.delegatorName} → ${d.delegateUserId === me ? 'siz' : d.delegateName}`} <Badge tone={STATE[d.state].tone}>{STATE[d.state].label}</Badge></p>
            <p className="text-xs text-muted">
              {d.docTypes.map((t) => LABEL[t] ?? t).join(', ')}{d.maxAmount ? ` · en çok ${d.maxAmount}` : ''} · {fmtDateTime(d.startsAt)} – {fmtDateTime(d.endsAt)} · {d.reason}
            </p>
          </div>
          {(d.state === 'active' || d.state === 'scheduled') && (d.delegatorUserId === me || can('members.manage')) && (
            <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === d.id} onClick={() => revoke.mutate(d.id, {
              onSuccess: () => toast.success('Vekâlet geri alındı'), onError: (e) => toast.error(errorMessage(e)),
            })}>Geri al</Button>
          )}
        </div>
      ))}
      <Sheet open={open} onOpenChange={setOpen} title="Onay vekâleti ver" description="Yalnız sizin onaylayabildiğiniz belge türleri devredilir; vekil belgeyi görebilmelidir. En çok 90 gün."
        footer={<>
          <Button onClick={() => setOpen(false)}>Vazgeç</Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={(event) => {
            const button = event.currentTarget;
            setError(null);
            create.mutate(undefined, { onSuccess: () => { markFormSaved(button); setOpen(false); toast.success('Vekâlet verildi'); }, onError: setError });
          }}>Kaydet</Button>
        </>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} />}
          <Field label="Vekil" required>{(id) => <Select id={id} value={form.delegateUserId} onChange={(e) => setForm({ ...form, delegateUserId: e.target.value })}>
            <option value="">Seçin</option>
            {(candidates.data?.candidates ?? []).map((c) => <option key={c.userId} value={c.userId}>{c.fullName}</option>)}
          </Select>}</Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px]">Belge türleri</legend>
            {allowed.map((t) => <label key={t.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={form.docTypes.includes(t.key)} onChange={(e) => setForm({ ...form, docTypes: e.target.checked ? [...form.docTypes, t.key] : form.docTypes.filter((k) => k !== t.key) })} />{t.label}
            </label>)}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Başlangıç" required>{(id) => <Input id={id} type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />}</Field>
            <Field label="Bitiş" required>{(id) => <Input id={id} type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />}</Field>
          </div>
          <Field label="Tutar sınırı" hint="Boş bırakılırsa sınır yok. Defter para birimindedir.">{(id) => <MoneyInput id={id} value={form.maxAmount} allowNegative={false} onChange={(v) => setForm({ ...form, maxAmount: v })} />}</Field>
          <Field label="Gerekçe" required>{(id) => <Input id={id} value={form.reason} maxLength={300} placeholder="Ör. Yıllık izin" onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
        </div>
      </Sheet>
    </Card>
  );
}
