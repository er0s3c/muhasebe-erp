import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';

describe('deri mağaza POS',async()=>{
  const {app,handle}=await makeApp();
  async function setup(name:string){
    const owner=await registerUser(app,name);const company=await createCompany(app,owner.token,{sector:'LEATHER_FASHION'});
    const c=client(app,owner.token,company.id);const bootstrap=(await c.get('/api/pos/bootstrap')).json();
    const warehouseId=bootstrap.warehouses[0].id;
    const account=await c.post('/api/treasury/accounts',{kind:'cash',name:'Mağaza nakit',currency:'TRY'});expect(account.statusCode,account.body).toBe(201);
    const card=await c.post('/api/treasury/accounts',{kind:'bank',name:'Mağaza kart',currency:'TRY'});expect(card.statusCode,card.body).toBe(201);
    const cashier=await addMember(app,c,company.id,'operator','Kasiyer');
    const access=await c.put(`/api/company/members/${cashier.userId}/module-access`,{levels:{'sales.pos':'write'}});expect(access.statusCode,access.body).toBe(200);
    const till=await c.post('/api/pos/tills',{name:'Ana kasa',warehouseId,cashAccountId:account.json().account.id,cardAccountId:card.json().account.id,assignedUserIds:[cashier.userId,owner.userId]});expect(till.statusCode,till.body).toBe(201);
    const item=await c.post('/api/items',{name:'Dana deri cüzdan',barcode:'869100000001',salePrice:'100',saleCurrency:'TRY',inventoryRole:'finished_goods'});expect(item.statusCode,item.body).toBe(201);
    const itemId=item.json().item.id;
    const receipt=await c.post('/api/stock-documents',{type:'receipt',docDate:TODAY_LOCAL,warehouseId,lines:[{itemId,quantity:'10',unitCost:'40'}]});expect(receipt.statusCode,receipt.body).toBe(201);
    return {owner,company,c,cashier,warehouseId,till:till.json().till,itemId,cashId:account.json().account.id,cardId:card.json().account.id};
  }
  const must201=(r:{statusCode:number;body:string;json:()=>any})=>{expect(r.statusCode,r.body).toBe(201);return r.json();};
  it('atanmış kasiyer tek işlemle parçalı tahsilat yapar; tekrar istek tek satış üretir',async()=>{
    const s=await setup('PosSplit');const c=s.cashier.client;
    expect((await c.get('/api/invoices')).statusCode).toBe(403);expect((await c.get('/api/treasury/accounts')).statusCode).toBe(403);
    const opened=must201(await c.post('/api/pos/sessions',{tillId:s.till.id,openingCash:'0'}));
    const sessionId=opened.session.id;
    const input={requestId:randomUUID(),lines:[{itemId:s.itemId,quantity:'2'}],payments:[{method:'cash',amount:'75'},{method:'card',amount:'125'}]};
    const responses=await Promise.all([c.post(`/api/pos/sessions/${sessionId}/sales`,input),c.post(`/api/pos/sessions/${sessionId}/sales`,input)]);
    const [sale,again]=responses.map(must201);expect(again.sale.id).toBe(sale.sale.id);expect(sale.invoice.lines[0].costValue).toBeUndefined();
    const conflict=await c.post(`/api/pos/sessions/${sessionId}/sales`,{...input,payments:[{method:'cash',amount:'200'}]});expect(conflict.statusCode).toBe(409);
    const stock=(await s.c.get(`/api/items/${s.itemId}`)).json().stock;expect(Number(stock.qty)).toBe(8);expect(Number(stock.value)).toBe(320);
    expect(Number((await s.c.get(`/api/treasury/accounts/${s.cashId}`)).json().account.balance)).toBe(75);
    expect(Number((await s.c.get(`/api/treasury/accounts/${s.cardId}`)).json().account.balance)).toBe(125);
    const mismatch=await c.post(`/api/pos/sessions/${sessionId}/sales`,{requestId:randomUUID(),lines:[{itemId:s.itemId,quantity:'1'}],payments:[{method:'cash',amount:'99'}]});expect(mismatch.statusCode).toBe(422);
    expect(Number((await s.c.get(`/api/items/${s.itemId}`)).json().stock.qty)).toBe(8);
    const close=await c.post(`/api/pos/sessions/${sessionId}/close`,{countedCash:'75'});expect(close.statusCode,close.body).toBe(200);expect(Number(close.json().session.variance)).toBe(0);
    must201(await c.post(`/api/pos/sessions/${sessionId}/sales`,input));
    expect((await c.post(`/api/pos/sessions/${sessionId}/sales`,{...input,requestId:randomUUID()})).statusCode).toBe(422);
  });
  it('iade yetkisi, kaynak miktarı, geri tahsilat ve kasa mutabakatını denetler',async()=>{
    const s=await setup('PosReturn');const session=must201(await s.c.post('/api/pos/sessions',{tillId:s.till.id,openingCash:'0'})).session;
    const sale=must201(await s.c.post(`/api/pos/sessions/${session.id}/sales`,{requestId:randomUUID(),lines:[{itemId:s.itemId,quantity:'2'}],payments:[{method:'cash',amount:'200'}]}));
    const input={requestId:randomUUID(),sessionId:session.id,reason:'Ölçü değişimi',lines:[{sourceLineId:sale.invoice.lines[0].id,quantity:'1'}],refunds:[{method:'cash',amount:'100'}]};
    expect((await s.cashier.client.post(`/api/pos/sales/${sale.sale.id}/returns`,input)).statusCode).toBe(403);
    const returned=must201(await s.c.post(`/api/pos/sales/${sale.sale.id}/returns`,input));
    expect(must201(await s.c.post(`/api/pos/sales/${sale.sale.id}/returns`,input)).sale.id).toBe(returned.sale.id);
    expect((await s.c.post(`/api/pos/sales/${sale.sale.id}/returns`,{...input,requestId:randomUUID(),lines:[{sourceLineId:sale.invoice.lines[0].id,quantity:'2'}],refunds:[{method:'cash',amount:'200'}]})).statusCode).toBe(422);
    expect(Number((await s.c.get(`/api/items/${s.itemId}`)).json().stock.qty)).toBe(9);
    expect(Number((await s.c.get(`/api/treasury/accounts/${s.cashId}`)).json().account.balance)).toBe(100);
    const result=await s.c.post(`/api/pos/sessions/${session.id}/close`,{countedCash:'100'});expect(result.statusCode,result.body).toBe(200);
    await asDb(handle,{userId:s.owner.userId,companyId:s.company.id},async q=>{
      const sums=(await q('select sum(debit_base-credit_base)::text as balance from journal_lines l join journal_entries e on e.id=l.entry_id join accounts a on a.id=l.account_id where e.status=$1 and a.party_control=$2',['posted','receivable'])).rows[0];expect(Number(sums.balance)).toBe(0);
    });
  });
  it('kasa ataması, iskonto istisnası ve şirket izolasyonunu korur',async()=>{
    const s=await setup('PosScope');const outsider=await addMember(app,s.c,s.company.id,'operator','BaskaKasiyer');
    expect((await s.c.put(`/api/company/members/${outsider.userId}/module-access`,{levels:{'sales.pos':'write'}})).statusCode).toBe(200);
    expect((await outsider.client.post('/api/pos/sessions',{tillId:s.till.id,openingCash:'0'})).statusCode).toBe(403);
    const session=must201(await s.cashier.client.post('/api/pos/sessions',{tillId:s.till.id,openingCash:'0'})).session;
    const discounted=await s.cashier.client.post(`/api/pos/sessions/${session.id}/sales`,{requestId:randomUUID(),lines:[{itemId:s.itemId,quantity:'1',discountPct:'10'}],payments:[{method:'cash',amount:'90'}]});expect(discounted.statusCode).toBe(403);
    const second=await createCompany(app,s.owner.token,{sector:'LEATHER_FASHION',name:'İkinci mağaza'});const other=client(app,s.owner.token,second.id);
    expect((await other.get(`/api/pos/sessions/${session.id}`)).statusCode).toBe(404);
  });
});
