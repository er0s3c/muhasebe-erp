import { beforeAll,describe,it,expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { todayIso,type InsightConfig } from '@erp/shared';
import { makeApp,registerUser,createCompany,client,addMember } from './helpers';
let app:FastifyInstance;
beforeAll(async()=>{app=(await makeApp()).app;});
const config=(patch:Partial<InsightConfig>={}):InsightConfig=>({title:'Satış panosu',reportKey:'sales-report',range:'month',from:todayIso().slice(0,8)+'01',to:todayIso(),options:{groupBy:'party'},chart:{tableKey:'satis-raporu',labelKey:'label',valueKey:'net'},shared:false,position:0,...patch});
describe('Kaydedilmiş ERP grafik panosu',()=>{
  it('kur çevrimi yapılmış gerçek defter rakamlarını kullanır; negatif bakiye, kaynak toplamı ve sütun denetimi',async()=>{
    const u=await registerUser(app,'InsightMoney'),co=await createCompany(app,u.token),c=client(app,u.token,co.id);
    const party=(await c.post('/api/parties',{name:'Grafik müşterisi',kind:'customer'})).json().party;
    for(const [currency,fxRate] of [['TRY','1'],['GBP','40']]){
      const invoice=await c.post('/api/invoices',{type:'sales',partyId:party.id,invoiceDate:todayIso(),currency,fxRate,lines:[{description:'Hizmet',quantity:'1',unitPrice:'100'}],post:true});expect(invoice.statusCode,invoice.body).toBe(201);
    }
    const result=await c.post('/api/workspace/insights/preview',config());expect(result.statusCode,result.body).toBe(200);
    const data=result.json();expect(data.tables[0].totals.net).toBe('4100.0000');expect(data.chart).toHaveLength(1);expect(data.chart[0]).toMatchObject({value:'4100.00',share:1});
    const mizan=await c.post('/api/workspace/insights/preview',config({reportKey:'trial-balance',chart:{tableKey:'mizan',labelKey:'code',valueKey:'closing'},options:{}}));expect(mizan.statusCode,mizan.body).toBe(200);
    expect(mizan.json().chart.find((r:{label:string})=>r.label==='600').value).toBe('-4100.00');expect(mizan.json().chartCurrency).toBe('TRY');
    expect((await c.post('/api/workspace/insights/preview',config({chart:{tableKey:'satis-raporu',labelKey:'net',valueKey:'net'}}))).statusCode).toBe(400);
    expect((await c.post('/api/workspace/insights/preview',config({chart:{tableKey:'unknown',labelKey:'label',valueKey:'net'}}))).statusCode).toBe(400);
    expect((await c.post('/api/workspace/insights/preview',config({range:'fixed',from:'2024-01-01',to:todayIso()}))).statusCode).toBe(400);
  });
  it('kişisel ve şirket panolarını ayırır; revizyon, kaynak yetki kaybı ve arşivleme',async()=>{
    const u=await registerUser(app,'InsightAccess'),co=await createCompany(app,u.token),c=client(app,u.token,co.id),member=await addMember(app,c,co.id,'admin');
    const own=await c.post('/api/workspace/insights',config());expect(own.statusCode,own.body).toBe(201);const id=own.json().id;
    expect((await member.client.get('/api/workspace/insights')).json().items).toHaveLength(0);expect((await member.client.get(`/api/workspace/insights/${id}`)).statusCode).toBe(404);
    expect((await c.put(`/api/workspace/insights/${id}`,{version:1,config:config({shared:true})})).statusCode).toBe(200);
    expect((await c.put(`/api/workspace/insights/${id}`,{version:1,config:config()})).statusCode).toBe(409);
    expect((await member.client.get('/api/workspace/insights')).json().items).toHaveLength(1);
    const outside=client(app,u.token,(await createCompany(app,u.token)).id);expect((await outside.get(`/api/workspace/insights/${id}`)).statusCode).toBe(404);
    const denied=await c.put(`/api/company/members/${member.userId}/module-access`,{levels:{'core.invoices':'none'}});expect(denied.statusCode,denied.body).toBe(200);
    expect((await member.client.get('/api/workspace/insights')).json().items).toHaveLength(0);expect((await member.client.get(`/api/workspace/insights/${id}`)).statusCode).toBe(403);
    expect((await member.client.post('/api/workspace/insights/preview',config())).statusCode).toBe(403);
    expect((await c.post(`/api/workspace/insights/${id}/archive`,{version:2})).statusCode).toBe(200);expect((await c.get(`/api/workspace/insights/${id}`)).statusCode).toBe(404);
  });
});
