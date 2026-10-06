import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { HardDrive, Download, Upload, RotateCcw, Clock3, CheckCircle2 } from 'lucide-react';
import { type OperationsSettings, operationsSettingsSchema } from '@erp/shared';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Field, Input } from '../../components/ui/Field';
import { TableWrap, Table, Tr, Th, Td } from '../../components/ui/Table';
import { Sheet } from '../../components/ui/Sheet';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { useCQuery, useCMutation } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { useToast } from '../../components/ui/Toast';

type Manifest={createdAt:string;version:string;fileCount:number;databaseSha256:string;filesSha256:string};
type Backup={id:string;kind:string;status:string;startedAt:string;finishedAt:string|null;error:string|null;result:{manifest?:Manifest;size?:number;database?:string;fileCount?:number;companyCount?:number;tableCount?:number;cutoverRequired?:boolean}};
type Data={available:boolean;reason:string|null;canRestore:boolean;maxPackageMb:number;settings:OperationsSettings;version:number;items:Backup[]};
export function BackupsPage(){return <BackupsContent key={useCompany().id} />;}
function BackupsContent(){
  const company=useCompany(),toast=useToast();
  const query=useCQuery<Data>(['backups'],'/api/settings/backups',{refetchInterval:5000,refetchOnWindowFocus:true});
  const [downloadError,setDownloadError]=useState(''),[downloading,setDownloading]=useState('');
  const [stage,setStage]=useState<{id:string;manifest:Manifest}|null>(null),[accepted,setAccepted]=useState(false);
  const [automatic,setAutomatic]=useState<boolean|null>(null),[hour,setHour]=useState<number|null>(null),[keep,setKeep]=useState<number|null>(null);
  const fileRef=useRef<HTMLInputElement>(null);
  const create=useCMutation((_:void,call)=>call('/api/settings/backups',{method:'POST'}),[['backups'],['operations-settings']]);
  const upload=useCMutation(async(file:File,call)=>{
    if(file.size>128*1024*1024)throw new Error('Yedek paketi en fazla 128 MB olabilir. Daha büyük yedekler için sunucu işletim betiklerini kullanın.');
    const base64=await new Promise<string>((ok,fail)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]!);r.onerror=()=>fail(new Error('Yedek dosyası okunamadı.'));r.readAsDataURL(file);});
    return call<{id:string;manifest:Manifest}>('/api/settings/backups/import',{method:'POST',body:{base64}});
  },[['backups']]);
  const restore=useCMutation((id:string,call)=>call(`/api/settings/backups/${id}/restore`,{method:'POST',body:{confirm:'AYRI KURTARMA VERİTABANI'}}),[['backups']]);
  const save=useCMutation((_:void,call)=>{
    if(!query.data)throw new Error('Ayarlar yüklenmedi.');
    return call('/api/settings/operations',{method:'PUT',body:{version:query.data.version,settings:operationsSettingsSchema.parse({...query.data.settings,automaticBackup:automatic??query.data.settings.automaticBackup,backupHour:hour??query.data.settings.backupHour,backupKeepCount:keep??query.data.settings.backupKeepCount})}});
  },[['backups'],['operations-settings']]);
  async function download(id:string){setDownloading(id);setDownloadError('');try{const result=await apiBlob(`/api/settings/backups/${id}/download`,{companyId:company.id});saveBlob(result.blob,`erp-backup-${id}.zip`);}catch(e){setDownloadError(e instanceof Error?e.message:'İndirme başarısız.');}finally{setDownloading('');}}
  const data=query.data,error=query.error??create.error??upload.error??restore.error??save.error;
  return <>
    <PageHeader title="Yedekleme merkezi" description="Veritabanı, belge arşivi ve özel saha dosyalarını aynı kurtarma paketinde saklayın."
      actions={<><Button disabled={!data?.available||upload.isPending} onClick={()=>fileRef.current?.click()}><Upload className="size-4" />Yedekten içeri aktar</Button><Button variant="primary" loading={create.isPending} disabled={!data?.available} onClick={()=>create.mutate(undefined,{onSuccess:()=>toast.success('Yedekleme kuyruğa alındı.')})}><HardDrive className="size-4" />Şimdi yedekle</Button></>} />
    <input ref={fileRef} className="hidden" type="file" accept=".zip,application/zip" aria-label="Kurtarma paketi seç" onChange={e=>{const file=e.target.files?.[0];if(file)upload.mutate(file,{onSuccess:r=>{setStage(r);setAccepted(false);}});e.target.value='';}} />
    {query.isPending&&<PageLoading />}
    {(error||downloadError)&&<div className="mb-5"><Callout tone="danger">{error?.message??downloadError}</Callout></div>}
    {data&&!data.available&&<div className="mb-5"><Callout title="Kurulum yedeklemesi henüz hazır değil">{data.reason} <Link className="link" to="/reports/data-export">Şirket verilerini dışa aktar</Link></Callout></div>}
    {data&&<div className="space-y-5">
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card><CardHeader title="Otomatik yedekleme" description="Sunucu açıkken seçilen yerel saatte çalışır; sonuç işlem geçmişine kaydedilir." action={<Clock3 className="size-4 text-muted" />} /><form className="space-y-4 p-5" onSubmit={e=>{e.preventDefault();save.mutate(undefined,{onSuccess:()=>{toast.success('Yedekleme politikası kaydedildi.');setAutomatic(null);setHour(null);setKeep(null);}});}}>
          <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="size-4" disabled={!data.available} checked={automatic??data.settings.automaticBackup} onChange={e=>setAutomatic(e.target.checked)} />Her gün otomatik yedekle</label>
          <div className="grid grid-cols-2 gap-4"><Field label="Saat (0–23)">{id=><Input id={id} type="number" min={0} max={23} value={hour??data.settings.backupHour} onChange={e=>setHour(Number(e.target.value))} required />}</Field><Field label="Saklanacak yedek sayısı">{id=><Input id={id} type="number" min={1} max={365} value={keep??data.settings.backupKeepCount} onChange={e=>setKeep(Number(e.target.value))} required />}</Field></div>
          <p className="text-xs text-muted">Europe/Nicosia · Temizlik yalnızca tamamlanmış yedeklerden yapılır. Yeni yedek başarısız olursa eski yedekler korunur. Kurtarma veritabanları otomatik silinmez.</p>
          <Button size="sm" type="submit" loading={save.isPending} disabled={!data.available}>Politikayı kaydet</Button>
        </form></Card>
        <Card><CardHeader title="Kurtarma kapsamı" description="Tam kurulum yedeği şirket sahibinin erişimindedir." action={<CheckCircle2 className="size-4 text-muted" />} /><div className="space-y-3 p-5 text-sm">
          <p>PostgreSQL verisi ve migrasyon geçmişi, eski belge ekleri, çizimler, fotoğraflar ve model dosyaları birlikte saklanır. SHA-256 özeti ve kurulum imzası doğrulanır.</p>
          <p className="text-muted">Yedekten içeri aktarım önce paketi inceler. “Kurtarmayı doğrula” ayrı bir veritabanı ve dosya dizini oluşturur; tablo, şirket ve dosya sayısını kontrol eder. Canlı sisteme geçiş sunucu işletim adımıdır.</p>
          <p className="text-xs text-muted">Web paket sınırı: {data.maxPackageMb} MB. Büyük yedeklerde scripts/backup.sh ve scripts/restore.sh kullanılabilir. Yapılandırma anahtarları ayrıca korunmalıdır.</p>
        </div></Card>
      </div>
      <Card className="overflow-hidden"><CardHeader title="Yedek ve kurtarma geçmişi" description="En son 100 işlem; indirme, bütünlük kontrolü ve kurtarma sonucu." /><TableWrap className="rounded-none border-0"><Table><thead><Tr><Th>İşlem / tarih</Th><Th>Durum</Th><Th>Kapsam / sonuç</Th><Th><span className="sr-only">Eylemler</span></Th></Tr></thead><tbody>{data.items.map(b=><Tr key={b.id}><Td className="whitespace-nowrap"><p>{b.kind==='restore'?'Yedekten kurtarma':'Kurulum yedeği'}</p><p className="mt-1 text-xs text-muted">{new Date(b.startedAt).toLocaleString('tr-TR')}</p></Td><Td><Badge tone={b.status==='failed'?'danger':b.status==='succeeded'?'success':'neutral'}>{({queued:'Bekliyor',running:'Çalışıyor',succeeded:'Tamamlandı',failed:'Başarısız',staged:'İncelendi',expired:'Saklama süresi doldu'} as Record<string,string>)[b.status]??b.status}</Badge></Td><Td className="max-w-96 break-words text-xs text-muted">{b.error??(b.result.database?<><span className="font-mono">{b.result.database}</span><span className="mt-1 block">{b.result.tableCount} tablo · {b.result.companyCount} şirket · {b.result.fileCount} dosya · Canlıya geçiş bekliyor</span></>:b.result.manifest?`${b.result.manifest.fileCount} özel dosya · ${Math.ceil((b.result.size??0)/1024/1024)} MB · ${b.result.manifest.version}`:'İşlem sonucu bekleniyor')}</Td><Td><div className="flex gap-2">{b.kind==='backup'&&b.status==='succeeded'&&<Button size="sm" loading={downloading===b.id} onClick={()=>void download(b.id)}><Download className="size-4" />İndir</Button>}{b.kind==='restore'&&b.status==='staged'&&b.result.manifest&&<Button size="sm" onClick={()=>{setStage({id:b.id,manifest:b.result.manifest!});setAccepted(false);}}>İncele</Button>}</div></Td></Tr>)}</tbody></Table></TableWrap>{!data.items.length&&<p className="p-5 text-sm text-muted">Henüz yedekleme işlemi yok.</p>}</Card>
    </div>}
    <Sheet open={!!stage} onOpenChange={open=>{if(!open)setStage(null);}} title="Yedek paketini incele" description="İmza ve dosya özetleri doğrulandı. Ayrı kurtarma hedefinin içeriğini doğrulayabilirsiniz."
      footer={<><Button onClick={()=>setStage(null)}>Kapat</Button><Button variant="primary" disabled={!accepted||!data?.canRestore} loading={restore.isPending} onClick={()=>stage&&restore.mutate(stage.id,{onSuccess:()=>{setStage(null);toast.success('Ayrı hedefe kurtarma kuyruğa alındı.');}})}><RotateCcw className="size-4" />Kurtarmayı doğrula</Button></>}>
      {stage&&<div className="space-y-5"><dl className="grid grid-cols-2 gap-4 text-sm"><div><dt className="text-xs text-muted">Yedek tarihi</dt><dd>{new Date(stage.manifest.createdAt).toLocaleString('tr-TR')}</dd></div><div><dt className="text-xs text-muted">Uygulama sürümü</dt><dd>{stage.manifest.version}</dd></div><div><dt className="text-xs text-muted">Özel dosya</dt><dd>{stage.manifest.fileCount}</dd></div><div><dt className="text-xs text-muted">Kuruluş</dt><dd>İmza doğrulandı</dd></div><div className="col-span-2"><dt className="text-xs text-muted">Veritabanı SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{stage.manifest.databaseSha256}</dd></div><div className="col-span-2"><dt className="text-xs text-muted">Dosya deposu SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{stage.manifest.filesSha256}</dd></div></dl>
        {!data?.canRestore&&<Callout>Ayrı veritabanı oluşturmak için yedekleme bağlantısının rolünde CREATEDB yetkisi gerekir.</Callout>}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" checked={accepted} onChange={e=>setAccepted(e.target.checked)} /><span>Ayrı bir kurtarma veritabanı ve dosya dizini oluşturulmasını kabul ediyorum. Canlı sisteme geçiş ayrıca yapılacaktır.</span></label>
        {restore.error&&<Callout tone="danger">{restore.error.message}</Callout>}
      </div>}
    </Sheet>
  </>;
}
