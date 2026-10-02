import { describe, expect, it } from 'vitest';
import { asOwner, day, expectDbError, makeApp, thisYear } from './helpers';
import { x2Kit } from './x2-helpers';

describe('iade irsaliyesi (X2)', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  /** 10 adet 50 maliyetle stoğa gir, müşteriye 10 sat (irsaliye): orijinal sevk. */
  async function salesBase(name: string) {
    const ctx = await k.setup(name);
    const { c, main } = ctx;
    const cust = await k.mkParty(c, 'Ali Yılmaz');
    const item = await k.mkItem(c, 'Çimento');
    await k.receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '10')] });
    return { ...ctx, cust, item, sale };
  }
  const ret = (c: any, ctx: { cust: { id: string }; sale: any; main: { id: string } }, qty: string, extra: Record<string, unknown> = {}, post = true) =>
    k.note(c, {
      type: 'sales_return', partyId: ctx.cust.id, noteDate: day(3, 8), warehouseId: ctx.main.id, returnOfId: ctx.sale.note.id, post,
      lines: [k.dline(ctx.sale.lines[0].itemId, qty, { sourceLineId: ctx.sale.lines[0].id })], ...extra,
    });

  it('satış iadesi: stoğa orijinal maliyetle girer, numara SIRI, yevmiye YOK, miktar sınırı kümülatif', async () => {
    const x = await salesBase('SatisIade');
    const { c } = x;
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '0.0000', value: '0.0000' });
    const journalsBefore = (await c.get('/api/journal-entries?limit=200')).json().entries.length;

    const r1 = await ret(c, x, '4');
    expect(r1.statusCode).toBe(201);
    const n1 = r1.json();
    expect(n1.note).toMatchObject({ type: 'sales_return', status: 'posted', noteNo: `SIRI-${thisYear}-000001`, returnOfId: x.sale.note.id, invoicing: 'open' });
    expect(n1.lines[0]).toMatchObject({ quantity: '4.0000', stockValue: '200.0000', sourceLineId: x.sale.lines[0].id });
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '4.0000', value: '200.0000' });
    expect((await c.get('/api/journal-entries?limit=200')).json().entries).toHaveLength(journalsBefore);
    expect(journalsBefore).toBe(1); // yalnızca elle stok girişi (150/500 açılış) — irsaliyeler yevmiye yazmaz

    // Orijinalde iade bilgisi
    const orig = await k.getNote(c, x.sale.note.id);
    expect(orig.lines[0]).toMatchObject({ returnedQty: '4.0000', returnableQty: '6.0000' });
    expect(orig.returns).toEqual([expect.objectContaining({ id: n1.note.id, noteNo: n1.note.noteNo, status: 'posted' })]);

    // İade edilebilir satırlar
    const rl = (await c.get(`/api/delivery-notes/returnable-lines?type=sales_return&partyId=${x.cust.id}`)).json().lines;
    expect(rl).toEqual([expect.objectContaining({ lineId: x.sale.lines[0].id, returnableQty: '6.0000', returnedQty: '4.0000' })]);

    // Aşım: 7 > kalan 6
    const over = await ret(c, x, '7');
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatchObject({ code: 'RETURN_QTY_EXCEEDED', details: { remaining: '6.0000' } });
    // Kalan tamamı iade: son pay kalan maliyeti alır (300), sonra 0.0001 bile iade edilemez
    const r2 = await ret(c, x, '6');
    expect(r2.statusCode).toBe(201);
    expect(r2.json().lines[0].stockValue).toBe('300.0000');
    expect((await ret(c, x, '0.0001')).json().error.code).toBe('RETURN_QTY_EXCEEDED');
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '10.0000', value: '500.0000' });
    expect((await k.getNote(c, x.sale.note.id)).lines[0]).toMatchObject({ returnedQty: '10.0000', returnableQty: '0.0000' });

    // İrsaliye listesi dışa aktarma: iade irsaliyeleri türüyle görünür
    const exp = await c.get('/api/exports/delivery-notes?format=csv');
    expect(exp.statusCode).toBe(200);
    expect(exp.body).toContain('Satış iade irsaliyesi');
    expect(exp.body).toContain(`SIRI-${thisYear}-000001`);

    // Faturalanmamış iade irsaliyesi mutabakat farkı olarak açıklanır (stok defteri hesaptan fazla)
    expect(await k.recon(c)).toMatchObject({ pendingDeliveries: { sales: '0.0000' }, unexplained: '0.0000' });
  });

  it('iadesi olan irsaliye iptal edilemez (veritabanı kuralı); iade iptali kalanı geri açar', async () => {
    const x = await salesBase('IadeIptal');
    const { c } = x;
    const r1 = (await (await ret(c, x, '3')).json()) as any;
    const cancelOrig = await c.post(`/api/delivery-notes/${x.sale.note.id}/cancel`, { reason: 'hatalı' });
    expect(cancelOrig.statusCode).toBe(422);
    expect(cancelOrig.json().error.code).toBe('DELIVERY_HAS_RETURNS');
    expect(cancelOrig.json().error.message).toContain(r1.note.noteNo);
    // Aynı kural veritabanında da var (ham SQL ile atlatılamaz)
    await asOwner(async (q) => {
      const e = await expectDbError(
        q,
        `update delivery_notes set status = 'cancelled', cancelled_at = now(), cancel_reason = 'x', cancel_stock_document_id = stock_document_id where id = $1`,
        [x.sale.note.id],
      );
      expect(e.code).toBe('ERP04');
      expect(e.message).toMatch(/İade irsaliyesi kesilmiş/);
    });

    const cancelRet = await c.post(`/api/delivery-notes/${r1.note.id}/cancel`, { reason: 'yanlış girildi' });
    expect(cancelRet.statusCode).toBe(200);
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '0.0000' });
    // Kalan miktar yeniden 10; artık tamamı iade edilebilir ve orijinal iptal edilebilir
    expect((await ret(c, x, '10')).statusCode).toBe(201);
  });

  it('doğrulamalar: aynı cari, karşı tür, aynı kart, bağsız satır, taslak orijinal; dış numara/maliyet yok', async () => {
    const x = await salesBase('IadeDogrula');
    const { c, main } = x;
    const other = await k.mkParty(c, 'Başka Müşteri');
    const item2 = await k.mkItem(c, 'Kum');

    const wrongParty = await k.note(c, { type: 'sales_return', partyId: other.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: x.sale.note.id, lines: [k.dline(x.item.id, '1')] });
    expect(wrongParty.json().error.code).toBe('RETURN_PARTY_MISMATCH');
    const wrongItem = await k.note(c, { type: 'sales_return', partyId: x.cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: x.sale.note.id, lines: [k.dline(item2.id, '1', { sourceLineId: x.sale.lines[0].id })] });
    expect(wrongItem.json().error.code).toBe('RETURN_ITEM_MISMATCH');
    // Satır bağı için orijinal irsaliye şart (şema)
    const noOrig = await k.note(c, { type: 'sales_return', partyId: x.cust.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(x.item.id, '1', { sourceLineId: x.sale.lines[0].id })] });
    expect(noOrig.statusCode).toBe(400);
    // Satış iadesi alış irsaliyesine bağlanamaz
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    await k.posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'T-1', noteDate: day(3, 2), warehouseId: main.id, lines: [k.dline(item2.id, '5', { unitCost: '10' })] });
    const purchNote = (await c.get('/api/delivery-notes?type=purchase')).json().notes[0];
    const wrongType = await k.note(c, { type: 'sales_return', partyId: sup.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: purchNote.id, lines: [k.dline(item2.id, '1')] });
    expect(wrongType.statusCode).toBe(422);
    // Taslak orijinal
    const draft = (await (await k.note(c, { type: 'sales', partyId: x.cust.id, noteDate: day(3, 6), warehouseId: main.id, lines: [k.dline(x.item.id, '1')] })).json()) as any;
    const draftOrig = await k.note(c, { type: 'sales_return', partyId: x.cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: draft.note.id, lines: [k.dline(x.item.id, '1')] });
    expect(draftOrig.json().error.code).toBe('RETURN_ORIGINAL_NOT_POSTED');
    // Maliyet ve dış numara
    expect((await ret(c, x, '1', { externalNo: 'X' }, false)).statusCode).toBe(400);
    const cost = await k.note(c, { type: 'sales_return', partyId: x.cust.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(x.item.id, '1', { unitCost: '5' })] });
    expect(cost.statusCode).toBe(400);
    // Orijinalsiz (bağsız) iade: güncel referans maliyetle girer
    const free = await k.note(c, { type: 'sales_return', partyId: x.cust.id, noteDate: day(3, 8), warehouseId: main.id, post: true, lines: [k.dline(x.item.id, '2')] });
    expect(free.statusCode).toBe(201);
    expect(free.json().lines[0].stockValue).toBe('100.0000');
  });

  it('alış iadesi: stoktan ortalama maliyetle çıkar, stok yetersizse reddedilir, miktar sınırı', async () => {
    const x = await k.setup('AlisIade');
    const { c, main } = x;
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    const item = await k.mkItem(c, 'Demir');
    const rcv = await k.posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'T-9', noteDate: day(3, 2), warehouseId: main.id, lines: [k.dline(item.id, '10', { unitCost: '20' })] });
    const pr = (qty: string, post = true) =>
      k.note(c, { type: 'purchase_return', partyId: sup.id, noteDate: day(3, 9), warehouseId: main.id, returnOfId: rcv.note.id, post, lines: [k.dline(item.id, qty, { sourceLineId: rcv.lines[0].id })] });
    const r = await pr('3');
    expect(r.statusCode).toBe(201);
    expect(r.json().note).toMatchObject({ type: 'purchase_return', noteNo: `AIRI-${thisYear}-000001`, status: 'posted' });
    expect(r.json().lines[0].stockValue).toBe('60.0000');
    expect(await k.stockInfo(c, item.id)).toMatchObject({ qty: '7.0000', value: '140.0000' });
    expect((await pr('8')).json().error.code).toBe('RETURN_QTY_EXCEEDED');
    // Faturalanmamış alış iadesi mutabakat farkı
    expect(await k.recon(c)).toMatchObject({ unexplained: '0.0000' });
    // Stok yetersiz: başka çıkışla azalt, kalan iade yapılamaz
    await c.post('/api/stock-documents', { type: 'issue', docDate: day(3, 10), warehouseId: main.id, lines: [{ itemId: item.id, quantity: '7' }] });
    const insufficient = await pr('5');
    expect(insufficient.statusCode).toBe(422);
    expect(insufficient.json().error.code).toBe('STOCK_INSUFFICIENT');
  });

  it('iade faturası iade irsaliyesine bağlanır: stok iki kez hareket etmez, yevmiye dengeli, mutabakat kapanır', async () => {
    const x = await salesBase('IadeFatura');
    const { c } = x;
    // Orijinal sevk faturalandı (satış faturası irsaliyeye bağlı)
    const sale = await k.invPosted(c, { type: 'sales', partyId: x.cust.id, invoiceDate: day(3, 6), lines: [k.invLine(x.item.id, '10', '100', { deliveryLineId: x.sale.lines[0].id })] });
    const r = (await (await ret(c, x, '4')).json()) as any;
    expect((await k.recon(c)).pendingDeliveries.sales).toBe('200.0000'); // iade stoğu defterde, hesapta değil

    // İade faturası, iade irsaliyesi satırına bağlı
    const credit = await k.invPosted(c, {
      type: 'sales_return', partyId: x.cust.id, invoiceDate: day(3, 9), returnOfId: sale.invoice.id,
      lines: [k.invLine(x.item.id, '4', '100', { deliveryLineId: r.lines[0].id })],
    });
    expect(credit.invoice).toMatchObject({ status: 'posted', stockDocumentId: null, grossTotal: '464.0000' });
    expect(credit.lines[0]).toMatchObject({ costValue: '200.0000', deliveryNoteNo: r.note.noteNo });
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '4.0000', value: '200.0000' }); // yeniden girmedi
    const j = await k.journalOf(c, credit.invoice.journalEntryId);
    expect(j.lines).toEqual([['120', 0, 464], ['610', 400, 0], ['391', 64, 0], ['150', 200, 0], ['621', 0, 200]]);
    expect((await k.getNote(c, r.note.id)).note.invoicing).toBe('invoiced');
    expect(await k.recon(c)).toMatchObject({ difference: '0.0000', pendingDeliveries: { sales: '0.0000' }, unexplained: '0.0000' });

    // Satış faturasının iptali iade faturası varken engellenir
    const cancelSale = await c.post(`/api/invoices/${sale.invoice.id}/cancel`, { reason: 'hatalı iptal' });
    expect(cancelSale.statusCode).toBe(422);
    // İade irsaliyesi faturalıyken iptal edilemez
    expect((await c.post(`/api/delivery-notes/${r.note.id}/cancel`, { reason: 'hatalı iptal' })).json().error.code).toBe('DELIVERY_INVOICED');
    // İade faturası iptal edilince irsaliye serbest kalır
    expect((await c.post(`/api/invoices/${credit.invoice.id}/cancel`, { reason: 'hatalı' })).statusCode).toBe(200);
    expect((await k.getNote(c, r.note.id)).note.invoicing).toBe('open');
    // Aşırı iade faturası: irsaliye satırının kalanını aşamaz
    const tooMuch = await c.post('/api/invoices', { type: 'sales_return', partyId: x.cust.id, invoiceDate: day(3, 10), lines: [k.invLine(x.item.id, '5', '100', { deliveryLineId: r.lines[0].id })] });
    expect(tooMuch.json().error.code).toBe('DELIVERY_QTY_EXCEEDED');
  });

  it('alış iadesi faturası: alış iade irsaliyesine bağlanır, stok bir kez çıkar, yevmiye dengeli', async () => {
    const x = await k.setup('AlisIadeFat');
    const { c, main } = x;
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    const item = await k.mkItem(c, 'Demir');
    const rcv = await k.posted(c, { type: 'purchase', partyId: sup.id, externalNo: 'T-5', noteDate: day(3, 2), warehouseId: main.id, lines: [k.dline(item.id, '10', { unitCost: '20' })] });
    const buy = await k.invPosted(c, { type: 'purchase', partyId: sup.id, externalNo: 'F-5', invoiceDate: day(3, 3), lines: [k.invLine(item.id, '10', '20', { deliveryLineId: rcv.lines[0].id })] });
    const pr = (await (await k.note(c, { type: 'purchase_return', partyId: sup.id, noteDate: day(3, 9), warehouseId: main.id, returnOfId: rcv.note.id, post: true, lines: [k.dline(item.id, '3', { sourceLineId: rcv.lines[0].id })] })).json()) as any;
    expect((await k.recon(c)).pendingDeliveries.purchases).toBe('-60.0000');
    const credit = await k.invPosted(c, {
      type: 'purchase_return', partyId: sup.id, externalNo: 'IF-1', invoiceDate: day(3, 10), returnOfId: buy.invoice.id,
      lines: [k.invLine(item.id, '3', '20', { deliveryLineId: pr.lines[0].id })],
    });
    expect(credit.invoice.stockDocumentId).toBeNull();
    expect(await k.stockInfo(c, item.id)).toMatchObject({ qty: '7.0000', value: '140.0000' });
    const j = await k.journalOf(c, credit.invoice.journalEntryId);
    const sumD = j.lines.reduce((s: number, l: readonly [string, number, number]) => s + l[1], 0);
    const sumC = j.lines.reduce((s: number, l: readonly [string, number, number]) => s + l[2], 0);
    expect(sumD).toBeCloseTo(sumC, 4);
    expect(j.byCode('150')).toEqual([['150', 0, 60]]);
    expect(await k.recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
  });

  it('eşzamanlı iki iade taslağı birlikte kalanı aşamaz: biri kaydedilir, diğeri reddedilir', async () => {
    const x = await salesBase('IadeYaris');
    const { c } = x;
    const a = (await (await ret(c, x, '6', {}, false)).json()) as any;
    const b = (await (await ret(c, x, '6', {}, false)).json()) as any;
    const [ra, rb] = await Promise.all([c.post(`/api/delivery-notes/${a.note.id}/post`), c.post(`/api/delivery-notes/${b.note.id}/post`)]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 422]);
    const failed = ra.statusCode === 422 ? ra : rb;
    expect(failed.json().error.code).toBe('RETURN_QTY_EXCEEDED');
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '6.0000' });
  });

  it('veritabanı kuralları (ham SQL): satır bağı yalnızca iade irsaliyesinde, maliyet yalnızca alışta', async () => {
    const x = await salesBase('IadeSql');
    await asOwner(async (q) => {
      const hdr = await q(
        `insert into delivery_notes (id, company_id, type, status, note_date, party_id, warehouse_id) values (gen_random_uuid(), $1, 'sales', 'draft', current_date, $2, $3) returning id`,
        [x.company.id, x.cust.id, x.main.id],
      );
      const id = hdr.rows[0].id as string;
      const line = `insert into delivery_note_lines (id, company_id, note_id, line_no, item_id, description, quantity, source_line_id) values (gen_random_uuid(), $1, $2, 1, $3, 'x', 1, $4)`;
      const e1 = await expectDbError(q, line, [x.company.id, id, x.item.id, x.sale.lines[0].id]);
      expect(e1.code).toBe('ERP04');
      expect(e1.message).toMatch(/Satır bağı yalnızca/);
      const e2 = await expectDbError(
        q,
        `insert into delivery_note_lines (id, company_id, note_id, line_no, item_id, description, quantity, unit_cost) values (gen_random_uuid(), $1, $2, 1, $3, 'x', 1, 5)`,
        [x.company.id, id, x.item.id],
      );
      expect(e2.code).toBe('ERP04');
      // Orijinal irsaliye dışı türde return_of_id olan taslak: kayıtta reddedilir (iade olmayan tür)
      const e3 = await expectDbError(q, `update delivery_notes set status = 'posted' where id = $1`, [id]);
      expect(e3.code).toBe('ERP04');
    });
  });
});
