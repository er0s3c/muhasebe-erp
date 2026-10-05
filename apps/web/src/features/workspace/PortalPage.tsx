import { useEffect,useState } from 'react';
import { PageHeader,Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { api,apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { moneyIn } from '../../lib/format';

type PortalData={company:string;party:{name:string;code:string};asOf:string;receivables:{dueDate:string;currency:string;remaining:string}[];payables:{dueDate:string;currency:string;remaining:string}[];sales:{code:string;status:string;currency:string;price:string}[];subcontracts:{code:string;title:string;status:string}[];documents:{id:string;filename:string;size:number}[]};
export function PortalPage(){
  const [token]=useState(()=>window.location.hash.slice(1));
  useEffect(()=>{if(window.location.hash)window.history.replaceState(null,'',window.location.pathname);},[]);
  const [password,setPassword]=useState('');const [data,setData]=useState<PortalData|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function login(){setBusy(true);setError('');try{setData(await api<PortalData>('/api/portal/view',{method:'POST',body:{token,password}}));}catch(e){setError((e as Error).message);setData(null);}finally{setBusy(false);}}
  return <main className="mx-auto min-h-screen max-w-5xl space-y-5 p-5 sm:p-10"><PageHeader title={data?`${data.company} · Müşteri / taşeron portalı`:'Müşteri / taşeron portalı'} description={data?`${data.party.name} · ${data.asOf}`:'Paylaşılan cari bilgilerinize bağlantı ve portal parolanızla erişin.'}/>
    {error&&<Callout tone="danger">{error}</Callout>}
    {!data?<Card className="max-w-md p-6"><form className="space-y-4" onSubmit={e=>{e.preventDefault();void login();}}><label className="block text-sm">Portal parolası<Input type="password" autoComplete="current-password" required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/></label><Button type="submit" variant="primary" disabled={busy||!token}>Giriş yap</Button>{!token&&<p className="text-sm">Size verilen tam portal bağlantısını açın.</p>}</form></Card>:<>
      <div className="flex gap-3"><Button onClick={()=>void login()} disabled={busy}>Yenile</Button><Button onClick={()=>{setData(null);setPassword('');}}>Çıkış</Button></div>
      {([['Ödemeniz gereken açık kalemler',data.receivables],['Size ödenecek açık kalemler',data.payables]] as const).map(([label,rows])=><Card key={label} className="p-5"><h2 className="mb-3 font-semibold">{label}</h2>{rows.length===0?<p className="text-muted">Açık kalem yok.</p>:<ul className="divide-y divide-border">{rows.map((r,i)=><li key={i} className="flex justify-between py-3"><span>{r.dueDate}</span><span>{moneyIn(r.remaining,r.currency)}</span></li>)}</ul>}</Card>)}
      <Card className="p-5"><h2 className="mb-3 font-semibold">Sözleşmeler</h2>{data.sales.map(s=><p key={s.code}>{s.code} · {s.status} · {moneyIn(s.price,s.currency)}</p>)}{data.subcontracts.map(s=><p key={s.code}>{s.code} · {s.title} · {s.status}</p>)}{!data.sales.length&&!data.subcontracts.length&&<p className="text-muted">Sözleşme bulunmuyor.</p>}</Card>
      <Card className="p-5"><h2 className="mb-3 font-semibold">Paylaşılan belgeler</h2>{data.documents.map(d=><div key={d.id} className="mb-2 flex items-center justify-between gap-3"><span>{d.filename}</span><Button onClick={()=>{void apiBlob('/api/portal/view',{method:'POST',body:{token,password,documentId:d.id}}).then(r=>saveBlob(r.blob,d.filename)).catch((e:Error)=>setError(e.message));}}>İndir</Button></div>)}{!data.documents.length&&<p className="text-muted">Paylaşılan belge yok.</p>}</Card>
    </>}
  </main>;
}
