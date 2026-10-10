import { BrandLogo } from '../../components/layout/Brand';
import { FileText, LockKeyhole } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { formatDateTR } from '../../lib/format';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_PORTAL_SCOPES, type PortalDocumentScopes } from '@erp/shared';
import { PortalBusinessDocuments } from './PortalBusinessDocuments';
import { PageHeader, Card } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { fileBase64 } from '../construction-control/offline';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Feedback';
import { api, apiBlob } from '../../lib/api';
import { saveBlob } from '../../lib/download';
import { moneyIn } from '../../lib/format';

type PortalData = {
  documentScopes?: PortalDocumentScopes;
  company: string;
  party: { name: string; code: string };
  asOf: string;
  receivables: { dueDate: string; currency: string; remaining: string }[];
  payables: { dueDate: string; currency: string; remaining: string }[];
  sales: { id:string;code: string; status: string; currency: string; price: string }[];
  serviceEnabled:boolean;
  services:{id:string;title:string;status:string;description:string;resolution:string|null;confirmed:boolean}[];
  passports:{id:string;title:string;payload:{maintenance:string;devices:{name:string;serial:string;warrantyEnd:string;documentIds:string[]}[]}}[];
  subcontracts: { code: string; title: string; status: string }[];
  documents: { id: string; filename: string; size: number }[];
};
export function PortalPage() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [password, setPassword] = useState('');
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestGeneration = useRef(0);
  const pending = useRef(false);
  const accessLost = useCallback((message: string) => { requestGeneration.current++; pending.current = false; setData(null); setPassword(''); setError(message); setBusy(false); }, []);
  async function login() {
    if (pending.current) return;
    pending.current = true;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setError('');
    try {
      const response = await api<PortalData>('/api/portal/view', {
          anonymous: true,
          method: 'POST',
          body: { token, password },
        });
      if (requestGeneration.current !== generation) return;
      setData(response); setRevision(value => value + 1);
    } catch (e) {
      if (requestGeneration.current !== generation) return;
      setError((e as Error).message);
      setData(null);
    } finally {
      if (requestGeneration.current === generation) { pending.current = false; setBusy(false); }
    }
  }
  return (
    <main className="mx-auto min-h-screen max-w-5xl space-y-5 p-5 sm:p-10">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
        <BrandLogo className="h-8" />
        <span className="inline-flex items-center gap-2 text-xs text-muted">
          <LockKeyhole className="size-4" />
          Güvenli paylaşım
        </span>
      </div>
      <PageHeader
        title={data ? `${data.company} · Müşteri / taşeron portalı` : 'Müşteri / taşeron portalı'}
        description={
          data
            ? `${data.party.name} · ${data.asOf}`
            : 'Paylaşılan cari bilgilerinize bağlantı ve portal parolanızla erişin.'
        }
      />
      {error && <Callout tone="danger">{error}</Callout>}
      {!data ? (
        <Card className="max-w-md p-6">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <label className="block text-sm">
              Portal parolası
              <Input
                type="password"
                autoComplete="current-password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <Button type="submit" variant="primary" loading={busy} disabled={!token}>
              Giriş yap
            </Button>
            {!token && <p className="text-sm">Size verilen tam portal bağlantısını açın.</p>}
          </form>
        </Card>
      ) : (
        <>
          <div className="flex gap-3">
            <Button onClick={() => void login()} loading={busy}>
              Yenile
            </Button>
            <Button
              onClick={() => {
                requestGeneration.current++;
                pending.current = false;
                setData(null);
                setPassword('');
                setBusy(false);
              }}
            >
              Çıkış
            </Button>
          </div>
          <PortalBusinessDocuments scopes={data.documentScopes ?? EMPTY_PORTAL_SCOPES} token={token} password={password} revision={revision} onAccessLost={accessLost} />
          {(
            [
              ['Ödemeniz gereken açık kalemler', data.receivables],
              ['Size ödenecek açık kalemler', data.payables],
            ] as const
          ).map(([label, rows]) => (
            <Card key={label} className="p-5">
              <h2 className="mb-4 text-base">{label}</h2>
              {rows.length === 0 ? (
                <p className="text-muted">Açık kalem yok.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {rows.map((r, i) => (
                    <li key={i} className="flex flex-wrap justify-between gap-3 py-3 text-sm">
                      <span>{formatDateTR(r.dueDate)}</span>
                      <span>{moneyIn(r.remaining, r.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Sözleşmeler</h2>
            {data.sales.map((s) => (
              <p key={s.code}>
                {s.code} ·{' '}
                <Badge>
                  {(
                    {
                      draft: 'Taslak',
                      active: 'Aktif',
                      handed_over: 'Teslim edildi',
                      terminated: 'Sonlandı',
                      cancelled: 'İptal',
                    } as Record<string, string>
                  )[s.status] ?? s.status}
                </Badge>{' '}
                · {moneyIn(s.price, s.currency)}
              </p>
            ))}
            {data.subcontracts.map((s) => (
              <p key={s.code}>
                {s.code} · {s.title} ·{' '}
                <Badge>
                  {(
                    {
                      draft: 'Taslak',
                      active: 'Aktif',
                      completed: 'Tamamlandı',
                      cancelled: 'İptal',
                    } as Record<string, string>
                  )[s.status] ?? s.status}
                </Badge>
              </p>
            ))}
            {!data.sales.length && !data.subcontracts.length && (
              <p className="text-muted">Sözleşme bulunmuyor.</p>
            )}
          </Card>
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Paylaşılan belgeler</h2>
            {data.documents.map((d) => (
              <div key={d.id} className="mb-2 flex items-center justify-between gap-3">
                <span className="inline-flex min-w-0 items-center gap-2 break-all text-sm">
                  <FileText className="size-4 shrink-0 text-muted" />
                  {d.filename}
                </span>
                <Button
                  onClick={() => {
                    void apiBlob('/api/portal/view', {
                      anonymous: true,
                      method: 'POST',
                      body: { token, password, documentId: d.id },
                    })
                      .then((r) => saveBlob(r.blob, d.filename))
                      .catch((e: Error) => setError(e.message));
                  }}
                >
                  İndir
                </Button>
              </div>
            ))}
            {!data.documents.length && <p className="text-muted">Paylaşılan belge yok.</p>}
          </Card>
          <PortalServices data={data} token={token} password={password} onRefresh={()=>void login()}/>
        </>
      )}
    </main>
  );
}
function PortalServices({data,token,password,onRefresh}:{data:PortalData;token:string;password:string;onRefresh:()=>void}){
  const [contractId,setContractId]=useState(''),[description,setDescription]=useState(''),[photo,setPhoto]=useState<File|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[clientId,setClientId]=useState(()=>crypto.randomUUID());
  async function submit(){setBusy(true);setError('');try{if(photo&&(photo.size>5*1024*1024||!['image/jpeg','image/png'].includes(photo.type)))throw new Error('Fotoğraf JPEG/PNG ve en fazla 5 MB olmalı.');await api('/api/portal/view',{anonymous:true,method:'POST',body:{token,password,action:'request_service',clientId,contractId,description,...(photo?{photo:{filename:photo.name,mime:photo.type,base64:await fileBase64(photo)}}:{})}});setClientId(crypto.randomUUID());setDescription('');setPhoto(null);onRefresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="space-y-5">{data.serviceEnabled && <Card className="p-5"><h2 className="mb-4 font-semibold">Garanti ve servis talebi</h2><form className="space-y-4" onSubmit={e=>{e.preventDefault();void submit();}}><Field label="Teslim edilmiş sözleşmeniz">{id=><Select id={id} value={contractId} required onChange={e=>setContractId(e.target.value)}><option value="">Birim seçin</option>{data.sales.filter(s=>s.status==='handed_over').map(s=><option key={s.id} value={s.id}>{s.code}</option>)}</Select>}</Field><Field label="Talep açıklaması">{id=><Textarea id={id} required minLength={3} maxLength={4000} value={description} onChange={e=>setDescription(e.target.value)}/>}</Field><Field label="Servis fotoğrafı">{id=><input id={id} type="file" accept="image/jpeg,image/png" onChange={e=>setPhoto(e.target.files?.[0]??null)}/>}</Field>{error && <Callout tone="danger">{error}</Callout>}<Button type="submit" variant="primary" disabled={busy}>Talebi gönder</Button></form></Card>}{data.services?.length>0 && <Card className="p-5"><h2 className="mb-3 font-semibold">Servis talepleriniz</h2>{data.services.map(s=><div key={s.id} className="space-y-2 border-b border-border py-4"><p>{s.title}</p><Badge>{s.status==='closed'?'Tamamlandı':s.status==='approved'?'Servis sürecinde':'İnceleniyor'}</Badge>{s.resolution && <p className="text-sm text-muted">Çözüm: {s.resolution}</p>}{s.resolution && s.status==='approved' && !s.confirmed && <Button disabled={busy} onClick={()=>{setBusy(true);void api('/api/portal/view',{anonymous:true,method:'POST',body:{token,password,action:'confirm_service',serviceId:s.id}}).then(onRefresh).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Çözümü teyit et</Button>}{s.confirmed && <Badge tone="success">Çözümü teyit ettiniz</Badge>}</div>)}</Card>}{data.passports?.map(p=><Card key={p.id} className="p-5"><h2 className="mb-3 font-semibold">{p.title} · Birim pasaportu</h2><p className="text-sm text-muted">{p.payload.maintenance}</p>{p.payload.devices.map((d,i)=><div key={i} className="space-y-2 border-b border-border py-4"><p>{d.name} · Seri: {d.serial}</p><p className="text-xs text-muted">Garanti sonu: {d.warrantyEnd}</p>{d.documentIds.map((assetId,n)=><Button key={assetId} size="sm" onClick={()=>void apiBlob('/api/portal/view',{anonymous:true,method:'POST',body:{token,password,action:'passport_asset',passportId:p.id,assetId}}).then(r=>saveBlob(r.blob,r.filename??`cihaz-belgesi-${n+1}`)).catch(e=>setError(e.message))}>Cihaz belgesi {n+1}</Button>)}</div>)}</Card>)}</div>;
}
