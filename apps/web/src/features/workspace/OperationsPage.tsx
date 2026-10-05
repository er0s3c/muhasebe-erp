import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { operationKindSchema,operationSchema,todayIso,type OperationKind,type OperationRow,type SearchHit } from '@erp/shared';
import { useCompany,useSession } from '../../lib/session';
import { useCan,useCMutation,useCQuery,useModuleEnabled } from '../../lib/queries';
import { PageHeader,Card } from '../../components/ui/Card';
import { Input,Textarea,Select } from '../../components/ui/Field';
import { Button } from '../../components/ui/Button';
import { Callout,PageLoading } from '../../components/ui/Feedback';
import { RecordPicker } from './RecordPicker';

const labels:Record<OperationKind,string>={collection:'Tahsilat takibi',site_report:'Şantiye günlük raporu',schedule:'İş programı',equipment:'Ekipman ve araçlar',equipment_log:'Ekipman çalışma ve giderleri',defect:'Teslim ve kusur takibi'};
const permissions:Record<OperationKind,string>={collection:'parties.read',site_report:'projects.read',schedule:'projects.read',equipment:'projects.read',equipment_log:'projects.read',defect:'realestate.read'};
const writePermissions:Record<OperationKind,string>={collection:'parties.manage',site_report:'projects.manage',schedule:'projects.manage',equipment:'projects.manage',equipment_log:'projects.manage',defect:'realestate.manage'};
type FieldDef={key:string;label:string;type:'text'|'number'|'date'|'note'|'select';options?:string[];numeric?:boolean;required?:boolean};
const fields:Record<OperationKind,FieldDef[]>={
  collection:[{key:'promiseAmount',label:'Söz verilen tutar',type:'number',required:true},{key:'currency',label:'Para birimi',type:'select',options:['TRY','GBP','EUR','USD']},{key:'promiseDate',label:'Ödeme sözü tarihi',type:'date',required:true},{key:'contactNote',label:'Görüşme notu',type:'note'}],
  site_report:[{key:'weather',label:'Hava durumu',type:'text'},{key:'workers',label:'Çalışan sayısı',type:'number',numeric:true,required:true},{key:'workDone',label:'Yapılan işler',type:'note'},{key:'issues',label:'Engeller ve ihtiyaçlar',type:'note'}],
  schedule:[{key:'start',label:'Planlanan başlangıç',type:'date',required:true},{key:'end',label:'Planlanan bitiş',type:'date',required:true},{key:'progress',label:'Tamamlanma (%)',type:'number',numeric:true,required:true}],
  equipment:[{key:'code',label:'Ekipman kodu / plaka',type:'text',required:true},{key:'category',label:'Tür (vehicle: araç, machine: makine, tool: alet)',type:'select',options:['vehicle','machine','tool']},{key:'serial',label:'Seri numarası',type:'text'},{key:'nextMaintenance',label:'Sonraki bakım tarihi',type:'date'}],
  equipment_log:[{key:'hours',label:'Çalışma saati',type:'number',numeric:true,required:true},{key:'fuelLiters',label:'Yakıt (litre)',type:'number',required:true},{key:'cost',label:'Gider tutarı',type:'number',required:true},{key:'currency',label:'Para birimi',type:'select',options:['TRY','GBP','EUR','USD']},{key:'expenseType',label:'Gider (fuel: yakıt, maintenance: bakım, rent: kira, other: diğer)',type:'select',options:['fuel','maintenance','rent','other']}],
  defect:[{key:'location',label:'Kusurun konumu',type:'text',required:true},{key:'resolution',label:'Çözüm / yapılan düzeltme',type:'note'}],
};
function defaults(kind:OperationKind):Record<string,unknown>{
  const out:Record<string,unknown>={};for(const field of fields[kind]) out[field.key]=field.type==='select'?field.options![0]:field.type==='date'?todayIso():field.numeric?0:field.type==='number'?'0':'';
  if(kind==='schedule')out.dependencies=[];return out;
}
export function OperationsPage(){const company=useCompany();const [params]=useSearchParams();const parsed=operationKindSchema.safeParse(params.get('kind'));return <OperationsContent key={`${company.id}:${parsed.success?parsed.data:'site_report'}`} kind={parsed.success?parsed.data:'site_report'}/>;}
function OperationsContent({kind}:{kind:OperationKind}){
  const company=useCompany();const {user}=useSession();const can=useCan();
  const projectsOn=useModuleEnabled('construction.projects');const partiesOn=useModuleEnabled('core.parties');const realestateOn=useModuleEnabled('construction.realestate');
  const enabled=(k:OperationKind)=>can(permissions[k])&&(k==='collection'?partiesOn:k==='defect'?realestateOn:projectsOn);
  const [offset,setOffset]=useState(0);const [title,setTitle]=useState('');const [eventDate,setEventDate]=useState(todayIso());const [dueDate,setDueDate]=useState(todayIso());
  const [record,setRecord]=useState<SearchHit|null>(null);const [payload,setPayload]=useState<Record<string,unknown>>(defaults(kind));const [editing,setEditing]=useState<OperationRow|null>(null);const [status,setStatus]=useState('open');const [message,setMessage]=useState('');const [error,setError]=useState('');
  const [submissionId,setSubmissionId]=useState<string>(()=>crypto.randomUUID());
  const list=useCQuery<{items:OperationRow[];hasMore:boolean}>(['operations',kind,offset],enabled(kind)?`/api/workspace/operations?kind=${kind}&offset=${offset}`:null);
  const equipment=useCQuery<{items:OperationRow[]}>(['operations','equipment',record?.id],kind==='equipment_log'&&record?`/api/workspace/operations?kind=equipment&projectId=${record.id}`:null);
  const schedules=useCQuery<{items:OperationRow[]}>(['operations','schedule',record?.id],kind==='schedule'&&record?`/api/workspace/operations?kind=schedule&projectId=${record.id}`:null);
  const impact=useCQuery<{items:{id:string;forecastEnd:string;delayDays:number}[]}>(['schedule-impact',record?.id],kind==='schedule'&&record?`/api/workspace/schedule/${record.id}`:null);
  const units=useCQuery<{items:{id:string;name:string}[]}>(['workspace-units',record?.id],kind==='defect'&&record?`/api/workspace/units/${record.id}`:null);
  const body=()=>({id:submissionId,kind,title,eventDate,dueDate,payload,...(record?kind==='collection'?{partyId:record.id}:{projectId:record.id}:{}),...(editing?{ownerId:editing.ownerId}:{})});
  const draftKey=`ada-site-draft:${company.id}:${user?.id}:${kind}`;
  const save=useCMutation(async (_v:void,call)=>{const parsed=operationSchema.parse(body());return editing?call(`/api/workspace/operations/${editing.id}`,{method:'PUT',body:{...parsed,version:editing.version,status}}):call('/api/workspace/operations',{method:'POST',body:parsed});},[['operations'],['schedule-impact']]);
  function restore(){try{const raw=localStorage.getItem(draftKey);if(!raw){setMessage('Kayıtlı taslak yok.');return;}const d=JSON.parse(raw);const parsed=operationSchema.parse(d.body);setTitle(parsed.title);setEventDate(parsed.eventDate);setDueDate(parsed.dueDate);setPayload(parsed.payload);setSubmissionId(parsed.id??crypto.randomUUID());setRecord(d.record);setMessage('Taslak yüklendi. Göndermeden önce kontrol edin.');}catch{setError('Taslak okunamadı.');}}
  function edit(row:OperationRow){setEditing(row);setTitle(row.title);setEventDate(row.eventDate);setDueDate(row.dueDate);setPayload(row.payload);setStatus(row.status);setRecord({id:(row.projectId??row.partyId)!,kind:kind==='collection'?'party':'project',label:'Bağlı kayıt',path:''});setSubmissionId(row.id);}
  function reset(){setEditing(null);setTitle('');setPayload(defaults(kind));setStatus('open');setSubmissionId(crypto.randomUUID());}
  return <><PageHeader title={labels[kind]} description={kind==='collection'?'Ödeme sözlerini ve sonraki görüşmeleri takip edin.':kind==='equipment_log'?'Operasyonel gider takibi. Muhasebe kaydı mevcut fatura / gider akışından yapılır.':'Sahadaki işi proje kayıtlarıyla birlikte takip edin.'} actions={<Button onClick={()=>window.print()}>Yazdır / PDF</Button>}/>
    <nav aria-label="Operasyon modülleri" className="mb-5 flex flex-wrap gap-3 print:hidden">{(Object.keys(labels) as OperationKind[]).filter(enabled).map(k=><Link className={k===kind?'font-semibold underline':'text-muted'} key={k} to={`/workspace/operations?kind=${k}`}>{labels[k]}</Link>)}</nav>
    {!enabled(kind)?<Callout>Bu modül için erişiminiz bulunmuyor.</Callout>:<>
    {(error||save.error||list.error)&&<Callout tone="danger">{error||save.error?.message||list.error?.message}</Callout>}{message&&<p role="status" className="mb-4 text-sm">{message}</p>}
    <div className="grid gap-5 xl:grid-cols-[1fr_390px]"><section className="space-y-3">
      {list.isPending&&<PageLoading/>}{list.data?.items.length===0&&<Card className="p-5 text-muted">Henüz kayıt yok.</Card>}
      {list.data?.items.map(row=><Card key={row.id} className="space-y-2 p-4"><h2 className="font-semibold">{row.title}</h2><p className="text-sm text-muted">{row.eventDate} · Takip / termin: {row.dueDate} · {row.ownerName} · {row.status==='open'?'Açık':row.status==='done'?'Tamamlandı':'İptal'}</p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">{fields[kind].map(f=><div key={f.key}><dt className="text-muted">{f.label}</dt><dd className="whitespace-pre-wrap">{String(row.payload[f.key]??'—')}</dd></div>)}</dl>
        {impact.data?.items.find(i=>i.id===row.id)&&<p className="text-sm">Tahmini bitiş: {impact.data.items.find(i=>i.id===row.id)!.forecastEnd} · {impact.data.items.find(i=>i.id===row.id)!.delayDays} gün gecikme</p>}
        <div className="flex flex-wrap gap-3 print:hidden">{can(writePermissions[kind])&&<Button onClick={()=>edit(row)}>Düzenle / durum</Button>}<Link className="text-sm underline" to={`/workspace/documents?kind=${row.kind==='defect'?'defect':row.kind==='site_report'?'site_report':row.partyId?'party':'project'}&id=${(row.kind==='defect'||row.kind==='site_report')?row.id:row.partyId??row.projectId}`}>Belgeler / fotoğraflar</Link>{row.partyId&&<Link className="text-sm underline" to={`/parties/${row.partyId}`}>Cari ve tahsilatlar</Link>}</div>
      </Card>)}
      <div className="flex gap-2 print:hidden"><Button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-100))}>Önceki</Button><Button disabled={!list.data?.hasMore} onClick={()=>setOffset(offset+100)}>Sonraki</Button></div>
    </section>
    {can(writePermissions[kind])&&<Card className="h-fit p-5 print:hidden"><form className="space-y-3" onSubmit={e=>{e.preventDefault();setError('');save.mutate(undefined,{onSuccess:()=>{setMessage('Kayıt kaydedildi.');try{localStorage.removeItem(draftKey);}catch{/* storage unavailable */}reset();}});}}><h2 className="font-semibold">{editing?'Kaydı düzenle':'Yeni kayıt'}</h2>
      <label className="block text-sm">Başlık<Input required minLength={2} maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label>
      <RecordPicker value={record} kind={kind==='collection'?'party':'project'} onChange={r=>{setRecord(r);if(kind==='schedule')setPayload(p=>({...p,dependencies:[]}));}}/>
      <label className="block text-sm">Kayıt tarihi<Input type="date" required value={eventDate} onChange={e=>setEventDate(e.target.value)}/></label><label className="block text-sm">Sonraki takip / termin<Input type="date" required value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
      {fields[kind].map(f=><label className="block text-sm" key={f.key}>{f.label}{f.type==='note'?<Textarea value={String(payload[f.key]??'')} maxLength={4000} onChange={e=>setPayload({...payload,[f.key]:e.target.value})}/>:f.type==='select'?<Select value={String(payload[f.key]??f.options![0])} onChange={e=>setPayload({...payload,[f.key]:e.target.value})}>{f.options!.map(v=><option key={v} value={v}>{v}</option>)}</Select>:<Input type={f.type} required={f.required} min={f.type==='number'?0:undefined} step={f.type==='number'?'any':undefined} value={String(payload[f.key]??'')} onChange={e=>setPayload({...payload,[f.key]:f.numeric?Number(e.target.value):e.target.value})}/>}</label>)}
      {kind==='equipment_log'&&<label className="block text-sm">Ekipman<Select required value={String(payload.equipmentId??'')} onChange={e=>setPayload({...payload,equipmentId:e.target.value})}><option value="">Seçin</option>{equipment.data?.items.filter(i=>i.status==='open').map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</Select></label>}
      {kind==='defect'&&<label className="block text-sm">Bağımsız birim<Select required value={String(payload.unitId??'')} onChange={e=>setPayload({...payload,unitId:e.target.value})}><option value="">Seçin</option>{units.data?.items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</Select></label>}
      {kind==='schedule'&&<fieldset className="space-y-2"><legend className="text-sm">Önce tamamlanması gereken işler</legend>{schedules.data?.items.filter(i=>i.id!==editing?.id&&i.status!=='cancelled').map(i=><label key={i.id} className="flex gap-2 text-sm"><input type="checkbox" checked={(payload.dependencies as string[]??[]).includes(i.id)} onChange={e=>{const d=payload.dependencies as string[]??[];setPayload({...payload,dependencies:e.target.checked?[...d,i.id]:d.filter(id=>id!==i.id)});}}/>{i.title}</label>)}<p className="text-xs text-muted">Tahmin, kalan iş süresi ve bitiş-başlangıç bağımlılığına dayanır; takvim günü kullanır.</p></fieldset>}
      {editing&&<label className="block text-sm">Durum<Select value={status} onChange={e=>setStatus(e.target.value)}><option value="open">Açık</option><option value="done">Tamamlandı</option><option value="cancelled">İptal</option></Select></label>}
      <div className="flex flex-wrap gap-2"><Button variant="primary" type="submit" disabled={save.isPending||!record}>Kaydet</Button>{editing&&<Button onClick={reset}>Yeni kayıt</Button>}
      {kind==='site_report'&&!editing&&<><Button onClick={()=>{try{localStorage.setItem(draftKey,JSON.stringify({body:body(),record}));setMessage('Taslak bu cihazda saklandı. İnternet geldiğinde yükleyip kaydedebilirsiniz.');}catch{setError('Cihazda taslak saklanamadı.');}}}>Taslağı cihazda sakla</Button><Button onClick={restore}>Taslağı yükle</Button></>}
      </div>
      {kind==='site_report'&&<div className="flex flex-wrap gap-3 pt-2 text-sm"><Link to="/hr/attendance">Puantaj</Link><Link to="/delivery-notes/new?type=purchase">Mal kabul</Link><Link to="/purchasing/requests">Malzeme talebi</Link></div>}
    </form></Card>}
    </div></>}
  </>;
}
