import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PASSWORD, accountIds, asDb, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

describe('irsaliye', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const warehouses = (await c.get('/api/warehouses')).json().warehouses as { id: string; isDefault: boolean }[];
    const main = warehouses.find((w) => w.isDefault)!;
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, main, ids, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  const mkParty = async (c: C, name: string, kind = 'customer', extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/parties', { name, kind, ...extra });
    if (res.statusCode !== 201) throw new Error(`party failed: ${res.body}`);
    return res.json().party as { id: string };
  };
  const mkItem = async (c: C, name: string, extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/items', { name, vatCode: 'KDV-16', ...extra });
    if (res.statusCode !== 201) throw new Error(`item failed: ${res.body}`);
    return res.json().item as { id: string };
  };
  const receipt = async (c: C, date: string, wh: string, itemId: string, qty: string, unitCost: string) => {
    const res = await c.post('/api/stock-documents', { type: 'receipt', docDate: date, warehouseId: wh, lines: [{ itemId, quantity: qty, unitCost }] });
    if (res.statusCode !== 201) throw new Error(`receipt failed: ${res.body}`);
  };
  const issue = async (c: C, date: string, wh: string, itemId: string, qty: string) => {
    const res = await c.post('/api/stock-documents', { type: 'issue', docDate: date, warehouseId: wh, lines: [{ itemId, quantity: qty }] });
    if (res.statusCode !== 201) throw new Error(`issue failed: ${res.body}`);
  };

  const dline = (itemId: string, quantity: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, ...extra });
  const note = (c: C, body: Record<string, unknown>) => c.post('/api/delivery-notes', body);
  const posted = async (c: C, body: Record<string, unknown>) => {
    const res = await note(c, { post: true, ...body });
    if (res.statusCode !== 201) throw new Error(`delivery note failed: ${res.body}`);
    return res.json() as { note: any; lines: any[]; invoices: any[] };
  };
  const invLine = (itemId: string, quantity: string, unitPrice: string, deliveryLineId: string, extra: Record<string, unknown> = {}) => ({
    itemId,
    description: 'Kalem',
    quantity,
    unitPrice,
    vatCode: 'KDV-16',
    deliveryLineId,
    ...extra,
  });
  const inv = (c: C, body: Record<string, unknown>) => c.post('/api/invoices', body);
  const invPosted = async (c: C, body: Record<string, unknown>) => {
    const res = await inv(c, { post: true, ...body });
    if (res.statusCode !== 201) throw new Error(`invoice failed: ${res.body}`);
    return res.json() as { invoice: any; lines: any[] };
  };

  const journalOf = async (c: C, id: string) => {
    const e = (await c.get(`/api/journal-entries/${id}`)).json().entry;
    const lines = e.lines.map((l: any) => [l.accountCode, Number(l.debitBase), Number(l.creditBase)] as const);
    return { entry: e, lines, byCode: (code: string) => lines.filter((l: readonly [string, number, number]) => l[0] === code) };
  };
  const closing = async (c: C) => {
    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    return Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing])) as Record<string, string>;
  };
  const bal = (cl: Record<string, string>, code: string) => Number(cl[code] ?? 0);
  const stockInfo = async (c: C, id: string) => (await c.get(`/api/items/${id}`)).json().stock as { qty: string; value: string };
  const recon = async (c: C, asOf = day(12, 31)) => (await c.get(`/api/reports/stock-status?asOf=${asOf}`)).json().ledger;
  const getNote = async (c: C, id: string) => (await c.get(`/api/delivery-notes/${id}`)).json() as { note: any; lines: any[]; invoices: any[] };

  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  it('satış irsaliyesi: numara, stok çıkışı ortalama maliyetle, yevmiye YOK; mutabakat farkı bekleyen irsaliyeyle açıklanır', async () => {
    const { c, main } = await setup('SatisIrs');
    const cust = await mkParty(c, 'Ali Yılmaz');
    const item = await mkItem(c, 'Çimento', { unit: 'cuval' });
    await receipt(c, day(3, 1), main.id, item.id, '10', '50'); // 500

    const r = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, vehiclePlate: '34 ABC 123', lines: [dline(item.id, '6')] });
    expect(r.note).toMatchObject({
      status: 'posted', noteNo: `SIR-${thisYear}-000001`, type: 'sales', invoicing: 'open',
      stockDocumentNo: expect.stringMatching(/^SH-/), vehiclePlate: '34 ABC 123', warehouseName: 'Ana depo',
    });
    expect(r.lines[0]).toMatchObject({ quantity: '6.0000', stockValue: '300.0000', adjustValue: '0.0000', invoicedQty: '0.0000', remainingQty: '6.0000', unit: 'cuval' });

    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '4.0000', value: '200.0000' });
    // Yevmiye yok: 150 hesabı yalnızca elle girilen girişi taşır
    const cl = await closing(c);
    expect(bal(cl, '150')).toBe(500);
    expect(bal(cl, '621')).toBe(0);

    const led = await recon(c);
    expect(led).toMatchObject({
      difference: '-300.0000',
      pendingDeliveries: { sales: '-300.0000', purchases: '0.0000', total: '-300.0000' },
      unexplained: '0.0000',
    });

    // Stok belgesi kaynağı irsaliye; doğrudan ters çevrilemez
    const doc = (await c.get(`/api/stock-documents/${r.note.stockDocumentId}`)).json().document;
    expect(doc).toMatchObject({ sourceType: 'delivery_note', sourceId: r.note.id, type: 'issue' });
    const rev = await c.post(`/api/stock-documents/${r.note.stockDocumentId}/reverse`, {});
    expect(rev.json().error.code).toBe('STOCK_DOC_HAS_SOURCE');
  });

  it('kısmi ve çoklu faturalama: stok çift hareket etmez, maliyet payı yevmiyeye gider, son pay kalanı alır, aşım reddedilir', async () => {
    const { c, main } = await setup('Kismi');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Çimento');
    await receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '6')] });
    const dl = dn.lines[0].id;

    const a = await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [invLine(item.id, '2', '100', dl)] });
    expect(a.invoice).toMatchObject({ status: 'posted', grossTotal: '232.0000', stockDocumentId: null, warehouseId: null });
    expect(a.lines[0]).toMatchObject({ costValue: '100.0000', deliveryLineId: dl, deliveryNoteNo: dn.note.noteNo, deliveryLineNo: 1 });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '4.0000', value: '200.0000' }); // yeniden çıkmadı

    const j = await journalOf(c, a.invoice.journalEntryId);
    expect(j.lines.map(([code, d, cr]: readonly [string, number, number]) => [code, d, cr])).toEqual([
      ['120', 232, 0],
      ['600', 0, 200],
      ['391', 0, 32],
      ['621', 100, 0],
      ['150', 0, 100],
    ]);
    let n = await getNote(c, dn.note.id);
    expect(n.note.invoicing).toBe('partial');
    expect(n.lines[0]).toMatchObject({ invoicedQty: '2.0000', remainingQty: '4.0000' });
    expect(n.invoices.map((i: any) => i.invoiceNo)).toEqual([a.invoice.invoiceNo]);
    expect(await recon(c)).toMatchObject({ difference: '-200.0000', pendingDeliveries: { sales: '-200.0000' }, unexplained: '0.0000' });

    // Kalan miktarın tamamı: son pay kalan maliyetin tamamını alır
    const b = await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 12), lines: [invLine(item.id, '4', '90', dl)] });
    expect(b.lines[0].costValue).toBe('200.0000');
    n = await getNote(c, dn.note.id);
    expect(n.note.invoicing).toBe('invoiced');
    expect(await recon(c)).toMatchObject({ difference: '0.0000', pendingDeliveries: { sales: '0.0000', total: '0.0000' }, unexplained: '0.0000' });

    // Aşım
    const over = await inv(c, { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 13), lines: [invLine(item.id, '1', '90', dl)] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('DELIVERY_QTY_EXCEEDED');
  });

  it('kuruş artığı: 3 adet 100,00 maliyet üç faturaya bölününce 33,33 + 33,33 + 33,34', async () => {
    const { c, main } = await setup('Kurus');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Cıvata');
    await receipt(c, day(3, 1), main.id, item.id, '3', '33.333333'); // 100,00
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '3')] });
    expect(dn.lines[0].stockValue).toBe('100.0000');
    const costs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10 + i), lines: [invLine(item.id, '1', '50', dn.lines[0].id)] });
      costs.push(r.lines[0].costValue);
    }
    expect(costs).toEqual(['33.3300', '33.3300', '33.3400']);
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
    expect((await getNote(c, dn.note.id)).note.invoicing).toBe('invoiced');
  });

  it('çoklu irsaliye tek faturada; fatura iptali irsaliyeleri yeniden faturalanabilir yapar; faturalı irsaliye iptal edilemez', async () => {
    const { c, main } = await setup('Coklu');
    const cust = await mkParty(c, 'Müşteri');
    const x = await mkItem(c, 'Kum');
    const y = await mkItem(c, 'Çakıl');
    await receipt(c, day(3, 1), main.id, x.id, '10', '10');
    await receipt(c, day(3, 1), main.id, y.id, '10', '20');
    const d1 = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(x.id, '2')] });
    const d2 = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [dline(y.id, '3')] });
    expect(d2.note.noteNo).toBe(`SIR-${thisYear}-000002`);

    const r = await invPosted(c, {
      type: 'sales', partyId: cust.id, invoiceDate: day(3, 10),
      lines: [invLine(x.id, '2', '30', d1.lines[0].id), invLine(y.id, '3', '50', d2.lines[0].id)],
    });
    expect(r.lines.map((l: any) => l.costValue)).toEqual(['20.0000', '60.0000']);
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('621')).toEqual([['621', 80, 0]]);
    expect(j.byCode('150')).toEqual([['150', 0, 80]]);

    // Faturalı irsaliye iptal edilemez
    const blocked = await c.post(`/api/delivery-notes/${d1.note.id}/cancel`, { reason: 'Hatalı', date: day(3, 11) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('DELIVERY_INVOICED');
    expect(blocked.json().error.message).toContain(r.invoice.invoiceNo);

    // Fatura iptal → irsaliyeler açık; yeniden faturalanır; sonra irsaliye iptal edilir ve stok geri gelir
    expect((await c.post(`/api/invoices/${r.invoice.id}/cancel`, { reason: 'Hatalı fiyat', date: day(3, 11) })).statusCode).toBe(200);
    expect((await getNote(c, d1.note.id)).note.invoicing).toBe('open');
    expect(await recon(c)).toMatchObject({ difference: '-80.0000', pendingDeliveries: { sales: '-80.0000' }, unexplained: '0.0000' });
    const again = await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 12), lines: [invLine(x.id, '2', '35', d1.lines[0].id)] });
    expect(again.lines[0].costValue).toBe('20.0000');
    expect((await c.post(`/api/invoices/${again.invoice.id}/cancel`, { reason: 'Vazgeçildi', date: day(3, 13) })).statusCode).toBe(200);

    const ok = await c.post(`/api/delivery-notes/${d1.note.id}/cancel`, { reason: 'Sevk edilmedi', date: day(3, 14) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().note).toMatchObject({ status: 'cancelled', cancelStockDocumentNo: expect.stringMatching(/^SH-/) });
    expect(await stockInfo(c, x.id)).toMatchObject({ qty: '10.0000', value: '100.0000' });
    expect(await recon(c)).toMatchObject({ pendingDeliveries: { sales: '-60.0000' }, unexplained: '0.0000' });
    // İptal edilen irsaliye bir daha faturalanamaz ve değiştirilemez
    const gone = await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 15), lines: [invLine(x.id, '1', '30', d1.lines[0].id)] });
    expect(gone.json().error.code).toBe('DELIVERY_NOT_POSTED_LINK');
    expect((await c.put(`/api/delivery-notes/${d1.note.id}`, { partyId: cust.id, noteDate: day(3, 5), lines: [dline(x.id, '1')] })).json().error.code).toBe('DELIVERY_NOT_DRAFT');
  });

  it('irsaliyeli satışın iadesi mal maliyetini irsaliye maliyetinden alır', async () => {
    const { c, main } = await setup('Iade');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Çimento');
    await receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '6')] });
    const sale = await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [invLine(item.id, '2', '100', dn.lines[0].id)] });
    expect(sale.lines[0].costValue).toBe('100.0000');

    const ret = await invPosted(c, {
      type: 'sales_return', partyId: cust.id, invoiceDate: day(3, 12), returnOfId: sale.invoice.id,
      lines: [{ itemId: item.id, description: 'İade', quantity: '1', unitPrice: '100', vatCode: 'KDV-16', sourceLineId: sale.lines[0].id }],
    });
    expect(ret.lines[0].costValue).toBe('50.0000'); // 100 × 1/2
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '5.0000', value: '250.0000' });
    // Satış fatura kaydı irsaliyeyi etkilemez; kalan faturalanabilir miktar değişmez
    expect((await getNote(c, dn.note.id)).lines[0]).toMatchObject({ invoicedQty: '2.0000', remainingQty: '4.0000' });
  });

  it('alış irsaliyesi: dış numara zorunlu ve tekil, stok girişi, yevmiye yok; aynı fiyatlı fatura stok hareketi yapmaz', async () => {
    const { c, main } = await setup('AlisIrs');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Demir');

    const body = { type: 'purchase', partyId: sup.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '10', { unitCost: '50' })] };
    // Taslak dış numarasız olur; kaydetme ister
    expect((await note(c, { ...body, post: true })).json().error.code).toBe('EXTERNAL_NO_REQUIRED');
    const dn = await posted(c, { ...body, externalNo: 'IRS-1' });
    expect(dn.note).toMatchObject({ status: 'posted', noteNo: `AIR-${thisYear}-000001`, externalNo: 'IRS-1' });
    expect(dn.lines[0]).toMatchObject({ stockValue: '500.0000', adjustValue: '0.0000', unitCost: '50.000000' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    expect(bal(await closing(c), '150')).toBe(0);
    expect(await recon(c)).toMatchObject({ difference: '500.0000', pendingDeliveries: { purchases: '500.0000', total: '500.0000' }, unexplained: '0.0000' });

    // Aynı tedarikçinin aynı irsaliyesi ikinci kez kaydedilemez; iptalden sonra yeniden girilebilir
    const dup = await note(c, { ...body, externalNo: 'IRS-1', post: true });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EXTERNAL_NO_TAKEN');
    const other = await mkParty(c, 'Başka tedarikçi', 'supplier');
    const otherNote = await note(c, { ...body, partyId: other.id, externalNo: 'IRS-1', post: true });
    expect(otherNote.statusCode).toBe(201); // aynı numara başka tedarikçide serbest
    expect((await c.post(`/api/delivery-notes/${otherNote.json().note.id}/cancel`, { reason: 'Deneme', date: day(3, 5) })).statusCode).toBe(200);

    const r = await invPosted(c, {
      type: 'purchase', partyId: sup.id, invoiceDate: day(3, 8), externalNo: 'F-1',
      lines: [invLine(item.id, '10', '50', dn.lines[0].id)],
    });
    expect(r.invoice).toMatchObject({ grossTotal: '580.0000', stockDocumentId: null, warehouseId: null });
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('150')).toEqual([['150', 500, 0]]);
    expect(j.byCode('191')).toEqual([['191', 80, 0]]);
    expect(j.byCode('320')).toEqual([['320', 0, 580]]);
    expect(j.byCode('621')).toEqual([]);
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });

    // Faturalı alış irsaliyesi iptal edilemez; fatura iptalinden sonra edilir
    expect((await c.post(`/api/delivery-notes/${dn.note.id}/cancel`, { reason: 'Yanlış', date: day(3, 9) })).json().error.code).toBe('DELIVERY_INVOICED');
    await c.post(`/api/invoices/${r.invoice.id}/cancel`, { reason: 'Yanlış', date: day(3, 9) });
    expect((await c.post(`/api/delivery-notes/${dn.note.id}/cancel`, { reason: 'Yanlış', date: day(3, 10) })).statusCode).toBe(200);
    const again = await note(c, { ...body, externalNo: 'IRS-1', post: true });
    expect(again.statusCode).toBe(201);
  });

  it('alış fiyat farkı: elde kalan miktar stok maliyetine gider (cost_adjust), yevmiyede 621 oluşmaz', async () => {
    const { c, main } = await setup('Fark');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Demir');
    const dn = await posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'IRS-9', noteDate: day(3, 1), warehouseId: main.id, lines: [dline(item.id, '10', { unitCost: '50' })] });

    const r = await invPosted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 5), externalNo: 'F-9', lines: [invLine(item.id, '10', '60', dn.lines[0].id)] });
    expect(r.invoice).toMatchObject({ grossTotal: '696.0000', stockDocumentNo: expect.stringMatching(/^SH-/), warehouseId: main.id });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '600.0000' });
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('150')).toEqual([['150', 600, 0]]);
    expect(j.byCode('621')).toEqual([]);
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });

    // Yalnızca maliyet düzeltmesi taşıyan stok belgesi okunabilir; ters belgeyle fatura iptali stoğu geri alır
    const doc = (await c.get(`/api/stock-documents/${r.invoice.stockDocumentId}`)).json();
    expect(doc.lines[0]).toMatchObject({ direction: 'adjust', qty: '0.0000', adjustment: '100.0000' });
    expect((await c.post(`/api/invoices/${r.invoice.id}/cancel`, { reason: 'Hatalı fiyat', date: day(3, 6) })).statusCode).toBe(200);
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    expect(await recon(c)).toMatchObject({ difference: '500.0000', pendingDeliveries: { purchases: '500.0000' }, unexplained: '0.0000' });
  });

  it('alış fiyat farkı: satılmış kısım 621e, elde kalan kısım stok maliyetine gider', async () => {
    const { c, main } = await setup('FarkSatilmis');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Demir');
    const dn = await posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'IRS-7', noteDate: day(3, 1), warehouseId: main.id, lines: [dline(item.id, '10', { unitCost: '50' })] });
    await issue(c, day(3, 10), main.id, item.id, '6'); // 300 sarf; 4 adet / 200 kaldı

    const r = await invPosted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 20), externalNo: 'F-7', lines: [invLine(item.id, '10', '60', dn.lines[0].id)] });
    // Fark 100: 4/10 stoğa (40), 6/10 satılan mal maliyetine (60)
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '4.0000', value: '240.0000' });
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('150')).toEqual([['150', 600, 0], ['150', 0, 60]]);
    expect(j.byCode('621')).toEqual([['621', 60, 0]]);
    const cl = await closing(c);
    expect(bal(cl, '150')).toBe(240); // −300 sarf + 600 − 60
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
  });

  it('eksi bakiyeyi kapatan alış irsaliyesi: irsaliyenin maliyet düzeltmesi faturada 621e aktarılır', async () => {
    const { c, main } = await setup('Eksi', { sector: 'RETAIL_MARKET' });
    const sup = await mkParty(c, 'Toptancı', 'supplier');
    const item = await mkItem(c, 'Süt');
    await receipt(c, day(3, 1), main.id, item.id, '5', '10');
    await issue(c, day(3, 2), main.id, item.id, '10'); // 5 adet eksiye düştü (stok −5, değer −50)
    const dn = await posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'IRS-N', noteDate: day(3, 3), warehouseId: main.id, lines: [dline(item.id, '10', { unitCost: '12' })] });
    expect(dn.lines[0]).toMatchObject({ stockValue: '120.0000', adjustValue: '-10.0000' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '5.0000', value: '60.0000' });
    expect(await recon(c)).toMatchObject({ difference: '110.0000', pendingDeliveries: { purchases: '110.0000' }, unexplained: '0.0000' });

    const r = await invPosted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 5), externalNo: 'F-N', lines: [invLine(item.id, '10', '12', dn.lines[0].id)] });
    expect(r.invoice.stockDocumentId).toBeNull(); // fiyat farkı yok: stok belgesi de yok
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('153')).toEqual([['153', 120, 0], ['153', 0, 10]]);
    expect(j.byCode('621')).toEqual([['621', 10, 0]]);
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
  });

  it('dövizli alış irsaliyesi ve faturası: fark defter para biriminde hesaplanır', async () => {
    const { c, main } = await setup('Doviz');
    const sup = await mkParty(c, 'Yabancı tedarikçi', 'supplier');
    const item = await mkItem(c, 'İthal parça');
    const dn = await posted(c, {
      type: 'purchase', partyId: sup.id, externalNo: 'EUR-1', noteDate: day(3, 1), warehouseId: main.id,
      lines: [dline(item.id, '10', { unitCost: '5', currency: 'EUR', fxRate: '40' })],
    });
    expect(dn.lines[0]).toMatchObject({ stockValue: '2000.0000', currencyCode: 'EUR', fxRate: '40.00000000' });
    const r = await invPosted(c, {
      type: 'purchase', partyId: sup.id, invoiceDate: day(3, 5), externalNo: 'EF-1', currency: 'EUR', fxRate: '41',
      lines: [invLine(item.id, '10', '5.5', dn.lines[0].id, { vatCode: null })],
    });
    expect(r.lines[0]).toMatchObject({ netBase: '2255.0000' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '2255.0000' }); // 255 fark stokta
    expect(await recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
  });

  it('bağ doğrulamaları: cari, tür, kart, kaydedilmemiş irsaliye ve geçersiz fatura türü', async () => {
    const { c, main } = await setup('Baglar');
    const cust = await mkParty(c, 'Müşteri');
    const other = await mkParty(c, 'Başka müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const x = await mkItem(c, 'Kum');
    const y = await mkItem(c, 'Çakıl');
    await receipt(c, day(3, 1), main.id, x.id, '10', '10');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(x.id, '2')] });
    const dl = dn.lines[0].id;
    const draftNote = (await note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(x.id, '1')] })).json();

    const code = async (body: Record<string, unknown>) => (await inv(c, body)).json().error?.code;
    expect(await code({ type: 'sales', partyId: other.id, invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', dl)] })).toBe('DELIVERY_PARTY_MISMATCH');
    expect(await code({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [invLine(y.id, '1', '10', dl)] })).toBe('DELIVERY_ITEM_MISMATCH');
    expect(await code({ type: 'purchase', partyId: sup.id, externalNo: 'Z-1', invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', dl)] })).toBe('DELIVERY_TYPE_MISMATCH');
    expect(await code({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', draftNote.lines[0].id)] })).toBe('DELIVERY_NOT_POSTED_LINK');
    expect(await code({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', randomUUID())] })).toBe('DELIVERY_LINE_NOT_FOUND');
    // Şema: yalnızca satış/alış faturasında; kart zorunlu; iade satırıyla birlikte olmaz
    expect(await code({ type: 'expense', partyId: sup.id, externalNo: 'Z-2', invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', dl)] })).toBe('VALIDATION_ERROR');
    expect(await code({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [{ description: 'Serbest', quantity: '1', unitPrice: '10', deliveryLineId: dl }] })).toBe('VALIDATION_ERROR');
    // Satırlar iki kez aynı irsaliye satırına bağlanabilir ama toplam aşılamaz (2 adet)
    expect(await code({ type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', dl), invLine(x.id, '2', '10', dl)] })).toBe('DELIVERY_QTY_EXCEEDED');
    expect((await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [invLine(x.id, '1', '10', dl), invLine(x.id, '1', '10', dl)] })).statusCode).toBe(201);
  });

  it('irsaliye doğrulamaları: hizmet kalemi, satışta maliyet, hedef cari türü, kapalı dönem, taslak yaşam döngüsü', async () => {
    const { c, main } = await setup('Dogrula');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const goods = await mkItem(c, 'Kum');
    const service = await mkItem(c, 'Nakliye', { kind: 'service' });
    await receipt(c, day(3, 1), main.id, goods.id, '5', '10');
    const base = { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id };
    const code = async (body: Record<string, unknown>) => (await note(c, body)).json().error?.code;

    expect(await code({ ...base, lines: [dline(service.id, '1')] })).toBe('ITEM_NOT_STOCKED');
    expect(await code({ ...base, lines: [dline(goods.id, '1', { unitCost: '5' })] })).toBe('VALIDATION_ERROR');
    expect(await code({ ...base, partyId: sup.id, lines: [dline(goods.id, '1')] })).toBe('PARTY_KIND_MISMATCH');
    expect(await code({ ...base, externalNo: 'X', lines: [dline(goods.id, '1')] })).toBe('VALIDATION_ERROR');
    expect(await code({ ...base, lines: [] })).toBe('VALIDATION_ERROR');
    // Yetersiz stok (negatif stok kapalı)
    expect(await code({ ...base, post: true, lines: [dline(goods.id, '6')] })).toBe('STOCK_INSUFFICIENT');
    // Tanımsız dönem
    expect(await code({ ...base, noteDate: `${thisYear - 5}-03-05`, post: true, lines: [dline(goods.id, '1')] })).toMatch(/PERIOD_/);

    // Taslak: düzenlenir, kaydedilir, silinir; numara kaydetmeyle gelir
    const draft = (await note(c, { ...base, lines: [dline(goods.id, '1')] })).json();
    expect(draft.note).toMatchObject({ status: 'draft', noteNo: null, invoicing: null });
    const edited = await c.put(`/api/delivery-notes/${draft.note.id}`, { partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [dline(goods.id, '2', { description: 'Özel açıklama' })] });
    expect(edited.json()).toMatchObject({ note: { noteDate: day(3, 6), status: 'draft' }, lines: [{ quantity: '2.0000', description: 'Özel açıklama' }] });
    const postedNote = await c.post(`/api/delivery-notes/${draft.note.id}/post`, {});
    expect(postedNote.json().note).toMatchObject({ status: 'posted', noteNo: `SIR-${thisYear}-000001` });
    expect((await c.post(`/api/delivery-notes/${draft.note.id}/post`, {})).json().error.code).toBe('DELIVERY_NOT_DRAFT');
    expect((await c.delete(`/api/delivery-notes/${draft.note.id}`)).json().error.code).toBe('DELIVERY_NOT_DRAFT');
    const other = (await note(c, { ...base, lines: [dline(goods.id, '1')] })).json();
    expect((await c.delete(`/api/delivery-notes/${other.note.id}`)).statusCode).toBe(200);
    expect((await c.get(`/api/delivery-notes/${other.note.id}`)).statusCode).toBe(404);
    // Numara boşluksuz: iptal edilen numara serinin parçası kalır
    expect((await c.post(`/api/delivery-notes/${draft.note.id}/cancel`, { reason: 'Vazgeçildi', date: day(3, 7) })).statusCode).toBe(200);
    expect((await posted(c, { ...base, lines: [dline(goods.id, '1')] })).note.noteNo).toBe(`SIR-${thisYear}-000002`);
    expect((await c.post(`/api/delivery-notes/${draft.note.id}/cancel`, { reason: 'Tekrar', date: day(3, 8) })).json().error.code).toBe('DELIVERY_ALREADY_CANCELLED');
  });

  it('irsaliyeden sonra stok hareketi varsa irsaliye iptal edilemez', async () => {
    const { c, main } = await setup('Sonra');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kum');
    await receipt(c, day(3, 1), main.id, item.id, '10', '10');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '2')] });
    await issue(c, day(3, 6), main.id, item.id, '1');
    const r = await c.post(`/api/delivery-notes/${dn.note.id}/cancel`, { reason: 'Hatalı', date: day(3, 7) });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('DELIVERY_CANCEL_BLOCKED');
  });

  it('liste, faturalama süzgeci, açık satırlar ve özet', async () => {
    const { c, main } = await setup('Liste');
    const ali = await mkParty(c, 'Çağlar Ticaret');
    const veli = await mkParty(c, 'Veli İnşaat');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Kum');
    await receipt(c, day(3, 1), main.id, item.id, '100', '10');
    const s1 = await posted(c, { type: 'sales', partyId: ali.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '10')] }); // 100
    const s2 = await posted(c, { type: 'sales', partyId: ali.id, noteDate: day(3, 6), warehouseId: main.id, lines: [dline(item.id, '20')] }); // 200
    await posted(c, { type: 'sales', partyId: veli.id, noteDate: day(3, 7), warehouseId: main.id, lines: [dline(item.id, '5')] }); // 50
    await posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'L-1', noteDate: day(3, 8), warehouseId: main.id, lines: [dline(item.id, '10', { unitCost: '12' })] }); // 120
    await note(c, { type: 'sales', partyId: ali.id, noteDate: day(3, 9), warehouseId: main.id, lines: [dline(item.id, '1')] }); // taslak
    await invPosted(c, { type: 'sales', partyId: ali.id, invoiceDate: day(3, 10), lines: [invLine(item.id, '10', '20', s1.lines[0].id)] }); // s1 tam
    await invPosted(c, { type: 'sales', partyId: ali.id, invoiceDate: day(3, 10), lines: [invLine(item.id, '5', '20', s2.lines[0].id)] }); // s2 kısmi

    const list = async (qs: string) => (await c.get(`/api/delivery-notes?${qs}`)).json().notes.map((n: any) => `${n.noteNo ?? 'taslak'}:${n.invoicing}`);
    expect((await list('type=sales')).length).toBe(4);
    expect(await list('type=purchase')).toEqual([`AIR-${thisYear}-000001:open`]);
    expect((await list('status=draft'))).toEqual(['taslak:null']);
    expect(await list('invoicing=invoiced')).toEqual([`SIR-${thisYear}-000001:invoiced`]);
    expect(await list('invoicing=partial')).toEqual([`SIR-${thisYear}-000002:partial`]);
    expect((await list('invoicing=open')).sort()).toEqual([`AIR-${thisYear}-000001:open`, `SIR-${thisYear}-000003:open`]);
    expect((await list(`partyId=${veli.id}`)).length).toBe(1);
    expect((await list('query=' + encodeURIComponent('ÇAĞLAR'))).length).toBe(3);
    expect(await list('query=L-1')).toEqual([`AIR-${thisYear}-000001:open`]);
    expect((await c.get('/api/delivery-notes?limit=1&offset=1')).json()).toMatchObject({ total: 5 });
    const s2Row = (await c.get('/api/delivery-notes?invoicing=partial')).json().notes[0];
    expect(s2Row).toMatchObject({ totalQty: '20.0000', invoicedQty: '5.0000', pendingValue: '150.0000' });

    const open = (await c.get(`/api/delivery-notes/open-lines?type=sales&partyId=${ali.id}`)).json().lines;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ lineId: s2.lines[0].id, noteNo: s2.note.noteNo, remainingQty: '15.0000', invoicedQty: '5.0000', itemCode: expect.any(String) });
    expect((await c.get(`/api/delivery-notes/open-lines?type=sales&partyId=${veli.id}`)).json().lines).toHaveLength(1);
    expect((await c.get(`/api/delivery-notes/open-lines?type=purchase&partyId=${sup.id}`)).json().lines[0]).toMatchObject({ unitCost: '12.000000', remainingQty: '10.0000' });

    const sum = (await c.get('/api/delivery-notes/summary')).json();
    expect(sum).toEqual({ sales: { openCount: 2, openValue: '200.0000' }, purchases: { openCount: 1, openValue: '120.0000' } });
    expect(await recon(c)).toMatchObject({ pendingDeliveries: { sales: '-200.0000', purchases: '120.0000', total: '-80.0000' }, unexplained: '0.0000' });
  });

  it('alış iadesinde bağlı satırın iade miktarı kaydetmede de denetlenir (paralel iki taslak fazla iade edemez)', async () => {
    const { c, main } = await setup('IadeSinir');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Demir');
    await receipt(c, day(3, 1), main.id, item.id, '20', '5');
    const buy = await invPosted(c, {
      type: 'purchase', partyId: sup.id, invoiceDate: day(3, 2), externalNo: 'A-1', warehouseId: main.id,
      lines: [{ itemId: item.id, description: 'Demir', quantity: '10', unitPrice: '50', vatCode: 'KDV-16' }],
    });
    const mk = async (no: string) =>
      (await inv(c, {
        type: 'purchase_return', partyId: sup.id, invoiceDate: day(3, 5), externalNo: no, returnOfId: buy.invoice.id, warehouseId: main.id,
        lines: [{ itemId: item.id, description: 'İade', quantity: '6', unitPrice: '50', vatCode: 'KDV-16', sourceLineId: buy.lines[0].id }],
      })).json().invoice;
    const d1 = await mk('R-1');
    const d2 = await mk('R-2'); // taslakta ikisi de tek başına geçerli
    expect((await c.post(`/api/invoices/${d1.id}/post`, {})).statusCode).toBe(200);
    const second = await c.post(`/api/invoices/${d2.id}/post`, {});
    expect(second.statusCode).toBe(422);
    expect(second.json().error.code).toBe('RETURN_QTY_EXCEEDED');
  });

  it('iptal edilen faturanın tedarikçi numarası yeniden girilebilir; kayıtlı olan girilemez', async () => {
    const { c } = await setup('DisNo');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const body = { type: 'expense', partyId: sup.id, invoiceDate: day(3, 5), externalNo: 'T-1', lines: [{ description: 'Gider', quantity: '1', unitPrice: '100' }] };
    const first = await invPosted(c, body);
    expect((await inv(c, { ...body, post: true })).json().error.code).toBe('EXTERNAL_NO_TAKEN');
    await c.post(`/api/invoices/${first.invoice.id}/cancel`, { reason: 'Hatalı tutar', date: day(3, 6) });
    expect((await inv(c, { ...body, post: true })).statusCode).toBe(201);
  });

  it('yetkiler: satış rolü taslak hazırlar ama işleyemez; şantiye sorumlusu mal kabul işler, faturaya erişemez; izleyici yalnızca okur', async () => {
    const { c, company, main } = await setup('Yetki');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Kum');
    await receipt(c, day(3, 1), main.id, item.id, '10', '10');

    const sales = await memberClient(c, company.id, 'sales');
    const sm = await memberClient(c, company.id, 'site_manager');
    const viewer = await memberClient(c, company.id, 'viewer');
    const acct = await memberClient(c, company.id, 'accountant');
    const body = { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '1')] };

    const draft = await sales.post('/api/delivery-notes', body);
    expect(draft.statusCode).toBe(201);
    expect((await sales.post('/api/delivery-notes', { ...body, post: true })).statusCode).toBe(403);
    expect((await sales.post(`/api/delivery-notes/${draft.json().note.id}/post`, {})).statusCode).toBe(403);
    expect((await sales.get('/api/delivery-notes')).statusCode).toBe(200);

    const receiving = await sm.post('/api/delivery-notes', { type: 'purchase', partyId: sup.id, externalNo: 'SM-1', noteDate: day(3, 6), warehouseId: main.id, lines: [dline(item.id, '4', { unitCost: '9' })], post: true });
    expect(receiving.statusCode).toBe(201);
    expect((await sm.get('/api/invoices')).statusCode).toBe(403);
    expect((await sm.post('/api/invoices', {})).statusCode).toBe(403);

    expect((await viewer.get('/api/delivery-notes')).statusCode).toBe(200);
    expect((await viewer.post('/api/delivery-notes', body)).statusCode).toBe(403);
    expect((await viewer.post(`/api/delivery-notes/${receiving.json().note.id}/cancel`, { reason: 'Deneme' })).statusCode).toBe(403);
    expect((await acct.post(`/api/delivery-notes/${receiving.json().note.id}/cancel`, { reason: 'Muhasebe iptali', date: day(3, 7) })).statusCode).toBe(200);
    expect((await sm.post(`/api/delivery-notes/${draft.json().note.id}/post`, {})).statusCode).toBe(200); // sevk de işler
  });

  it('DB kuralları: kaydedilmiş irsaliye ve satırları değiştirilemez; yalnızca mal kartı; satışta maliyet yok; faturalı irsaliye iptal edilemez', async () => {
    const { s, company, c, main, orgId } = await setup('DbKural');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kum');
    const service = await mkItem(c, 'Nakliye', { kind: 'service' });
    await receipt(c, day(3, 1), main.id, item.id, '10', '10');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '2')] });
    const draft = (await note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [dline(item.id, '1')] })).json();
    await invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 7), lines: [invLine(item.id, '1', '20', dn.lines[0].id)] });

    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      expect((await expectDbError(q, `update delivery_notes set description = 'x' where id = $1`, [dn.note.id])).code).toBe('ERP04');
      expect((await expectDbError(q, `delete from delivery_notes where id = $1`, [dn.note.id])).code).toBe('ERP04');
      expect((await expectDbError(q, `update delivery_note_lines set quantity = 9 where note_id = $1`, [dn.note.id])).code).toBe('ERP04');
      expect((await expectDbError(q, `delete from delivery_note_lines where note_id = $1`, [dn.note.id])).code).toBe('ERP04');
      // Faturalı irsaliye ham SQL ile de iptal edilemez
      expect(
        (await expectDbError(q, `update delivery_notes set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x', cancel_stock_document_id = stock_document_id where id = $1`, [dn.note.id])).code,
      ).toBe('ERP04');
      // Taslak: stok belgesi olmadan kaydedilemez; tür değişmez; iptal edilemez
      expect(
        (await expectDbError(q, `update delivery_notes set status = 'posted', note_no = 'X', posted_at = now(), stock_document_id = $2 where id = $1`, [draft.note.id, dn.note.stockDocumentId])).code,
      ).toBe('ERP04');
      expect((await expectDbError(q, `update delivery_notes set type = 'purchase' where id = $1`, [draft.note.id])).code).toBe('ERP04');
      expect((await expectDbError(q, `update delivery_notes set status = 'cancelled' where id = $1`, [draft.note.id])).code).toBe('ERP04');
      // Yalnızca stoklu mal kartı; satışta maliyet girilmez
      const ins = (withCost = false) =>
        `insert into delivery_note_lines (id, company_id, note_id, line_no, item_id, description, quantity${withCost ? ', unit_cost' : ''}) values (gen_random_uuid(), $1, $2, 9, $3, 'x', 1${withCost ? ', 5' : ''})`;
      expect((await expectDbError(q, ins(), [company.id, draft.note.id, service.id])).code).toBe('ERP04');
      expect((await expectDbError(q, ins(true), [company.id, draft.note.id, item.id])).code).toBe('ERP04');
      // Kaydedilmiş satırın stok değeri de değiştirilemez
      expect((await expectDbError(q, `update delivery_note_lines set stock_value = 1 where note_id = $1`, [dn.note.id])).code).toBe('ERP04');
    });
  });

  it('eşzamanlılık: aynı irsaliye satırını iki fatura aynı anda faturalayamaz; fatura ve iptal yarışında yalnızca biri kazanır', async () => {
    const { c, main } = await setup('Yaris');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kum');
    await receipt(c, day(3, 1), main.id, item.id, '10', '10');
    const dn = await posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [dline(item.id, '4')] });
    const dl = dn.lines[0].id;
    const mk = (d: number) => inv(c, { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, d), lines: [invLine(item.id, '4', '20', dl)] });

    const [a, b] = await Promise.all([mk(10), mk(11)]);
    // Tam olarak biri kazanır. Kaybeden ya kalan miktar denetimine (422) ya da veritabanının kilitlenme (deadlock)
    // seçimine (409 RETRY: işlem geri alındı, yeniden denenebilir) takılır; ikinci durumda yeniden denenince 422 alır.
    expect([a.statusCode, b.statusCode].filter((s) => s === 201)).toHaveLength(1);
    let loser = a.statusCode === 201 ? b : a;
    if (loser.statusCode === 409) {
      expect(loser.json().error.code).toBe('RETRY');
      loser = await mk(12);
    }
    expect(loser.statusCode).toBe(422);
    expect(loser.json().error.code).toBe('DELIVERY_QTY_EXCEEDED');
    expect((await getNote(c, dn.note.id)).lines[0]).toMatchObject({ invoicedQty: '4.0000', remainingQty: '0.0000' });

    // Fatura iptalinden sonra: yeni fatura ile irsaliye iptali yarışır
    const invoices = (await c.get('/api/invoices?side=sales')).json().invoices as { id: string; status: string }[];
    await c.post(`/api/invoices/${invoices.find((i) => i.status === 'posted')!.id}/cancel`, { reason: 'Yeniden', date: day(3, 12) });
    const [inv2, cancel] = await Promise.all([
      inv(c, { post: true, type: 'sales', partyId: cust.id, invoiceDate: day(3, 13), lines: [invLine(item.id, '4', '20', dl)] }),
      c.post(`/api/delivery-notes/${dn.note.id}/cancel`, { reason: 'Yarış', date: day(3, 13) }),
    ]);
    expect([inv2.statusCode === 201, cancel.statusCode === 200].filter(Boolean)).toHaveLength(1);
    const cur = (await getNote(c, dn.note.id)).note;
    expect(cur.status === 'cancelled' || cur.invoicing === 'invoiced').toBe(true);
    expect(await recon(c)).toMatchObject({ unexplained: '0.0000' });
  });
});
