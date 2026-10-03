import { describe, expect, it } from 'vitest';
import { asDb, asOwner, day, expectDbError, makeApp } from './helpers';
import { x2Kit } from './x2-helpers';

describe('seri no takibi (X3)', async () => {
  const { app, handle } = await makeApp();
  const k = x2Kit(app);

  async function base(name: string) {
    const ctx = await k.setup(name);
    const { c } = ctx;
    const cust = await k.mkParty(c, 'Ali Yılmaz');
    const sup = await k.mkParty(c, 'Tedarikçi AŞ', 'supplier');
    const item = await k.mkItem(c, 'Dizüstü bilgisayar', { tracksSerial: true });
    const plain = await k.mkItem(c, 'Kablo');
    const wh2 = (await c.post('/api/warehouses', { name: 'Şube deposu' })).json().warehouse as { id: string };
    return { ...ctx, cust, sup, item, plain, wh2 };
  }
  const stockDoc = (c: any, body: Record<string, unknown>) => c.post('/api/stock-documents', { docDate: day(3, 1), ...body });
  const receive = (c: any, wh: string, itemId: string, serials: string[], extra: Record<string, unknown> = {}) =>
    stockDoc(c, { type: 'receipt', warehouseId: wh, lines: [{ itemId, quantity: String(serials.length), unitCost: '1000', serials, ...extra }] });
  const lookup = async (c: any, no: string) => (await c.get(`/api/serials/lookup?serialNo=${encodeURIComponent(no)}`)).json();
  const statusOf = async (c: any, no: string) => (await lookup(c, no)).serials[0].status as string;

  it('yaşam döngüsü: giriş → çıkış → iade → hurda; yinelenen/yanlış durumlar reddedilir', async () => {
    const { c, main, item, cust, sup, wh2 } = await base('Yasam');
    // Giriş: seri sayısı miktarla eşit olmalı, tam sayı olmalı, normalize edilir
    expect((await receive(c, main.id, item.id, ['sn-1', ' sn-2 ', 'SN-3'])).statusCode).toBe(201);
    const bad = await stockDoc(c, { type: 'receipt', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '3', unitCost: '1', serials: ['A1', 'A2'] }] });
    expect(bad.json().error.code).toBe('SERIAL_COUNT_MISMATCH');
    expect((await stockDoc(c, { type: 'receipt', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1.5', unitCost: '1', serials: ['A1'] }] })).json().error.code).toBe('SERIAL_QTY_NOT_WHOLE');
    expect((await stockDoc(c, { type: 'receipt', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1', unitCost: '1' }] })).json().error.code).toBe('SERIAL_COUNT_MISMATCH');
    expect((await receive(c, main.id, item.id, ['SN-1'])).json().error.code).toBe('SERIAL_EXISTS');
    expect((await receive(c, main.id, item.id, ['X1', 'x1'])).json().error.code).toBe('SERIAL_DUPLICATE');
    const plain = await k.mkItem(c, 'Düz');
    expect((await receive(c, main.id, plain.id, ['Z1'])).json().error.code).toBe('SERIAL_ITEM_NOT_TRACKED');
    expect((await c.get(`/api/serials?itemId=${item.id}&status=in_stock`)).json()).toMatchObject({ total: 3 });
    expect(await k.stockInfo(c, item.id)).toMatchObject({ qty: '3.0000' });

    // Satış irsaliyesi ile çıkış (müşteriye), aynı seri tekrar çıkamaz
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '2', { serials: ['SN-1', 'SN-2'] })] });
    expect(sale.lines[0].serials).toEqual(['SN-1', 'SN-2']);
    expect(await statusOf(c, 'SN-1')).toBe('issued');
    const twice = await k.note(c, { type: 'sales', post: true, partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['SN-1'] })] });
    expect(twice.json().error.code).toBe('SERIAL_NOT_IN_STOCK');
    // Depoda olmayan depodan çıkış
    const wrongWh = await stockDoc(c, { type: 'issue', warehouseId: wh2.id, lines: [{ itemId: item.id, quantity: '1', serials: ['SN-3'] }] });
    expect(wrongWh.statusCode).toBe(422);
    // Aynı müşteri değilse iade edilemez
    const other = await k.mkParty(c, 'Başka Müşteri');
    const wrongParty = await k.note(c, { type: 'sales_return', post: true, partyId: other.id, noteDate: day(3, 7), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['SN-2'] })] });
    expect(wrongParty.json().error.code).toBe('SERIAL_PARTY_MISMATCH');

    // Satış iadesi: orijinal satıra bağlı, yalnızca satırdaki seri
    const ret = await k.note(c, { type: 'sales_return', post: true, partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: sale.note.id, lines: [k.dline(item.id, '1', { sourceLineId: sale.lines[0].id, serials: ['SN-2'] })] });
    expect(ret.statusCode).toBe(201);
    expect(await statusOf(c, 'SN-2')).toBe('in_stock');
    const notOnOrig = await k.note(c, { type: 'sales_return', post: true, partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: sale.note.id, lines: [k.dline(item.id, '1', { sourceLineId: sale.lines[0].id, serials: ['SN-3'] })] });
    expect(notOnOrig.json().error.code).toBe('SERIAL_NOT_ON_ORIGINAL');
    const notIssued = await k.note(c, { type: 'sales_return', post: true, partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['SN-3'] })] });
    expect(notIssued.json().error.code).toBe('SERIAL_NOT_ISSUED');

    // Fire (hurda) belgesi: SN-2 hurda; sonra tekrar çıkamaz
    expect((await stockDoc(c, { type: 'waste', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1', serials: ['SN-2'] }] })).statusCode).toBe(201);
    expect(await statusOf(c, 'SN-2')).toBe('scrapped');
    expect((await stockDoc(c, { type: 'issue', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1', serials: ['SN-2'] }] })).json().error.code).toBe('SERIAL_NOT_IN_STOCK');

    // Transfer: depo değişir; eski depodan çıkamaz
    expect((await stockDoc(c, { type: 'transfer', warehouseId: main.id, toWarehouseId: wh2.id, lines: [{ itemId: item.id, quantity: '1', serials: ['SN-3'] }] })).statusCode).toBe(201);
    expect((await lookup(c, 'SN-3')).serials[0]).toMatchObject({ status: 'in_stock', warehouseId: wh2.id });
    expect((await stockDoc(c, { type: 'issue', warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1', serials: ['SN-3'] }] })).statusCode).toBe(422);

    // Alış iadesi: tedarikçiye iade; durum 'returned', sonra aynı seri yeniden alınabilir
    const rcv = await k.posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'T-1', noteDate: day(3, 9), warehouseId: wh2.id, lines: [k.dline(item.id, '1', { unitCost: '900', serials: ['SN-9'] })] });
    expect(rcv.lines[0].serials).toEqual(['SN-9']);
    await k.note(c, { type: 'purchase_return', post: true, partyId: sup.id, noteDate: day(3, 10), warehouseId: wh2.id, lines: [k.dline(item.id, '1', { serials: ['SN-9'] })] });
    expect(await statusOf(c, 'SN-9')).toBe('returned');
    expect((await k.note(c, { type: 'purchase', post: true, partyId: sup.id, externalNo: 'T-2', noteDate: day(3, 11), warehouseId: wh2.id, lines: [k.dline(item.id, '1', { unitCost: '900', serials: ['SN-9'] })] })).statusCode).toBe(201);
    expect(await statusOf(c, 'SN-9')).toBe('in_stock');

    // Sorgu: tam geçmiş (tedarikçi → müşteri)
    const h = await lookup(c, 'SN-1');
    expect(h.serials[0]).toMatchObject({ itemCode: item.code, status: 'issued', customer: 'Ali Yılmaz' });
    expect(h.serials[0].history.map((e: any) => e.event)).toEqual(['receive', 'issue']);
    expect(h.serials[0].history[1]).toMatchObject({ sourceNo: sale.note.noteNo, partyName: 'Ali Yılmaz' });
    expect((await c.get('/api/serials/lookup?serialNo=YOK')).statusCode).toBe(404);
    // Liste süzgeçleri ve dışa aktarma
    expect((await c.get(`/api/serials?status=issued`)).json().total).toBe(1);
    expect((await c.get(`/api/serials?query=sn-9`)).json().serials).toHaveLength(1);
    const csv = await c.get('/api/exports/serials?format=csv');
    expect(csv.body).toContain('SN-1');
    expect(csv.body).toContain('Müşteriye çıktı');
  });

  it('ters belge ve iptaller serileri eski haline döndürür; sonradan hareket gören seri geri alınamaz', async () => {
    const { c, main, item, cust, sup } = await base('Ters');
    const doc = (await receive(c, main.id, item.id, ['R1', 'R2'])).json();
    // Ters kayıt: seri sicilden düşer (void), yeniden alınabilir
    const rev = await c.post(`/api/stock-documents/${doc.document.id}/reverse`, {});
    expect(rev.statusCode).toBe(200);
    expect(await statusOf(c, 'R1')).toBe('void');
    expect((await c.get('/api/serials?itemId=' + item.id)).json().total).toBe(0);
    expect((await receive(c, main.id, item.id, ['R1', 'R2'])).statusCode).toBe(201);
    expect(await statusOf(c, 'R1')).toBe('in_stock');

    // Satış irsaliyesi iptali: seri depoya döner
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['R1'] })] });
    expect(await statusOf(c, 'R1')).toBe('issued');
    expect((await c.post(`/api/delivery-notes/${sale.note.id}/cancel`, { reason: 'yanlış' })).statusCode).toBe(200);
    expect(await statusOf(c, 'R1')).toBe('in_stock');
    const hist = (await lookup(c, 'R1')).serials[0].history.map((e: any) => e.event);
    expect(hist).toEqual(['receive', 'issue', 'reversal']);

    // Alış faturası (irsaliyesiz) ile giriş ve iptal; satış faturası ile çıkış ve iptal
    const pinv = await k.invPosted(c, { type: 'purchase', partyId: sup.id, invoiceDate: day(3, 6), externalNo: 'F-1', warehouseId: main.id, lines: [k.invLine(item.id, '2', '800', { serials: ['F1', 'F2'] })] });
    expect(await statusOf(c, 'F1')).toBe('in_stock');
    const sinv = await k.invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 7), warehouseId: main.id, lines: [k.invLine(item.id, '1', '1500', { serials: ['F1'] })] });
    expect(await statusOf(c, 'F1')).toBe('issued');
    expect(sinv.lines[0].serials).toEqual(['F1']);
    // Alış faturası, satılmış seriler varken iptal edilemez
    expect((await c.post(`/api/invoices/${pinv.invoice.id}/cancel`, { reason: 'hata' })).statusCode).toBe(422);
    expect((await c.post(`/api/invoices/${sinv.invoice.id}/cancel`, { reason: 'hata' })).statusCode).toBe(200);
    expect(await statusOf(c, 'F1')).toBe('in_stock');
    expect((await c.post(`/api/invoices/${pinv.invoice.id}/cancel`, { reason: 'hata' })).statusCode).toBe(200);
    expect(await statusOf(c, 'F1')).toBe('void');
    // Taslak faturada irsaliyeye bağlı satıra seri girilemez
    const dl = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['R2'] })] });
    const linked = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 9), lines: [k.invLine(item.id, '1', '10', { deliveryLineId: dl.lines[0].id, serials: ['R2'] })] });
    expect(linked.json().error.code).toBe('SERIAL_ON_LINKED_LINE');
  });

  it('taslakta seri girilir ve değiştirilebilir; kayıtta miktar/seri sayısı uyuşmazlığı reddedilir; sayım desteklenmez', async () => {
    const { c, main, item, cust } = await base('Taslak');
    await receive(c, main.id, item.id, ['T1', 'T2', 'T3']);
    const d = await k.note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '2', { serials: ['T1'] })] });
    expect(d.statusCode).toBe(201);
    const id = d.json().note.id;
    expect((await c.post(`/api/delivery-notes/${id}/post`)).json().error.code).toBe('SERIAL_COUNT_MISMATCH');
    expect((await c.put(`/api/delivery-notes/${id}`, { partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '2', { serials: ['T1', 'T2'] })] })).statusCode).toBe(200);
    expect((await c.get(`/api/delivery-notes/${id}`)).json().lines[0].serials).toEqual(['T1', 'T2']);
    expect((await c.post(`/api/delivery-notes/${id}/post`)).statusCode).toBe(200);
    // Sayım: seri takipli kartın farkı sayımla işlenemez
    const cnt = (await c.post('/api/stock-counts', { warehouseId: main.id, countDate: day(3, 10) })).json();
    await c.put(`/api/stock-counts/${cnt.count.id}`, { lines: [{ itemId: item.id, countedQty: '5' }] });
    expect((await c.post(`/api/stock-counts/${cnt.count.id}/post`)).json().error.code).toBe('SERIAL_COUNT_UNSUPPORTED');
  });

  it('veritabanı korumaları: miktar/seri sayısı, durum değişmezliği, salt-eklenir geçmiş, bayrak kilidi', async () => {
    const { c, company, main, item, plain } = await base('DB');
    await receive(c, main.id, item.id, ['D1', 'D2']);
    // Hareketi olan kartın seri takibi değişmez; hareketsiz kartta serbest
    expect((await c.patch(`/api/items/${item.id}`, { tracksSerial: false })).json().error.code).toBe('SERIAL_RULE_VIOLATION');
    expect((await c.patch(`/api/items/${plain.id}`, { tracksSerial: true })).statusCode).toBe(200);
    expect((await c.patch(`/api/items/${plain.id}`, { tracksSerial: false })).statusCode).toBe(200);
    // Hizmet kartı seri takipli olamaz
    expect((await c.post('/api/items', { name: 'Montaj', kind: 'service', tracksSerial: true })).json().error.code).toBe('SERIAL_ITEM_NOT_GOODS');

    await asOwner(async (q) => {
      const doc = (await q(`select d.id from stock_documents d where d.company_id = $1 order by d.created_at limit 1`, [company.id])).rows[0].id;
      const serial = (await q(`select id from item_serials where company_id = $1 and serial_no = 'D1'`, [company.id])).rows[0].id;
      // Durum doğrudan değiştirilemez
      let e = await expectDbError(q, `update item_serials set status = 'scrapped', warehouse_id = null where id = $1`, [serial]);
      expect(e.code).toBe('ERP17');
      e = await expectDbError(q, `delete from item_serials where id = $1`, [serial]);
      expect(e.code).toBe('ERP17');
      // Hareketler değişmez/silinmez
      e = await expectDbError(q, `update serial_events set line_no = 9 where serial_id = $1`, [serial]);
      expect(e.code).toBe('ERP17');
      e = await expectDbError(q, `delete from serial_events where serial_id = $1`, [serial]);
      expect(e.code).toBe('ERP17');
      // Çifte çıkış: ikinci 'issue' hareketi (önceki durum artık in_stock değil) reddedilir
      const ev = `insert into serial_events (id, company_id, serial_id, item_id, event, from_status, to_status, from_warehouse_id, to_warehouse_id, stock_document_id, line_no)
                  values (gen_random_uuid(), $1, $2, $3, 'issue', 'in_stock', 'issued', $4, null, $5, 1)`;
      await q(ev, [company.id, serial, item.id, main.id, doc]);
      e = await expectDbError(q, ev, [company.id, serial, item.id, main.id, doc]);
      expect(e.code).toBe('ERP17');
      expect(e.message).toMatch(/bu durumda değil/);
      // Miktar ≠ seri sayısı: seri hareketi olmayan tracked kart stok hareketi
      const sd = await q(
        `insert into stock_documents (id, company_id, doc_no, doc_date, period_id, type, warehouse_id) select gen_random_uuid(), $1, 'SH-X', doc_date, period_id, 'receipt', warehouse_id from stock_documents where id = $2 returning id`,
        [company.id, doc],
      );
      e = await expectDbError(
        q,
        `insert into stock_movements (id, company_id, document_id, line_no, kind, item_id, warehouse_id, movement_date, qty, value) select gen_random_uuid(), $1, $2, 1, 'qty', $3, $4, doc_date, 2, 10 from stock_documents where id = $2`,
        [company.id, sd.rows[0].id, item.id, main.id],
      );
      expect(e.code).toBe('ERP17');
      expect(e.message).toMatch(/eşit olmalı/);
      // Tam sayı olmayan miktar
      e = await expectDbError(
        q,
        `insert into stock_movements (id, company_id, document_id, line_no, kind, item_id, warehouse_id, movement_date, qty, value) select gen_random_uuid(), $1, $2, 1, 'qty', $3, $4, doc_date, 1.5, 10 from stock_documents where id = $2`,
        [company.id, sd.rows[0].id, item.id, main.id],
      );
      expect(e.code).toBe('ERP17');
      // Sicile doğrudan eklenen seri 'pending' dışında olamaz
      e = await expectDbError(q, `insert into item_serials (id, company_id, item_id, serial_no, status, warehouse_id) values (gen_random_uuid(), $1, $2, 'ZZ', 'in_stock', $3)`, [company.id, item.id, main.id]);
      expect(e.code).toBe('ERP17');
    });
  });

  it('yetki ve kiracı yalıtımı: görüntüleyici sorgular, seri girişi stok hareketi yetkisi ister; başka şirket göremez', async () => {
    const { c, company, main, item } = await base('Yetki');
    await receive(c, main.id, item.id, ['Y1']);
    const viewer = await k.memberClient(c, company.id, 'viewer');
    expect((await viewer.get('/api/serials')).statusCode).toBe(200);
    expect((await viewer.get('/api/serials/lookup?serialNo=Y1')).statusCode).toBe(200);
    expect((await viewer.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 2), warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1', unitCost: '1', serials: ['Y2'] }] })).statusCode).toBe(403);
    const other = await k.setup('Baska');
    expect((await other.c.get('/api/serials')).json().total).toBe(0);
    expect((await other.c.get('/api/serials/lookup?serialNo=Y1')).statusCode).toBe(404);
  });

  it('DB-5: kayıtlı belgenin satır seri no kaydı uygulama rolüyle silinemez; taslak belgeninki silinir', async () => {
    const { s, company, orgId, c, main, item, cust } = await base('SeriSil');
    expect((await receive(c, main.id, item.id, ['D5-1', 'D5-2'])).statusCode).toBe(201);
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['D5-1'] })] });
    const draft = await k.note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [k.dline(item.id, '1', { serials: ['D5-2'] })] });
    const draftLine = draft.json().lines[0].id as string;
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      const err = await expectDbError(q, 'delete from document_line_serials where delivery_line_id = $1', [sale.lines[0].id]);
      expect(err.code).toBe('ERP17');
      expect((await q('delete from document_line_serials where delivery_line_id = $1 returning id', [draftLine])).rows).toHaveLength(1);
    });
  });
});
