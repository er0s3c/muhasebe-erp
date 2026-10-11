import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';

/** Öneri 45: kör sayım, tolerans dışı farkta bağımsız yeniden sayım ve döngüsel sayım seçimi. */
describe('sayım: kör, yeniden sayım, döngüsel', async () => {
  const { app } = await makeApp();

  it('kör sayımda sayan farkı görmez; tolerans dışı fark başka kişinin yeniden sayımı olmadan işlenmez; döngüsel sayım sayılmamışı seçer', async () => {
    const s = await registerUser(app, 'Sayim');
    const company = await createCompany(app, s.token);
    const owner = client(app, s.token, company.id);
    const sm = await addMember(app, owner, company.id, 'site_manager', 'sayan');
    const ok = async (p: ReturnType<typeof owner.get>, status = 200) => { const r = await p; expect(r.statusCode, r.body).toBe(status); return r.json(); };
    const wh = (await ok(owner.get('/api/warehouses'))).warehouses[0].id as string;
    const item = async (code: string) => (await ok(owner.post('/api/items', { code, name: code, unit: 'adet' }), 201)).item.id as string;
    const a = await item('SAY-A'), b = await item('SAY-B'), cc = await item('SAY-C');
    await ok(owner.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: wh, lines: [{ itemId: a, quantity: '100', unitCost: '1' }, { itemId: b, quantity: '50', unitCost: '1' }, { itemId: cc, quantity: '10', unitCost: '1' }] }), 201);

    const count = (await ok(owner.post('/api/stock-counts', { warehouseId: wh, countDate: TODAY_LOCAL, prefill: 'empty', blind: true, recountTolerancePct: '5' }), 201)).count.id as string;
    await ok(sm.client.put(`/api/stock-counts/${count}`, { lines: [{ itemId: a, countedQty: '100' }, { itemId: b, countedQty: '40' }] }));
    const blind = await ok(sm.client.get(`/api/stock-counts/${count}`));
    expect(blind.lines.every((l: { systemQty: unknown; diffQty: unknown }) => l.systemQty === null && l.diffQty === null)).toBe(true);
    expect(blind.summary).toMatchObject({ surplus: null, shortage: null });
    const full = await ok(owner.get(`/api/stock-counts/${count}`));
    expect(full.lines.find((l: { itemId: string }) => l.itemId === b)).toMatchObject({ systemQty: '50.0000', recountRequired: true });
    expect(full.summary.recountRequired).toBe(1);

    const blocked = await owner.post(`/api/stock-counts/${count}/post`, {});
    expect(blocked.json().error).toMatchObject({ code: 'COUNT_RECOUNT_REQUIRED', details: { items: ['SAY-B'] } });
    expect((await sm.client.put(`/api/stock-counts/${count}/recount`, { lines: [{ itemId: b, recountQty: '45' }] })).json().error.code).toBe('COUNT_RECOUNT_SAME_USER');
    await ok(owner.put(`/api/stock-counts/${count}/recount`, { lines: [{ itemId: b, recountQty: '45' }] }));
    // Değişmeyen satır kaydedilince ilk sayan ve yeniden sayım korunur
    await ok(sm.client.put(`/api/stock-counts/${count}`, { lines: [{ itemId: a, countedQty: '100' }, { itemId: b, countedQty: '40' }] }));
    const posted = await ok(owner.post(`/api/stock-counts/${count}/post`, {}));
    expect(posted.lines.find((l: { itemId: string }) => l.itemId === b)).toMatchObject({ systemQty: '50.0000', diffQty: '-5.0000', recountQty: '45.0000' });

    // Döngüsel sayım: hiç sayılmamış C önce gelir
    const cycle = (await ok(owner.post('/api/stock-counts', { warehouseId: wh, countDate: TODAY_LOCAL, prefill: 'cycle', cycleLimit: 1 }), 201));
    expect(cycle.lines.map((l: { itemId: string }) => l.itemId)).toEqual([cc]);
  });
});
