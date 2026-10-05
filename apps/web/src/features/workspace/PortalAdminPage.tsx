import { useState } from 'react';
import type { SearchHit } from '@erp/shared';
import { useCMutation,useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { PageHeader,Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { RecordPicker } from './RecordPicker';
export function PortalAdminPage(){const company=useCompany();return <PortalAdminContent key={company.id}/>;}
function PortalAdminContent(){
  const [record,setRecord]=useState<SearchHit|null>(null);const [label,setLabel]=useState('');const [password,setPassword]=useState('');const [days,setDays]=useState(7);const [selected,setSelected]=useState<string[]>([]);const [url,setUrl]=useState('');
  const links=useCQuery<{items:{id:string;label:string;partyName:string;expiresAt:string;revokedAt:string|null}[]}>(['portal-links'],'/api/workspace/portal-links');
  const documents=useCQuery<{items:{id:string;filename:string}[]}>(['record-documents','party',record?.id],record?`/api/workspace/documents?kind=party&id=${record.id}`:null);
  const create=useCMutation((_v:void,call)=>call<{token:string}>('/api/workspace/portal-links',{method:'POST',body:{partyId:record?.id,label,password,days,documentIds:selected}}),[['portal-links']]);
  const revoke=useCMutation((id:string,call)=>call(`/api/workspace/portal-links/${id}/revoke`,{method:'POST'}),[['portal-links']]);
  return <><PageHeader title="Portal erişimleri" description="Müşteri ve taşeronlara yalnızca kendi cari bilgileri için süreli, salt okunur erişim verin."/>
    {(create.error||revoke.error||links.error)&&<Callout tone="danger">{(create.error??revoke.error??links.error)?.message}</Callout>}
    {url&&<Card className="mb-5 space-y-2 p-5"><p className="font-medium">Bağlantı oluşturuldu</p><Input readOnly aria-label="Portal bağlantısı" value={url} onFocus={e=>e.target.select()}/><p className="text-sm text-muted">Bağlantıyı ve belirlediğiniz parolayı alıcıya iletin. Bağlantı yalnızca bu oluşturma işleminde gösterilir.</p></Card>}
    <div className="grid gap-5 lg:grid-cols-2"><Card className="h-fit p-5"><form className="space-y-4" onSubmit={e=>{e.preventDefault();create.mutate(undefined,{onSuccess:r=>{setUrl(`${window.location.origin}/portal#${r.token}`);setPassword('');}});}}>
      <RecordPicker kind="party" value={record} onChange={r=>{setRecord(r);setSelected([]);}}/>
      <label className="block text-sm">Erişim adı<Input required minLength={2} maxLength={120} value={label} onChange={e=>setLabel(e.target.value)}/></label>
      <label className="block text-sm">Portal parolası (en az 12 karakter)<Input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <label className="block text-sm">Geçerlilik (gün)<Input type="number" min={1} max={30} required value={days} onChange={e=>setDays(Number(e.target.value))}/></label>
      <fieldset><legend className="mb-2 text-sm">Paylaşılacak belgeler</legend>{documents.data?.items.map(d=><label key={d.id} className="mb-2 flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(d.id)} onChange={e=>setSelected(e.target.checked?[...selected,d.id]:selected.filter(id=>id!==d.id))}/>{d.filename}</label>)}{!documents.data?.items.length&&<p className="text-sm text-muted">Cariye bağlı paylaşılabilecek belge yok.</p>}</fieldset>
      <Button type="submit" variant="primary" disabled={create.isPending||!record}>Erişim oluştur</Button>
    </form></Card><section className="space-y-3">{links.data?.items.map(l=><Card key={l.id} className="space-y-2 p-4"><h2 className="font-semibold">{l.label} · {l.partyName}</h2><p className="text-sm text-muted">Son erişim: {new Date(l.expiresAt).toLocaleString('tr-TR')}</p>{l.revokedAt?<p className="text-sm">Erişim kapatıldı.</p>:<Button disabled={revoke.isPending} onClick={()=>revoke.mutate(l.id)}>Erişimi kapat</Button>}</Card>)}</section></div>
  </>;
}
