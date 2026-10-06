import { useState } from 'react';
import { Bell, ArrowRight, CheckCheck, Clock3, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { Card, CardHeader } from '../../components/ui/Card';
import { formatDateTR, moneyIn } from '../../lib/format';
import { useCMutation, useCQuery } from '../../lib/queries';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Select } from '../../components/ui/Field';
import { Callout } from '../../components/ui/Feedback';

type Alert = {
  key: string; title: string; dueDate: string; path: string; category: string; read: boolean;
  amount?: string; currency?: string; subject?: string;
};
export function Alerts({ compact = false }: { compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useCQuery<{ items: Alert[]; total: number; truncated: boolean }>(['work-alerts'], '/api/workspace/alerts');
  const state = useCMutation(
    (input: { key: string; snoozedUntil?: string }, call) => call('/api/workspace/alerts/state', { method: 'POST', body: input }),
    [['work-alerts']],
  );
  const today = todayIso();
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const all = query.data?.items ?? [];
  const items = all.filter(i => (category === 'all' || i.category === category) && (!unreadOnly || !i.read));
  const unread = all.filter(i => !i.read).length;
  return (
    <Card className="overflow-hidden" aria-label="Bildirim merkezi">
      <CardHeader title="Dikkat gerektirenler"
        description={query.data ? `${query.data.total} uyarı · ${unread} okunmamış` : 'Vade ve takip hatırlatmaları'}
        action={<span className="flex size-9 items-center justify-center rounded-xl bg-surface-2"><Bell className="size-4 text-muted" aria-hidden /></span>} />
      {(query.error || state.error) && <div className="p-4"><Callout tone="danger">{(query.error ?? state.error)?.message}</Callout></div>}
      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 print:hidden">
          <Select aria-label="Uyarı kategorisi" className="min-w-0 flex-1 text-xs" value={category} onChange={e => { setCategory(e.target.value); setExpanded(false); }}>
            <option value="all">Tüm kategoriler</option>
            {[...new Set(all.map(i => i.category))].map(c => <option key={c}>{c}</option>)}
          </Select>
          <Button size="sm" variant="ghost" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(!unreadOnly)} className={unreadOnly ? 'bg-surface-2' : ''}>
            <CheckCheck className="size-4" aria-hidden /> Okunmamış
          </Button>
        </div>
      )}
      {query.isPending && <p className="px-5 py-6 text-sm text-muted" role="status">Uyarılar yükleniyor…</p>}
      {!query.isPending && !query.error && items.length === 0 && (
        <div className="flex gap-3 px-5 py-8"><CheckCircle2 className="mt-0.5 size-5 text-success" aria-hidden /><div><p className="text-sm">{all.length ? 'Filtreye uygun uyarı yok' : 'Takipleriniz güncel'}</p><p className="mt-1 text-xs text-muted">{all.length ? 'Diğer uyarılar için filtreleri değiştirin.' : 'Yeni bir vade veya onay gerektiğinde burada görünür.'}</p></div></div>
      )}
      <div className={compact ? 'max-h-[620px] divide-y divide-border overflow-y-auto' : 'divide-y divide-border'}>
        {items.slice(0, compact && !expanded ? 5 : 100).map(item => {
          const late = item.dueDate < today;
          return (
            <article key={item.key} className="group px-5 py-4 transition-colors hover:bg-surface-2/50">
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                {!item.read && <span className="size-1.5 rounded-full bg-brand" aria-label="Okunmamış" />}
                <span>{item.category}</span><span aria-hidden>·</span><time dateTime={item.dueDate}>{formatDateTR(item.dueDate)}</time>
                {late && <Badge tone="danger">Gecikmiş</Badge>}
                {!late && item.dueDate === today && <Badge tone="warning">Bugün</Badge>}
              </div>
              <Link className="flex min-w-0 items-start justify-between gap-3 rounded-md text-sm hover:underline" to={item.path}>
                <span className="break-words">{item.subject ?? item.title}{item.amount && item.currency && <span className="mt-1 block text-base tabular-nums">{moneyIn(item.amount, item.currency)} <span className="text-xs text-muted">tahsilat</span></span>}</span>
                <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              </Link>
              <div className="mt-3 flex flex-wrap items-center gap-1 print:hidden">
                <Button size="sm" variant="ghost" disabled={state.isPending || item.read} aria-label={`${item.title}: okundu olarak işaretle`} onClick={() => state.mutate({ key: item.key })}>
                  <CheckCheck className="size-3.5" aria-hidden />{item.read ? 'Okundu' : 'Okundu işaretle'}
                </Button>
                <Button size="sm" variant="ghost" disabled={state.isPending} aria-label={`${item.title}: yarına ertele`} onClick={() => state.mutate({ key: item.key, snoozedUntil: tomorrow.toISOString().slice(0, 10) })}>
                  <Clock3 className="size-3.5" aria-hidden />Yarına ertele
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      {(query.data?.truncated || (compact && items.length > 5)) && <div className="border-t border-border px-5 py-3">
        {query.data?.truncated && <p className="mb-2 text-xs text-muted">İlk 100 uyarı gösteriliyor. Diğer kayıtları ilgili modülden açabilirsiniz.</p>}
        {compact && items.length > 5 && <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Daha az göster' : `Tüm uyarıları göster (${items.length})`}<ArrowRight className="size-4" aria-hidden /></Button>}
      </div>}
    </Card>
  );
}
