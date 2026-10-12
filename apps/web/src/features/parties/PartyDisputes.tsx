import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorCallout } from '../../components/layout/Blocked';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { useToast } from '../../components/ui/Toast';
import { formatDateTR, moneyIn } from '../../lib/format';
import { fmtDateTime } from '../../lib/license';
import { useCan, useCMutation, useCQuery, useIdempotencyKey } from '../../lib/queries';

type Status = 'open' | 'in_review' | 'resolved' | 'rejected';
type Category = 'price' | 'quantity' | 'quality' | 'delivery' | 'payment' | 'other';
interface Dispute {
  id: string;
  sourceType: 'invoice' | 'delivery_note' | 'sales_order' | null;
  sourceId: string | null;
  sourceNo: string | null;
  category: Category;
  subject: string;
  amount: string | null;
  currencyCode: string | null;
  status: Status;
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  resolution: string | null;
  createdAt: string;
  createdByName: string | null;
}
interface DisputeEvent { id: string; kind: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string; userName: string | null }

const STATUS: Record<Status, { label: string; tone: 'info' | 'warning' | 'success' | 'neutral' }> = {
  open: { label: 'Açık', tone: 'info' },
  in_review: { label: 'İnceleniyor', tone: 'warning' },
  resolved: { label: 'Çözüldü', tone: 'success' },
  rejected: { label: 'Reddedildi', tone: 'neutral' },
};
const CATEGORY: Record<Category, string> = { price: 'Fiyat', quantity: 'Miktar', quality: 'Kalite', delivery: 'Teslimat', payment: 'Ödeme', other: 'Diğer' };
const SOURCE_PATH = { invoice: '/invoices/', delivery_note: '/delivery-notes/', sales_order: '/sales/docs/' } as const;

/**
 * Ticari itiraz ve anlaşmazlık dosyası (öneri 39): müşteri itirazı belgeyle ilişkilendirilir, sorumluya atanır, notlanır ve
 * gerekçeyle kapatılır. Dosya muhasebe kaydı oluşturmaz; düzeltme ayrıca iade/fiyat farkı faturasıyla yapılır.
 */
