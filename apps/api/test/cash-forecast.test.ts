import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { accountIds, client, createCompany, makeApp, registerUser } from './helpers';

const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('nakit projeksiyonu: açık alacak/borç vadeleri + elle kalemler → haftalık bakiye', async () => {
  const { app } = await makeApp();

  it('haftalara dağılım, vadesi geçmiş kalem 1. haftada, elle kalem, kapanış bakiyesi, en düşük hafta, dışa aktarma', async () => {
    const s = await registerUser(app, 'Nakit');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const cust = (await c.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).json().party as { id: string };
    const sup = (await c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' })).json().party as { id: string };
    const cash = (await c.post('/api/treasury/accounts', { kind: 'cash', name: 'Ana kasa', currency: 'TRY' })).json().account as { id: string };
    const fund = await c.post('/api/treasury/transactions', { type: 'other_receipt', date: iso(-1), accountId: cash.id, amount: '10000', glAccountId: ids['500'] });
    expect(fund.statusCode, fund.body).toBe(201);
    // Alacak 1.000 vade +10 gün (2. hafta); borç 400 vadesi 3 gün önce geçmiş (1. haftaya alınır)
    const sale = await c.post('/api/invoices', { post: true, type: 'sales', partyId: cust.id, invoiceDate: iso(-1), dueDate: iso(10), currency: 'TRY', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '1000' }] });
    expect(sale.statusCode, sale.body).toBe(201);
    const exp = await c.post('/api/invoices', { post: true, type: 'expense', partyId: sup.id, invoiceDate: iso(-5), dueDate: iso(-3), externalNo: 'G-1', currency: 'TRY', lines: [{ description: 'Gider', quantity: '1', unitPrice: '400' }] });
    expect(exp.statusCode, exp.body).toBe(201);
    // Elle çıkış 250 (+20 gün: 3. hafta)
    const item = await c.post('/api/cash-forecast/items', { itemDate: iso(20), direction: 'out', description: 'Ofis kirası', amount: '250', currencyCode: 'TRY' });
    expect(item.statusCode, item.body).toBe(201);

    const f = (await c.get('/api/cash-forecast')).json();
    expect(f).toMatchObject({ weeks: 13, baseCurrency: 'TRY', opening: '10000.00', missingRate: 0 });
    expect(f.buckets).toHaveLength(13);
    const [w1, w2, w3] = f.buckets;
    expect(w1).toMatchObject({ week: 1, payables: '400.00', receivables: '0.00', net: '-400.00', closing: '9600.00' });
    expect(w2).toMatchObject({ week: 2, receivables: '1000.00', net: '1000.00', closing: '10600.00' });
    expect(w3).toMatchObject({ week: 3, manualOut: '250.00', closing: '10350.00' });
    expect(f.buckets[12].closing).toBe('10350.00');
    expect(f.lowest).toEqual({ week: 1, balance: '9600.00' });
    expect(f.items.find((i: any) => i.source === 'payable')).toMatchObject({ overdue: true, week: 1, partyName: 'Tedarikçi' });

    // Kalem güncelle ve sil
    const id = item.json().id as string;
    expect((await c.put(`/api/cash-forecast/items/${id}`, { itemDate: iso(2), direction: 'in', description: 'Kira geliri', amount: '300', currencyCode: 'TRY' })).statusCode).toBe(200);
    expect((await c.get('/api/cash-forecast')).json().buckets[0]).toMatchObject({ manualIn: '300.00', closing: '9900.00' });
    const book = readXlsx(new Uint8Array((await c.get('/api/exports/cash-forecast?format=xlsx')).rawPayload));
    expect(book.map((b) => b.name)).toEqual(['Projeksiyon', 'Kalemler']);
    expect(book[0]!.rows[3]![0]).toBe('Hafta');
    expect((await c.delete(`/api/cash-forecast/items/${id}`)).statusCode).toBe(204);
    expect((await c.get('/api/cash-forecast/items')).json().items).toEqual([]);
  });

  it('izin: görüntüleyici projeksiyonu okur, kalem ekleyemez', async () => {
    const s = await registerUser(app, 'NakitIzin');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const { addMember } = await import('./helpers');
    const v = await addMember(app, c, company.id, 'viewer');
    expect((await v.client.get('/api/cash-forecast')).statusCode).toBe(200);
    expect((await v.client.post('/api/cash-forecast/items', { itemDate: iso(1), direction: 'in', description: 'Deneme', amount: '1', currencyCode: 'TRY' })).statusCode).toBe(403);
  });
  it('tam kapanmış faturaların ödeme gecikmesini öğrenir; kısmi ödeme örnek sayısını şişirmez',async()=>{
    const user=await registerUser(app,'NakitGecikme');
    const company=await createCompany(app,user.token), c=client(app,user.token,company.id);
    const party=(await c.post('/api/parties',{name:'Gecikmeli müşteri',kind:'customer'})).json().party.id;
    const account=(await c.post('/api/treasury/accounts',{kind:'cash',name:'Tahsilat kasası',currency:'TRY'})).json().account.id;
    for(const offset of [-30,-25,-20,-17]){
      const invoice=await c.post('/api/invoices',{post:true,type:'sales',partyId:party,invoiceDate:iso(offset-5),dueDate:iso(offset),lines:[{description:'Geçmiş fatura '+offset,quantity:'1',unitPrice:'100'}]});
      expect(invoice.statusCode,invoice.body).toBe(201);
      const open=(await c.get(`/api/parties/${party}/open-items?type=receivable&asOf=${iso(0)}`)).json().receivable.items;
      const line=open.find((i:{dueDate:string})=>i.dueDate===iso(offset));
      expect(line).toBeDefined();
      const amount=offset===-17?'50':'100';
      const paid=await c.post('/api/treasury/transactions',{type:'receipt',date:iso(offset+10),accountId:account,amount,partyId:party,items:[{lineId:line.lineId,amount,settleAmount:amount}]});
      expect(paid.statusCode,paid.body).toBe(201);
    }
    const future=await c.post('/api/invoices',{post:true,type:'sales',partyId:party,invoiceDate:iso(-1),dueDate:iso(7),lines:[{description:'Tahmin edilecek fatura',quantity:'1',unitPrice:'1000'}]});
    expect(future.statusCode,future.body).toBe(201);
    const learned=await c.get('/api/cash-forecast?timing=history');
    expect(learned.statusCode,learned.body).toBe(200);
    const item=learned.json().items.find((i:{dueDate:string})=>i.dueDate===iso(7));
    expect(item).toMatchObject({date:iso(17),dueDate:iso(7),delayDays:10,sampleCount:3,timingSource:'payment_history',amountBase:'1000.00',week:3});
    const due=(await c.get('/api/cash-forecast?timing=due')).json().items.find((i:{dueDate:string})=>i.dueDate===iso(7));
    expect(due).toMatchObject({date:iso(7),week:2,amountBase:'1000.00'});
    const delayed=(await c.get('/api/cash-forecast?timing=history&collectionDelayDays=7')).json().items.find((i:{dueDate:string})=>i.dueDate===iso(7));
    expect(delayed).toMatchObject({date:iso(24),delayDays:17,week:4});
    const book=readXlsx(new Uint8Array((await c.get('/api/exports/cash-forecast?format=xlsx&timing=history')).rawPayload));
    expect(book[1]!.rows.flat().includes('Gerçek ödeme geçmişi')).toBe(true);
  });
});
