import { useState } from 'react';
import { CalendarCheck, Plus, Pencil, Archive, Undo2 } from 'lucide-react';
import {
  CURRENCY_CODES,
  OBLIGATION_CATEGORIES,
  OBLIGATION_CATEGORY_LABELS,
  addDaysIso,
  obligationSchema,
  todayIso,
  type ObligationCategory,
  type ObligationInput,
  type ObligationState,
} from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal, Sheet } from '../../components/ui/Sheet';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';

interface Obligation {
  id: string;
  title: string;
  category: ObligationCategory;
  config: ObligationInput;
  active: boolean;
  version: number;
}
interface Period {
  obligationId: string;
  title: string;
  category: ObligationCategory;
  periodDate: string;
  dueDate: string;
  amount: string | null;
  currency: string;
  amountKind: 'fixed' | 'estimated';
  state: ObligationState;
  completion: { status: 'done' | 'skipped'; paidAmount: string | null; note: string } | null;
}
interface Calendar {
  today: string;
  periods: Period[];
  summary: Record<ObligationState, { count: number; byCurrency: Record<string, string> }>;
}
const STATE: Record<ObligationState, { label: string; tone: 'danger' | 'warning' | 'info' | 'success' | 'neutral' }> = {
  overdue: { label: 'Gecikti', tone: 'danger' },
  due_soon: { label: 'Yaklaşıyor', tone: 'warning' },
  upcoming: { label: 'Planlı', tone: 'info' },
  done: { label: 'Ödendi', tone: 'success' },
  skipped: { label: 'Atlandı', tone: 'neutral' },
};
const FREQ = { daily: 'Günlük', weekly: 'Haftalık', monthly: 'Aylık', quarterly: 'Üç aylık', yearly: 'Yıllık' } as const;
const invalidate = [['obligations'], ['cash-forecast']];
const totals = (byCurrency: Record<string, string>) =>
  Object.entries(byCurrency)
    .map(([cur, v]) => `${money(v)} ${cur}`)
    .join(' · ');

/**
 * Düzenli mali yükümlülük takvimi (öneri 57): vergi, SGK, kira, kredi gibi ödemeler tekrar kuralıyla tanımlanır; her dönem
 * ödendi ya da atlandı olarak işaretlenir. Tutarı olan açık dönemler nakit projeksiyonuna çıkış olarak girer.
 */
