import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, day, makeApp, registerUser } from './helpers';

describe('üçlü eşleştirme: sipariş – mal kabul – fatura', async () => {
  const { app } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const project = (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '03', name: 'Betonarme' })).json().wbs[0] as { id: string };
    const sup = (await c.post('/api/parties', { name: 'A Beton Ltd.', kind: 'supplier' })).json().party as { id: string };
    const other = (await c.post('/api/parties', { name: 'B Yapı Ltd.', kind: 'supplier' })).json().party as { id: string };
    /** Tek hizmet satırlı verilmiş sipariş (2 gün × 4000). */
    const order = async (qty = '2', price = '4000', partyId = sup.id) => {
      const created = await c.post('/api/purchase-orders', {
        projectId: project.id,
        partyId,
        currencyCode: 'TRY',
        paymentDays: 30,
        lines: [{ description: 'Beton pompası kiralama', unit: 'gün', quantity: qty, unitPrice: price, wbsId: wbs.id }],
      });
      if (created.statusCode !== 201) throw new Error(created.body);
      const id = created.json().order.id as string;
      const issued = await c.post(`/api/purchase-orders/${id}/issue`, {});
      if (issued.statusCode !== 200) throw new Error(issued.body);
      return { id, lineId: issued.json().lines[0].id as string };
    };
    const receive = (orderId: string, lineId: string, qty: string) =>
      c.post(`/api/purchase-orders/${orderId}/receipts`, { receiptDate: day(3, 12), lines: [{ orderLineId: lineId, quantity: qty }] });
    let n = 0;
    const invoice = (lineId: string, qty: string, price: string, extra: Record<string, unknown> = {}, partyId = sup.id) =>
      c.post('/api/invoices', {
        type: 'purchase',
        partyId,
        currency: 'TRY',
        invoiceDate: day(3, 20),
        externalNo: `TED-${name}-${++n}`,
        post: true,
        lines: [{ description: 'Beton pompası kiralama', quantity: qty, unitPrice: price, orderLineId: lineId, projectId: project.id, wbsId: wbs.id }],
        ...extra,
      });
    const cost = async () => (await c.get(`/api/projects/${project.id}/cost-report?asOf=${day(12, 31)}`)).json().totals as { committed: string; actual: string };
    return { s, company, c, project, sup, other, order, receive, invoice, cost };
  }

  it('kabulsüz fatura reddedilir; kabulle geçer; taahhüt çift sayılmaz', async () => {
    const w = await world('Kabul');
    const o = await w.order();
    expect((await w.cost()).committed).toBe('8000.00');
    const early = await w.invoice(o.lineId, '2', '4000');
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('THREE_WAY_MISMATCH');
    expect(early.json().error.details.rows[0].flags).toContain('over_received');
    expect((await w.receive(o.id, o.lineId, '2')).statusCode).toBe(201);
    const ok = await w.invoice(o.lineId, '2', '4000');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().lines[0]).toMatchObject({ orderCode: expect.stringMatching(/^SIP-/) });
    const t = await w.cost();
    expect(t.committed).toBe('0.00'); // kabul + fatura birlikte yalnızca bir kez düşer
    expect(t.actual).toBe('8000.00');
    const view = (await w.c.get(`/api/purchase-orders/${o.id}`)).json();
    expect(view.lines[0].invoicedQty).toBe('2.0000');
    expect(view.invoices).toHaveLength(1);
    const m = (await w.c.get(`/api/invoices/${ok.json().invoice.id}/match`)).json().rows[0];
    expect(m).toMatchObject({ orderedQty: '2.0000', receivedQty: '2.0000', invoicedBeforeQty: '0.0000', flags: [] });
    // Bağlı kayıtlı fatura varken sipariş iptal edilemez
    expect((await w.c.post(`/api/purchase-orders/${o.id}/cancel`, { reason: 'Vazgeçildi' })).json().error.code).toBe('ORDER_HAS_INVOICES');
    // Faturayı iptal edince miktar yeniden faturalanabilir
    expect((await w.c.post(`/api/invoices/${ok.json().invoice.id}/cancel`, { reason: 'Hatalı', date: day(3, 21) })).statusCode).toBe(200);
    expect((await w.invoice(o.lineId, '2', '4000')).statusCode).toBe(201);
  });

  it('fazla miktar ve fiyat sapması: gerekçesiz reddedilir, yetkili gerekçesiyle geçer, tolerans ayarlanır', async () => {
    const w = await world('Sapma');
    const o = await w.order();
    await w.receive(o.id, o.lineId, '2');
    // Fiyat +%2,5 > varsayılan %2
    const pricey = await w.invoice(o.lineId, '2', '4100');
    expect(pricey.json().error.code).toBe('THREE_WAY_MISMATCH');
    expect(pricey.json().error.details.rows[0]).toMatchObject({ flags: ['price_variance'], priceDiffPct: '2.50' });
    // %1,25 tolerans içinde
    expect((await w.invoice(o.lineId, '1', '4050')).statusCode).toBe(201);
    // Toplam 3 > sipariş 2 ve kabul 2
    const over = await w.invoice(o.lineId, '2', '4000');
    expect(over.json().error.details.rows[0].flags).toEqual(['over_received', 'over_ordered']);
    // Gerekçe: yetkisiz (izleyici) kullanıcı veremez; yetkili verir
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect((await viewer.client.post('/api/invoices', { type: 'purchase', partyId: w.sup.id, invoiceDate: day(3, 20), matchOverrideReason: 'x yok', lines: [{ description: 'a', quantity: '1', unitPrice: '1' }] })).statusCode).toBe(403);
    const passed = await w.invoice(o.lineId, '2', '4000', { matchOverrideReason: 'Ek gün onaylandı (şantiye şefi)' });
    expect(passed.statusCode, passed.body).toBe(201);
    // Tolerans ayarı: fiyat %5
    expect((await w.c.put('/api/procurement/settings', { qtyTolerancePct: '0', priceTolerancePct: '5' })).json().settings).toEqual({ qtyTolerancePct: '0', priceTolerancePct: '5' });
    const o2 = await w.order('2', '4000');
    await w.receive(o2.id, o2.lineId, '2');
    expect((await w.invoice(o2.lineId, '2', '4100')).statusCode).toBe(201);
    expect((await w.c.put('/api/procurement/settings', { qtyTolerancePct: '101', priceTolerancePct: '5' })).statusCode).toBe(400);
  });

  it('eşleştirme özeti ve korumalar: faturasız kabul görünür; başka cari/taslak sipariş bağlanamaz', async () => {
    const w = await world('Ozet');
    const o = await w.order('4', '1000');
    await w.receive(o.id, o.lineId, '3');
    const row = (await w.c.get('/api/procurement/matching')).json().orders.find((r: { id: string }) => r.id === o.id);
    expect(row).toMatchObject({ orderedAmount: '4000.00', receivedAmount: '3000.00', uninvoicedReceiptAmount: '3000.00' });
    // Başka tedarikçinin faturası bu siparişe bağlanamaz (DB koruması)
    const wrong = await w.invoice(o.lineId, '1', '1000', {}, w.other.id);
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('PROCUREMENT_RULE_VIOLATION');
    // Alış dışı faturada sipariş bağı şema denetiminden geçmez
    const exp = await w.c.post('/api/invoices', { type: 'expense', partyId: w.sup.id, invoiceDate: day(3, 20), lines: [{ description: 'a', quantity: '1', unitPrice: '1', orderLineId: o.lineId }] });
    expect(exp.statusCode).toBe(400);
  });
});
