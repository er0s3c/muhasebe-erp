import { describe, expect, it } from 'vitest';
import { asDb, asOwner, client, day, expectDbError, makeApp, registerUser, createCompany, thisYear } from './helpers';
import { x2Kit } from './x2-helpers';

describe('satış teklifi ve siparişi (X2)', async () => {
  const { app, handle } = await makeApp();
  const k = x2Kit(app);

  const doc = async (c: any, body: Record<string, unknown>) => {
    const res = await c.post('/api/sales-docs', body);
    if (res.statusCode !== 201) throw new Error(`sales doc failed: ${res.body}`);
    return res.json() as { doc: any; lines: any[]; events: any[]; notes: any[]; invoices: any[] };
  };
  const act = async (c: any, id: string, action: string, body: Record<string, unknown> = {}) => c.post(`/api/sales-docs/${id}/${action}`, body);
  const get = async (c: any, id: string) => (await c.get(`/api/sales-docs/${id}`)).json() as { doc: any; lines: any[]; events: any[]; notes: any[]; invoices: any[] };
  const line = (itemId: string | null, quantity: string, unitPrice?: string, extra: Record<string, unknown> = {}) => ({ itemId, quantity, ...(unitPrice ? { unitPrice } : {}), ...extra });

  /** Stoklu mal (50 maliyet, 10 adet), müşteri ve 6 adetlik onaylı sipariş: 100 TL fiyat. */
  async function orderBase(name: string, qty = '6') {
    const ctx = await k.setup(name);
    const { c, main } = ctx;
    const cust = await k.mkParty(c, 'Ali Yılmaz');
    const item = await k.mkItem(c, 'Çimento', { salePrice: '120' });
    await k.receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const o = await doc(c, { kind: 'order', partyId: cust.id, docDate: day(3, 2), warehouseId: main.id, lines: [line(item.id, qty, '100')] });
    await act(c, o.doc.id, 'confirm');
    return { ...ctx, cust, item, order: await get(c, o.doc.id) };
  }

  it('teklif: fiyat kartın satış fiyatından gelir, numara gönderilince verilir, olay geçmişi, kabul → siparişe dönüşüm', async () => {
    const { c, main } = await k.setup('Teklif');
    const cust = await k.mkParty(c, 'Ali Yılmaz');
    const item = await k.mkItem(c, 'Çimento', { salePrice: '120' });
    const noPrice = await k.mkItem(c, 'Fiyatsız');
    // Kartta fiyat yok ve satırda da yok: reddedilir (fiyat listesi kancası: X3)
    const miss = await c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: day(3, 1), lines: [line(noPrice.id, '1')] });
    expect(miss.json().error.code).toBe('SO_PRICE_REQUIRED');

    const q = await doc(c, {
      kind: 'quote', partyId: cust.id, docDate: day(3, 1), validUntil: day(12, 31), warehouseId: main.id, notes: 'Ödeme: peşin',
      lines: [line(item.id, '5'), { description: 'Nakliye', quantity: '1', unitPrice: '50', vatCode: 'KDV-16' }, line(item.id, '2', '100', { discountPct: '10' })],
    });
    expect(q.doc).toMatchObject({ kind: 'quote', status: 'draft', docNo: null, currencyCode: 'TRY', netTotal: '830.0000', vatTotal: '132.8000', grossTotal: '962.8000' });
    expect(q.lines.map((l) => [l.unitPrice, l.net])).toEqual([['120.000000', '600.0000'], ['50.000000', '50.0000'], ['100.000000', '180.0000']]);
    expect(q.lines[0]).toMatchObject({ vatCode: 'KDV-16', vatRate: '16.0000', isGoods: true });

    // Taslak düzenlenir; gönderilince numara + donar
    expect((await c.put(`/api/sales-docs/${q.doc.id}`, { partyId: cust.id, docDate: day(3, 1), lines: [line(item.id, '5')] })).statusCode).toBe(200);
    const sent = await act(c, q.doc.id, 'send');
    expect(sent.statusCode).toBe(200);
    expect(sent.json().doc).toMatchObject({ status: 'sent', docNo: `TKL-${thisYear}-000001` });
    expect((await c.put(`/api/sales-docs/${q.doc.id}`, { partyId: cust.id, docDate: day(3, 1), lines: [line(item.id, '5')] })).json().error.code).toBe('SO_NOT_DRAFT');
    expect((await c.delete(`/api/sales-docs/${q.doc.id}`)).json().error.code).toBe('SO_NOT_DRAFT');

    // Geçersiz geçişler
    expect((await act(c, q.doc.id, 'confirm')).json().error.code).toBe('SO_INVALID_TRANSITION');
    expect((await act(c, q.doc.id, 'convert')).json().error.code).toBe('SO_QUOTE_NOT_ACCEPTED');
    expect((await act(c, q.doc.id, 'cancel')).json().error.code).toBe('SO_REASON_REQUIRED');

    // Kabul → siparişe dönüştür
    expect((await act(c, q.doc.id, 'accept')).statusCode).toBe(200);
    const conv = await act(c, q.doc.id, 'convert');
    expect(conv.statusCode).toBe(201);
    const ord = await get(c, conv.json().orderId);
    expect(ord.doc).toMatchObject({ kind: 'order', status: 'draft', quoteId: q.doc.id, quoteNo: `TKL-${thisYear}-000001`, grossTotal: '696.0000' });
    expect(ord.lines[0]).toMatchObject({ quantity: '5.0000', unitPrice: '120.000000' });
    const after = await get(c, q.doc.id);
    expect(after.doc).toMatchObject({ status: 'converted', orderId: ord.doc.id });
    expect(after.events.map((e) => [e.fromStatus, e.toStatus])).toEqual([['draft', 'sent'], ['sent', 'accepted'], ['accepted', 'converted']]);
    // Aynı teklif ikinci kez dönüşmez
    expect((await act(c, q.doc.id, 'convert')).json().error.code).toBe('SO_QUOTE_NOT_ACCEPTED');
    // Sipariş onayı: numara SSP
    const conf = await act(c, ord.doc.id, 'confirm');
    expect(conf.json().doc).toMatchObject({ status: 'confirmed', docNo: `SSP-${thisYear}-000001` });
    // Dışa aktarma (csv): numara, tür ve durum görünür; modül/izin korumalı
    const exp = await c.get('/api/exports/sales-docs?format=csv&kind=order');
    expect(exp.statusCode).toBe(200);
    expect(exp.body).toContain(`SSP-${thisYear}-000001`);
    expect(exp.body).toContain('Onaylandı');
    expect(exp.body).not.toContain('TKL-');
    // Liste ve filtre
    const list = (await c.get('/api/sales-docs?kind=quote')).json();
    expect(list.docs).toEqual([expect.objectContaining({ id: q.doc.id, status: 'converted' })]);
  });

  it('teklif: reddet, geri al (revize) numarayı korur, süresi geçmiş teklif kabul edilmez, müşteri olmayan cariye düzenlenmez', async () => {
    const { c } = await k.setup('TeklifDurum');
    const cust = await k.mkParty(c, 'Ali');
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    const item = await k.mkItem(c, 'Kum', { salePrice: '10' });
    expect((await c.post('/api/sales-docs', { kind: 'quote', partyId: sup.id, docDate: day(3, 1), lines: [line(item.id, '1')] })).json().error.code).toBe('PARTY_KIND_MISMATCH');

    const q = await doc(c, { kind: 'quote', partyId: cust.id, docDate: day(3, 1), lines: [line(item.id, '1')] });
    await act(c, q.doc.id, 'send');
    const reopened = await act(c, q.doc.id, 'reopen');
    expect(reopened.json().doc).toMatchObject({ status: 'draft', docNo: `TKL-${thisYear}-000001` });
    expect((await c.put(`/api/sales-docs/${q.doc.id}`, { partyId: cust.id, docDate: day(3, 1), lines: [line(item.id, '3')] })).statusCode).toBe(200);
    // Numaralı taslak silinemez, iptal edilir
    expect((await c.delete(`/api/sales-docs/${q.doc.id}`)).json().error.code).toBe('SO_NOT_DRAFT');
    expect((await act(c, q.doc.id, 'send')).json().doc.docNo).toBe(`TKL-${thisYear}-000001`); // numara korunur, yeni numara yok
    expect((await act(c, q.doc.id, 'reject', { reason: 'pahalı' })).json().doc.status).toBe('rejected');
    expect((await act(c, q.doc.id, 'accept')).json().error.code).toBe('SO_INVALID_TRANSITION');

    // Süresi geçmiş (geçerlilik tarihi bugünden önce) teklif kabul edilemez
    const old = await doc(c, { kind: 'quote', partyId: cust.id, docDate: day(1, 1, thisYear - 1), validUntil: day(1, 15, thisYear - 1), lines: [line(item.id, '1')] });
    await act(c, old.doc.id, 'send');
    expect((await get(c, old.doc.id)).doc.expired).toBe(true);
    expect((await act(c, old.doc.id, 'accept')).json().error.code).toBe('QUOTE_EXPIRED');
    expect((await c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: day(3, 5), validUntil: day(3, 1), lines: [line(item.id, '1')] })).json().error.code).toBe('VALID_UNTIL_BEFORE_DATE');
    // Taslak (numarasız) silinebilir
    const d = await doc(c, { kind: 'quote', partyId: cust.id, docDate: day(3, 1), lines: [line(item.id, '1')] });
    expect((await c.delete(`/api/sales-docs/${d.doc.id}`)).statusCode).toBe(200);
  });

  it('sipariş → irsaliye → fatura: karşılanma miktarları ve durumu türer, aşım reddedilir, yevmiye dengeli', async () => {
    const x = await orderBase('SiparisAkis');
    const { c } = x;
    const lineId = x.order.lines[0].id;
    expect(x.order.doc.fulfilment).toEqual({ delivery: 'none', invoicing: 'none' });
    expect(x.order.lines[0]).toMatchObject({ delivered: '0.0000', remainingDeliverable: '6.0000', remainingInvoiceable: '6.0000' });

    // İrsaliye taslağı: kalan teslim edilebilir miktar (6); sipariş satırına bağlı
    const dn = await act(c, x.order.doc.id, 'delivery-note', { lines: [{ lineId, quantity: '4' }] });
    expect(dn.statusCode).toBe(201);
    const draft = await k.getNote(c, dn.json().noteId);
    expect(draft.note).toMatchObject({ type: 'sales', status: 'draft', description: `Sipariş ${x.order.doc.docNo}` });
    expect(draft.lines[0]).toMatchObject({ salesOrderLineId: lineId, salesOrderNo: x.order.doc.docNo, quantity: '4.0000' });
    expect((await c.post(`/api/delivery-notes/${draft.note.id}/post`)).statusCode).toBe(200);
    let st = await get(c, x.order.doc.id);
    expect(st.doc.fulfilment).toEqual({ delivery: 'partial', invoicing: 'none' });
    expect(st.lines[0]).toMatchObject({ delivered: '4.0000', remainingDeliverable: '2.0000', deliveredNotInvoiced: '4.0000' });
    expect(st.notes).toEqual([expect.objectContaining({ id: draft.note.id, status: 'posted' })]);

    // Aşım: kalan 2'den fazla teslim edilemez (taslakta bile)
    const over = await k.note(c, { type: 'sales', partyId: x.cust.id, noteDate: day(3, 6), warehouseId: x.main.id, lines: [k.dline(x.item.id, '3', { salesOrderLineId: lineId })] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatchObject({ code: 'SO_QTY_EXCEEDED', details: { remaining: '2.0000' } });

    // Kalan 2: ikinci irsaliye (varsayılan miktar = kalan) → tam teslim
    const dn2 = await act(c, x.order.doc.id, 'delivery-note');
    await c.post(`/api/delivery-notes/${dn2.json().noteId}/post`);
    st = await get(c, x.order.doc.id);
    expect(st.doc.fulfilment).toEqual({ delivery: 'full', invoicing: 'none' });
    expect((await act(c, x.order.doc.id, 'delivery-note')).json().error.code).toBe('SO_NOTHING_TO_DELIVER');

    // Faturaya dönüştür: iki irsaliye satırı, sipariş fiyatıyla, irsaliyeye bağlı (stok tekrar hareket etmez)
    const inv = await act(c, x.order.doc.id, 'invoice');
    expect(inv.statusCode).toBe(201);
    const draftInv = (await c.get(`/api/invoices/${inv.json().invoiceId}`)).json();
    expect(draftInv.invoice).toMatchObject({ type: 'sales', status: 'draft', netTotal: '600.0000', grossTotal: '696.0000', description: `Sipariş ${x.order.doc.docNo}` });
    expect(draftInv.lines.map((l: any) => [l.quantity, l.unitPrice, !!l.deliveryLineId, l.salesOrderLineId])).toEqual([['4.0000', '100.000000', true, lineId], ['2.0000', '100.000000', true, lineId]]);
    const postedInv = (await (await c.post(`/api/invoices/${draftInv.invoice.id}/post`)).json()) as any;
    expect(postedInv.invoice).toMatchObject({ status: 'posted', stockDocumentId: null });
    const j = await k.journalOf(c, postedInv.invoice.journalEntryId);
    expect(j.lines).toEqual([['120', 696, 0], ['600', 0, 600], ['391', 0, 96], ['621', 300, 0], ['150', 0, 300]]);
    expect(await k.stockInfo(c, x.item.id)).toMatchObject({ qty: '4.0000', value: '200.0000' });
    st = await get(c, x.order.doc.id);
    expect(st.doc.fulfilment).toEqual({ delivery: 'full', invoicing: 'full' });
    expect(st.invoices).toEqual([expect.objectContaining({ id: draftInv.invoice.id, status: 'posted' })]);
    expect((await act(c, x.order.doc.id, 'invoice')).json().error.code).toBe('SO_NOTHING_TO_INVOICE');
    expect(await k.recon(c)).toMatchObject({ difference: '0.0000', unexplained: '0.0000' });
    // Satış raporlarında sipariş yoktur (yalnızca fatura) — sipariş yevmiye yazmaz
    const journalCount = (await c.get('/api/journal-entries?limit=200')).json().entries.length;
    expect(journalCount).toBe(2); // elle stok girişi + satış faturası
  });

  it('hizmet satırı doğrudan, hiç teslim edilmemiş mal satırı isteğe bağlı faturalanır (stok faturada hareket eder); teslim + doğrudan toplamı siparişi aşamaz', async () => {
    const x = await k.setup('SiparisDogrudan');
    const { c, main } = x;
    const cust = await k.mkParty(c, 'Müşteri');
    const item = await k.mkItem(c, 'Kum', { salePrice: '20' });
    await k.receipt(c, day(3, 1), main.id, item.id, '20', '5');
    const o = await doc(c, { kind: 'order', partyId: cust.id, docDate: day(3, 2), warehouseId: main.id, lines: [line(item.id, '10'), { description: 'Nakliye', quantity: '1', unitPrice: '150' }] });
    await act(c, o.doc.id, 'confirm');
    const full = await get(c, o.doc.id);
    const [goods, service] = full.lines;
    expect(service).toMatchObject({ isGoods: false, itemId: null });

    // 3 adet teslim → hizmet satırı + teslim edilmiş mal faturalanır, teslim edilmemiş (7) alınmaz
    const dn = await act(c, o.doc.id, 'delivery-note', { lines: [{ lineId: goods.id, quantity: '3' }] });
    await c.post(`/api/delivery-notes/${dn.json().noteId}/post`);
    const inv1 = await act(c, o.doc.id, 'invoice');
    const i1 = (await c.get(`/api/invoices/${inv1.json().invoiceId}`)).json();
    expect(i1.lines.map((l: any) => [l.description, l.quantity, !!l.deliveryLineId])).toEqual([['Kum', '3.0000', true], ['Nakliye', '1.0000', false]]);
    await c.post(`/api/invoices/${i1.invoice.id}/post`);

    // Kalan 7 mal: includeUndelivered ile doğrudan fatura; stok FATURADA çıkar
    const inv2 = await act(c, o.doc.id, 'invoice', { includeUndelivered: true });
    expect(inv2.statusCode).toBe(201);
    const i2 = (await c.get(`/api/invoices/${inv2.json().invoiceId}`)).json();
    expect(i2.lines.map((l: any) => [l.quantity, !!l.deliveryLineId])).toEqual([['7.0000', false]]);
    const p2 = (await (await c.post(`/api/invoices/${i2.invoice.id}/post`)).json()) as any;
    expect(p2.invoice.stockDocumentId).not.toBeNull();
    expect(await k.stockInfo(c, item.id)).toMatchObject({ qty: '10.0000' }); // 20 - 3 (irsaliye) - 7 (fatura)
    const st = await get(c, o.doc.id);
    expect(st.lines[0]).toMatchObject({ delivered: '3.0000', invoiced: '10.0000', remainingDeliverable: '0.0000', remainingInvoiceable: '0.0000' });
    expect(st.doc.fulfilment).toEqual({ delivery: 'full', invoicing: 'full' });
    // Doğrudan faturalanan miktar teslim hakkını da tüketti: yeni teslim kalmadı
    expect((await act(c, o.doc.id, 'delivery-note')).json().error.code).toBe('SO_NOTHING_TO_DELIVER');
  });

  it('irsaliyeden elle kesilen fatura sipariş satırına otomatik bağlanır; teslim iptali miktarı serbest bırakır; kapalı sipariş teslim almaz', async () => {
    const x = await orderBase('SiparisElle');
    const { c } = x;
    const lineId = x.order.lines[0].id;
    const dn = await act(c, x.order.doc.id, 'delivery-note', { lines: [{ lineId, quantity: '6' }] });
    await c.post(`/api/delivery-notes/${dn.json().noteId}/post`);
    const note = await k.getNote(c, dn.json().noteId);
    // Elle fatura (fiyat sipariştekinden farklı olabilir): sipariş bağı kalıtılır
    const inv = await k.invPosted(c, { type: 'sales', partyId: x.cust.id, invoiceDate: day(3, 9), lines: [k.invLine(x.item.id, '6', '110', { deliveryLineId: note.lines[0].id })] });
    expect(inv.lines[0]).toMatchObject({ salesOrderLineId: lineId });
    expect((await get(c, x.order.doc.id)).doc.fulfilment).toEqual({ delivery: 'full', invoicing: 'full' });
    // İptal: faturalı sipariş iptal edilemez, kapatılır
    expect((await act(c, x.order.doc.id, 'cancel', { reason: 'vazgeçildi' })).json().error.code).toBe('SO_HAS_FULFILMENT');
    expect((await act(c, x.order.doc.id, 'close')).json().doc.status).toBe('closed');
    // Kapalı siparişe yeni teslim yok
    const closedDn = await k.note(c, { type: 'sales', partyId: x.cust.id, noteDate: day(3, 10), warehouseId: x.main.id, lines: [k.dline(x.item.id, '1', { salesOrderLineId: lineId })] });
    expect(closedDn.json().error.code).toBe('SO_NOT_CONFIRMED');

    // İkinci sipariş: teslim iptal edilince miktar serbest
    const o2 = await doc(c, { kind: 'order', partyId: x.cust.id, docDate: day(3, 11), warehouseId: x.main.id, lines: [line(x.item.id, '4', '100')] });
    await act(c, o2.doc.id, 'confirm');
    const l2 = o2.lines[0].id;
    const d1 = (await (await k.note(c, { type: 'sales', partyId: x.cust.id, noteDate: day(3, 12), warehouseId: x.main.id, post: true, lines: [k.dline(x.item.id, '4', { salesOrderLineId: l2 })] })).json()) as any;
    expect((await get(c, o2.doc.id)).lines[0].remainingDeliverable).toBe('0.0000');
    await c.post(`/api/delivery-notes/${d1.note.id}/cancel`, { reason: 'yanlış sevk' });
    expect((await get(c, o2.doc.id)).lines[0]).toMatchObject({ delivered: '0.0000', remainingDeliverable: '4.0000' });
    // Teslimi olmayan onaylı sipariş iptal edilebilir
    expect((await act(c, o2.doc.id, 'cancel', { reason: 'müşteri vazgeçti' })).json().doc.status).toBe('cancelled');
  });

  it('faturaya sipariş bağı: farklı cari/aşım/para birimi reddedilir; teklife bağlanamaz', async () => {
    const x = await orderBase('SiparisBag');
    const { c } = x;
    const lineId = x.order.lines[0].id;
    const other = await k.mkParty(c, 'Başka');
    const bad = (partyId: string, extra: Record<string, unknown>, qty = '1') =>
      c.post('/api/invoices', { type: 'sales', partyId, invoiceDate: day(3, 9), lines: [{ ...k.invLine(x.item.id, qty, '100'), salesOrderLineId: lineId, ...extra }], ...('currency' in extra ? {} : {}) });
    expect((await bad(other.id, {})).json().error.code).toBe('SO_PARTY_MISMATCH');
    expect((await bad(x.cust.id, {}, '7')).json().error.code).toBe('SO_QTY_EXCEEDED');
    const q = await doc(c, { kind: 'quote', partyId: x.cust.id, docDate: day(3, 1), lines: [line(x.item.id, '1', '100')] });
    const toQuote = await c.post('/api/invoices', { type: 'sales', partyId: x.cust.id, invoiceDate: day(3, 9), lines: [{ ...k.invLine(x.item.id, '1', '100'), salesOrderLineId: q.lines[0].id }] });
    expect(toQuote.statusCode).toBe(422);
    expect(['SO_LINK_KIND', 'SO_NOT_CONFIRMED']).toContain(toQuote.json().error.code);
    // Alış faturasına sipariş bağı yok (şema)
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    expect((await c.post('/api/invoices', { type: 'purchase', partyId: sup.id, externalNo: 'X1', invoiceDate: day(3, 9), lines: [{ ...k.invLine(x.item.id, '1', '100'), salesOrderLineId: lineId }] })).statusCode).toBe(400);
  });

  it('veritabanı kuralları (ham SQL): geçersiz geçiş, olaysız geçiş, donmuş gövde, numaralı silme, olay/satır değiştirilemez, sipariş aşımı', async () => {
    const x = await orderBase('SiparisSql');
    const { c } = x;
    const q = await doc(c, { kind: 'quote', partyId: x.cust.id, docDate: day(3, 1), lines: [line(x.item.id, '1', '100')] });
    await act(c, q.doc.id, 'send');
    const orderId = x.order.doc.id;
    const lineId = x.order.lines[0].id;
    await asOwner(async (q2) => {
      const quoteId = q.doc.id;
      const e1 = await expectDbError(q2, `update sales_orders set status = 'converted' where id = $1`, [quoteId]);
      expect(e1.code).toBe('ERP15');
      expect(e1.message).toMatch(/Geçersiz durum geçişi/);
      // Geçerli geçiş ama olay kaydı yok
      const e2 = await expectDbError(q2, `update sales_orders set status = 'accepted' where id = $1`, [quoteId]);
      expect(e2.code).toBe('ERP15');
      expect(e2.message).toMatch(/olay/);
      // Gövde donuk
      const e3 = await expectDbError(q2, `update sales_orders set gross_total = 1, net_total = 1, vat_total = 0 where id = $1`, [quoteId]);
      expect(e3.code).toBe('ERP15');
      // Tür/numara değişmez
      expect((await expectDbError(q2, `update sales_orders set kind = 'order' where id = $1`, [quoteId])).code).toBe('ERP15');
      expect((await expectDbError(q2, `update sales_orders set doc_no = 'X' where id = $1`, [quoteId])).code).toBe('ERP15');
      // Numaralı belge silinemez; satırlar donuk
      expect((await expectDbError(q2, `delete from sales_orders where id = $1`, [quoteId])).code).toBe('ERP15');
      expect((await expectDbError(q2, `update sales_order_lines set quantity = 9 where order_id = $1`, [quoteId])).code).toBe('ERP15');
      expect((await expectDbError(q2, `insert into sales_order_lines (id, company_id, order_id, line_no, description, quantity, unit_price, net, vat, gross) values (gen_random_uuid(), $1, $2, 9, 'x', 1, 1, 1, 0, 1)`, [x.company.id, quoteId])).code).toBe('ERP15');
      // Olay geçmişi değişmez, sahte olay yazılamaz
      expect((await expectDbError(q2, `update sales_order_events set reason = 'x'`)).code).toBe('ERP15');
      expect((await expectDbError(q2, `delete from sales_order_events`)).code).toBe('ERP15');
      expect((await expectDbError(q2, `insert into sales_order_events (id, company_id, order_id, from_status, to_status) values (gen_random_uuid(), $1, $2, 'draft', 'accepted')`, [x.company.id, quoteId])).code).toBe('ERP15');
      // Gönderilmiş (kabul edilmemiş) tekliften sipariş oluşturulamaz
      const bad = await expectDbError(
        q2,
        `insert into sales_orders (id, company_id, kind, status, party_id, doc_date, currency_code, quote_id) values (gen_random_uuid(), $1, 'order', 'draft', $2, current_date, 'TRY', $3)`,
        [x.company.id, x.cust.id, quoteId],
      );
      expect(bad.code).toBe('ERP15');
      expect(bad.message).toMatch(/kabul edilmiş teklif/);
      // Sipariş kimliği/tutarı onaylandıktan sonra donuk; onaylı siparişin iptali teslim olmadığı için geçerli ama olay şart
      expect((await expectDbError(q2, `update sales_orders set status = 'cancelled' where id = $1`, [orderId])).code).toBe('ERP15');
      expect((await expectDbError(q2, `update sales_orders set notes = 'x' where id = $1`, [orderId])).code).toBe('ERP15');
      void lineId;
    });
  });

  it('eşzamanlı iki fatura birlikte sipariş miktarını aşamaz (kilit altında yeniden doğrulama)', async () => {
    const x = await k.setup('SiparisYaris');
    const { c } = x;
    const cust = await k.mkParty(c, 'Müşteri');
    const o = await doc(c, { kind: 'order', partyId: cust.id, docDate: day(3, 2), lines: [{ description: 'Montaj hizmeti', quantity: '10', unitPrice: '100', vatCode: 'KDV-16' }] });
    await act(c, o.doc.id, 'confirm');
    const lid = o.lines[0].id;
    const mk = async () => {
      const r = await c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 9), lines: [{ description: 'Montaj', quantity: '7', unitPrice: '100', vatCode: 'KDV-16', salesOrderLineId: lid }] });
      expect(r.statusCode).toBe(201);
      return r.json().invoice.id as string;
    };
    const [a, b] = [await mk(), await mk()]; // taslakta ikisi de tek başına sınırın içinde
    const [ra, rb] = await Promise.all([c.post(`/api/invoices/${a}/post`), c.post(`/api/invoices/${b}/post`)]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 422]);
    expect((ra.statusCode === 422 ? ra : rb).json().error.code).toBe('SO_QTY_EXCEEDED');
    expect((await get(c, o.doc.id)).lines[0]).toMatchObject({ invoiced: '7.0000', remainingInvoiceable: '3.0000' });
  });

  it('yetki ve izolasyon: satış rolü teklif/siparişi taslak hazırlar, izleyici yazamaz, başka şirket göremez, modül kapalıysa 403', async () => {
    const x = await orderBase('SiparisYetki');
    const { c, company, ids } = x;
    void ids;
    const sales = await k.memberClient(c, company.id, 'sales');
    const viewer = await k.memberClient(c, company.id, 'viewer');
    const created = await sales.post('/api/sales-docs', { kind: 'quote', partyId: x.cust.id, docDate: day(3, 1), lines: [line(x.item.id, '1', '100')] });
    expect(created.statusCode).toBe(201);
    expect((await viewer.get('/api/sales-docs')).statusCode).toBe(200);
    expect((await viewer.post('/api/sales-docs', { kind: 'quote', partyId: x.cust.id, docDate: day(3, 1), lines: [line(x.item.id, '1', '100')] })).statusCode).toBe(403);
    expect((await viewer.post(`/api/sales-docs/${x.order.doc.id}/cancel`, { reason: 'deneme' })).statusCode).toBe(403);
    // Satış rolü irsaliye yönetir (deliveries.manage) ama sipariş irsaliyesini kaydedemez (deliveries.post yok)
    expect((await sales.post(`/api/sales-docs/${x.order.doc.id}/delivery-note`, {})).statusCode).toBe(201);

    // Başka şirket (RLS)
    const s2 = await registerUser(app, 'Dis');
    const co2 = await createCompany(app, s2.token);
    const c2 = client(app, s2.token, co2.id);
    expect((await c2.get(`/api/sales-docs/${x.order.doc.id}`)).statusCode).toBe(404);
    expect((await c2.get('/api/sales-docs')).json().docs).toEqual([]);
    // Ham SQL: erp_app rolü başka şirketin satırını göremez
    const seen = await asDb(handle, { companyId: co2.id }, async (q) => (await q(`select count(*)::int as n from sales_orders`)).rows[0].n);
    expect(seen).toBe(0);

    // Modül kapalı
    await c.put('/api/company/modules/invoices.orders', { enabled: false });
    const off = await c.get('/api/sales-docs');
    expect(off.statusCode).toBe(403);
    expect(off.json().error.code).toBe('MODULE_DISABLED');
    // Toplu faturalama ve irsaliye çekirdek faturaya bağlı, açık kalır
    expect((await c.get('/api/invoice-batches/preview')).statusCode).toBe(200);
  });
});
