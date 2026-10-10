import { createHmac,randomUUID } from 'node:crypto';
import { beforeAll,describe,expect,it } from 'vitest';
import { todayIso } from '@erp/shared';
import type { FastifyInstance } from 'fastify';
import { addMember,asDb,asOwner,client,createCompany,expectDbError,makeApp,orgOf,registerUser,type TestApp } from './helpers';
import { processPlatformWebhooks } from '../src/modules/platform-integrations/events';
import { publicAddress,webhookUrl,type WebhookTransport } from '../src/modules/platform-integrations/transport';
import { canonicalJson,requestHash } from '../src/modules/platform-integrations/crypto';

const received:{url:string;headers:Record<string,string>;body:string}[]=[];
let status=200;
const receiver:WebhookTransport={validate:async url=>{webhookUrl(url);},send:async(url,headers,body)=>{received.push({url,headers,body});return status;}};
let fixture:TestApp,app:FastifyInstance;
beforeAll(async()=>{fixture=await makeApp({webhookTransport:receiver});app=fixture.app;});
async function setup(){
 const session=await registerUser(app,'Platform'),company=await createCompany(app,session.token,{jurisdiction:'TR',sector:'COMMERCE'}),c=client(app,session.token,company.id);
 const party=(await c.post('/api/parties',{name:'Entegrasyon alıcısı',kind:'customer'})).json().party;
 const createKey=async(scopes:string[]= ['invoices.read','invoices.create_draft'],branchId:string|null=null,owner=c)=>{
  const result=await owner.post('/api/company/api-keys',{name:'Test bağlantısı',branchId,scopes,expiresAt:new Date(Date.now()+86400000).toISOString()});expect(result.statusCode,result.body).toBe(201);return result.json() as {id:string;token:string};
 };
 const external=(token:string,method:'GET'|'POST',path='/invoices',payload?:object,requestId=randomUUID(),headers:Record<string,string>={})=>app.inject({method,url:`/api/integration/v1/companies/${company.id}${path}`,payload,headers:{authorization:'Bearer '+token,'idempotency-key':requestId,...headers}});
 const input={type:'sales',partyId:party.id,currency:'TRY',invoiceDate:todayIso(),lines:[{description:'Test hizmeti',quantity:'1',unitPrice:'100',vatCode:'KDV-20'}]};
 return {session,company,c,party,createKey,external,input};
}
describe('genel şirket API anahtarları',()=>{
 it('anahtar yalnız bir kez döner, ham değer DB/listede bulunmaz, kapsam ve süre denetlenir',async()=>{
  const {session,company,c,createKey,external}=await setup(),key=await createKey(['parties.read']);
  expect((await external(key.token,'GET','/parties')).statusCode).toBe(200);
  expect((await external(key.token,'GET')).statusCode).toBe(403);
  const list=await c.get('/api/company/api-keys');expect(list.body).not.toContain(key.token);expect(list.json().keys[0].keyHash).toBeUndefined();
  await asOwner(async q=>{const row=(await q('select key_hash from company_api_keys where id=$1',[key.id])).rows[0];expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);expect(row.key_hash).not.toContain(key.token);});
  expect((await c.post('/api/company/api-keys',{name:'Süresiz',branchId:null,scopes:['invoices.read'],expiresAt:new Date(Date.now()+366*86400000).toISOString()})).statusCode).toBe(422);
  const orgId=await orgOf(app,session.token);await asDb(fixture.handle,{companyId:company.id,orgId,userId:session.userId},async q=>expect((await expectDbError(q,'update company_api_keys set scopes=$1::jsonb where id=$2',['["invoices.read"]',key.id])).code).toBe('ERP10'));
 });
 it('geçersiz, iptal edilen ve süresi geçen anahtarlar kullanılamaz',async()=>{
  const {c,createKey,external}=await setup(),key=await createKey(['invoices.read']);
  expect((await external(key.token.slice(0,-1)+'!', 'GET')).statusCode).toBe(401);
  expect((await c.post(`/api/company/api-keys/${key.id}/revoke`)).statusCode).toBe(200);
  expect((await external(key.token,'GET')).statusCode).toBe(401);
  const expiry=new Date(Date.now()+2000),short=await c.post('/api/company/api-keys',{name:'Kısa süreli test',branchId:null,scopes:['invoices.read'],expiresAt:expiry.toISOString()});expect(short.statusCode,short.body).toBe(201);const another=short.json();await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry.getTime()-Date.now()+50)));
  expect((await external(another.token,'GET')).statusCode).toBe(401);
 });
 it('eşzamanlı tekrar tek fatura oluşturur, farklı içerik conflict ve post alanı reddedilir',async()=>{
  const {company,c,createKey,external,input}=await setup(),key=await createKey(),requestId=randomUUID();
  const [a,b]=await Promise.all([external(key.token,'POST','/invoices',input,requestId),external(key.token,'POST','/invoices',input,requestId)]);
  expect(a.statusCode,a.body).toBe(201);expect(b.statusCode,b.body).toBe(201);expect(a.json().invoice.id).toBe(b.json().invoice.id);expect([a.headers['idempotency-replayed'],b.headers['idempotency-replayed']]).toContain('true');
  const changed=await external(key.token,'POST','/invoices',{...input,description:'Farklı'},requestId);expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await external(key.token,'POST','/invoices',{...input,post:true})).statusCode).toBe(400);
  expect((await external(key.token,'POST','/invoices',{...input,type:'purchase'})).statusCode).toBe(400);
  expect((await c.get('/api/invoices')).json().invoices).toHaveLength(1);
  await asOwner(async q=>expect((await q('select count(*)::int n from integration_write_requests where company_id=$1',[company.id])).rows[0].n).toBe(1));
 });
 it('sabit şube başlıkla genişlemez, sahibi yetki kaybederse anahtar durur',async()=>{
  const {company,c,createKey,external,input}=await setup();
  const a=(await c.post('/api/company/branches',{code:'A',name:'Birinci şube'})).json().branch,b=(await c.post('/api/company/branches',{code:'B',name:'İkinci şube'})).json().branch;
  const key=await createKey(['invoices.read','invoices.create_draft'],a.id);
  const draft=await external(key.token,'POST','/invoices',input,randomUUID(),{'x-branch-id':b.id});expect(draft.statusCode,draft.body).toBe(201);expect(draft.json().invoice.branchId).toBe(a.id);
  const unassignedKey=await createKey(['invoices.read']);expect((await external(unassignedKey.token,'GET')).json().invoices).toHaveLength(0);
  const admin=await addMember(app,c,company.id,'admin','IntegrationAdmin'),adminKey=await createKey(['invoices.read'],a.id,admin.client);
  expect((await external(adminKey.token,'GET')).statusCode).toBe(200);
  await c.patch(`/api/company/members/${admin.userId}`,{role:'viewer'});expect((await external(adminKey.token,'GET')).statusCode).toBe(403);
  expect((await external(adminKey.token,'GET','/invoices',undefined,randomUUID(),{'x-company-id':company.id})).statusCode).toBe(403);
 });
 it('modül kapatma anahtarı durdurur ve başka şirket token ile okunamaz',async()=>{
  const {company,c,createKey,external}=await setup(),key=await createKey(['invoices.read']);
  const stranger=await registerUser(app,'BaskaPlatform'),other=await createCompany(app,stranger.token,{jurisdiction:'TR',sector:'COMMERCE'});
  expect((await app.inject({method:'GET',url:`/api/integration/v1/companies/${other.id}/invoices`,headers:{authorization:'Bearer '+key.token}})).statusCode).toBe(401);
  expect((await c.put('/api/company/modules/core.integrations',{enabled:false})).statusCode).toBe(200);expect((await external(key.token,'GET')).statusCode).toBe(403);
  expect(company.id).not.toBe(other.id);
 });
});
describe('kalıcı imzalı bildirim kuyruğu',()=>{
 it('draft/post olayı gerçek işlemde yazılır, imza doğru ve secret listede görünmez',async()=>{
  const {company,c,input}=await setup(),start=received.length;status=200;
  const created=await c.post('/api/company/webhook-subscriptions',{name:'Gerçek alıcı',url:'https://receiver.example/erp',branchId:null,eventTypes:['invoice.draft.created','invoice.posted']});expect(created.statusCode,created.body).toBe(201);const {subscription,secret}=created.json();
  const invoice=(await c.post('/api/invoices',input)).json().invoice;expect(invoice.status).toBe('draft');
  const posted=await c.post(`/api/invoices/${invoice.id}/post`);expect(posted.statusCode,posted.body).toBe(200);
  await processPlatformWebhooks(app,new Date(Date.now()+1000));
  const mine=received.slice(start).filter(r=>JSON.parse(r.body).companyId===company.id);expect(mine).toHaveLength(2);expect(mine.map(r=>JSON.parse(r.body).type).sort()).toEqual(['invoice.draft.created','invoice.posted']);
  for(const delivery of mine){const h=delivery.headers;expect(h['x-erp-signature']).toBe('v1='+createHmac('sha256',secret).update(h['x-erp-timestamp']+'.'+h['x-erp-event-id']+'.'+delivery.body).digest('hex'));expect(JSON.parse(delivery.body).data).toEqual({invoiceId:invoice.id,invoiceNo:JSON.parse(delivery.body).type==='invoice.posted'?posted.json().invoice.invoiceNo:null,status:JSON.parse(delivery.body).type==='invoice.posted'?'posted':'draft'});}
  expect((await c.get('/api/company/webhook-subscriptions')).body).not.toContain(secret);
  const history=await c.get(`/api/company/webhook-subscriptions/${subscription.id}/deliveries`);expect(history.json().deliveries).toHaveLength(2);expect(history.json().deliveries.every((d:{status:string})=>d.status==='delivered')).toBe(true);
 });
 it('başarısız teslim aynı kimlik/içerikle yeniden denenir; kesin geri kalan form kayıtlarını etkilemez',async()=>{
  const {company,c,input}=await setup();status=503;
  const {subscription}= (await c.post('/api/company/webhook-subscriptions',{name:'Tekrar alıcısı',url:'https://receiver.example/retry',branchId:null,eventTypes:['invoice.draft.created']})).json();
  expect((await c.post('/api/invoices',input)).statusCode).toBe(201);
  await processPlatformWebhooks(app,new Date(Date.now()+1000));const first=received.findLast(r=>JSON.parse(r.body).companyId===company.id)!;
  let history=(await c.get(`/api/company/webhook-subscriptions/${subscription.id}/deliveries`)).json().deliveries;expect(history[0].status).toBe('pending');expect(history[0].attempts).toBe(1);
  status=200;await processPlatformWebhooks(app,new Date(Date.now()+60000));const second=received.findLast(r=>JSON.parse(r.body).companyId===company.id)!;
  expect(second.headers['x-erp-event-id']).toBe(first.headers['x-erp-event-id']);expect(second.body).toBe(first.body);
  history=(await c.get(`/api/company/webhook-subscriptions/${subscription.id}/deliveries`)).json().deliveries;expect(history[0].status).toBe('delivered');expect(history[0].attempts).toBe(2);
 });
 it('iptal veya oluşturucu üyeliği kaybı teslimi durdurur; işlem başarısızsa olay da rollback olur',async()=>{
  const {company,c,input}=await setup(),start=received.length;
  const admin=await addMember(app,c,company.id,'admin','HookAdmin');
  const subscription=(await admin.client.post('/api/company/webhook-subscriptions',{name:'Yetki alıcısı',url:'https://receiver.example/revoked',branchId:null,eventTypes:['invoice.draft.created']})).json().subscription;
  expect((await c.post('/api/invoices',input)).statusCode).toBe(201);await c.patch(`/api/company/members/${admin.userId}`,{role:'viewer'});
  await processPlatformWebhooks(app,new Date(Date.now()+1000));expect(received.slice(start).filter(r=>JSON.parse(r.body).companyId===company.id)).toHaveLength(0);
  expect((await c.get(`/api/company/webhook-subscriptions/${subscription.id}/deliveries`)).json().deliveries[0].status).toBe('cancelled');
  const invalid=await c.post('/api/invoices',{...input,partyId:randomUUID()});expect(invalid.statusCode).toBe(422);
  await asOwner(async q=>expect((await q('select count(*)::int n from webhook_events where company_id=$1',[company.id])).rows[0].n).toBe(1));
 });
 it('outbox definer şirkete/şubeye/duruma bağlı, gövde sonradan değiştirilemez',async()=>{
  const {session,company,c,input}=await setup();const orgId=await orgOf(app,session.token);
  const subscription=(await c.post('/api/company/webhook-subscriptions',{name:'Guard alıcısı',url:'https://receiver.example/guard',branchId:null,eventTypes:['invoice.draft.created']})).json().subscription;
  const invoice=(await c.post('/api/invoices',input)).json().invoice;
  await asDb(fixture.handle,{companyId:company.id,orgId,userId:session.userId},async q=>{
   expect((await expectDbError(q,'select enqueue_invoice_webhooks($1,$2)',[invoice.id,'invoice.posted'])).code).toBe('ERP10');
   expect((await expectDbError(q,'select enqueue_invoice_webhooks($1,$2)',[randomUUID(),'invoice.draft.created'])).code).toBe('ERP26');
   expect((await expectDbError(q,"update webhook_events set body='{}',payload='{}' where subscription_id=$1",[subscription.id])).code).toBe('ERP10');
  });
 });
});
describe('gönderim güvenlik sınırları',()=>{
 it('özel/test/multicast ve IPv4 gömülü IPv6 reddedilir, genel adresler kabul edilir',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','192.0.2.1','224.0.0.1','255.255.255.255','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::1'])expect(publicAddress(address),address).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  for(const url of ['http://example.com','https://example.com:444','https://user:password@example.com','https://example.com/#frag'])expect(()=>webhookUrl(url)).toThrow();
 });
 it('kanonik hash alan sırasından etkilenmez, içerik değişimini ayırır',()=>{
  expect(canonicalJson({b:2,a:{z:3,x:1}})).toBe(canonicalJson({a:{x:1,z:3},b:2}));expect(requestHash({a:1,b:2})).toBe(requestHash({b:2,a:1}));expect(requestHash({a:1})).not.toBe(requestHash({a:2}));
 });
});
