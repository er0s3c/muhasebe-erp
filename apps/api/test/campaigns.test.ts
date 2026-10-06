import { beforeAll,describe,it,expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { todayIso,addDaysIso,type Campaign } from '@erp/shared';
import { makeApp,registerUser,createCompany,client,addMember } from './helpers';
let app:FastifyInstance;
beforeAll(async()=>{app=(await makeApp()).app;});
const offer=(patch:Partial<Campaign>={}):Campaign=>({code:'SAHA10',title:'Saha promosyonu',description:'',from:todayIso(),to:addDaysIso(todayIso(),30),currency:'TRY',discountPct:'10',minimumAmount:'100',minimumQuantity:'1',partyId:null,itemId:null,active:true,...patch});
async function setup(name:string){const user=await registerUser(app,name),company=await createCompany(app,user.token),c=client(app,user.token,company.id);const party=(await c.post('/api/parties',{name:'Promosyon müşterisi',kind:'customer'})).json().party;return {user,company,c,party};}
describe('Satış kampanyası → mevcut fatura taslağı',()=>{
  it('KDV dahil fiyatı hesaplar, bir kez uygular ve önceki şartları değişmeden saklar',async()=>{
    const w=await setup('PromoTax');const invoice=await w.c.post('/api/invoices',{type:'sales',partyId:w.party.id,invoiceDate:todayIso(),vatIncluded:true,lines:[{description:'Şantiye hizmeti',quantity:'2',unitPrice:'116',vatCode:'KDV-16'}]});expect(invoice.statusCode,invoice.body).toBe(201);const invoiceId=invoice.json().invoice.id;
    const made=await w.c.post('/api/sales/campaigns',offer());expect(made.statusCode,made.body).toBe(201);const id=made.json().id;
    const preview=await w.c.post(`/api/sales/campaigns/${id}/preview`,{invoiceId});expect(preview.statusCode,preview.body).toBe(200);expect(preview.json()).toMatchObject({eligible:true,netBefore:'200.0000',netAfter:'180.0000',grossAfter:'208.8000',discountNet:'20.0000'});
    const requests=await Promise.all([w.c.post(`/api/sales/campaigns/${id}/apply`,{invoiceId,fingerprint:preview.json().fingerprint}),w.c.post(`/api/sales/campaigns/${id}/apply`,{invoiceId,fingerprint:preview.json().fingerprint})]);expect(requests.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const saved=(await w.c.get(`/api/invoices/${invoiceId}`)).json();expect(saved.invoice).toMatchObject({netTotal:'180.0000',grossTotal:'208.8000',status:'draft',journalEntryId:null});expect(saved.lines[0].discountPct).toBe('10.0000');
    expect((await w.c.put(`/api/sales/campaigns/${id}`,{version:1,config:offer({discountPct:'20'})})).statusCode).toBe(200);
    expect((await w.c.get(`/api/sales/campaigns/${id}/history`)).json().items[0].snapshot.campaign.discountPct).toBe('10');expect((await w.c.get(`/api/invoices/${invoiceId}`)).json().invoice.netTotal).toBe('180.0000');
    expect((await w.c.delete(`/api/invoices/${invoiceId}`)).statusCode).toBe(409);
    const post=await w.c.post(`/api/invoices/${invoiceId}/post`);expect(post.statusCode,post.body).toBe(200);expect(post.json().invoice.netTotalBase).toBe('180.0000');
  });
  it('geçmiş önizlemeyi, kapsam dışı müşteri/para/miktarı, mevcut indirim ve yetki kaybını reddeder',async()=>{
    const w=await setup('PromoGuard'),other=await setup('PromoOutside');
    const made=await w.c.post('/api/sales/campaigns',offer());const id=made.json().id;
    const invoice=await w.c.post('/api/invoices',{type:'sales',partyId:w.party.id,invoiceDate:todayIso(),lines:[{description:'Hizmet',quantity:'1',unitPrice:'1000'}]});const invoiceId=invoice.json().invoice.id;
    const preview=(await w.c.post(`/api/sales/campaigns/${id}/preview`,{invoiceId})).json();
    await w.c.put(`/api/invoices/${invoiceId}`,{partyId:w.party.id,invoiceDate:todayIso(),lines:[{description:'Fiyat değişti',quantity:'1',unitPrice:'2000'}]});
    expect((await w.c.post(`/api/sales/campaigns/${id}/apply`,{invoiceId,fingerprint:preview.fingerprint})).statusCode).toBe(409);
    for(const patch of [{currency:'GBP'},{minimumAmount:'5000'},{minimumQuantity:'2'},{to:addDaysIso(todayIso(),-1),from:addDaysIso(todayIso(),-30)},{active:false},{partyId:other.party.id}]){
      const create=await w.c.post('/api/sales/campaigns',offer({...patch,code:'P'+Math.random().toString(36).slice(2)} as Partial<Campaign>));
      if('partyId' in patch){expect(create.statusCode).toBe(404);continue;}
      expect(create.statusCode,create.body).toBe(201);expect((await w.c.post(`/api/sales/campaigns/${create.json().id}/preview`,{invoiceId})).json().eligible).toBe(false);
    }
    await w.c.put(`/api/invoices/${invoiceId}`,{partyId:w.party.id,invoiceDate:todayIso(),lines:[{description:'İndirimli',quantity:'1',unitPrice:'2000',discountPct:'5'}]});expect((await w.c.post(`/api/sales/campaigns/${id}/preview`,{invoiceId})).json().eligible).toBe(false);
    expect((await other.c.get(`/api/sales/campaigns/${id}/history`)).statusCode).toBe(404);
    const viewer=await addMember(app,w.c,w.company.id,'viewer');expect((await viewer.client.post(`/api/sales/campaigns/${id}/apply`,{invoiceId,fingerprint:preview.fingerprint})).statusCode).toBe(403);
  });
});
