import { describe, expect, it } from 'vitest';
import { asOwner, day, expectDbError, makeApp } from './helpers';
import { x2Kit } from './x2-helpers';

/**
 * Öneri 52: iade kabulünden son karara iş akışı. Kalite kararı istenen satış iadesinin miktarı karar verilene kadar satışa
 * kapalıdır; karar parça parça verilir (satışa aç / hurda), hurda fire belgesiyle stoktan düşer; kararlı iade iptal edilemez.
 */
describe('iade kalite kararı', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  it('bekleyen iade satışa kapalı; satışa açma ve hurda kararı', async () => {
    const { c, main } = await k.setup('IadeKalite');
    const cust = await k.mkParty(c, 'İade Müşterisi');
    const item = await k.mkItem(c, 'Kalite Kartı');
    await k.receipt(c, day(3, 1), main.id, item.id, '10', '50');
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '10')] });

    // Kalite kararı yalnız satış iadesinde istenir
    const wrong = await k.note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 6), warehouseId: main.id, inspectionRequired: true, lines: [k.dline(item.id, '1')] });
    expect(wrong.statusCode).toBe(400);

    const ret = await k.posted(c, {
      type: 'sales_return', partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: sale.note.id, inspectionRequired: true,
      lines: [k.dline(item.id, '6', { sourceLineId: sale.lines[0].id })],
    });
    expect(ret.note.inspectionRequired).toBe(true);
    const lineId = ret.lines[0].id as string;
    let list = (await c.get('/api/return-inspections')).json();
    expect(list.lines).toEqual([expect.objectContaining({ lineId, quantity: '6.0000', decided: '0.0000', pending: '6.0000' })]);

    // Depoda 6 var, 6'sı kalite bekliyor: satılamaz
    const blocked = await k.note(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 9), warehouseId: main.id, post: true, lines: [k.dline(item.id, '1')] });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('RETURN_INSPECTION_HOLD');
    // Yeni giriş satılabilir; bekleyen miktara dokunulmaz
    await k.receipt(c, day(3, 9), main.id, item.id, '4', '50');
    await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 10), warehouseId: main.id, lines: [k.dline(item.id, '4')] });

    const decide = (body: Record<string, unknown>) => c.post('/api/return-inspections/decide', { noteLineId: lineId, ...body });
    const restock = await decide({ quantity: '2', decision: 'restock', reason: 'unwanted' });
    expect(restock.statusCode, restock.body).toBe(200);
    expect(restock.json().lines[0]).toMatchObject({ decided: '2.0000', pending: '4.0000' });
    // Satışa açılan 2 artık satılabilir
    await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 11), warehouseId: main.id, lines: [k.dline(item.id, '2')] });

    const scrap = await decide({ quantity: '3', decision: 'scrap', reason: 'damaged', note: 'Kutu ezik' });
    expect(scrap.statusCode, scrap.body).toBe(200);
    expect(scrap.json().stockDocumentId).toBeTruthy();
    expect(scrap.json().lines[0].decisions).toEqual([
      expect.objectContaining({ decision: 'restock', quantity: '2.0000' }),
      expect.objectContaining({ decision: 'scrap', reason: 'damaged', quantity: '3.0000', note: 'Kutu ezik', stockDocumentNo: expect.any(String) }),
    ]);
    // 10 + 4 − 10 + 6 − 4 − 2 − 3 (hurda) = 1; o da kalite bekliyor
    expect(await k.stockInfo(c, item.id)).toMatchObject({ qty: '1.0000' });

    const over = await decide({ quantity: '2', decision: 'restock', reason: 'other' });
    expect(over.json().error.code).toBe('RETURN_DECISION_EXCEEDS');

    // Kararı verilmiş iade iptal edilemez; kayıtlar değişmez
    const cancel = await c.post(`/api/delivery-notes/${ret.note.id}/cancel`, { reason: 'hatalı iade' });
    expect(cancel.json().error.code).toBe('RETURN_DECIDED');
    await asOwner(async (q) => {
      const e = await expectDbError(q, `update return_decisions set quantity = 1 where note_line_id = $1`, [lineId]);
      expect(e.code).toBe('ERP04');
    });

    await decide({ quantity: '1', decision: 'restock', reason: 'other' });
    list = (await c.get('/api/return-inspections')).json();
    expect(list.lines).toEqual([]);
    expect((await c.get('/api/return-inspections?status=decided')).json().lines).toHaveLength(1);
  });

  it('kalite kararı istenmeyen iadeye karar verilemez', async () => {
    const { c, main } = await k.setup('IadeKaliteYok');
    const cust = await k.mkParty(c, 'Müşteri');
    const item = await k.mkItem(c, 'Kart');
    await k.receipt(c, day(3, 1), main.id, item.id, '5', '10');
    const sale = await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 5), warehouseId: main.id, lines: [k.dline(item.id, '5')] });
    const ret = await k.posted(c, {
      type: 'sales_return', partyId: cust.id, noteDate: day(3, 8), warehouseId: main.id, returnOfId: sale.note.id,
      lines: [k.dline(item.id, '2', { sourceLineId: sale.lines[0].id })],
    });
    expect(ret.note.inspectionRequired).toBe(false);
    const r = await c.post('/api/return-inspections/decide', { noteLineId: ret.lines[0].id, quantity: '1', decision: 'restock', reason: 'other' });
    expect(r.json().error.code).toBe('RETURN_INSPECTION_NOT_REQUIRED');
    // Kalite kararı istenmeyen iade hemen satılabilir
    await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(3, 9), warehouseId: main.id, lines: [k.dline(item.id, '2')] });
  });
});
