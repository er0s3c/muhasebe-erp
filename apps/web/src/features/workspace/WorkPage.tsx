import { useState } from 'react';
import { Link } from 'react-router-dom';
import { todayIso, type SearchHit, type WorkItem } from '@erp/shared';
import { PageHeader, Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input, Textarea, Select } from '../../components/ui/Field';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { RecordPicker } from './RecordPicker';
import { Alerts } from './Alerts';

export function WorkPage() {
  const company=useCompany();
  return <WorkContent key={company.id} />;
}
function WorkContent() {
  const company=useCompany();
  const [status,setStatus]=useState('open');
  const [offset,setOffset]=useState(0);
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [dueDate,setDueDate]=useState(todayIso());
  const [ownerId,setOwnerId]=useState('');
  const [priority,setPriority]=useState('normal');
  const [record,setRecord]=useState<SearchHit|null>(null);
  const [editing,setEditing]=useState<WorkItem|null>(null);
  const tasks=useCQuery<{items:WorkItem[];hasMore:boolean;today:string}>(['workspace-tasks',status,offset],`/api/workspace/tasks?status=${status}&offset=${offset}`);
  const members=useCQuery<{items:{id:string;name:string}[]}>(['workspace-members'],'/api/workspace/members');
  const agenda=useCQuery<{counts:{today:number;overdue:number;upcoming:number}}>(['workspace-agenda'],'/api/workspace/agenda');
  const create=useCMutation((_v:void,call)=>call('/api/workspace/tasks',{method:'POST',body:{title,description,dueDate,priority,...(ownerId?{ownerId}:{}),...(record?{record:{kind:record.kind,id:record.id}}:{})}}),[['workspace-tasks']]);
  const update=useCMutation((input:{id:string;version:number;status?:string;dueDate?:string},call)=>call(`/api/workspace/tasks/${input.id}`,{method:'PATCH',body:input}),[['workspace-tasks']]);
  const error=create.error??update.error??tasks.error;
  return <>
    <PageHeader title="Bugünkü işlerim" description="Görevlerini, gecikmeleri ve ajandandaki işleri takip et." actions={<Link to="/workspace/documents">Belge arşivi →</Link>} />
    {error && <Callout tone="danger">{error.message}</Callout>}
    <Alerts />
    {!!agenda.data && <div className="mb-4 flex flex-wrap gap-4 text-sm"><Link to="/agenda">Ajanda: {agenda.data.counts.today} bugün · {agenda.data.counts.overdue} gecikmiş · {agenda.data.counts.upcoming} yaklaşan</Link></div>}
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <section aria-label="Görevler" className="space-y-3">
        <label className="block max-w-xs text-sm">Durum<Select value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}}><option value="open">Açık işler</option><option value="done">Tamamlanan</option><option value="cancelled">İptal edilen</option><option value="all">Tümü</option></Select></label>
        {tasks.isPending && <PageLoading />}
        {tasks.data?.items.length===0 && <Card className="p-6 text-muted">Bu görünümde görev bulunmuyor.</Card>}
        {tasks.data?.items.map(item=><Card key={item.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{item.title}</h2><span className={item.status==='open'&&item.dueDate<tasks.data.today?'text-sm text-danger':'text-sm text-muted'}>{item.dueDate} · {item.priority==='high'?'Öncelikli':'Normal'}</span></div>
          <p className="whitespace-pre-wrap text-sm text-muted">{item.description}</p><p className="text-xs text-muted">Sorumlu: {item.ownerName}</p>
          {item.recordKind && <Link className="text-sm underline" to={`/workspace/documents?kind=${item.recordKind}&id=${item.recordId}`}>Bağlı kayıt ve belgeler</Link>}
          {company.role!=='viewer' && <div className="flex flex-wrap gap-2"><Button disabled={update.isPending} onClick={()=>update.mutate({id:item.id,version:item.version,status:item.status==='open'?'done':'open'})}>{item.status==='open'?'Tamamla':'Yeniden aç'}</Button>
            {item.status==='open'&&<><Button onClick={()=>setEditing(item)}>Vade değiştir</Button><Button disabled={update.isPending} onClick={()=>update.mutate({id:item.id,version:item.version,status:'cancelled'})}>İptal et</Button></>}
          </div>}
          {editing?.id===item.id && <form className="flex gap-2" onSubmit={e=>{e.preventDefault();update.mutate({id:item.id,version:item.version,dueDate:editing.dueDate},{onSuccess:()=>setEditing(null)});}}><Input type="date" aria-label="Yeni vade" required value={editing.dueDate} onChange={e=>setEditing({...editing,dueDate:e.target.value})}/><Button type="submit" disabled={update.isPending}>Kaydet</Button></form>}
        </Card>)}
        <div className="flex gap-2"><Button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>Önceki</Button><Button disabled={!tasks.data?.hasMore} onClick={()=>setOffset(offset+100)}>Sonraki</Button></div>
      </section>
      {company.role!=='viewer' && <Card className="h-fit p-5"><form className="space-y-4" onSubmit={e=>{e.preventDefault();create.mutate(undefined,{onSuccess:()=>{setTitle('');setDescription('');setRecord(null);}});}}>
        <h2 className="font-semibold">Yeni görev</h2>
        <label className="block text-sm">Başlık<Input required minLength={2} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} /></label>
        <label className="block text-sm">Açıklama<Textarea maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)} /></label>
        <label className="block text-sm">Vade<Input required type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} /></label>
        <label className="block text-sm">Öncelik<Select value={priority} onChange={e=>setPriority(e.target.value)}><option value="normal">Normal</option><option value="high">Yüksek</option></Select></label>
        {!!members.data?.items.length && <label className="block text-sm">Sorumlu<Select value={ownerId} onChange={e=>setOwnerId(e.target.value)}><option value="">Kendim</option>{members.data.items.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>}
        <RecordPicker value={record} onChange={setRecord}/><Button type="submit" variant="primary" disabled={create.isPending}>Görev oluştur</Button>
      </form></Card>}
    </div>
  </>;
}
