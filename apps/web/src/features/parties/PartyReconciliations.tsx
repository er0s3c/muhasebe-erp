import { useState } from 'react';
import { todayIso } from '@erp/shared';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { markFormSaved } from '../../components/ui/UnsavedChanges';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, moneyIn } from '../../lib/format';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery, useIdempotencyKey, usePublicConfig } from '../../lib/queries';

type Status = 'open' | 'agreed' | 'disputed' | 'cancelled';
interface Reconciliation {
  id: string; asOf: string; baseCurrency: string; baseBalance: string; byCurrency: { currency: string; balance: string }[];
  status: Status; sentTo: string | null; note: string | null; createdAt: string; respondedAt: string | null;
  counterBalance: string | null; responseNote: string | null; overdue: boolean; difference: string | null;
}
const STATUS: Record<Status, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral' }> = {
  open: { label: 'Cevap bekleniyor', tone: 'info' }, agreed: { label: 'Mutabık', tone: 'success' },
  disputed: { label: 'Mutabık değil', tone: 'danger' }, cancelled: { label: 'İptal', tone: 'neutral' },
};

/**
 * Cari mutabakat (öneri 59): seçilen tarihteki bakiye görüntüsüyle mektup, isteğe bağlı e-posta, cevap ve fark takibi.
 * Bakiye işareti: borç (+) cari bize borçlu, alacak (−) biz cariye borçluyuz.
 */
