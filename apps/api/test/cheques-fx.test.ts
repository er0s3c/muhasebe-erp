import { describe,it,expect } from 'vitest';
import { todayIso,addDaysIso } from '@erp/shared';
import { makeApp,registerUser,createCompany,client,asDb,expectDbError,orgOf } from './helpers';
describe('Dövizli çek/senet',async()=>{
  const {app,handle}=await makeApp();
  async function world(name:string,baseCurrency='TRY') {
    const user=await registerUser(app,name),company=await createCompany(app,user.token,{baseCurrency}),c=client(app,user.token,company.id);
    const party=async(kind:string)=>(await c.post('/api/parties',{name:kind+' kişi',kind})).json().party;
    const bank=async(currency:string)=>(await c.post('/api/treasury/accounts',{kind:'bank',name:currency+' banka',currency})).json().account;
    const cheque=async(partyId:string,currency='GBP',direction='received',extra:Record<string,unknown>={})=>{
      const r=await c.post('/api/cheques',{direction,docType:direction==='issued'?'note':'cheque',docNo:Math.random().toString(),partyId,currency,amount:'100',issueDate:todayIso(),dueDate:addDaysIso(todayIso(),10),registerDate:todayIso(),...extra});expect(r.statusCode,r.body).toBe(201);return r.json().cheque;
    };
    const act=async(action:string,id:string,extra:Record<string,unknown>={})=>{const r=await c.post('/api/cheques/actions',{action,chequeIds:[id],date:todayIso(),...extra});expect(r.statusCode,r.body).toBe(200);return r.json();};
    const journal=async(id:string)=>{const r=(await c.get(`/api/journal-entries/${id}`)).json().entry;expect(r.lines.reduce((n:number,l:{debitBase:string;creditBase:string})=>n+Number(l.debitBase)-Number(l.creditBase),0)).toBeCloseTo(0,4);return r.lines as {accountCode:string;debitBase:string;creditBase:string;currency:string}[];};
    return {c,user,company,party,bank,cheque,act,journal};
  }
  it('kısmi fatura kapama ve tahsil gününün kur farkı dengeli yevmiyeler üretir',async()=>{
    const w=await world('FxReceive'),party=await w.party('customer'),bank=await w.bank('GBP');
    const invoice=await w.c.post('/api/invoices',{type:'sales',partyId:party.id,invoiceDate:todayIso(),currency:'GBP',fxRate:'40',post:true,lines:[{description:'Hizmet',quantity:'1',unitPrice:'200'}]});expect(invoice.statusCode,invoice.body).toBe(201);
    const line=(await w.c.get(`/api/parties/${party.id}/open-items?type=receivable&asOf=${todayIso()}`)).json().receivable.items[0];
    const cheque=await w.cheque(party.id,'GBP','received',{fxRate:'42',items:[{lineId:line.lineId,amount:'100',settleAmount:'100'}]});expect(cheque.amountBase).toBe('4200.0000');
    expect((await w.journal(cheque.entryId)).find(l=>l.accountCode==='646')?.creditBase).toBe('200.0000');
    expect((await w.c.get(`/api/parties/${party.id}/open-items?type=receivable&asOf=${todayIso()}`)).json().receivable.items[0]).toMatchObject({remaining:'100.00',remainingBase:'4000.00'});
    await w.act('deposit',cheque.id,{bankAccountId:bank.id});const collected=await w.act('collect',cheque.id,{fxRate:'45'});
    const lines=await w.journal(collected.batch.entryId);expect(lines.find(l=>l.accountCode==='646')?.creditBase).toBe('300.0000');
    expect((await w.c.get('/api/treasury/accounts')).json().accounts.find((a:{id:string})=>a.id===bank.id)).toMatchObject({balance:'100.0000',balanceBase:'4500.0000'});
    const tb=(await w.c.get(`/api/reports/trial-balance?from=${todayIso()}&to=${todayIso()}`)).json();expect(tb.totals.difference).toBe('0.0000');expect(Number(tb.rows.find((r:{code:string})=>r.code==='108').closing)).toBe(0);
    expect((await w.c.post('/api/cheques/actions',{action:'collect',chequeIds:[cheque.id],date:todayIso(),fxRate:'45'})).statusCode).toBe(422);
    await asDb(handle,{companyId:w.company.id,orgId:await orgOf(app,w.user.token),userId:w.user.userId},async q=>{expect((await expectDbError(q,`update cheques set amount_base=1 where id=$1`,[cheque.id])).code).toBe('ERP14');});
  });
  it('verilen senet ödeme kur farkı, karşılıksız/iade ve ciroda taşıma değeri korunur',async()=>{
    const w=await world('FxPay'),supplier=await w.party('supplier'),customer=await w.party('customer'),bank=await w.bank('GBP');
    const cheque=await w.cheque(supplier.id,'GBP','issued',{fxRate:'40'}),paid=await w.act('pay',cheque.id,{bankAccountId:bank.id,fxRate:'45'});
    expect((await w.journal(paid.batch.entryId)).find(l=>l.accountCode==='656')?.debitBase).toBe('500.0000');
    const bounced=await w.cheque(customer.id,'GBP','received',{fxRate:'42'});await w.act('deposit',bounced.id,{bankAccountId:bank.id});const event=await w.act('bounce',bounced.id);
    expect((await w.journal(event.batch.entryId)).find(l=>l.accountCode==='120')?.debitBase).toBe('4200.0000');
    const endorsee=await w.party('supplier');
    const endorse=await w.cheque(customer.id,'GBP','received',{fxRate:'42'});const invoice=await w.c.post('/api/invoices',{type:'expense',partyId:endorsee.id,externalNo:'GBP-1',invoiceDate:todayIso(),currency:'GBP',fxRate:'40',post:true,lines:[{description:'Gider',quantity:'1',unitPrice:'100'}]});expect(invoice.statusCode,invoice.body).toBe(201);
    const payable=(await w.c.get(`/api/parties/${endorsee.id}/open-items?type=payable&asOf=${todayIso()}`)).json().payable.items.find((i:{remaining:string})=>i.remaining==='100.00');
    const endorsed=await w.act('endorse',endorse.id,{partyId:endorsee.id,items:[{lineId:payable.lineId,amount:'100',settleAmount:'100'}]});expect((await w.journal(endorsed.batch.entryId)).find(l=>l.accountCode==='656')?.debitBase).toBe('200.0000');
    const returned=await w.act('unendorse',endorse.id);expect((await w.journal(returned.batch.entryId)).find(l=>l.accountCode==='320')?.creditBase).toBe('4200.0000');
  });
  it('eksik kur, karışık para birimi ve yanlış banka reddedilir; özet defter tutarıdır',async()=>{
    const w=await world('FxRules'),party=await w.party('customer'),tryBank=await w.bank('TRY');
    const missing=await w.c.post('/api/cheques',{direction:'received',docType:'cheque',docNo:'missing',partyId:party.id,currency:'GBP',amount:'100',issueDate:todayIso(),dueDate:todayIso()});expect(missing.statusCode).toBe(422);expect(missing.json().error.code).toBe('FX_RATE_MISSING');
    const gbp=await w.cheque(party.id,'GBP','received',{fxRate:'40'}),eur=await w.cheque(party.id,'EUR','received',{fxRate:'35'});
    const mixed=await w.c.post('/api/cheques/actions',{action:'return',date:todayIso(),chequeIds:[gbp.id,eur.id]});expect(mixed.statusCode).toBe(422);expect(mixed.json().error.code).toBe('CHEQUE_MIXED_CURRENCY');
    const wrong=await w.c.post('/api/cheques/actions',{action:'deposit',date:todayIso(),chequeIds:[gbp.id],bankAccountId:tryBank.id});expect(wrong.json().error.code).toBe('CHEQUE_BANK_CURRENCY');
    expect((await w.c.get('/api/cheques/reports/maturity')).json().received.amount).toBe('7500.00');
    expect((await w.c.get('/api/cheques/reports/due?days=30')).json().totals.received).toBe('7500.00');
    const returned=await w.act('return',gbp.id);await w.journal(returned.batch.entryId);
  });
  it('defter para birimi GBP iken TRY belge aynı kur kurallarıyla çalışır',async()=>{
    const w=await world('FxOtherBase','GBP'),party=await w.party('customer'),bank=await w.bank('TRY');
    const cheque=await w.cheque(party.id,'TRY','received',{fxRate:'0.025'});expect(cheque.amountBase).toBe('2.5000');await w.act('deposit',cheque.id,{bankAccountId:bank.id});const collected=await w.act('collect',cheque.id,{fxRate:'0.03'});expect((await w.journal(collected.batch.entryId)).find(l=>l.accountCode==='646')?.creditBase).toBe('0.5000');
  });
});