export function PartyDisputes({ partyId }: { partyId: string }) {
  const can = useCan();
  const toast = useToast();
  const manage = can('parties.manage');
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const listKey = ['disputes', partyId];
  const list = useCQuery<{ disputes: Dispute[] }>([...listKey, status], `/api/disputes?partyId=${partyId}&status=${status}`);
  const reps = useCQuery<{ reps: { id: string; name: string }[] }>(['sales-reps'], '/api/sales-reps');
  const command = useIdempotencyKey();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ category: 'price' as Category, subject: '', amount: '', ownerId: '', dueDate: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useCQuery<{ dispute: Dispute; events: DisputeEvent[] }>(['disputes', 'detail', open ?? ''], open ? `/api/disputes/${open}` : null);
  const [text, setText] = useState('');

  const create = useCMutation(
    (_: void, c) =>
      c('/api/disputes', {
        method: 'POST',
        idempotencyKey: command.key,
        body: {
          partyId,
          category: form.category,
          subject: form.subject,
          ...(form.amount ? { amount: form.amount } : {}),
          ...(form.ownerId ? { ownerId: form.ownerId } : {}),
          ...(form.dueDate ? { dueDate: form.dueDate } : {}),
          ...(form.note ? { note: form.note } : {}),
        },
      }),
    [listKey],
  );
  const act = useCMutation((body: Record<string, unknown>, c) => c(`/api/disputes/${open}/actions`, { method: 'POST', body }), [listKey, ['disputes', 'detail']]);
  const runAction = (body: Record<string, unknown>, done: string) =>
    act.mutate(body, {
      onSuccess: () => {
        toast.success(done);
        setText('');
      },
      onError: setError,
    });
  const rows = list.data?.disputes ?? [];
  const d = detail.data?.dispute;
  const closed = d ? d.status === 'resolved' || d.status === 'rejected' : true;

  return (
    <Card className="mt-5 p-5">
      <section aria-label="İtiraz dosyaları" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">İtiraz dosyaları</h2>
            <p className="text-xs text-muted">Fiyat, miktar, kalite, teslimat veya ödeme itirazı; düzeltme belgesi ayrıca kesilir.</p>
          </div>
          <div className="flex items-center gap-2">
            <Select aria-label="İtiraz durumu" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="open">Açık</option>
              <option value="closed">Kapanmış</option>
              <option value="all">Tümü</option>
            </Select>
            {manage && (
              <Button
                onClick={() => {
                  setForm({ category: 'price', subject: '', amount: '', ownerId: '', dueDate: '', note: '' });
                  setError(null);
                  command.renew();
                  setCreating(true);
                }}
              >
                Yeni itiraz
              </Button>
            )}
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Kayıt yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <Badge tone={STATUS[r.status].tone} dot>
                  {STATUS[r.status].label}
                </Badge>
                <span className="text-muted">{CATEGORY[r.category]}</span>
                <button type="button" className="link text-left" onClick={() => { setError(null); setText(''); setOpen(r.id); }}>
                  {r.subject}
                </button>
                {r.sourceNo && r.sourceType && r.sourceId && (
                  <Link className="link text-xs" to={`${SOURCE_PATH[r.sourceType]}${r.sourceId}`}>
                    {r.sourceNo}
                  </Link>
                )}
                {r.amount && r.currencyCode && <span className="num">{moneyIn(r.amount, r.currencyCode)}</span>}
                {r.ownerName && <span className="text-xs text-muted">{r.ownerName}</span>}
                {r.dueDate && <span className="text-xs text-muted">Son tarih {formatDateTR(r.dueDate)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={creating}
        onOpenChange={setCreating}
        title="Yeni itiraz dosyası"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Vazgeç</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={form.subject.trim().length < 3}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: () => {
                    toast.success('İtiraz dosyası açıldı');
                    command.renew();
                    setCreating(false);
                  },
                  onError: setError,
                })
              }
            >
              Aç
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Konu" required className="sm:col-span-2">
            {(id) => <Input id={id} value={form.subject} maxLength={300} onChange={(e) => setForm({ ...form, subject: e.target.value })} />}
          </Field>
          <Field label="Tür">
            {(id) => (
              <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Category })}>
                {(Object.keys(CATEGORY) as Category[]).map((k) => (
                  <option key={k} value={k}>
                    {CATEGORY[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Tutar (cari para birimi)">
            {(id) => <Input id={id} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}
          </Field>
          <Field label="Sorumlu">
            {(id) => (
              <Select id={id} value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                <option value="">Atanmamış</option>
                {(reps.data?.reps ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Son tarih">{(id) => <Input id={id} type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />}</Field>
          <Field label="Not" className="sm:col-span-2">
            {(id) => <Textarea id={id} rows={3} value={form.note} maxLength={2000} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
          </Field>
          {error ? <div className="sm:col-span-2"><ErrorCallout error={error} /></div> : null}
        </div>
      </Modal>

      <Modal open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={d?.subject ?? 'İtiraz dosyası'} description={d ? `${CATEGORY[d.category]} · ${STATUS[d.status].label}` : ''}>
        {d && (
          <div className="flex flex-col gap-3 text-sm">
            {d.resolution && <p><span className="text-muted">Sonuç:</span> {d.resolution}</p>}
            <ol className="flex flex-col gap-1 text-xs">
              {(detail.data?.events ?? []).map((e) => (
                <li key={e.id}>
                  <span className="num text-muted">{fmtDateTime(e.createdAt)}</span> · {e.userName ?? ''} ·{' '}
                  {e.kind === 'status' ? `${STATUS[e.fromStatus as Status]?.label ?? e.fromStatus} → ${STATUS[e.toStatus as Status]?.label ?? e.toStatus}` : e.kind === 'assign' ? 'Sorumlu değişti' : e.kind === 'created' ? 'Açıldı' : 'Not'}
                  {e.note && <> — {e.note}</>}
                </li>
              ))}
            </ol>
            {manage && !closed && (
              <>
                <Field label="Not / sonuç açıklaması">
                  {(id) => <Textarea id={id} rows={2} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!text.trim()} loading={act.isPending} onClick={() => runAction({ action: 'note', note: text.trim() }, 'Not eklendi')}>
                    Not ekle
                  </Button>
                  {d.status === 'open' && (
                    <Button onClick={() => runAction({ action: 'review', note: text.trim() || undefined }, 'İncelemeye alındı')}>İncelemeye al</Button>
                  )}
                  <Button variant="primary" disabled={text.trim().length < 3} onClick={() => runAction({ action: 'resolve', resolution: text.trim() }, 'İtiraz çözüldü')}>
                    Çöz
                  </Button>
                  <Button variant="danger" disabled={text.trim().length < 3} onClick={() => runAction({ action: 'reject', resolution: text.trim() }, 'İtiraz reddedildi')}>
                    Reddet
                  </Button>
                  <Select
                    aria-label="Sorumlu ata"
                    value={d.ownerId ?? ''}
                    onChange={(e) => runAction({ action: 'assign', ownerId: e.target.value || null }, 'Sorumlu atandı')}
                  >
                    <option value="">Sorumlu: atanmamış</option>
                    {(reps.data?.reps ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        Sorumlu: {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </>
            )}
            {error ? <ErrorCallout error={error} /> : null}
          </div>
        )}
      </Modal>
    </Card>
  );
}
