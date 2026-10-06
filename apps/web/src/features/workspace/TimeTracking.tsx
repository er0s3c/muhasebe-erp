import { useEffect, useState } from 'react';
import { Play, Square, Timer } from 'lucide-react';
import type { TimeSession } from '@erp/shared';
import { useCQuery, useCMutation } from '../../lib/queries';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { formatDateTR } from '../../lib/format';

export function duration(seconds:number) {
  const mins=Math.floor(seconds/60);
  return `${Math.floor(mins/60)} sa ${mins%60} dk`;
}
export function TaskTimer({taskId}:{taskId:string}) {
  const query=useCQuery<{items:TimeSession[]}>(['work-time'],'/api/workspace/time',{refetchInterval:60000,refetchOnWindowFocus:true});
  const active=query.data?.items.find(s=>!s.stoppedAt);
  const start=useCMutation((_:void,call)=>call(`/api/workspace/tasks/${taskId}/time/start`,{method:'POST'}),[['work-time']]);
  return <><Button size="sm" variant="ghost" disabled={!!active || start.isPending || query.isPending || !!query.error} onClick={()=>start.mutate()}><Play className="size-3.5" aria-hidden />{active?.taskId===taskId ? 'Süre çalışıyor' : 'Süre başlat'}</Button>{start.error && <span className="text-xs text-danger" role="alert">{start.error.message}</span>}</>;
}
export function TimeTracking() {
  const query=useCQuery<{items:TimeSession[]}>(['work-time'],'/api/workspace/time',{refetchInterval:60000,refetchOnWindowFocus:true});
  const [now,setNow]=useState(Date.now());
  const active=query.data?.items.find(s=>!s.stoppedAt);
  useEffect(()=>{
    if(!active) return;
    const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);
  },[active]);
  const stop=useCMutation((id:string,call)=>call(`/api/workspace/time/${id}/stop`,{method:'POST',body:{}}),[['work-time'],['activity-report']]);
  const seconds=active ? Math.max(0,Math.min(86400,Math.floor((now-Date.parse(active.startedAt))/1000))) : 0;
  return <Card className="overflow-hidden"><CardHeader title="Çalışma sürem" description="Görev üzerinden başlatılan süreler" action={<Timer className="size-4 text-muted" aria-hidden />} />
    <div className="space-y-4 p-5">
      {(query.error || stop.error) && <Callout tone="danger">{(query.error??stop.error)?.message}</Callout>}
      {active ? <div><p className="break-words text-sm">{active.title}</p><p className="my-3 text-[28px] tabular-nums" role="timer" aria-label="Geçen çalışma süresi">{duration(seconds)}</p><Button size="sm" loading={stop.isPending} onClick={()=>stop.mutate(active.id)}><Square className="size-3.5" aria-hidden />Durdur</Button></div> : <p className="text-sm text-muted">Bir görevde “Süre başlat” ile çalışmanızı kaydedin.</p>}
      {query.data?.items.filter(s=>s.stoppedAt).slice(0,3).map(s=><div key={s.id} className="flex gap-3 border-t border-border pt-3 text-xs"><div className="min-w-0 flex-1"><p className="truncate">{s.title}</p><p className="mt-1 text-muted">{formatDateTR(s.startedAt.slice(0,10))}</p></div><span className="shrink-0 tabular-nums">{duration(s.seconds)}</span></div>)}
      <p className="text-xs text-muted">Sayaç siz durdurana kadar sürer; en fazla 24 saat kaydedilir. Puantaj saatleri ayrıca raporlanır.</p>
    </div>
  </Card>;
}