export function ObligationsPage() {
  const can = useCan(),
    toast = useToast();
  const [from, setFrom] = useState(todayIso().slice(0, 8) + '01'),
    [to, setTo] = useState(addDaysIso(todayIso(), 90));
  const [form, setForm] = useState<{ obligation: Obligation | null } | null>(null),
    [complete, setComplete] = useState<{ period: Period; status: 'done' | 'skipped' } | null>(null);
  const cal = useCQuery<Calendar>(['obligations', 'calendar', from, to], `/api/obligations/calendar?from=${from}&to=${to}`, { enabled: !!from && !!to && to >= from });
  const list = useCQuery<{ obligations: Obligation[] }>(['obligations', 'list'], '/api/obligations');
  const toggle = useCMutation(
    (o: Obligation, call) => call(`/api/obligations/${o.id}/active`, { method: 'PATCH', body: { active: !o.active, version: o.version } }),
    invalidate,
  );
  const undo = useCMutation(
    (p: Period, call) => call(`/api/obligations/${p.obligationId}/completions/${p.periodDate}`, { method: 'DELETE' }),
    invalidate,
  );
  const manage = can('treasury.manage');
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Yükümlülük takvimi"
          description="Hafta sonuna denk gelen ödeme günü sonraki iş gününe kayar; resmî tatiller hesaba katılmaz."
          action={
            manage && (
              <Button variant="primary" size="sm" onClick={() => setForm({ obligation: null })}>
                <Plus className="size-4" aria-hidden />
                Yükümlülük ekle
              </Button>
            )
          }
        />
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Başlangıç">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="Bitiş">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            {cal.data && (
              <div className="flex flex-wrap gap-2 text-sm">
                {(['overdue', 'due_soon', 'upcoming'] as const).map((s) => (
                  <Badge key={s} tone={STATE[s].tone}>
                    {STATE[s].label}: {cal.data.summary[s].count}
                    {Object.keys(cal.data.summary[s].byCurrency).length ? ` · ${totals(cal.data.summary[s].byCurrency)}` : ''}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {cal.isPending ? (
            <PageLoading />
          ) : cal.error ? (
            <Callout tone="danger">{errorMessage(cal.error)}</Callout>
          ) : !cal.data?.periods.length ? (
            <EmptyState title="Bu aralıkta yükümlülük yok" description="Vergi, SGK, kira ya da kredi ödemelerini tekrar kuralıyla tanımlayın." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Ödeme günü</Th>
                    <Th>Yükümlülük</Th>
                    <Th num>Tutar</Th>
                    <Th>Durum</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {cal.data.periods.map((p) => (
                    <Tr key={`${p.obligationId}:${p.periodDate}`}>
                      <Td>
                        {formatDateTR(p.dueDate)}
                        {p.dueDate !== p.periodDate && <span className="block text-xs text-muted">dönem {formatDateTR(p.periodDate)}</span>}
                      </Td>
                      <Td>
                        {p.title}
                        <span className="block text-xs text-muted">{OBLIGATION_CATEGORY_LABELS[p.category]}</span>
                      </Td>
                      <Td num>
                        {p.amount ? `${money(p.amount)} ${p.currency}` : '—'}
                        {p.amount && p.amountKind === 'estimated' && <span className="block text-xs text-muted">tahmini</span>}
                        {p.completion?.paidAmount && <span className="block text-xs text-muted">ödenen {money(p.completion.paidAmount)}</span>}
                      </Td>
                      <Td>
                        <Badge tone={STATE[p.state].tone}>{STATE[p.state].label}</Badge>
                        {p.completion?.note && <span className="block text-xs text-muted">{p.completion.note}</span>}
                      </Td>
                      <Td>
                        {manage && (
                          <div className="flex flex-wrap justify-end gap-1">
                            {p.completion ? (
                              <Button size="sm" variant="ghost" loading={undo.isPending} onClick={() => undo.mutate(p, { onError: (e) => toast.error(errorMessage(e)) })}>
                                <Undo2 className="size-4" aria-hidden />
                                Geri al
                              </Button>
                            ) : (
                              <>
                                <Button size="sm" onClick={() => setComplete({ period: p, status: 'done' })}>
                                  <CalendarCheck className="size-4" aria-hidden />
                                  Ödendi
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setComplete({ period: p, status: 'skipped' })}>
                                  Atla
                                </Button>
                              </>
                            )}
                          </div>
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
      <Card>
        <CardHeader title="Tanımlı yükümlülükler" description="Pasif yükümlülük takvimde ve nakit projeksiyonunda görünmez." />
        <ul className="divide-y divide-border">
          {(list.data?.obligations ?? []).map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{o.title}</span>{' '}
                <span className="text-xs text-muted">
                  {OBLIGATION_CATEGORY_LABELS[o.category]} · {FREQ[o.config.recurrence.frequency]}
                  {o.config.recurrence.interval > 1 ? ` (${o.config.recurrence.interval} aralıkla)` : ''} · başlangıç{' '}
                  {formatDateTR(o.config.recurrence.startDate)}
                  {o.config.amount ? ` · ${money(o.config.amount)} ${o.config.currency}` : ''}
                </span>
              </span>
              {!o.active && <Badge tone="neutral">Pasif</Badge>}
              {manage && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setForm({ obligation: o })}>
                    <Pencil className="size-4" aria-hidden />
                    Düzenle
                  </Button>
                  <Button size="sm" variant="ghost" loading={toggle.isPending} onClick={() => toggle.mutate(o, { onError: (e) => toast.error(errorMessage(e)) })}>
                    <Archive className="size-4" aria-hidden />
                    {o.active ? 'Pasifleştir' : 'Etkinleştir'}
                  </Button>
                </>
              )}
            </li>
          ))}
          {list.data && !list.data.obligations.length && <li className="px-5 py-3 text-sm text-muted">Henüz yükümlülük tanımlanmadı.</li>}
        </ul>
      </Card>
      {form && <ObligationForm obligation={form.obligation} onClose={() => setForm(null)} />}
      {complete && <CompleteModal {...complete} onClose={() => setComplete(null)} />}
    </div>
  );
}

function CompleteModal({ period, status, onClose }: { period: Period; status: 'done' | 'skipped'; onClose: () => void }) {
  const toast = useToast();
  const [paidAmount, setPaidAmount] = useState(period.amount ?? ''),
    [note, setNote] = useState('');
  const save = useCMutation(
    (_: void, call) =>
      call(`/api/obligations/${period.obligationId}/complete`, {
        method: 'POST',
        body: { periodDate: period.periodDate, status, paidAmount: status === 'done' && paidAmount ? paidAmount : null, note },
      }),
    invalidate,
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={status === 'done' ? 'Ödendi olarak işaretle' : 'Dönemi atla'}
      description={`${period.title} · ${formatDateTR(period.dueDate)}`}
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={status === 'skipped' && note.trim().length < 3}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => {
                  toast.success(status === 'done' ? 'Dönem ödendi olarak işaretlendi.' : 'Dönem atlandı.');
                  onClose();
                },
                onError: (e) => toast.error(errorMessage(e)),
              })
            }
          >
            Kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {status === 'done' && (
          <Field label={`Ödenen tutar (${period.currency})`} hint="Ödeme kaydı hazine ekranından ayrıca girilir; bu alan takvim içindir.">
            {(id) => <MoneyInput id={id} value={paidAmount} onChange={setPaidAmount} />}
          </Field>
        )}
        <Field label={status === 'skipped' ? 'Atlama nedeni' : 'Not'}>
          {(id) => <Input id={id} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function ObligationForm({ obligation, onClose }: { obligation: Obligation | null; onClose: () => void }) {
  const toast = useToast(),
    base = useCompany().baseCurrency;
  const [f, setF] = useState<ObligationInput>(
    obligation?.config ?? {
      title: '',
      category: 'tax',
      recurrence: { startDate: todayIso(), endDate: null, frequency: 'monthly', interval: 1 },
      weekendRule: 'next_business_day',
      amount: null,
      currency: base as ObligationInput['currency'],
      amountKind: 'estimated',
      leadDays: 5,
      responsibleUserId: null,
      notes: '',
    },
  );
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ObligationInput>(k: K, v: ObligationInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const setRule = <K extends keyof ObligationInput['recurrence']>(k: K, v: ObligationInput['recurrence'][K]) =>
    setF((x) => ({ ...x, recurrence: { ...x.recurrence, [k]: v } }));
  const save = useCMutation(
    (config: ObligationInput, call) =>
      call(obligation ? `/api/obligations/${obligation.id}` : '/api/obligations', {
        method: obligation ? 'PUT' : 'POST',
        body: obligation ? { config, version: obligation.version } : config,
      }),
    invalidate,
  );
  const submit = () => {
    const parsed = obligationSchema.safeParse({ ...f, amount: f.amount || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Alanları kontrol edin.');
      return;
    }
    setError(null);
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Yükümlülük kaydedildi.');
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={obligation ? 'Yükümlülüğü düzenle' : 'Yeni yükümlülük'}
      footer={
        <>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Ad">{(id) => <Input id={id} value={f.title} maxLength={160} onChange={(e) => set('title', e.target.value)} />}</Field>
        <Field label="Tür">
          {(id) => (
            <Select id={id} value={f.category} onChange={(e) => set('category', e.target.value as ObligationCategory)}>
              {OBLIGATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {OBLIGATION_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="İlk ödeme günü">
            {(id) => <Input id={id} type="date" value={f.recurrence.startDate} onChange={(e) => setRule('startDate', e.target.value)} />}
          </Field>
          <Field label="Bitiş (isteğe bağlı)">
            {(id) => <Input id={id} type="date" value={f.recurrence.endDate ?? ''} onChange={(e) => setRule('endDate', e.target.value || null)} />}
          </Field>
          <Field label="Sıklık">
            {(id) => (
              <Select id={id} value={f.recurrence.frequency} onChange={(e) => setRule('frequency', e.target.value as ObligationInput['recurrence']['frequency'])}>
                {Object.entries(FREQ).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Aralık">
            {(id) => (
              <Input id={id} type="number" min={1} max={30} value={f.recurrence.interval} onChange={(e) => setRule('interval', Math.max(1, Number(e.target.value) || 1))} />
            )}
          </Field>
          <Field label="Tutar (isteğe bağlı)">{(id) => <MoneyInput id={id} value={f.amount ?? ''} onChange={(v) => set('amount', v || null)} />}</Field>
          <Field label="Para birimi">
            {(id) => (
              <Select id={id} value={f.currency} onChange={(e) => set('currency', e.target.value as ObligationInput['currency'])}>
                {CURRENCY_CODES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Tutar türü">
            {(id) => (
              <Select id={id} value={f.amountKind} onChange={(e) => set('amountKind', e.target.value as 'fixed' | 'estimated')}>
                <option value="estimated">Tahmini</option>
                <option value="fixed">Sabit</option>
              </Select>
            )}
          </Field>
          <Field label="Hatırlatma (gün önce)">
            {(id) => <Input id={id} type="number" min={0} max={60} value={f.leadDays} onChange={(e) => set('leadDays', Math.max(0, Number(e.target.value) || 0))} />}
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={f.weekendRule === 'next_business_day'}
            onChange={(e) => set('weekendRule', e.target.checked ? 'next_business_day' : 'none')}
          />
          <span>Hafta sonuna denk gelirse sonraki iş gününe kaydır</span>
        </label>
        <Field label="Not">{(id) => <Textarea id={id} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} />}</Field>
      </div>
    </Sheet>
  );
}
