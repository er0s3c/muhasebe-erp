import { Link } from 'react-router-dom';
import { todayIso } from '@erp/shared';
import { useCMutation, useCQuery } from '../../lib/queries';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';

type Alert={key:string;title:string;dueDate:string;path:string;category:string;read:boolean};
export function Alerts() {
  const query=useCQuery<{items:Alert[];total:number;truncated:boolean}>(['work-alerts'],'/api/workspace/alerts');
  const state=useCMutation((input:{key:string;snoozedUntil?:string},call)=>call('/api/workspace/alerts/state',{method:'POST',body:input}),[['work-alerts']]);
  const tomorrow=new Date(`${todayIso()}T12:00:00Z`);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  return <section className="mb-6 space-y-3" aria-label="Bildirim merkezi"><h2 className="font-semibold">Dikkat gerektirenler{query.data?` (${query.data.total})`:''}</h2>
    {(query.error||state.error)&&<Callout tone="danger">{(query.error??state.error)?.message}</Callout>}
    {query.isPending&&<p className="text-sm text-muted">Uyarılar yükleniyor…</p>}
    {query.data?.items.length===0&&<p className="text-sm text-muted">Şu anda bekleyen uyarı yok.</p>}
    <div className="grid gap-3 md:grid-cols-2">{query.data?.items.map(item=><Card key={item.key} className="space-y-2 p-4"><p className="text-xs text-muted">{item.category} · {item.dueDate}{item.read?' · Okundu':''}</p><Link className="font-medium underline" to={item.path}>{item.title}</Link><div className="flex gap-2"><Button disabled={state.isPending||item.read} onClick={()=>state.mutate({key:item.key})}>Okundu</Button><Button disabled={state.isPending} onClick={()=>state.mutate({key:item.key,snoozedUntil:tomorrow.toISOString().slice(0,10)})}>Yarına ertele</Button></div></Card>)}</div>
    {query.data?.truncated&&<p className="text-sm text-muted">İlk 100 uyarı gösteriliyor. Ayrıntılar için ilgili modülü açın.</p>}
  </section>;
}
