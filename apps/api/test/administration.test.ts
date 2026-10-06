import { beforeAll,describe,it,expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { todayIso } from '@erp/shared';
import { makeApp,registerUser,createCompany,client,addMember,execAsOwner } from './helpers';
import { withContext, type Db } from '../src/db/client';
import { sanitizeAudit } from '../src/modules/administration/report';

let app:FastifyInstance,db:Db;
beforeAll(async()=>{
  const built=await makeApp({rateFetcher:async()=>readFileSync(new URL('./fixtures/kktcmb-gunluk.xml',import.meta.url),'utf8')});app=built.app;db=built.handle.db;
});
describe('Şirket işletimi ve faaliyet raporu',()=>{
  it('sahip/kapsam filtresi, tek sayaç, kapatma, şirket ve kullanıcı izolasyonu',async()=>{
    const user=await registerUser(app,'Timer'),company=await createCompany(app,user.token),other=await createCompany(app,user.token);
    const owner=client(app,user.token,company.id),outside=client(app,user.token,other.id);
    const member=await addMember(app,owner,company.id,'site_manager');
    const task=(await owner.post('/api/workspace/tasks',{title:'Saha kontrolü',dueDate:todayIso(),ownerId:member.userId})).json().item;
    expect((await owner.get('/api/workspace/tasks?scope=mine')).json().items).toHaveLength(0);
    expect((await owner.get('/api/workspace/tasks?scope=team')).json().items).toHaveLength(1);
    const started=await member.client.post(`/api/workspace/tasks/${task.id}/time/start`);expect(started.statusCode,started.body).toBe(200);
    expect((await member.client.post(`/api/workspace/tasks/${task.id}/time/start`)).statusCode).toBe(409);
    expect((await outside.post(`/api/workspace/time/${started.json().id}/stop`)).statusCode).toBe(403);
    expect((await owner.post(`/api/workspace/time/${started.json().id}/stop`)).statusCode).toBe(403);
    const completed=await owner.patch(`/api/workspace/tasks/${task.id}`,{version:1,status:'done'});expect(completed.statusCode,completed.body).toBe(200);
    const times=(await member.client.get('/api/workspace/time')).json();expect(times.items[0].stoppedAt).toBeTruthy();
    expect((await member.client.post(`/api/workspace/tasks/${task.id}/time/start`)).statusCode).toBe(400);
    const report=await owner.get(`/api/reports/activity?from=${todayIso()}&to=${todayIso()}`);expect(report.statusCode,report.body).toBe(200);
    expect(report.json().summary.completedTasks).toBe(1);expect(report.json().sessions).toHaveLength(1);
    expect(report.json().users.some((u:{id:string})=>u.id===member.userId)).toBe(true);
    expect((await member.client.get(`/api/reports/activity?from=${todayIso()}&to=${todayIso()}`)).statusCode).toBe(403);
    expect((await outside.get(`/api/reports/activity?from=${todayIso()}&to=${todayIso()}`)).json().sessions).toHaveLength(0);
  });
  it('ayar sürümü, üst sınır ve yeni özel dosya deposundan belge indirme',async()=>{
    const user=await registerUser(app,'Limits'),company=await createCompany(app,user.token),c=client(app,user.token,company.id);
    const settings=(await c.get('/api/settings/operations')).json();expect(settings.settings.documentLimitMb).toBe(5);
    expect((await c.put('/api/settings/operations',{version:0,settings:{documentLimitMb:101}})).statusCode).toBe(400);
    const changed=await c.put('/api/settings/operations',{version:0,settings:{documentLimitMb:1,fieldLimitMb:2}});expect(changed.statusCode,changed.body).toBe(200);
    expect((await c.put('/api/settings/operations',{version:0,settings:{documentLimitMb:10}})).statusCode).toBe(409);
    expect((await c.get('/api/workspace/upload-limits')).json()).toEqual({documentLimitMb:1,fieldLimitMb:2});
    const project=(await c.post('/api/projects',{code:'A',name:'Arşiv',status:'active'})).json().project;
    const bytes=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(1048576)]);
    const large=await c.post('/api/workspace/documents',{record:{kind:'project',id:project.id},filename:'large.pdf',mime:'application/pdf',base64:bytes.toString('base64')});expect(large.statusCode,large.body).toBe(400);
    const doc=await c.post('/api/workspace/documents',{record:{kind:'project',id:project.id},filename:'test.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.4 test').toString('base64')});expect(doc.statusCode,doc.body).toBe(201);
    const download=await c.get(`/api/workspace/documents/${doc.json().id}/download`);expect(download.statusCode,download.body).toBe(200);expect(download.body).toBe('%PDF-1.4 test');
    await withContext(db,{companyId:company.id,orgId:app.jwt.verify<{org:string}>(user.token).org,userId:user.userId},async tx=>{expect((await tx.execute(sql`select 1 from record_document_content where id=${doc.json().id}::uuid`)).rows).toHaveLength(0);});
  });
  it('otomatik kur kontrolü elle girilen kuru korur, tarih ve geçmişi saklar',async()=>{
    const user=await registerUser(app,'RatesAuto'),company=await createCompany(app,user.token),c=client(app,user.token,company.id);
    await c.put('/api/exchange-rates',{rateDate:'2026-03-16',currencyCode:'GBP',quoteCode:'TRY',buy:'99',sell:'100',source:'Elle'});
    const run=await c.post('/api/settings/operations/rates/run');expect(run.statusCode,run.body).toBe(200);expect(run.json().status).toBe('succeeded');
    const date=run.json().result.date;
    const manual=await c.put('/api/exchange-rates',{rateDate:date,currencyCode:'GBP',quoteCode:'TRY',buy:'99',sell:'100',source:'Elle'});expect(manual.statusCode,manual.body).toBe(200);
    const second=await c.post('/api/settings/operations/rates/run');expect(second.json().result.skipped).toContain('GBP (elle girilen kur korundu)');
    const rates=(await c.get('/api/exchange-rates?limit=200')).json().rates;
    expect(rates.find((r:{rateDate:string;currencyCode:string})=>r.rateDate===date&&r.currencyCode==='GBP').buy).toBe('99.00000000');
    expect((await c.get('/api/settings/operations')).json().runs).toHaveLength(2);
  });
  it('rapor kimlik/güvenlik verisini ve yetkisiz kayıt türlerini açmaz',async()=>{
    const user=await registerUser(app,'AuditPrivacy'),company=await createCompany(app,user.token),c=client(app,user.token,company.id);
    await addMember(app,c,company.id,'viewer','AuditViewer');
    expect(sanitizeAudit({title:'Başlık',password_hash:'secret',secret_enc:'secret',content:'secret',number_enc:'secret',settings:{password:'secret'}})).toEqual({title:'Başlık'});
    expect(sanitizeAudit({payload:{notes:'Saha kaydı',password:'secret',nested:{apiToken:'secret',quantity:'12'}}},'operation_entries')).toEqual({payload:{notes:'Saha kaydı',nested:{quantity:'12'}}});
    expect((await c.get(`/api/reports/activity?from=${todayIso()}&to=${todayIso()}&table=users`)).statusCode).toBe(403);
    const report=await c.get(`/api/reports/activity?from=${todayIso()}&to=${todayIso()}`);expect(report.statusCode,report.body).toBe(200);expect(report.body).not.toContain('password_hash');expect(report.body).not.toContain('secret');
    expect((await c.get('/api/reports/activity?from=2024-01-01&to=2026-10-01')).statusCode).toBe(400);
  });
  it('gece yarısını aşan sayaçları günlere böler ve seçilen aralığa kırpar',async()=>{
    const user=await registerUser(app,'Midnight'),company=await createCompany(app,user.token),c=client(app,user.token,company.id);
    const created=await c.post('/api/workspace/tasks',{title:'Gece saha kontrolü',dueDate:todayIso()});expect(created.statusCode,created.body).toBe(201);const task=created.json().item;
    await execAsOwner(`insert into work_time_sessions(id,company_id,task_id,user_id,started_at,stopped_at) values(gen_random_uuid(),$1,$2,$3,'2026-03-02 23:30:00 Europe/Nicosia','2026-03-03 01:30:00 Europe/Nicosia')`,[company.id,task.id,user.userId]);
    const both=await c.get('/api/reports/activity?from=2026-03-02&to=2026-03-03');expect(both.statusCode,both.body).toBe(200);expect(both.json().summary.seconds).toBe(7200);expect(both.json().daily.map((d:{seconds:number})=>d.seconds)).toEqual([1800,5400]);
    const day=(await c.get('/api/reports/activity?from=2026-03-03&to=2026-03-03')).json();expect(day.summary.seconds).toBe(5400);expect(day.sessions[0].seconds).toBe(5400);
  });
  it('MFA kurmadan şirket zorunluluğu açılamaz; zorunluluk üyelere uygulanır',async()=>{
    const user=await registerUser(app,'MfaPolicy'),company=await createCompany(app,user.token),c=client(app,user.token,company.id),member=await addMember(app,c,company.id,'viewer');
    expect((await c.put('/api/settings/operations',{version:0,settings:{requireMfa:true}})).statusCode).toBe(400);
    await withContext(db,{companyId:company.id,orgId:app.jwt.verify<{org:string}>(user.token).org,userId:user.userId},async tx=>{await tx.execute(sql`insert into user_mfa(user_id,secret_enc,enabled_at) values(${user.userId},'test-only',now())`);});
    const save=await c.put('/api/settings/operations',{version:0,settings:{requireMfa:true}});expect(save.statusCode,save.body).toBe(200);
    const denied=await member.client.get('/api/workspace/tasks');expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().error.code).toBe('MFA_SETUP_REQUIRED');
    expect((await client(app,member.token).get('/api/auth/mfa')).statusCode).toBe(200);
  });
  it('kur hizmeti hatası sıfır kur üretmez; yedek yapılandırması eksikse politika açılamaz',async()=>{
    const failedApp=(await makeApp({rateFetcher:async()=>{throw new Error('Servis erişilemez');}})).app;
    const user=await registerUser(failedApp,'Unavailable'),company=await createCompany(failedApp,user.token),c=client(failedApp,user.token,company.id);
    const run=await c.post('/api/settings/operations/rates/run');expect(run.json().status).toBe('failed');expect(run.json().error).toBe('Servis erişilemez');
    expect((await c.get('/api/exchange-rates')).json().rates).toHaveLength(0);
    expect((await c.get('/api/settings/backups')).json().available).toBe(false);
    expect((await c.put('/api/settings/operations',{version:0,settings:{automaticBackup:true}})).statusCode).toBe(400);
  });
});
