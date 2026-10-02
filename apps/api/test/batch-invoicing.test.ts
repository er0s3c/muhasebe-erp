import { describe, expect, it } from 'vitest';
import { asOwner, day, expectDbError, makeApp } from './helpers';
import { x2Kit } from './x2-helpers';

describe('toplu faturalama (X2)', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  /** Stok 100 adet 50 maliyet; iki müşteri; kart satış fiyatı 120. */
  async function base(name: string) {
    const ctx = await k.setup(name);
    const { c, main } = ctx;
    const a = await k.mkParty(c, 'Ali Yılmaz');
    const b = await k.mkParty(c, 'Burak Ltd.');
    const item = await k.mkItem(c, 'Çimento', { salePrice: '120' });
    await k.receipt(c, day(3, 1), main.id, item.id, '100', '50');
    const dn = (party: { id: string }, date: string, qty: string, extra: Record<string, unknown> = {}) =>
      k.posted(c, { type: 'sales', partyId: party.id, noteDate: date, warehouseId: main.id, lines: [k.dline(item.id, qty)], ...extra });
    return { ...ctx, a, b, item, dn };
  }
  const run = (c: any, noteIds: string[], extra: Record<string, unknown> = {}) =>
    c.post('/api/invoice-batches', { noteIds, invoiceDate: day(4, 1), grouping: 'party', post: true, ...extra });

  it('önizleme: cari → irsaliye → satır, fiyat kaynağı, tutarlar, sorunlu irsaliye engellenir, bekleyen iade bilgisi', async () => {
    const x = await base('ToplPrev');
    const { c, main } = x;
    const n1 = await x.dn(x.a, day(3, 5), '10');
    const n2 = await x.dn(x.a, day(3, 6), '5');
    const n3 = await x.dn(x.b, day(3, 7), '4');
    const noPrice = await k.mkItem(c, 'Fiyatsız mal');
    await k.receipt(c, day(3, 1), main.id, noPrice.id, '10', '5');
    const n4 = await k.posted(c, { type: 'sales', partyId: x.b.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(noPrice.id, '2')] });
    // Bekleyen iade: n1'in 2'si iade, iade faturası yok
    await k.note(c, { type: 'sales_return', partyId: x.a.id, noteDate: day(3, 9), warehouseId: main.id, returnOfId: n1.note.id, post: true, lines: [k.dline(x.item.id, '2', { sourceLineId: n1.lines[0].id })] });

    const p = (await c.get(`/api/invoice-batches/preview?from=${day(3, 1)}&to=${day(3, 31)}&grouping=party`)).json();
    expect(p.parties.map((q: any) => q.partyName)).toEqual(['Ali Yılmaz', 'Burak Ltd.']);
    const ali = p.parties[0];
    expect(ali).toMatchObject({ invoiceCount: 1, pendingReturns: 1 });
    expect(ali.notes.map((n: any) => [n.noteNo, n.blocked, n.net, n.gross])).toEqual([[n1.note.noteNo, false, '1200.00', '1392.00'], [n2.note.noteNo, false, '600.00', '696.00']]);
    expect(ali.notes[0].lines[0]).toMatchObject({ unitPrice: '120.000000', priceSource: 'item', vatCode: 'KDV-16', quantity: '10.0000' });
    const burak = p.parties[1];
    const blocked = burak.notes.find((n: any) => n.noteId === n4.note.id);
    expect(blocked).toMatchObject({ blocked: true, issues: [expect.objectContaining({ code: 'NO_PRICE' })] });
    expect(burak.invoiceCount).toBe(1); // yalnızca fiyatı olan n3
    expect(p.totals).toEqual({ notes: 4, invoiceable: 3, invoices: 2 });
    // İrsaliye bazında bölme: 3 fatura
    expect((await c.get(`/api/invoice-batches/preview?grouping=note`)).json().totals.invoices).toBe(3);
    // Cari ve tarih süzgeci
    expect((await c.get(`/api/invoice-batches/preview?partyId=${x.b.id}&from=${day(3, 1)}&to=${day(3, 7)}`)).json().totals.notes).toBe(1);
    void n3;
  });

  it('çalıştırma: cari başına tek fatura, irsaliyeye bağlı (stok tekrar hareket etmez), yevmiye dengeli, tekrar çalıştırma yeni fatura üretmez', async () => {
    const x = await base('ToplRun');
    const { c } = x;
    const n1 = await x.dn(x.a, day(3, 5), '10');
    const n2 = await x.dn(x.a, day(3, 6), '5');
    const n3 = await x.dn(x.b, day(3, 7), '4');
    const stockBefore = await k.stockInfo(c, x.item.id);

    const r = await run(c, [n1.note.id, n2.note.id, n3.note.id]);
    expect(r.statusCode).toBe(201);
    const res = r.json();
    expect(res.failed).toEqual([]);
    expect(res.created).toHaveLength(2);
    const ali = res.created.find((i: any) => i.partyName === 'Ali Yılmaz');
    expect(ali).toMatchObject({ status: 'posted', gross: '2088.0000', noteIds: expect.arrayContaining([n1.note.id, n2.note.id]) });
    expect(ali.invoiceNo).toMatch(/^SF-/);

    const inv = (await c.get(`/api/invoices/${ali.invoiceId}`)).json();
    expect(inv.invoice).toMatchObject({ type: 'sales', status: 'posted', stockDocumentId: null, grossTotal: '2088.0000', invoiceDate: day(4, 1) });
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]).toMatchObject({ unitPrice: '120.000000', deliveryNoteNo: n1.note.noteNo });
    const j = await k.journalOf(c, inv.invoice.journalEntryId);
    expect(j.lines).toEqual([['120', 2088, 0], ['600', 0, 1800], ['391', 0, 288], ['621', 750, 0], ['150', 0, 750]]);
    expect(await k.stockInfo(c, x.item.id)).toEqual(stockBefore); // stok yeniden hareket etmedi
    for (const n of [n1, n2, n3]) expect((await k.getNote(c, n.note.id)).note.invoicing).toBe('invoiced');
    expect(await k.recon(c)).toMatchObject({ difference: '0.0000', pendingDeliveries: { sales: '0.0000' }, unexplained: '0.0000' });

    // Çalıştırma kaydı ve sonuç kalemleri
    const hist = (await c.get('/api/invoice-batches')).json().batches;
    expect(hist[0]).toMatchObject({ id: res.batchId, invoicesCreated: 2, invoicesFailed: 0, grouping: 'party', post: true });
    const items = (await c.get(`/api/invoice-batches/${res.batchId}`)).json().items;
    expect(items.map((i: any) => [i.status, i.invoiceNo ? 'no' : 'yok'])).toEqual([['created', 'no'], ['created', 'no']]);

    // İdempotans: aynı irsaliyelerle tekrar → yeni fatura yok, atlananlar listelenir
    const again = (await run(c, [n1.note.id, n2.note.id, n3.note.id])).json();
    expect(again.created).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(again.skipped.map((s: any) => s.noteId).sort()).toEqual([n1.note.id, n2.note.id, n3.note.id].sort());
    expect((await c.get('/api/invoices?type=sales&limit=100')).json().total).toBe(2);
  });

  it('irsaliye bazında bölme: her irsaliye ayrı fatura; kısmen faturalanmış irsaliyenin kalanı faturalanır', async () => {
    const x = await base('ToplNote');
    const { c } = x;
    const n1 = await x.dn(x.a, day(3, 5), '10');
    const n2 = await x.dn(x.a, day(3, 6), '5');
    // n1'in 4'ü elle faturalandı
    await k.invPosted(c, { type: 'sales', partyId: x.a.id, invoiceDate: day(3, 20), lines: [k.invLine(x.item.id, '4', '100', { deliveryLineId: n1.lines[0].id })] });
    const res = (await run(c, [n1.note.id, n2.note.id], { grouping: 'note' })).json();
    expect(res.created).toHaveLength(2);
    const first = (await c.get(`/api/invoices/${res.created[0].invoiceId}`)).json();
    expect(first.lines[0]).toMatchObject({ quantity: '6.0000', deliveryNoteNo: n1.note.noteNo }); // kalan 6
    expect((await k.getNote(c, n1.note.id)).note.invoicing).toBe('invoiced');
  });

  it('kısmi hata: fiyatı olmayan irsaliye ve kuru bulunamayan dövizli cari raporlanır, diğer cariler faturalanır', async () => {
    const x = await base('ToplHata');
    const { c, main } = x;
    const good = await x.dn(x.a, day(3, 5), '3');
    // Fiyatsız mal
    const noPrice = await k.mkItem(c, 'Fiyatsız mal');
    await k.receipt(c, day(3, 1), main.id, noPrice.id, '10', '5');
    const bad1 = await k.posted(c, { type: 'sales', partyId: x.b.id, noteDate: day(3, 8), warehouseId: main.id, lines: [k.dline(noPrice.id, '2')] });
    // Dövizli cari: kart fiyatı EUR, EUR kuru girilmemiş → kayıtta hata
    const eur = await k.mkParty(c, 'Euro Müşteri', 'customer', { currencyCode: 'EUR' });
    const eurItem = await k.mkItem(c, 'Euro mal', { salePrice: '10', saleCurrency: 'EUR' });
    await k.receipt(c, day(3, 1), main.id, eurItem.id, '10', '5');
    const bad2 = await k.posted(c, { type: 'sales', partyId: eur.id, noteDate: day(3, 9), warehouseId: main.id, lines: [k.dline(eurItem.id, '2')] });

    const r = await run(c, [good.note.id, bad1.note.id, bad2.note.id]);
    expect(r.statusCode).toBe(201);
    const res = r.json();
    expect(res.created).toHaveLength(1);
    expect(res.created[0]).toMatchObject({ partyName: 'Ali Yılmaz', status: 'posted' });
    expect(res.failed.map((f: any) => [f.partyName, f.code]).sort()).toEqual([['Burak Ltd.', 'NO_PRICE'], ['Euro Müşteri', expect.any(String)]].sort());
    const eurFail = res.failed.find((f: any) => f.partyName === 'Euro Müşteri');
    expect(eurFail.message).toMatch(/EUR/);
    // Başarısız kayıt hiçbir fatura/numara izi bırakmadı: yalnızca 1 fatura, numara atlamadı
    expect((await c.get('/api/invoices?type=sales&limit=100')).json().total).toBe(1);
    expect((await k.getNote(c, bad2.note.id)).note.invoicing).toBe('open');
    expect(res.created[0].invoiceNo).toMatch(/-000001$/); // geri alınan kayıt numara tüketmedi
    // Kur girilmeden dövizli cari kayıtta başarısız olan (savepoint geri alındı) irsaliye hâlâ faturalanabilir durumda
    const again = (await run(c, [bad2.note.id])).json();
    expect(again.failed).toHaveLength(1);
    expect(again.created).toEqual([]);
    const items = (await c.get(`/api/invoice-batches/${res.batchId}`)).json().items;
    expect(items.map((i: any) => i.status).sort()).toEqual(['created', 'failed', 'failed']);
  });

  it('taslak olarak toplu faturalama: invoices.post gerekmez, taslaktaki satırlar ikinci kez alınmaz, veritabanı çift toplu faturayı engeller', async () => {
    const x = await base('ToplTaslak');
    const { c, company } = x;
    const n1 = await x.dn(x.a, day(3, 5), '10');
    const res = (await run(c, [n1.note.id], { post: false })).json();
    expect(res.created).toEqual([expect.objectContaining({ status: 'draft', invoiceNo: null })]);
    const invId = res.created[0].invoiceId;
    expect((await c.get(`/api/invoices/${invId}`)).json().invoice.status).toBe('draft');
    // Ön izlemede ve ikinci çalıştırmada: taslak faturada → engellendi
    const p = (await c.get('/api/invoice-batches/preview')).json();
    expect(p.parties[0].notes[0]).toMatchObject({ blocked: true, issues: [expect.objectContaining({ code: 'IN_DRAFT_INVOICE' })] });
    const again = (await run(c, [n1.note.id], { post: false })).json();
    expect(again.created).toEqual([]);
    expect(again.failed[0]).toMatchObject({ code: 'IN_DRAFT_INVOICE' });

    // Veritabanı koruması: aynı irsaliye satırını başka bir toplu faturaya sokmak (ham SQL) reddedilir
    await asOwner(async (q) => {
      const batch = (await q(`select id from invoice_batches where company_id = $1`, [company.id])).rows[0].id;
      const item = await q(
        `insert into invoice_batch_items (id, company_id, batch_id, party_id, status, invoice_id) values (gen_random_uuid(), $1, $2, $3, 'created', null) returning id`,
        [company.id, batch, x.a.id],
      );
      const inv = await q(
        `insert into invoices (id, company_id, type, status, invoice_date, party_id, currency_code, net_total, vat_total, gross_total)
         values (gen_random_uuid(), $1, 'sales', 'draft', current_date, $2, 'TRY', 0, 0, 0) returning id`,
        [company.id, x.a.id],
      );
      const e = await expectDbError(
        q,
        `insert into invoice_lines (id, company_id, invoice_id, line_no, item_id, description, quantity, unit_price, net, vat, gross, delivery_line_id, batch_item_id)
         values (gen_random_uuid(), $1, $2, 1, $3, 'x', 1, 1, 1, 0, 1, $4, $5)`,
        [company.id, inv.rows[0].id, x.item.id, n1.lines[0].id, item.rows[0].id],
      );
      expect(e.code).toBe('ERP15');
      expect(e.message).toMatch(/başka bir toplu faturada/);
      // Toplu işlem kayıtları değiştirilemez/silinemez
      expect((await expectDbError(q, `delete from invoice_batch_items`)).code).toBe('ERP15');
      expect((await expectDbError(q, `delete from invoice_batches`)).code).toBe('ERP15');
    });
    // Taslak silinince irsaliye yeniden faturalanabilir
    expect((await c.delete(`/api/invoices/${invId}`)).statusCode).toBe(200);
    const redo = (await run(c, [n1.note.id])).json();
    expect(redo.created).toHaveLength(1);
  });

  it('eşzamanlı iki toplu faturalama aynı irsaliyeyi çift faturalayamaz', async () => {
    const x = await base('ToplYaris');
    const { c } = x;
    const n1 = await x.dn(x.a, day(3, 5), '10');
    const [r1, r2] = await Promise.all([run(c, [n1.note.id]), run(c, [n1.note.id])]);
    const created = [r1, r2].flatMap((r) => r.json().created ?? []);
    expect(created).toHaveLength(1);
    expect((await c.get('/api/invoices?type=sales&limit=100')).json().total).toBe(1);
    expect((await k.getNote(c, n1.note.id)).lines[0]).toMatchObject({ invoicedQty: '10.0000', remainingQty: '0.0000' });
  });

  it('yetki: satış rolü taslak toplu faturalar ama kayıt isteyemez; izleyici erişemez; sipariş fiyatı kartın fiyatını ezer', async () => {
    const x = await base('ToplYetki');
    const { c, company, main } = x;
    const n1 = await x.dn(x.a, day(3, 5), '4');
    const sales = await k.memberClient(c, company.id, 'sales');
    const viewer = await k.memberClient(c, company.id, 'viewer');
    expect((await viewer.get('/api/invoice-batches/preview')).statusCode).toBe(403);
    expect((await viewer.post('/api/invoice-batches', { noteIds: [n1.note.id], invoiceDate: day(4, 1), post: false })).statusCode).toBe(403);
    expect((await run(sales, [n1.note.id])).statusCode).toBe(403); // post: true
    const draft = await run(sales, [n1.note.id], { post: false });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().created[0].status).toBe('draft');

    // Sipariş fiyatı (95) kartın fiyatından (120) önce gelir; irsaliye siparişe bağlı
    const o = await c.post('/api/sales-docs', { kind: 'order', partyId: x.b.id, docDate: day(3, 2), warehouseId: main.id, lines: [{ itemId: x.item.id, quantity: '6', unitPrice: '95', discountPct: '10' }] });
    const oid = o.json().doc.id;
    await c.post(`/api/sales-docs/${oid}/confirm`, {});
    const lineId = o.json().lines[0].id;
    const n2 = await k.posted(c, { type: 'sales', partyId: x.b.id, noteDate: day(3, 9), warehouseId: main.id, lines: [k.dline(x.item.id, '6', { salesOrderLineId: lineId })] });
    const p = (await c.get(`/api/invoice-batches/preview?partyId=${x.b.id}`)).json();
    expect(p.parties[0].notes[0].lines[0]).toMatchObject({ unitPrice: '95.000000', discountPct: '10.0000', priceSource: 'order' });
    const res = (await run(c, [n2.note.id])).json();
    const inv = (await c.get(`/api/invoices/${res.created[0].invoiceId}`)).json();
    expect(inv.lines[0]).toMatchObject({ unitPrice: '95.000000', discountPct: '10.0000', net: '513.0000', salesOrderLineId: lineId });
    expect((await c.get(`/api/sales-docs/${oid}`)).json().doc.fulfilment).toEqual({ delivery: 'full', invoicing: 'full' });
  });
});
