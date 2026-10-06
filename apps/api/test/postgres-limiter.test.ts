import { it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { makeApp } from './helpers';
import { PostgresLimiter,postgresFastifyStore } from '../src/http/postgres-limiter';

it('iki sunucu aynı sınırı paylaşır; paralel isteklerde limit aşılmaz',async()=>{
  const first=await makeApp(),second=await makeApp();
  const a=new PostgresLimiter(first.handle.db),b=new PostgresLimiter(second.handle.db),key='parallel:'+randomUUID();
  const results=await Promise.all(Array.from({length:40},(_,i)=>(i%2?a:b).consume(key,10,60000)));
  expect(results.filter(r=>r.ok)).toHaveLength(10);expect(await b.blocked(key,10)).toBeGreaterThan(0);
  await a.reset(key);expect(await b.blocked(key,10)).toBe(0);
  await b.hit(key,60000);expect(await a.blocked(key,1)).toBeGreaterThan(0);
});
it('Fastify depo çocukları aynı rotada ortak, farklı rotalarda ayrı sayaç kullanır',async()=>{
  const {handle}=await makeApp(),Store=postgresFastifyStore(handle.db),key=randomUUID();
  const a=new Store().child({method:'POST',path:'/login'}),b=new Store().child({method:'POST',path:'/login'}),c=new Store().child({method:'POST',path:'/reset'});
  const hit=(store:InstanceType<typeof Store>)=>new Promise<{current:number;ttl:number}>((ok,fail)=>store.incr(key,(e,result)=>e?fail(e):ok(result!),60000,3));
  expect((await hit(a)).current).toBe(1);expect((await hit(b)).current).toBe(2);expect((await hit(c)).current).toBe(1);
});
it('yeni pencere sona eren sayacı sıfırlar; kapalı limiter veri yazmadan geçer',async()=>{
  const {handle}=await makeApp(),a=new PostgresLimiter(handle.db),key=randomUUID();
  expect((await a.consume(key,1,20)).ok).toBe(true);
  await new Promise(r=>setTimeout(r,50));expect((await a.consume(key,1,60000)).ok).toBe(true);
  const disabled=new PostgresLimiter(handle.db,false);expect((await disabled.consume(key,1,60000)).ok).toBe(true);
});
it('paylaşılan Fastify sınırı iki gerçek uygulama örneğinde uygulanır',async()=>{
  const a=(await makeApp({configOverrides:{RATE_LIMIT_STORE:'postgres',RATE_LIMIT_ENABLED:true}})).app;
  const b=(await makeApp({configOverrides:{RATE_LIMIT_STORE:'postgres',RATE_LIMIT_ENABLED:true}})).app;
  // A unique IP avoids interference from independent authentication tests.
  const ip=`10.99.${Math.floor(Math.random()*200)+1}.${Math.floor(Math.random()*200)+1}`;
  const options={method:'POST' as const,url:'/api/auth/mfa/verify',remoteAddress:ip,payload:{mfaToken:'invalid',code:'123456'}};
  for(let i=0;i<10;i++)expect((await (i%2?a:b).inject(options)).statusCode).not.toBe(429);
  const blocked=await b.inject(options);expect(blocked.statusCode,blocked.body).toBe(429);
});