export function PartyReconciliations({ partyId, partyEmail }: { partyId: string; partyEmail: string | null }) {
  const can = useCan();
  const toast = useToast();
  const mailEnabled = usePublicConfig().data?.mailEnabled ?? false;
  const path = `/api/parties/${partyId}/reconciliations`;
  const key = [['parties', partyId, 'reconciliations']];
  const query = useCQuery<{ reconciliations: Reconciliation[] }>(key[0]!, path);
  const command = useIdempotencyKey();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ asOf: todayIso(), sendTo: '', note: '' });
  const [responding, setResponding] = useState<Reconciliation | null>(null);
  const [response, setResponse] = useState({ result: 'agreed' as 'agreed' | 'disputed', counterBalance: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const create = useCMutation((_: void, c) => c(path, { method: 'POST', body: { asOf: form.asOf, sendTo: form.sendTo.trim() || null, note: form.note }, idempotencyKey: command.key }), key);
  const respond = useCMutation((id: string, c) => c(`${path}/${id}/response`, { method: 'POST', body: { result: response.result, counterBalance: response.counterBalance || null, note: response.note } }), key);
  const cancel = useCMutation((id: string, c) => c(`${path}/${id}/cancel`, { method: 'POST', body: {} }), key);
  const rows = query.data?.reconciliations ?? [];
  const manage = can('parties.manage');
  const signed = (v: string, currency: string) => `${moneyIn(v.replace('-', ''), currency)} ${Number(v) < 0 ? 'alacak' : Number(v) > 0 ? 'borç' : ''}`.trim();

  return (
    <Card className="mt-5 p-5">
      <section aria-label="Cari mutabakat" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Mutabakat</h2>
            <p className="text-xs text-muted">Seçilen tarihteki bakiye mektuba sabitlenir; sonradan girilen kayıtlar mektubu değiştirmez.</p>
          </div>
          {manage && <Button onClick={() => { setForm({ asOf: todayIso(), sendTo: partyEmail ?? '', note: '' }); setError(null); command.renew(); setCreating(true); }}>Mutabakat mektubu</Button>}
        </div>
        {query.error ? <ErrorCallout error={query.error} /> : rows.length === 0 ? <p className="text-sm text-muted">Mutabakat yok.</p> : rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3 text-sm">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">{formatDateTR(r.asOf)} itibarıyla · <span className="num">{signed(r.baseBalance, r.baseCurrency)}</span> <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.overdue && <Badge tone="danger">Cevap gecikti</Badge>}</p>
              <p className="text-xs text-muted">{fmtDateTime(r.createdAt)}{r.sentTo ? ` · ${r.sentTo} adresine gönderildi` : ' · gönderilmedi'}{r.byCurrency.length > 1 || r.byCurrency[0]?.currency !== r.baseCurrency ? ` · ${r.byCurrency.map((b) => signed(b.balance, b.currency)).join(', ')}` : ''}</p>
              {r.respondedAt && <p className="text-xs">{r.status === 'disputed' ? `Karşı taraf: ${signed(r.counterBalance ?? '0', r.baseCurrency)} · fark ${moneyIn(r.difference ?? '0', r.baseCurrency)}` : 'Bakiye teyit edildi'}{r.responseNote ? ` · ${r.responseNote}` : ''}</p>}
            </div>
            {r.status === 'open' && manage && <div className="flex shrink-0 gap-1">
              <Button size="sm" onClick={() => { setResponse({ result: 'agreed', counterBalance: '', note: '' }); setError(null); setResponding(r); }}>Cevabı işle</Button>
              <Button size="sm" variant="ghost" loading={cancel.isPending && cancel.variables === r.id} onClick={() => cancel.mutate(r.id, { onError: (e) => toast.error(errorMessage(e)) })}>İptal</Button>
            </div>}
          </div>
        ))}
      </section>

      <Modal open={creating} onOpenChange={setCreating} title="Mutabakat mektubu" description="Seçilen tarihteki bakiye ve açık kalemler mektuba sabitlenir."
        footer={<><Button onClick={() => setCreating(false)}>Vazgeç</Button><Button variant="primary" loading={create.isPending} disabled={!form.asOf} onClick={(e) => {
          const button = e.currentTarget; setError(null);
          create.mutate(undefined, { onSuccess: () => { markFormSaved(button); setCreating(false); toast.success(form.sendTo.trim() ? 'Mektup gönderim kuyruğuna alındı' : 'Mutabakat kaydedildi'); }, onError: setError });
        }}>Oluştur</Button></>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} discardDraft onNavigate={() => setCreating(false)} />}
          <Field label="Tarih itibarıyla" required>{(id) => <Input id={id} type="date" max={todayIso()} value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} />}</Field>
          <Field label="E-posta ile gönder" hint={mailEnabled ? 'Boş bırakılırsa yalnız kaydedilir (elden ya da başka yolla iletirsiniz).' : 'Bu kurulumda giden e-posta yok; mektup yalnız kaydedilir.'}>
            {(id) => <Input id={id} type="email" disabled={!mailEnabled} value={form.sendTo} onChange={(e) => setForm({ ...form, sendTo: e.target.value })} />}
          </Field>
          <Field label="Mektup notu">{(id) => <Input id={id} value={form.note} maxLength={1000} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
        </div>
      </Modal>

      <Modal open={!!responding} onOpenChange={(o) => !o && setResponding(null)} title="Mutabakat cevabı"
        description={responding ? `${formatDateTR(responding.asOf)} · bizim kayıtlarımız: ${signed(responding.baseBalance, responding.baseCurrency)}` : undefined}
        footer={<><Button onClick={() => setResponding(null)}>Vazgeç</Button><Button variant="primary" loading={respond.isPending} disabled={response.result === 'disputed' && !response.counterBalance} onClick={(e) => {
          if (!responding) return;
          const button = e.currentTarget; setError(null);
          respond.mutate(responding.id, { onSuccess: () => { markFormSaved(button); setResponding(null); toast.success('Cevap kaydedildi'); }, onError: setError });
        }}>Kaydet</Button></>}>
        <div className="flex flex-col gap-4">
          {error != null && <ErrorCallout error={error} />}
          <Field label="Cevap">{(id) => <Select id={id} value={response.result} onChange={(e) => setResponse({ ...response, result: e.target.value as 'agreed' | 'disputed' })}>
            <option value="agreed">Mutabıkız</option><option value="disputed">Mutabık değiliz</option>
          </Select>}</Field>
          {response.result === 'disputed' && <Field label="Karşı tarafın bakiyesi" required hint="Bizim işaretimizle: cari bize borçluysa artı, biz borçluysak eksi.">
            {(id) => <MoneyInput id={id} value={response.counterBalance} onChange={(v) => setResponse({ ...response, counterBalance: v })} />}
          </Field>}
          <Field label="Açıklama">{(id) => <Input id={id} value={response.note} maxLength={1000} onChange={(e) => setResponse({ ...response, note: e.target.value })} />}</Field>
        </div>
      </Modal>
    </Card>
  );
}
