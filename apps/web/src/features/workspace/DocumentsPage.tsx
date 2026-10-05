import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { recordRefSchema, type SearchHit } from '@erp/shared';
import { PageHeader, Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useCQuery, useCMutation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { RecordPicker } from './RecordPicker';

type Doc={id:string;filename:string;mime:string;size:number;previousId:string|null;createdAt:string;createdBy:string};
export function DocumentsPage() {
  const company=useCompany();
  const [params]=useSearchParams();
  return <DocumentsContent key={`${company.id}:${params.toString()}`} />;
}
function DocumentsContent() {
  const company=useCompany();
  const [params]=useSearchParams();
  const initial=recordRefSchema.safeParse({kind:params.get('kind'),id:params.get('id')});
  const [record,setRecord]=useState<SearchHit|null>(initial.success?{...initial.data,label:'Bağlı kayıt',path:''}:null);
  const [file,setFile]=useState<File|null>(null);
  const [previousId,setPreviousId]=useState('');
  const [localError,setLocalError]=useState('');
  const docs=useCQuery<{items:Doc[]}>(['record-documents',record?.kind,record?.id],record?`/api/workspace/documents?kind=${record.kind}&id=${record.id}`:null);
  const upload=useCMutation(async (_v:void,call)=>{
    if(!file||!record) throw new Error('Kayıt ve dosya seçin.');
    if(file.size>5*1024*1024) throw new Error('Dosya en fazla 5 MB olabilir.');
    const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.onerror=()=>reject(new Error('Dosya okunamadı.'));reader.readAsDataURL(file);});
    return call('/api/workspace/documents',{method:'POST',body:{record:{kind:record.kind,id:record.id},filename:file.name,mime:file.type,base64,...(previousId?{previousId}:{})}});
  },[['record-documents']]);
  const error=localError||upload.error?.message||docs.error?.message;
  return <><PageHeader title="Belge arşivi" description="Cari, fatura, proje ve sözleşmelerin PDF ve görsel belgeleri. Dosya başına en fazla 5 MB." actions={<Link to="/workspace">Bugünkü işlerim →</Link>} />
    {error&&<Callout tone="danger">{error}</Callout>}
    <Card className="mb-5 max-w-2xl space-y-4 p-5"><RecordPicker value={record} onChange={r=>{setRecord(r);setPreviousId('');}} />
      {record&&<form className="space-y-3" onSubmit={e=>{e.preventDefault();upload.mutate(undefined,{onSuccess:()=>{setPreviousId('');setFile(null);}});}}>
        <label className="block text-sm">PDF, JPEG veya PNG<input className="mt-2 block w-full" type="file" accept="application/pdf,image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0]??null)} /></label>
        {previousId&&<p className="text-sm">Seçilen belgenin yeni sürümü yüklenecek. <button type="button" className="underline" onClick={()=>setPreviousId('')}>Vazgeç</button></p>}
        <Button type="submit" variant="primary" disabled={!file||upload.isPending}>Belge yükle</Button>
      </form>}
    </Card>
    {record&&docs.isPending&&<PageLoading/>}
    {docs.data?.items.length===0&&<p className="text-muted">Bu kayda henüz belge eklenmemiş.</p>}
    <div className="space-y-3">{docs.data?.items.map(doc=><Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={doc.id}><div><h2 className="font-medium">{doc.filename}</h2><p className="text-xs text-muted">{Math.ceil(doc.size/1024)} KB · {doc.createdBy} · {new Date(doc.createdAt).toLocaleString('tr-TR')}{doc.previousId?' · Yeni sürüm':''}</p></div><div className="flex gap-2"><Button onClick={()=>{setLocalError('');void apiBlob(`/api/workspace/documents/${doc.id}/download`,{companyId:company.id}).then(r=>saveBlob(r.blob,doc.filename)).catch((e:Error)=>setLocalError(e.message));}}>İndir</Button>{!docs.data.items.some(d=>d.previousId===doc.id)&&<Button onClick={()=>setPreviousId(doc.id)}>Yeni sürüm</Button>}</div></Card>)}</div>
  </>;
}
