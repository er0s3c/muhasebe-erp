import { describe, expect, it } from 'vitest';
import { createLegacyCompany } from './legacy-company';
import { client, makeApp, registerUser, TODAY_LOCAL } from './helpers';

/**
 * Öneri 43, 44: yönlendirmeli yerleştirme ve toplama güzergâhı. Raf önerisi aynı kartı, tam sığmayı ve en dar rafı önceler;
 * rafa ayrılmamış kart konamaz; toplama listesi raf sırasına göre durak verir, rafta olmayan miktarı ayrıca gösterir.
 */
describe('depo yönlendirmesi', async () => {
  const { app } = await makeApp();

  it('raf önerisi, uyumluluk ve toplama sırası', async () => {
    const user = await registerUser(app, 'DepoYon');
    const company = await createLegacyCompany(app, user.token, { sector: 'MANUFACTURING_WHOLESALE' });
    const c = client(app, user.token, company.id);
    const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
      const r = await p;
      expect(r.statusCode, r.body).toBe(status);
      return r.json();
    };
    const wh = (await ok(c.get('/api/warehouses'))).warehouses[0].id as string;
    const item = async (code: string) => (await ok(c.post('/api/items', { code, name: code, unit: 'adet' }), 201)).item.id as string;
    const a = await item('YON-A'), b = await item('YON-B');
    const opening = (await ok(c.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: wh, lines: [{ itemId: a, quantity: '100', unitCost: '10' }, { itemId: b, quantity: '20', unitCost: '5' }] }), 201)).document.id;
    const lot = async (code: string, itemId: string, quantity: string) => (await ok(c.post('/api/wms/lots', { code, itemId, warehouseId: wh, sourceDocumentId: opening, quantity }))).record.id as string;
    const la = await lot('YON-LA', a, '100');
    await lot('YON-LB', b, '20');
    const bin = async (code: string, capacity: string, pickSequence: number, allowedItemIds: string[] = []) =>
      (await ok(c.post('/api/wms/bins', { warehouseId: wh, code, name: code, capacity, pickSequence, allowedItemIds }))).record.id as string;
    const r1 = await bin('R1', '50', 2), r2 = await bin('R2', '200', 1, [b]), r3 = await bin('R3', '0', 3);
    const suggest = async () => ok(c.get(`/api/wms/lots/${la}/placement-suggestions`));

    let s = await suggest();
    expect(s.unplaced).toBe('100.0000');
    // R2 yalnız B kartına ayrılmış; sınırsız R3 tamamını alır, R1 kısmen
    expect(s.suggestions.map((x: { code: string }) => x.code)).toEqual(['R3', 'R1']);
    expect(s.suggestions[1]).toMatchObject({ quantity: '50.0000', reasons: expect.arrayContaining([expect.stringContaining('Kısmen')]) });
    const place = (binId: string, quantity: string) => c.post('/api/wms/placements', { lotId: la, binId, quantity, requestKey: crypto.randomUUID() });
    expect((await place(r2, '10')).json().error.message).toContain('kabul etmiyor');
    await ok(place(r1, '40'));
    s = await suggest();
    expect(s.unplaced).toBe('60.0000');
    expect(s.suggestions[0]).toMatchObject({ binId: r1, reasons: expect.arrayContaining(['Aynı kart bu rafta']) });
    await ok(place(r3, '60'));
    expect((await suggest()).suggestions).toEqual([]);

    // Toplama listesi: R1 (sıra 2) önce, sonra R3; B rafta olmadığı için raf dışı
    const party = (await ok(c.post('/api/parties', { name: 'Toplama Müşterisi', kind: 'customer' }), 201)).party.id;
    const note = (await ok(c.post('/api/delivery-notes', { type: 'sales', partyId: party, noteDate: TODAY_LOCAL, warehouseId: wh, post: true, lines: [{ itemId: a, quantity: '50' }, { itemId: b, quantity: '5' }] }), 201)).note.id;
    const list = await ok(c.get(`/api/wms/pick-list?deliveryNoteId=${note}`));
    expect(list.stops.map((x: { binCode: string; quantity: string }) => [x.binCode, x.quantity])).toEqual([['R1', '40.0000'], ['R3', '10.0000']]);
    expect(list.shortfalls).toEqual([{ itemCode: 'YON-B', itemName: 'YON-B', quantity: '5.0000' }]);
    void r2;
  });
});
