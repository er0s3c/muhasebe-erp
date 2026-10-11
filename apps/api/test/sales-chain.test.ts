import { describe, expect, it } from 'vitest';
import { day, makeApp } from './helpers';
import { x2Kit } from './x2-helpers';

/**
 * Öneri 3: teklif → sipariş → irsaliye → fatura → tahsilat ve iade, kayıtlı bağlardan tek zincir olarak okunur. Hangi
 * belgeden başlanırsa başlansın aynı zincir döner; yetkisi olmayan aşama numara/tutar/bağlantı göstermez.
 */
describe('satış belge zinciri', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  it('teklif, sipariş, irsaliye, fatura, iade ve tahsilat tek zincirde; her başlangıç aynı zinciri verir; yetki aşamayı gizler', async () => {
    const x = await k.setup('Zincir');
    const { c, main } = x;
    const cust = await k.mkParty(c, 'Zincir Müşterisi');
    const item = await k.mkItem(c, 'Çimento', { salePrice: '100' });
    await k.receipt(c, day(3, 1), main.id, item.id, '10', '50');

    const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, label: string) => {
      const r = await p;
      if (r.statusCode >= 300) throw new Error(`${label}: ${r.statusCode} ${r.body}`);
      return r.json();
    };
    const quote = (await ok(c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: day(3, 2), warehouseId: main.id, lines: [{ itemId: item.id, quantity: '4', unitPrice: '100' }] }), 'teklif')).doc;
    for (const action of ['send', 'accept', 'convert']) await ok(c.post(`/api/sales-docs/${quote.id}/${action}`, {}), action);
    const orderId = (await ok(c.get(`/api/sales-docs/${quote.id}`), 'teklif oku')).doc.orderId as string;
    await ok(c.post(`/api/sales-docs/${orderId}/confirm`, {}), 'onay');
    const order = await ok(c.get(`/api/sales-docs/${orderId}`), 'sipariş');
    const noteId = (await ok(c.post(`/api/sales-docs/${orderId}/delivery-note`, { lines: [{ lineId: order.lines[0].id, quantity: '4' }] }), 'irsaliye')).noteId as string;
    await ok(c.post(`/api/delivery-notes/${noteId}/post`, {}), 'irsaliye kaydı');
    const note = await k.getNote(c, noteId);
    const invoice = await k.invPosted(c, { type: 'sales', partyId: cust.id, invoiceDate: day(3, 4), lines: [k.invLine(item.id, '4', '100', { deliveryLineId: note.lines[0].id })] });
    const ret = await k.invPosted(c, { type: 'sales_return', partyId: cust.id, returnOfId: invoice.invoice.id, invoiceDate: day(3, 5), lines: [k.invLine(item.id, '1', '100', { sourceLineId: invoice.lines[0].id })] });
    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'Banka', currency: 'TRY' }), 'banka')).account;
    const open = (await ok(c.get(`/api/parties/${cust.id}/open-items?type=receivable&asOf=${day(3, 6)}`), 'açık kalem')).receivable.items as { lineId: string; remaining: string }[];
    const target = open.find((o) => Number(o.remaining) > 100)!;
    const receipt = (await ok(c.post('/api/treasury/transactions', { type: 'receipt', date: day(3, 6), accountId: bank.id, amount: '100.00', partyId: cust.id, items: [{ lineId: target.lineId, amount: '100.00', settleAmount: '100.00' }] }), 'tahsilat')).transaction;

    const chain = async (client: typeof c, kind: string, id: string) => {
      const r = await client.get(`/api/sales-chain?kind=${kind}&id=${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { start: string; nodes: { kind: string; id: string; restricted: boolean; no: string | null; amount: string | null; path: string | null; type: string | null }[]; edges: { from: string; to: string }[]; truncated: boolean };
    };
    const fromInvoice = await chain(c, 'invoice', invoice.invoice.id);
    const keys = (r: Awaited<ReturnType<typeof chain>>) => r.nodes.map((n) => `${n.kind}:${n.id}`).sort();
    expect(fromInvoice.nodes.map((n) => n.kind)).toEqual(['quote', 'order', 'delivery', 'invoice', 'invoice', 'payment']);
    expect(fromInvoice.truncated).toBe(false);
    expect(fromInvoice.nodes.find((n) => n.id === ret.invoice.id)).toMatchObject({ type: 'sales_return', no: ret.invoice.invoiceNo, path: `/invoices/${ret.invoice.id}` });
    expect(fromInvoice.nodes.find((n) => n.kind === 'payment')).toMatchObject({ id: receipt.id, restricted: false, no: receipt.txnNo });
    expect(fromInvoice.edges).toEqual(expect.arrayContaining([
      { from: `quote:${quote.id}`, to: `order:${orderId}` },
      { from: `order:${orderId}`, to: `delivery:${noteId}` },
      { from: `delivery:${noteId}`, to: `invoice:${invoice.invoice.id}` },
      { from: `invoice:${invoice.invoice.id}`, to: `invoice:${ret.invoice.id}` },
      { from: `invoice:${invoice.invoice.id}`, to: `payment:${receipt.id}` },
    ]));
    // Hangi belgeden başlanırsa aynı zincir
    for (const [kind, id] of [['quote', quote.id], ['order', orderId], ['delivery', noteId], ['invoice', ret.invoice.id]] as const) {
      expect(keys(await chain(c, kind, id)), kind).toEqual(keys(fromInvoice));
    }
    // Teklif kimliği "sipariş" diye istense de türü kayıttan okunur
    expect((await chain(c, 'order', quote.id)).start).toBe(`quote:${quote.id}`);

    // Satış temsilcisi kasa/banka göremez: tahsilat aşaması görünür ama numara, tutar ve bağlantı gizli
    const sales = await k.memberClient(c, x.company.id, 'sales');
    const restricted = (await chain(sales, 'invoice', invoice.invoice.id)).nodes.find((n) => n.kind === 'payment');
    expect(restricted).toMatchObject({ restricted: true, no: null, amount: null, path: null });

    // Öneri 4: cari ve ürünün modüller arası ilişkili kayıtları; her bölüm kendi izniyle
    const related = async (client: typeof c, kind: string, id: string) => {
      const r = await client.get(`/api/related?kind=${kind}&id=${id}`);
      expect(r.statusCode, r.body).toBe(200);
      return Object.fromEntries((r.json().sections as { key: string; total: number; recent: { id: string; path: string }[] }[]).map((s) => [s.key, s]));
    };
    const party = await related(c, 'party', cust.id);
    expect(Object.fromEntries(Object.entries(party).map(([k, v]) => [k, v.total]))).toEqual({ quotes: 1, orders: 1, deliveries: 1, invoices: 2, payments: 1 });
    expect(party.payments!.recent[0]).toMatchObject({ id: receipt.id, path: `/treasury/transactions?open=${receipt.id}` });
    const product = await related(c, 'item', item.id);
    expect(Object.keys(product).sort()).toEqual(['deliveries', 'invoices', 'orders']);
    expect(product.invoices!.total).toBe(2);
    expect(Object.keys(await related(sales, 'party', cust.id))).not.toContain('payments');

    // Başka şirketin belgesi bulunamaz; geçersiz istek reddedilir
    const other = await k.setup('ZincirYabanci');
    expect((await other.c.get(`/api/related?kind=party&id=${cust.id}`)).statusCode).toBe(404);
    expect((await other.c.get(`/api/sales-chain?kind=invoice&id=${invoice.invoice.id}`)).statusCode).toBe(404);
    expect((await c.get('/api/sales-chain?kind=payment&id=' + receipt.id)).statusCode).toBe(400);
  });
});
