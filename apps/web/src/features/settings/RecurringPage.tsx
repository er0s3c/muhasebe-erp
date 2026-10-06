import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Repeat2, Play, Pause, History, CalendarDays, FileText } from 'lucide-react';
import { recurringCreateSchema, todayIso, type Recurrence, type RecurringTemplate, type SearchHit } from '@erp/shared';
import { PageHeader, Card, CardHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Sheet } from '../../components/ui/Sheet';
import { TableWrap, Table, Tr, Th, Td } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { useCompany } from '../../lib/session';
import { useCan, useCQuery, useCMutation, useModuleEnabled } from '../../lib/queries';
import { formatDateTR } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import { RecordPicker } from '../workspace/RecordPicker';

const frequencies: Record<Recurrence['frequency'], string> = { daily: 'Gün', weekly: 'Hafta', monthly: 'Ay', quarterly: 'Üç ay', yearly: 'Yıl' };
const invalidate = [['recurring'], ['agenda'], ['invoices'], ['notifications']];
export function RecurringPage() { return <RecurringContent key={useCompany().id} />; }
function RecurringContent() {
  const can = useCan(), toast = useToast();
  const agendaEnabled = useModuleEnabled('core.directory'), invoiceEnabled = useModuleEnabled('core.invoices');
  const [adding, setAdding] = useState(false), [history, setHistory] = useState<RecurringTemplate | null>(null);
  const query = useCQuery<{ items: RecurringTemplate[] }>(['recurring'], '/api/settings/recurring', { refetchInterval: 60000 });
  const toggle = useCMutation((row: RecurringTemplate, call) => call(`/api/settings/recurring/${row.id}`, { method: 'PATCH', body: { status: row.status === 'active' ? 'paused' : 'active', version: row.version } }), invalidate);
  const run = useCMutation((id: string, call) => call<{ created: unknown[]; hasMore: boolean }>(`/api/settings/recurring/${id}/run`, { method: 'POST' }), invalidate);
  const items = query.data?.items ?? [];
  const canAgenda = agendaEnabled && can('directory.manage'), canInvoice = invoiceEnabled && can('invoices.manage');
  return <>
    <PageHeader title="Tekrarlayan işler" description="Kira, abonelik, toplantı ve düzenli hatırlatmaları tarihli bir seri olarak yönetin." actions={(canAgenda || canInvoice) && <Button variant="primary" onClick={() => setAdding(true)}><Plus className="size-4" />Yeni tekrar</Button>} />
    <div className="mb-5 grid gap-5 lg:grid-cols-2">
      <Card><CardHeader title="Ajanda ve hatırlatma" action={<CalendarDays className="size-4 text-muted" />} /><p className="px-5 py-4 text-sm text-muted">Zamanı gelen kalem ajandaya eklenir. Seçtiğiniz hatırlatma süresi mevcut bildirim merkezinde kullanılır. Seriyi duraklatmak, daha önce oluşmuş kalemleri silmez.</p></Card>
      <Card><CardHeader title="Fatura taslağı" action={<FileText className="size-4 text-muted" />} /><p className="px-5 py-4 text-sm text-muted">Kaynak faturanın hizmet kalemleri ve fiyatları şablonda sabitlenir. Her dönem ayrı taslak oluşur; belge numarası, güncel kur ve muhasebeleştirme mevcut fatura ekranında doğrulanır.</p></Card>
    </div>
    {query.error && <Callout tone="danger">{errorMessage(query.error)}</Callout>}
    {(toggle.error || run.error) && <div className="mb-4"><Callout tone="danger">{errorMessage(toggle.error ?? run.error)}</Callout></div>}
    {query.isPending ? <PageLoading /> : <Card>
      <CardHeader title="Tekrar planları" description={`${items.filter(i => i.status === 'active').length} aktif · ${items.reduce((n, i) => n + i.generated, 0)} oluşmuş kayıt`} />
      {!items.length ? <EmptyState icon={<Repeat2 className="size-5" />} title="Henüz tekrar planı yok" description="Düzenli toplantı veya stoksuz kira/abonelik faturası için bir seri oluşturun." /> : <TableWrap className="border-0 rounded-none"><Table><thead><Tr><Th>Plan</Th><Th>Takvim</Th><Th>Sıradaki</Th><Th>Durum</Th><Th>İşlemler</Th></Tr></thead><tbody>
        {items.map(row => <Tr key={row.id}><Td><p className="font-medium">{row.title}</p><p className="mt-1 text-xs text-muted">{row.kind === 'invoice' ? 'Fatura taslağı' : 'Ajanda'} · {row.generated} kayıt</p>{row.error && <p className="mt-2 max-w-80 text-xs text-danger">{row.error}</p>}</Td><Td><span className="whitespace-nowrap">Her {row.recurrence.interval} {frequencies[row.recurrence.frequency].toLocaleLowerCase('tr-TR')}</span><p className="mt-1 text-xs text-muted">{formatDateTR(row.recurrence.startDate)}{row.recurrence.endDate ? ` — ${formatDateTR(row.recurrence.endDate)}` : ' · sürekli'}</p></Td><Td className="whitespace-nowrap">{row.nextDate ? formatDateTR(row.nextDate) : '—'}</Td><Td><Badge tone={row.status === 'active' ? 'success' : row.status === 'paused' ? 'warning' : 'neutral'}>{row.status === 'active' ? 'Aktif' : row.status === 'paused' ? 'Duraklatıldı' : 'Tamamlandı'}</Badge></Td><Td><div className="flex flex-wrap gap-1">
          <Button size="sm" onClick={() => setHistory(row)}><History className="size-3.5" />Geçmiş</Button>
          {(row.kind === 'agenda' ? canAgenda : canInvoice) && row.status !== 'finished' && <Button size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(row)}>{row.status === 'active' ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{row.status === 'active' ? 'Duraklat' : 'Devam et'}</Button>}
          {(row.kind === 'agenda' ? canAgenda : canInvoice) && row.status === 'active' && <Button size="sm" loading={run.isPending && run.variables === row.id} disabled={!row.nextDate || row.nextDate > todayIso()} onClick={() => run.mutate(row.id, { onSuccess: r => toast.success(`${r.created.length} kayıt oluşturuldu.${r.hasMore ? ' Bekleyen diğer dönemler sonraki çalışmada tamamlanacak.' : ''}`) })}>Şimdi çalıştır</Button>}
        </div></Td></Tr>)}
      </tbody></Table></TableWrap>}
      <p className="border-t border-border px-5 py-3 text-xs text-muted">Sunucu aktifken vadesi gelen planlar her dakika kontrol edilir. Bir çalışmada en fazla 20 dönem oluşturulur; aynı dönem ikinci kez oluşturulamaz.</p>
    </Card>}
    {adding && <NewRecurring canAgenda={canAgenda} canInvoice={canInvoice} onClose={() => setAdding(false)} />}
    {history && <RecurringHistory row={history} onClose={() => setHistory(null)} />}
  </>;
}
function NewRecurring({ canAgenda, canInvoice, onClose }: { canAgenda: boolean; canInvoice: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<'agenda' | 'invoice'>(canAgenda ? 'agenda' : 'invoice');
  const [title, setTitle] = useState(''), [rule, setRule] = useState<Recurrence>({ startDate: todayIso(), endDate: null, frequency: 'monthly', interval: 1 });
  const [source, setSource] = useState<SearchHit | null>(null), [dueDays, setDueDays] = useState(30);
  const [allDay, setAllDay] = useState(true), [time, setTime] = useState('09:00'), [reminder, setReminder] = useState('60'), [owner, setOwner] = useState('mine'), [description, setDescription] = useState(''), [validation, setValidation] = useState('');
  const toast = useToast();
  const save = useCMutation((body: unknown, call) => call('/api/settings/recurring', { method: 'POST', body }), invalidate);
  const submit = () => {
    const parsed = recurringCreateSchema.safeParse({ title, recurrence: rule, kind, ...(kind === 'invoice' ? { sourceInvoiceId: source?.id, dueDays } : { agenda: { title, description, kind: 'task', dueDate: rule.startDate, allDay, startTime: allDay ? null : time, remindBeforeMinutes: reminder === '' ? null : Number(reminder), ...(owner === 'company' ? { ownerId: null } : {}) } }) });
    if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? 'Alanları kontrol edin.'); return; }
    setValidation(''); save.mutate(parsed.data, { onSuccess: () => { toast.success('Tekrar planı oluşturuldu.'); onClose(); } });
  };
  return <Sheet open onOpenChange={o => { if (!o) onClose(); }} title="Yeni tekrar planı" footer={<Button variant="primary" loading={save.isPending} onClick={submit}>Planı kaydet</Button>}>
    <div className="space-y-5">
      {(validation || save.error) && <Callout tone="danger">{validation || errorMessage(save.error)}</Callout>}
      <Field label="Tür">{id => <Select id={id} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>{canAgenda && <option value="agenda">Ajanda ve hatırlatma</option>}{canInvoice && <option value="invoice">Fatura taslağı</option>}</Select>}</Field>
      <Field label="Plan başlığı" required>{id => <Input id={id} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="Aylık şantiye toplantısı" />}</Field>
      <div className="grid grid-cols-2 gap-4"><Field label="Başlangıç" required>{id => <Input id={id} type="date" value={rule.startDate} onChange={e => setRule(s => ({ ...s, startDate: e.target.value }))} />}</Field><Field label="Bitiş (isteğe bağlı)">{id => <Input id={id} type="date" value={rule.endDate ?? ''} onChange={e => setRule(s => ({ ...s, endDate: e.target.value || null }))} />}</Field></div>
      <div className="grid grid-cols-2 gap-4"><Field label="Her kaç dönem?">{id => <Input id={id} type="number" min={1} max={30} value={rule.interval} onChange={e => setRule(s => ({ ...s, interval: Number(e.target.value) }))} />}</Field><Field label="Dönem">{id => <Select id={id} value={rule.frequency} onChange={e => setRule(s => ({ ...s, frequency: e.target.value as Recurrence['frequency'] }))}>{Object.entries(frequencies).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>}</Field></div>
      {kind === 'invoice' ? <><RecordPicker kind="invoice" value={source} onChange={setSource} label="Kaynak hizmet faturası" /><Field label="Vade: oluşturma tarihinden sonra gün">{id => <Input id={id} type="number" min={0} max={365} value={dueDays} onChange={e => setDueDays(Number(e.target.value))} />}</Field><Callout>Stok, sipariş ve irsaliye bağlantılı faturalar kullanılamaz. Her dönem taslak oluşur; onay ve ödeme işlemleri fatura ekranından yapılır.</Callout></> : <>
        <Field label="Ajanda sahibi">{id => <Select id={id} value={owner} onChange={e => setOwner(e.target.value)}><option value="mine">Ben</option><option value="company">Şirket ajandası</option></Select>}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />Tüm gün</label>
        {!allDay && <Field label="Başlangıç saati">{id => <Input id={id} type="time" value={time} onChange={e => setTime(e.target.value)} />}</Field>}
        <Field label="Kaç dakika önce hatırlatılsın?" hint="Boş bırakılırsa hatırlatma oluşturulmaz. En fazla 30 gün (43.200 dakika).">{id => <Input id={id} type="number" min={0} max={43200} value={reminder} onChange={e => setReminder(e.target.value)} />}</Field>
        <Field label="Açıklama">{id => <Textarea id={id} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} />}</Field>
      </>}
      <p className="text-xs text-muted">Ay sonunda eksik gün varsa o ayın son günü kullanılır. Geçmiş başlangıç tarihi seçerseniz geçmiş dönemler de sırayla oluşturulur.</p>
    </div>
  </Sheet>;
}
function RecurringHistory({ row, onClose }: { row: RecurringTemplate; onClose: () => void }) {
  const query = useCQuery<{ kind: string; items: { id: string; date: string; targetId: string; createdAt: string }[] }>(['recurring', 'history', row.id], `/api/settings/recurring/${row.id}/history`);
  return <Sheet open onOpenChange={o => { if (!o) onClose(); }} title={row.title} description="Son 200 oluşum ve kaynak kayıtları.">
    {query.error ? <Callout tone="danger">{errorMessage(query.error)}</Callout> : !query.data ? <PageLoading /> : !query.data.items.length ? <p className="text-sm text-muted">Henüz kayıt oluşmadı.</p> : <ul className="divide-y divide-border">{query.data.items.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm">{formatDateTR(item.date)}</p><p className="mt-1 text-xs text-muted">{new Date(item.createdAt).toLocaleString('tr-TR')}</p></div><Link className="link text-sm" to={row.kind === 'invoice' ? `/invoices/${item.targetId}` : `/agenda?from=${item.date}&to=${item.date}&scope=all`}>{row.kind === 'invoice' ? 'Fatura taslağı' : 'Ajandayı aç'}</Link></li>)}</ul>}
  </Sheet>;
}
