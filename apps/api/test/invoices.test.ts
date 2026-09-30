import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PASSWORD, accountIds, asDb, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

describe('fatura', async () => {
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
  const receipt = (c: C, date: string, wh: string, itemId: string, qty: string, unitCost: string) =>
    c.post('/api/stock-documents', { type: 'receipt', docDate: date, warehouseId: wh, lines: [{ itemId, quantity: qty, unitCost }] });
  const putRate = (c: C, date: string, code: string, buy: string) =>
    c.put('/api/exchange-rates', { rateDate: date, currencyCode: code, quoteCode: 'TRY', buy });

  const line = (itemId: string | null, quantity: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({
    ...(itemId ? { itemId } : {}),
    description: extra.description ?? 'Kalem',
    quantity,
    unitPrice,
    vatCode: 'KDV-16',
    ...extra,
  });
  const inv = (c: C, body: Record<string, unknown>) => c.post('/api/invoices', body);
  const posted = async (c: C, body: Record<string, unknown>) => {
    const res = await inv(c, { post: true, ...body });
    if (res.statusCode !== 201) throw new Error(`invoice failed: ${res.body}`);
    return res.json() as { invoice: any; lines: any[]; warnings?: any };
  };

  /** Yevmiye satırları hesap koduna göre: [borç, alacak] (defter para birimi). */
  const journalOf = async (c: C, id: string) => {
    const e = (await c.get(`/api/journal-entries/${id}`)).json().entry;
    const lines = e.lines.map((l: any) => [l.accountCode, l.debitBase, l.creditBase] as const);
    return { entry: e, lines, byCode: (code: string) => e.lines.filter((l: any) => l.accountCode === code) };
  };
  const closing = async (c: C) => {
    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    return Object.fromEntries(tb.rows.map((r: any) => [r.code, r.closing])) as Record<string, string>;
  };
  const stockInfo = async (c: C, id: string) => (await c.get(`/api/items/${id}`)).json().stock as { qty: string; value: string };
  const recon = async (c: C, asOf = day(12, 31)) => (await c.get(`/api/reports/stock-status?asOf=${asOf}`)).json().ledger;

  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  it('satış faturası: numara, KDV, cari, gelir, maliyet ve stok tek işlemde; mutabakat 0', async () => {
    const { c, main } = await setup('Satis');
    const cust = await mkParty(c, 'Ali Yılmaz', 'customer', { paymentTermDays: 30 });
    const item = await mkItem(c, 'Çimento', { unit: 'cuval' });
    await receipt(c, day(3, 1), main.id, item.id, '10', '50'); // 500

    const r = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [line(item.id, '4', '100')] });
    expect(r.invoice).toMatchObject({
      status: 'posted', invoiceNo: `SF-${thisYear}-000001`, netTotal: '400.0000', vatTotal: '64.0000', grossTotal: '464.0000',
      grossTotalBase: '464.0000', currencyCode: 'TRY', dueDate: day(4, 9), stockDocumentNo: expect.stringMatching(/^SH-/),
    });
    expect(r.lines[0]).toMatchObject({ costValue: '200.0000', netBase: '400.0000', vatBase: '64.0000', unit: 'cuval' });

    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.entry).toMatchObject({ sourceType: 'invoice', sourceId: r.invoice.id, status: 'posted' });
    expect(j.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([
      ['120', 464, 0],
      ['600', 0, 400],
      ['391', 0, 64],
      ['621', 200, 0],
      ['150', 0, 200],
    ]);
    expect(j.byCode('120')[0]).toMatchObject({ partyId: cust.id, dueDate: day(4, 9) });

    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '6.0000', value: '300.0000' });
    expect((await c.get(`/api/parties/${cust.id}`)).json().summary.balance).toBe('464.0000');
    const doc = (await c.get(`/api/stock-documents/${r.invoice.stockDocumentId}`)).json().document;
    expect(doc).toMatchObject({ type: 'issue', sourceType: 'invoice', sourceId: r.invoice.id });
    expect(await recon(c)).toMatchObject({ stockValue: '300.0000', accountsBalance: '300.0000', difference: '0.0000' });

    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    expect(tb.totals.difference).toBe('0.0000');
    // İkinci fatura boşluksuz sıradaki numarayı alır
    const r2 = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 11), lines: [line(item.id, '1', '100')] });
    expect(r2.invoice.invoiceNo).toBe(`SF-${thisYear}-000002`);
  });

  it('taslak: numara/yevmiye/stok yok; düzenlenir, silinir, sonra kaydedilir; kaydedilmiş fatura düzenlenemez', async () => {
    const { c, main } = await setup('Taslak');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kalem');
    await receipt(c, day(3, 1), main.id, item.id, '10', '10');

    const created = await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [line(item.id, '2', '30')] });
    expect(created.statusCode).toBe(201);
    const d = created.json();
    expect(d.invoice).toMatchObject({ status: 'draft', invoiceNo: null, journalEntryId: null, stockDocumentId: null, grossTotal: '69.6000' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000' });

    const put = await c.put(`/api/invoices/${d.invoice.id}`, { partyId: cust.id, invoiceDate: day(3, 10), lines: [line(item.id, '3', '30', { discountPct: '10' })] });
    expect(put.statusCode).toBe(200);
    // 3 × 30 = 90, %10 iskonto → 81; KDV 12,96; brüt 93,96
    expect(put.json().invoice).toMatchObject({ netTotal: '81.0000', vatTotal: '12.9600', grossTotal: '93.9600' });

    expect((await c.delete(`/api/invoices/${d.invoice.id}`)).statusCode).toBe(200);
    expect((await c.get(`/api/invoices/${d.invoice.id}`)).statusCode).toBe(404);

    const d2 = (await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 12), lines: [line(item.id, '1', '30')] })).json();
    const p = await c.post(`/api/invoices/${d2.invoice.id}/post`);
    expect(p.statusCode).toBe(200);
    expect(p.json().invoice).toMatchObject({ status: 'posted', invoiceNo: `SF-${thisYear}-000001` });

    expect((await c.put(`/api/invoices/${d2.invoice.id}`, { partyId: cust.id, invoiceDate: day(3, 12), lines: [line(item.id, '1', '30')] })).json().error.code).toBe('INVOICE_NOT_DRAFT');
    expect((await c.delete(`/api/invoices/${d2.invoice.id}`)).json().error.code).toBe('INVOICE_NOT_DRAFT');
    expect((await c.post(`/api/invoices/${d2.invoice.id}/post`)).json().error.code).toBe('INVOICE_NOT_DRAFT');
  });

  it('alış faturası: stok girişi, KDV, tedarikçi no zorunlu ve tekil, vade cari koşulundan', async () => {
    const { c } = await setup('Alis');
    const sup = await mkParty(c, 'Demir Çelik A.Ş.', 'supplier', { paymentTermDays: 60 });
    const item = await mkItem(c, 'Demir', { unit: 'ton' });

    const body = { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 5), lines: [line(item.id, '10', '50')] };
    expect((await inv(c, { post: true, ...body })).json().error.code).toBe('EXTERNAL_NO_REQUIRED');

    const r = await posted(c, { ...body, externalNo: 'T-1001' });
    expect(r.invoice).toMatchObject({ invoiceNo: `AF-${thisYear}-000001`, netTotal: '500.0000', vatTotal: '80.0000', grossTotal: '580.0000', dueDate: day(5, 4) });
    expect(r.lines[0]).toMatchObject({ costValue: '500.0000' });
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([['320', 0, 580], ['150', 500, 0], ['191', 80, 0]]);
    expect(j.byCode('320')[0]).toMatchObject({ partyId: sup.id, dueDate: day(5, 4) });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    expect((await c.get(`/api/parties/${sup.id}`)).json().summary.balance).toBe('-580.0000');

    // Aynı tedarikçiden aynı numara ikinci kez işlenemez; başka tedarikçide olabilir
    const dup = await inv(c, { post: true, ...body, externalNo: 'T-1001' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EXTERNAL_NO_TAKEN');
    const other = await mkParty(c, 'Başka Tedarikçi', 'supplier');
    expect((await inv(c, { post: true, ...body, partyId: other.id, externalNo: 'T-1001' })).statusCode).toBe(201);
  });

  it('dövizli alış: kur faturada saklanır, cari satırı EUR, defter tutarları satır satır yuvarlanır ve denge bozulmaz', async () => {
    const { c } = await setup('Doviz');
    const sup = await mkParty(c, 'İthalatçı', 'supplier', { currencyCode: 'EUR' });
    const item = await mkItem(c, 'Seramik', { unit: 'm2' });
    await putRate(c, day(3, 1), 'EUR', '55.5');

    // 3 × 33,33 = 99,99 net; KDV 15,9984 → 16,00; brüt 115,99 EUR
    const r = await posted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 2), externalNo: 'E-1', lines: [line(item.id, '3', '33.33')] });
    expect(r.invoice).toMatchObject({ currencyCode: 'EUR', fxRate: '55.50000000', netTotal: '99.9900', vatTotal: '16.0000', grossTotal: '115.9900', netTotalBase: '5549.4500', vatTotalBase: '888.0000', grossTotalBase: '6437.4500' });
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.byCode('150')[0]).toMatchObject({ currencyCode: 'EUR', debit: '99.9900', debitBase: '5549.4500' });
    expect(j.byCode('320')[0]).toMatchObject({ currencyCode: 'EUR', credit: '115.9900', creditBase: '6437.4500' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '3.0000', value: '5549.4500' });
    const party = (await c.get(`/api/parties/${sup.id}`)).json().summary;
    expect(party).toMatchObject({ balance: '-6437.4500', byCurrency: [{ currency: 'EUR', balance: '-115.9900' }] });
    const movement = (await c.get(`/api/stock-documents/${r.invoice.stockDocumentId}`)).json().lines[0];
    expect(movement).toMatchObject({ currencyCode: 'EUR', fxRate: '55.50000000', unitCost: '33.330000' });

    // Kur yoksa (ve elle verilmemişse) kaydedilemez; elle kur çalışır
    const noRate = await inv(c, { post: true, type: 'purchase', partyId: sup.id, invoiceDate: day(6, 2), externalNo: 'E-2', currency: 'USD', lines: [line(item.id, '1', '10')] });
    expect(noRate.json().error.code).toBe('FX_RATE_MISSING');
    const manual = await inv(c, { post: true, type: 'purchase', partyId: sup.id, invoiceDate: day(6, 2), externalNo: 'E-2', currency: 'USD', fxRate: '48', lines: [line(item.id, '1', '10')] });
    expect(manual.statusCode).toBe(201);
    expect(manual.json().invoice).toMatchObject({ fxRate: '48.00000000', netTotalBase: '480.0000' });
    expect((await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json().totals.difference).toBe('0.0000');
  });

  it('gider faturası: stoksuz; satır hesabı ya da varsayılan gider; stoklu kart reddedilir', async () => {
    const { c, ids } = await setup('Gider');
    const sup = await mkParty(c, 'Kiralayan', 'supplier');
    const goods = await mkItem(c, 'Çimento');
    const service = await mkItem(c, 'Nakliye', { kind: 'service', unit: 'saat' });

    expect((await inv(c, { type: 'expense', partyId: sup.id, invoiceDate: day(4, 4), externalNo: 'G-0', lines: [line(goods.id, '1', '10')] })).json().error.code).toBe('EXPENSE_STOCK_ITEM');

    const r = await posted(c, {
      type: 'expense', partyId: sup.id, invoiceDate: day(4, 4), externalNo: 'G-1',
      lines: [line(null, '1', '1000', { description: 'Şantiye ofisi kirası', accountId: ids['770'] }), line(service.id, '2', '100', { description: 'Nakliye', vatCode: 'KDV-5' }), line(null, '1', '50', { description: 'Kırtasiye', vatCode: null })],
    });
    expect(r.invoice).toMatchObject({ invoiceNo: `GF-${thisYear}-000001`, netTotal: '1250.0000', vatTotal: '170.0000', grossTotal: '1420.0000', stockDocumentId: null });
    const j = await journalOf(c, r.invoice.journalEntryId);
    // 1000 → 770 (satır hesabı); nakliye 200 + kırtasiye 50 → varsayılan gider 632; KDV: %5 → 10, %16 → 160
    expect(j.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([
      ['320', 0, 1420], ['770', 1000, 0], ['632', 250, 0], ['191', 10, 0], ['191', 160, 0],
    ]);
    expect(j.byCode('191').map((l: any) => l.description)).toEqual(['KDV %5', 'KDV %16']);
  });

  it('KDV dahil fiyat: net ve KDV brüt tutardan türetilir', async () => {
    const { c } = await setup('KdvDahil');
    const cust = await mkParty(c, 'Müşteri');
    const r = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), vatIncluded: true, lines: [line(null, '1', '116', { description: 'Hizmet' })] });
    expect(r.invoice).toMatchObject({ vatIncluded: true, netTotal: '100.0000', vatTotal: '16.0000', grossTotal: '116.0000' });
    expect(r.lines[0]).toMatchObject({ net: '100.0000', vat: '16.0000', gross: '116.0000' });
  });

  it('satış iadesi: bağlı iade orijinal maliyetle girer, kalan miktar aşılamaz, son iade kuruş artığını kapatır', async () => {
    const { c, main } = await setup('Iade');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kalem');
    // 3 ad × 33,333333 = 100,00 (yuvarlanmış); tamamı satılınca maliyet 100,00
    expect((await receipt(c, day(3, 1), main.id, item.id, '3', '33.333333')).statusCode).toBe(201);
    const sale = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 2), lines: [line(item.id, '3', '60')] });
    expect(sale.lines[0]).toMatchObject({ costValue: '100.0000' });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '0.0000', value: '0.0000' });

    const ret = (n: number) =>
      inv(c, { post: true, type: 'sales_return', partyId: cust.id, returnOfId: sale.invoice.id, invoiceDate: day(3, 3 + n), lines: [line(item.id, '1', '60', { sourceLineId: sale.lines[0].id })] });
    const r1 = await ret(1);
    expect(r1.statusCode).toBe(201);
    const j1 = await journalOf(c, r1.json().invoice.journalEntryId);
    // Cari alacak, iade (610) ve KDV borç; stok maliyetle girer
    expect(j1.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([
      ['120', 0, 69.6], ['610', 60, 0], ['391', 9.6, 0], ['150', 33.33, 0], ['621', 0, 33.33],
    ]);
    expect(r1.json().invoice.invoiceNo).toBe(`SIF-${thisYear}-000001`);
    expect(r1.json().invoice.returnOfNo).toBe(sale.invoice.invoiceNo);
    expect((await ret(2)).json().lines[0].costValue).toBe('33.3300');
    const r3 = await ret(3);
    expect(r3.json().lines[0].costValue).toBe('33.3400'); // 100,00 − 33,33 − 33,33
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '3.0000', value: '100.0000' });

    const over = await ret(4);
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('RETURN_QTY_EXCEEDED');

    // Orijinal faturada iade edilen/kalan görünür; satış hesabına dokunulmadı, 610'a yazıldı
    const detail = (await c.get(`/api/invoices/${sale.invoice.id}`)).json();
    expect(detail.lines[0]).toMatchObject({ returnedQty: '3.0000', returnableQty: '0.0000' });
    expect(detail.returns).toHaveLength(3);
    const cl = await closing(c);
    expect(cl['610']).toBe('180.0000');
    expect(cl['621']).toBe('0.0000');
    expect(await recon(c)).toMatchObject({ difference: '0.0000' });

    // Kural: iade orijinal faturanın carisine kesilir, türü uyumlu olmalı
    const other = await mkParty(c, 'Başka müşteri');
    expect((await inv(c, { type: 'sales_return', partyId: other.id, returnOfId: sale.invoice.id, invoiceDate: day(4, 1), lines: [line(item.id, '1', '60')] })).json().error.code).toBe('RETURN_PARTY_MISMATCH');
    expect((await inv(c, { type: 'purchase_return', partyId: cust.id, returnOfId: sale.invoice.id, invoiceDate: day(4, 1), lines: [line(item.id, '1', '60')] })).statusCode).toBe(422);
  });

  it('alış iadesi: stok ortalama maliyetle çıkar, iade tutarı farkı satılan mal maliyetine gider', async () => {
    const { c } = await setup('AlisIade');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Kalem');
    const buy = await posted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 1), externalNo: 'A-1', lines: [line(item.id, '10', '50')] });

    // 2 ad iade, birim fiyat 60: net 120, KDV 19,20, brüt 139,20; stoktan 2 × 50 = 100 çıkar
    const r = await posted(c, { type: 'purchase_return', partyId: sup.id, returnOfId: buy.invoice.id, invoiceDate: day(3, 5), externalNo: 'AI-1', lines: [line(item.id, '2', '60', { sourceLineId: buy.lines[0].id })] });
    expect(r.invoice.invoiceNo).toBe(`AIF-${thisYear}-000001`);
    const j = await journalOf(c, r.invoice.journalEntryId);
    expect(j.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([
      ['320', 139.2, 0], ['191', 0, 19.2], ['150', 0, 100], ['621', 0, 20],
    ]);
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '8.0000', value: '400.0000' });
    expect((await c.get(`/api/parties/${sup.id}`)).json().summary.balance).toBe('-440.8000'); // 580 alacak − 139,20 borç
    expect(await recon(c)).toMatchObject({ difference: '0.0000' });

    // Alınandan fazla iade edilemez
    const over = await inv(c, { type: 'purchase_return', partyId: sup.id, returnOfId: buy.invoice.id, invoiceDate: day(3, 6), externalNo: 'AI-2', lines: [line(item.id, '9', '50', { sourceLineId: buy.lines[0].id })] });
    expect(over.json().error.code).toBe('RETURN_QTY_EXCEEDED');
  });

  it('iptal: ters kayıt (stok ve yevmiye), numara kalır; sonradan hareket ya da iade varsa engellenir; sondan başa iptal edilir', async () => {
    const { c, main } = await setup('Iptal');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kalem');
    await receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const a = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 2), lines: [line(item.id, '4', '100')] });
    const b = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 3), lines: [line(item.id, '2', '100')] });

    // A'dan sonra B ile aynı üründe hareket var → A iptal edilemez
    const blocked = await c.post(`/api/invoices/${a.invoice.id}/cancel`, { reason: 'Hatalı fatura', date: day(3, 10) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('INVOICE_CANCEL_BLOCKED');
    expect((await c.post(`/api/invoices/${a.invoice.id}/cancel`, {})).statusCode).toBe(400); // neden zorunlu

    const cancelB = await c.post(`/api/invoices/${b.invoice.id}/cancel`, { reason: 'Müşteri vazgeçti', date: day(3, 10) });
    expect(cancelB.statusCode).toBe(200);
    expect(cancelB.json().invoice).toMatchObject({ status: 'cancelled', cancelReason: 'Müşteri vazgeçti', invoiceNo: `SF-${thisYear}-000002` });
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '6.0000', value: '300.0000' });
    const rj = await journalOf(c, cancelB.json().invoice.cancelJournalEntryId);
    expect(rj.entry).toMatchObject({ sourceType: 'invoice', sourceId: b.invoice.id, reversalOfId: b.invoice.journalEntryId });

    // B (ve ters çifti) sonradan hareket sayılmaz: A artık iptal edilebilir
    const cancelA = await c.post(`/api/invoices/${a.invoice.id}/cancel`, { reason: 'Hatalı fatura', date: day(3, 10) });
    expect(cancelA.statusCode).toBe(200);
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    const cl = await closing(c);
    expect(['120', '600', '391', '621'].map((k) => cl[k])).toEqual(['0.0000', '0.0000', '0.0000', '0.0000']);
    expect((await c.get(`/api/parties/${cust.id}`)).json().summary.balance).toBe('0.0000');
    expect((await c.post(`/api/invoices/${a.invoice.id}/cancel`, { reason: 'Tekrar' })).json().error.code).toBe('INVOICE_ALREADY_CANCELLED');

    // İptal edilen numaralar serinin parçası kalır; yeni fatura sıradaki numarayı alır
    const next = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 12), lines: [line(item.id, '1', '100')] });
    expect(next.invoice.invoiceNo).toBe(`SF-${thisYear}-000003`);

    // İadesi olan fatura iptal edilemez; önce iade iptal edilir
    const ret = await posted(c, { type: 'sales_return', partyId: cust.id, returnOfId: next.invoice.id, invoiceDate: day(3, 13), lines: [line(item.id, '1', '100', { sourceLineId: next.lines[0].id })] });
    expect((await c.post(`/api/invoices/${next.invoice.id}/cancel`, { reason: 'Deneme' })).json().error.code).toBe('INVOICE_HAS_RETURNS');
    expect((await c.post(`/api/invoices/${ret.invoice.id}/cancel`, { reason: 'İade hatalı', date: day(3, 14) })).statusCode).toBe(200);
    expect((await c.post(`/api/invoices/${next.invoice.id}/cancel`, { reason: 'Deneme', date: day(3, 15) })).statusCode).toBe(200);
    expect(await recon(c)).toMatchObject({ difference: '0.0000' });
  });

  it('kaynak koruması: faturadan doğan yevmiye ve stok belgesi tek başına ters çevrilemez', async () => {
    const { c, main } = await setup('Kaynak');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kalem');
    await receipt(c, day(3, 1), main.id, item.id, '5', '10');
    const r = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 2), lines: [line(item.id, '1', '20')] });

    const je = await c.post(`/api/journal-entries/${r.invoice.journalEntryId}/reverse`, {});
    expect(je.statusCode).toBe(422);
    expect(je.json().error.code).toBe('ENTRY_HAS_SOURCE');
    const sd = await c.post(`/api/stock-documents/${r.invoice.stockDocumentId}/reverse`, {});
    expect(sd.statusCode).toBe(422);
    expect(sd.json().error.code).toBe('STOCK_DOC_HAS_SOURCE');
    const list = (await c.get('/api/journal-entries')).json().entries;
    expect(list.filter((e: any) => e.sourceType === 'invoice')).toHaveLength(1);
  });

  it('elle girilen stok belgeleri otomatik yevmiye üretir; transferde fiş yok; ters belge yevmiyeyi de ters çevirir; mutabakat 0', async () => {
    const { c, main } = await setup('StokFis');
    const site = (await c.post('/api/warehouses', { name: 'Şantiye' })).json().warehouse;
    const item = await mkItem(c, 'Demir');
    const doc = (type: string, date: string, wh: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
      c.post('/api/stock-documents', { type, docDate: date, warehouseId: wh, lines, ...extra });
    const entries = async () => (await c.get('/api/journal-entries?limit=200')).json().entries as any[];

    expect((await doc('opening', day(2, 1), main.id, [{ itemId: item.id, quantity: '10', unitCost: '20' }])).statusCode).toBe(201); // 200
    expect((await doc('receipt', day(2, 2), main.id, [{ itemId: item.id, quantity: '5', unitCost: '10' }])).statusCode).toBe(201); // 50
    const issue = await doc('issue', day(2, 3), main.id, [{ itemId: item.id, quantity: '3' }]); // 250/15 × 3 = 50
    expect(issue.statusCode).toBe(201);
    expect((await doc('waste', day(2, 4), main.id, [{ itemId: item.id, quantity: '3' }])).statusCode).toBe(201); // 200/12 × 3 = 50
    const before = (await entries()).length;
    expect((await doc('transfer', day(2, 5), main.id, [{ itemId: item.id, quantity: '2' }], { toWarehouseId: site.id })).statusCode).toBe(201);
    expect((await entries()).length).toBe(before); // transferde stok hesabı değişmez, fiş yok

    // Sayım: ana depoda sistem 7 (9 − 2), sayılan 8 → fazla 1 (referans maliyet 150/9 → 16,67)
    const count = (await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(2, 6), prefill: 'empty' })).json();
    await c.put(`/api/stock-counts/${count.count.id}`, { lines: [{ itemId: item.id, countedQty: '8' }] });
    expect((await c.post(`/api/stock-counts/${count.count.id}/post`)).statusCode).toBe(200);

    const cl = await closing(c);
    // 150: 200 + 50 − 50 − 50 + 16,67 = 166,67; karşılıklar: 500 (devir) alacak, 649 (giriş+sayım fazlası) alacak, 710 ve 659 borç
    expect(cl['150']).toBe('166.6700');
    expect(cl['500']).toBe('-200.0000');
    expect(cl['649']).toBe('-66.6700');
    expect(cl['710']).toBe('50.0000');
    expect(cl['659']).toBe('50.0000');
    expect(await recon(c)).toMatchObject({ stockValue: '166.6700', accountsBalance: '166.6700', difference: '0.0000' });

    // Sonradan hareket görmüş belge ters çevrilemez (tam geri alma güvencesi); fişleri de bu yüzden tutarlı kalır
    const rev = await c.post(`/api/stock-documents/${issue.json().document.id}/reverse`, { docDate: day(2, 7) });
    expect(rev.json().error.code).toBe('STOCK_DOC_HAS_LATER_MOVEMENTS');
    expect(await recon(c)).toMatchObject({ difference: '0.0000' });
  });

  it('ters stok belgesi: yevmiyesi ters çevrilir ve kaynağa bağlanır', async () => {
    const { c, main } = await setup('TersFis');
    const item = await mkItem(c, 'Kalem');
    const r = await receipt(c, day(3, 1), main.id, item.id, '5', '10');
    expect(r.statusCode).toBe(201);
    const rev = await c.post(`/api/stock-documents/${r.json().document.id}/reverse`, { docDate: day(3, 2) });
    expect(rev.statusCode).toBeLessThan(300);
    const entries = (await c.get('/api/journal-entries')).json().entries as any[];
    const stockEntries = entries.filter((e) => e.sourceType === 'stock_document');
    expect(stockEntries).toHaveLength(2);
    expect(stockEntries.filter((e) => e.reversalOfId)).toHaveLength(1);
    const cl = await closing(c);
    expect(cl['150']).toBe('0.0000');
    expect(cl['649']).toBe('0.0000');
  });

  it('perakende: eksi stokla satış, sonra gelen alış maliyet düzeltmesini satılan mal maliyetine yazar', async () => {
    const { c } = await setup('Perakende', { sector: 'RETAIL_MARKET' });
    const cust = await mkParty(c, 'Peşin müşteri');
    const sup = await mkParty(c, 'Toptancı', 'supplier');
    const item = await mkItem(c, 'Süt');
    const cl0 = await c.get('/api/account-mappings');
    expect(cl0.json().mappings.find((m: any) => m.key === 'stock').accountCode).toBe('153'); // ticari mal

    // Stok yokken 5 adet satılır: maliyet henüz bilinmiyor (0)
    const sale = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), lines: [line(item.id, '5', '20')] });
    expect(sale.lines[0].costValue).toBe('0.0000');
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '-5.0000', value: '0.0000' });

    // 10 ad 12 TL'den alınır: 5'i açığı kapatır → 60 TL maliyet düzeltmesi 621'e gider
    const buy = await posted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 5), externalNo: 'P-1', lines: [line(item.id, '10', '12')] });
    const j = await journalOf(c, buy.invoice.journalEntryId);
    expect(j.lines.map(([code, d, cr]: readonly string[]) => [code, Number(d), Number(cr)])).toEqual([
      ['320', 0, 139.2], ['153', 120, 0], ['191', 19.2, 0], ['621', 60, 0], ['153', 0, 60],
    ]);
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '5.0000', value: '60.0000' });
    const cl = await closing(c);
    expect(cl['153']).toBe('60.0000');
    expect(cl['621']).toBe('60.0000');
    expect(await recon(c)).toMatchObject({ stockValue: '60.0000', accountsBalance: '60.0000', difference: '0.0000' });
  });

  it('hesap eşlemesi: varsayılanlar, doğrulama, değişiklik faturaya yansır, eksik eşleme açık hata verir', async () => {
    const { company, c, ids, main } = await setup('Esleme');
    const list = (await c.get('/api/account-mappings')).json().mappings as any[];
    expect(list).toHaveLength(15);
    expect(list.every((m) => m.accountId)).toBe(true);
    expect(Object.fromEntries(list.map((m) => [m.key, m.accountCode]))).toMatchObject({
      receivable: '120', payable: '320', sales_revenue: '600', sales_return: '610', cogs: '621', stock: '150',
      vat_output: '391', vat_input: '191', default_expense: '632', stock_gain: '649', stock_loss: '659', consumption: '710', opening_offset: '500',
      fx_gain: '646', fx_loss: '656',
    });

    const put = (mappings: Record<string, string>) => c.put('/api/account-mappings', { mappings });
    expect((await put({ receivable: ids['600']! })).json().error.code).toBe('MAPPING_CONTROL_MISMATCH'); // cari kontrol hesabı olmalı
    expect((await put({ payable: ids['120']! })).json().error.code).toBe('MAPPING_CONTROL_MISMATCH'); // müşteri hesabı tedarikçiye olmaz
    expect((await put({ sales_revenue: ids['120']! })).json().error.code).toBe('MAPPING_CONTROL_MISMATCH'); // cari hesap gelire seçilemez
    expect((await put({ stock: ids['15']! })).json().error.code).toBe('ACCOUNT_NOT_POSTABLE');
    expect((await c.put('/api/account-mappings', { mappings: { bilinmeyen: ids['150'] } })).statusCode).toBe(400);

    // Stok hesabı 153'e alınınca alış oraya yazılır
    expect((await put({ stock: ids['153']! })).statusCode).toBe(200);
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Kalem');
    const buy = await posted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 1), externalNo: 'M-1', lines: [line(item.id, '1', '100')] });
    expect((await journalOf(c, buy.invoice.journalEntryId)).byCode('153')).toHaveLength(1);

    // Eşleme silinirse (ham SQL, kalıcı) ne fatura ne elle stok girişi yazılabilir; mesaj eksik eşlemeyi söyler
    const owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test' });
    await owner.connect();
    try {
      await owner.query(`delete from account_mappings where company_id = $1 and key in ('vat_input', 'stock_gain')`, [company.id]);
    } finally {
      await owner.end();
    }
    const missing = await inv(c, { post: true, type: 'purchase', partyId: sup.id, invoiceDate: day(3, 2), externalNo: 'M-2', lines: [line(item.id, '1', '100')] });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toMatchObject({ code: 'ACCOUNT_MAPPING_MISSING' });
    expect(missing.json().error.message).toContain('İndirilecek KDV');
    const manual = await receipt(c, day(3, 2), main.id, item.id, '1', '10');
    expect(manual.json().error.code).toBe('ACCOUNT_MAPPING_MISSING');
    expect(manual.json().error.message).toContain('Stok fazlası geliri');
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '1.0000' }); // başarısız belge geri alındı
  });

  it('doğrulamalar: cari türü, KDV kodu, hesap ezmesi, sıfır tutar, kapalı ve tanımsız dönem, pasif kart', async () => {
    const { c, ids } = await setup('Dogrula');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const item = await mkItem(c, 'Kalem');
    const base = { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), lines: [line(null, '1', '10')] };

    expect((await inv(c, { ...base, partyId: sup.id })).json().error.code).toBe('PARTY_KIND_MISMATCH');
    expect((await inv(c, { ...base, lines: [line(null, '1', '10', { vatCode: 'KDV-99' })] })).json().error.code).toBe('VAT_CODE_INVALID');
    expect((await inv(c, { ...base, lines: [line(null, '1', '10', { accountId: ids['120'] })] })).json().error.code).toBe('ACCOUNT_NOT_ALLOWED'); // cari hesabı
    expect((await inv(c, { ...base, lines: [line(null, '1', '10', { accountId: ids['60'] })] })).json().error.code).toBe('ACCOUNT_NOT_ALLOWED'); // grup hesabı
    expect((await inv(c, { ...base, partyId: '0198f2c4-7b1a-7000-8000-000000000001' })).json().error.code).toBe('PARTY_NOT_FOUND');
    expect((await inv(c, { ...base, lines: [] })).statusCode).toBe(400);
    expect((await inv(c, { ...base, dueDate: day(3, 1) })).statusCode).toBe(400);
    expect((await inv(c, { ...base, lines: [line(null, '0', '10')] })).statusCode).toBe(400);

    const zero = await inv(c, { ...base, post: true, lines: [line(null, '1', '0')] });
    expect(zero.json().error.code).toBe('INVOICE_TOTAL_ZERO');

    // Pasif kart
    await c.patch(`/api/items/${item.id}`, { isActive: false });
    expect((await inv(c, { ...base, lines: [line(item.id, '1', '10')] })).json().error.code).toBe('ITEM_INACTIVE');

    // Dönem kapalı / tanımsız
    const march = (await c.get(`/api/periods?year=${thisYear}`)).json().periods.find((p: any) => p.month === 3);
    await c.post(`/api/periods/${march.id}/close`);
    expect((await inv(c, { ...base, post: true })).json().error.code).toBe('PERIOD_CLOSED');
    expect((await inv(c, { ...base, invoiceDate: day(6, 1, thisYear + 5), post: true })).json().error.code).toBe('PERIOD_MISSING');
    // Taslak kapalı döneme de yazılabilir (yalnızca kayıt anında denetlenir)
    expect((await inv(c, base)).statusCode).toBe(201);
  });

  it('yetkiler: satış taslak hazırlar ama kaydedemez; muhasebeci kaydeder; izleyici okur; şantiye sorumlusu göremez', async () => {
    const { c, company } = await setup('Yetki');
    const cust = await mkParty(c, 'Müşteri');
    const sales = await memberClient(c, company.id, 'sales');
    const acc = await memberClient(c, company.id, 'accountant');
    const viewer = await memberClient(c, company.id, 'viewer');
    const site = await memberClient(c, company.id, 'site_manager');
    const body = { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), lines: [line(null, '1', '10')] };

    const draft = await inv(sales, body);
    expect(draft.statusCode).toBe(201);
    const id = draft.json().invoice.id;
    expect((await inv(sales, { ...body, post: true })).statusCode).toBe(403);
    expect((await sales.post(`/api/invoices/${id}/post`)).statusCode).toBe(403);
    expect((await sales.post(`/api/invoices/${id}/cancel`, { reason: 'Deneme' })).statusCode).toBe(403);
    expect((await acc.post(`/api/invoices/${id}/post`)).statusCode).toBe(200);

    expect((await viewer.get('/api/invoices')).statusCode).toBe(200);
    expect((await viewer.get(`/api/invoices/${id}`)).statusCode).toBe(200);
    expect((await inv(viewer, body)).statusCode).toBe(403);
    expect((await viewer.get('/api/reports/vat-summary?from=2026-01-01&to=2026-12-31')).statusCode).toBe(200);
    expect((await site.get('/api/invoices')).statusCode).toBe(403);
    expect((await viewer.put('/api/account-mappings', { mappings: {} })).statusCode).toBe(403);
  });

  it('yalıtım: başka şirketin cari/kartı faturada kullanılamaz, faturası okunamaz', async () => {
    const a = await setup('IzoleA');
    const b = await setup('IzoleB');
    const partyB = await mkParty(b.c, 'B müşterisi');
    const itemB = await mkItem(b.c, 'B kalemi');
    const partyA = await mkParty(a.c, 'A müşterisi');

    expect((await inv(a.c, { type: 'sales', partyId: partyB.id, invoiceDate: day(3, 1), lines: [line(null, '1', '10')] })).json().error.code).toBe('PARTY_NOT_FOUND');
    expect((await inv(a.c, { type: 'sales', partyId: partyA.id, invoiceDate: day(3, 1), lines: [line(itemB.id, '1', '10')] })).json().error.code).toBe('ITEM_NOT_FOUND');

    const mine = await posted(b.c, { type: 'sales', partyId: partyB.id, invoiceDate: day(3, 1), lines: [line(null, '1', '10')] });
    expect((await a.c.get(`/api/invoices/${mine.invoice.id}`)).statusCode).toBe(404);
    expect((await a.c.get('/api/invoices')).json().total).toBe(0);
  });

  it('eşzamanlılık: aynı stoğu satan iki fatura → yalnızca biri kaydedilir; aynı taslak iki kez kaydedilemez', async () => {
    const { c, main } = await setup('Es');
    const cust = await mkParty(c, 'Müşteri');
    const item = await mkItem(c, 'Kalem');
    await receipt(c, day(3, 1), main.id, item.id, '6', '10');
    const draft = async (qty: string) =>
      (await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), lines: [line(item.id, qty, '20')] })).json().invoice.id as string;
    const [d1, d2] = [await draft('4'), await draft('4')];
    const results = await Promise.all([c.post(`/api/invoices/${d1}/post`), c.post(`/api/invoices/${d2}/post`)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.statusCode === 422)!.json().error.code).toBe('STOCK_INSUFFICIENT');
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '2.0000' });

    const d3 = await draft('1');
    const twice = await Promise.all([c.post(`/api/invoices/${d3}/post`), c.post(`/api/invoices/${d3}/post`)]);
    expect(twice.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    expect(twice.find((r) => r.statusCode === 422)!.json().error.code).toBe('INVOICE_NOT_DRAFT');
    expect(await stockInfo(c, item.id)).toMatchObject({ qty: '1.0000' });
    // Numaralar boşluksuz: başarısız kayıt numara tüketmedi
    const nos = (await c.get('/api/invoices?status=posted')).json().invoices.map((i: any) => i.invoiceNo).sort();
    expect(nos).toEqual([`SF-${thisYear}-000001`, `SF-${thisYear}-000002`]);
  });

  it('kredi limiti aşılırsa kayıt engellenmez, uyarı döner', async () => {
    const { c } = await setup('Limit');
    const cust = await mkParty(c, 'Limitli müşteri', 'customer', { creditLimit: '100' });
    const r = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), lines: [line(null, '1', '200', { description: 'Hizmet' })] });
    expect(r.warnings.creditLimit).toEqual({ limit: '100.0000', balance: '232.0000' });
    const small = await mkParty(c, 'Rahat müşteri', 'customer', { creditLimit: '10000' });
    expect((await posted(c, { type: 'sales', partyId: small.id, invoiceDate: day(3, 5), lines: [line(null, '1', '200')] })).warnings.creditLimit).toBeNull();
  });

  it('liste ve özet: tür/durum/cari/metin süzgeci, sayfalama, ay özeti', async () => {
    const { c } = await setup('Liste');
    const ali = await mkParty(c, 'Çağlar Ticaret', 'customer');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    const today = new Date().toISOString().slice(0, 10);
    await posted(c, { type: 'sales', partyId: ali.id, invoiceDate: today, lines: [line(null, '1', '100')] });
    await posted(c, { type: 'expense', partyId: sup.id, invoiceDate: today, externalNo: 'X-9', lines: [line(null, '1', '40')] });
    await inv(c, { type: 'sales', partyId: ali.id, invoiceDate: today, lines: [line(null, '1', '10')] }); // taslak

    const ids = async (qs: string) => (await c.get(`/api/invoices?${qs}`)).json().invoices.map((i: any) => i.type + ':' + i.status);
    expect((await ids('side=sales')).sort()).toEqual(['sales:draft', 'sales:posted']);
    expect(await ids('side=purchases')).toEqual(['expense:posted']);
    expect(await ids('status=draft')).toEqual(['sales:draft']);
    expect(await ids('type=expense')).toEqual(['expense:posted']);
    expect(await ids(`partyId=${sup.id}`)).toEqual(['expense:posted']);
    expect((await ids('query=' + encodeURIComponent('ÇAĞLAR'))).length).toBe(2);
    expect(await ids('query=X-9')).toEqual(['expense:posted']);
    expect((await c.get('/api/invoices?limit=1&offset=1')).json()).toMatchObject({ total: 3 });

    const s = (await c.get('/api/invoices/summary')).json();
    expect(s).toMatchObject({ salesNet: '100.0000', purchasesNet: '40.0000', draftCount: 1 });
  });

  it('KDV özeti: oran bazında hesaplanan/indirilecek, iadeler düşer, iptaller hariç, doğrulanmamış kod bildirilir', async () => {
    const { c } = await setup('Kdv');
    const cust = await mkParty(c, 'Müşteri');
    const sup = await mkParty(c, 'Tedarikçi', 'supplier');
    await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 1), lines: [line(null, '1', '400'), line(null, '1', '100', { vatCode: 'KDV-5' })] });
    await posted(c, { type: 'expense', partyId: sup.id, invoiceDate: day(3, 2), externalNo: 'K-1', lines: [line(null, '1', '200')] });
    await posted(c, { type: 'sales_return', partyId: cust.id, invoiceDate: day(3, 3), lines: [line(null, '1', '100')] });
    const gone = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 4), lines: [line(null, '1', '999')] });
    await c.post(`/api/invoices/${gone.invoice.id}/cancel`, { reason: 'Hatalı', date: day(3, 5) });
    await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(5, 1), lines: [line(null, '1', '50')] }); // aralık dışı

    const r = (await c.get(`/api/reports/vat-summary?from=${day(3, 1)}&to=${day(3, 31)}`)).json();
    expect(r.rows).toEqual([
      { code: 'KDV-5', rate: '5.0000', salesNet: '100.0000', salesVat: '5.0000', purchaseNet: '0.0000', purchaseVat: '0.0000' },
      { code: 'KDV-16', rate: '16.0000', salesNet: '300.0000', salesVat: '48.0000', purchaseNet: '200.0000', purchaseVat: '32.0000' },
    ]);
    expect(r.totals).toEqual({ salesNet: '400.0000', salesVat: '53.0000', purchaseNet: '200.0000', purchaseVat: '32.0000', payable: '21.0000' });
    expect(r.unverifiedCodes).toEqual(['KDV-16', 'KDV-5']);
    // Defterle tutarlı: 391 = Mart 53 + Mayıs 8 (iptal edilen faturanın net etkisi 0); 191 = 32
    const cl = await closing(c);
    expect(cl['391']).toBe('-61.0000');
    expect(cl['191']).toBe('32.0000');
  });

  it('DB kuralları: kaydedilmiş fatura ve satırları değiştirilemez/silinemez; yevmiyesiz kaydetme reddedilir', async () => {
    const { s, company, c, orgId } = await setup('DbKural');
    const cust = await mkParty(c, 'Müşteri');
    const r = await posted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 5), lines: [line(null, '1', '10')] });
    const draft = (await inv(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 6), lines: [line(null, '1', '10')] })).json().invoice;

    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      expect((await expectDbError(q, `update invoices set description = 'x' where id = $1`, [r.invoice.id])).code).toBe('ERP03');
      expect((await expectDbError(q, `delete from invoices where id = $1`, [r.invoice.id])).code).toBe('ERP03');
      expect((await expectDbError(q, `update invoice_lines set description = 'x' where invoice_id = $1`, [r.invoice.id])).code).toBe('ERP03');
      expect((await expectDbError(q, `delete from invoice_lines where invoice_id = $1`, [r.invoice.id])).code).toBe('ERP03');
      // Taslak, yevmiyesi olmadan "kaydedildi" yapılamaz
      const e = await expectDbError(
        q,
        `update invoices set status = 'posted', invoice_no = 'X-1', posted_at = now(), fx_rate = 1, gross_total_base = gross_total where id = $1`,
        [draft.id],
      );
      expect(e.code).toBe('ERP03');
      // Tür değiştirilemez
      expect((await expectDbError(q, `update invoices set type = 'purchase' where id = $1`, [draft.id])).code).toBe('ERP03');
    });
    // API'de yalnızca iptal alanlarıyla ilerler
    expect((await c.post(`/api/invoices/${r.invoice.id}/cancel`, { reason: 'Deneme', date: day(3, 6) })).statusCode).toBe(200);
  });
});
