import { describe, expect, it } from 'vitest';
import { client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';

const { app } = await makeApp();
const must = (response: { statusCode: number; body: string; json: () => any }, status = 201) => {
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
};
async function setup() {
  const user = await registerUser(app, 'Replenishment');
  const company = await createCompany(app, user.token, { sector: 'COMMERCE', jurisdiction: 'TR' });
  return { c: client(app, user.token, company.id), user, company };
}
async function item(c: Awaited<ReturnType<typeof setup>>['c'], values: Record<string, unknown> = {}) {
  return must(await c.post('/api/items', { name: 'Tamamlanacak ürün', minLevel: '10', targetLevel: '20', purchasePrice: '2.345678', ...values })).item;
}

describe('Minimum ve hedef stoktan güvenli satın alma taslağı', () => {
  it('açık siparişi ve oluşturulan talebi düşer; yeniden deneme ikinci talep üretmez', async () => {
    const { c } = await setup();
    const product = await item(c);
    const party = must(await c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' })).party;
    must(await c.post('/api/purchase-orders', { partyId: party.id, currencyCode: 'TRY', lines: [{ itemId: product.id, description: product.name, unit: 'adet', quantity: '5', unitPrice: '2' }] }));
    const report = must(await c.get('/api/procurement/replenishment'), 200);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ onHand: '0.0000', onOrder: '5.0000', requested: '0.0000', suggested: '15.0000', estimateUnitPrice: '2.3457' });
    const payload = { items: [{ itemId: product.id, quantity: '15.0000' }] };
    const created = must(await c.post('/api/procurement/replenishment/draft', payload));
    expect(created.request.status).toBe('draft');
    expect(created.lines[0]).toMatchObject({ itemId: product.id, quantity: '15.0000', estUnitPrice: '2.3457' });
    const covered = must(await c.get('/api/procurement/replenishment'), 200).rows[0];
    expect(covered).toMatchObject({ requested: '15.0000', suggested: '0.0000' });
    const retry = await c.post('/api/procurement/replenishment/draft', payload);
    expect(retry.statusCode, retry.body).toBe(409);
    expect(retry.json().error.code).toBe('REPLENISHMENT_CHANGED');
    expect(must(await c.get('/api/purchase-requests'), 200).requests).toHaveLength(1);
  });
  it('kısmi mal kabulünde eldeki ve sipariş kalanı aynı miktarı iki kez saymaz', async () => {
    const { c } = await setup();
    const product = await item(c);
    const party = must(await c.post('/api/parties', { name: 'Kısmi tedarikçi', kind: 'supplier' })).party;
    const draft = must(await c.post('/api/purchase-orders', { partyId: party.id, currencyCode: 'TRY', lines: [{ itemId: product.id, description: product.name, unit: 'adet', quantity: '8', unitPrice: '2' }] }));
    const order = must(await c.post(`/api/purchase-orders/${draft.order.id}/issue`, {}), 200);
    const warehouse = must(await c.get('/api/warehouses'), 200).warehouses[0];
    must(await c.post(`/api/purchase-orders/${draft.order.id}/receipts`, { receiptDate: TODAY_LOCAL, externalNo: 'TARGET-MK-1', warehouseId: warehouse.id, lines: [{ orderLineId: order.lines[0].id, quantity: '3' }] }));
    expect(must(await c.get('/api/procurement/replenishment'), 200).rows[0]).toMatchObject({ onHand: '3.0000', onOrder: '5.0000', projected: '8.0000', suggested: '12.0000' });
  });
  it('hedef tahmin etmez, eski kartları değiştirmez ve farklı para biriminde tahmini fiyat uydurmaz', async () => {
    const { c } = await setup();
    const incomplete = await item(c, { targetLevel: undefined });
    const foreign = await item(c, { name: 'Dövizli hedef', purchaseCurrency: 'EUR' });
    const rows = must(await c.get('/api/procurement/replenishment'), 200).rows;
    expect(rows.find((row: { itemId: string }) => row.itemId === incomplete.id)).toMatchObject({ targetLevel: null, suggested: null });
    expect(rows.find((row: { itemId: string }) => row.itemId === foreign.id)).toMatchObject({ suggested: '20.0000', estimateUnitPrice: null });
    expect((await c.patch(`/api/items/${foreign.id}`, { minLevel: '21' })).json().error.code).toBe('STOCK_TARGET_BELOW_MINIMUM');
    expect((await c.post('/api/items', { name: 'Geçersiz hedef', minLevel: '10', targetLevel: '5' })).statusCode).toBe(422);
  });
  it('başka şirketin kalemini ve tek şube görünümünü öneriye katmaz', async () => {
    const a = await setup(), b = await setup();
    const product = await item(a.c);
    expect(must(await b.c.get('/api/procurement/replenishment'), 200).rows).toEqual([]);
    expect((await b.c.post('/api/procurement/replenishment/draft', { items: [{ itemId: product.id, quantity: '20.0000' }] })).statusCode).toBe(409);
    const branch = must(await a.c.post('/api/company/branches', { code: 'HEDEF', name: 'Hedef şubesi' })).branch;
    const scoped = await app.inject({ method: 'GET', url: '/api/procurement/replenishment', headers: { authorization: `Bearer ${a.user.token}`, 'x-company-id': a.company.id, 'x-branch-id': branch.id } });
    expect(scoped.statusCode, scoped.body).toBe(403);
    expect(scoped.json().error.code).toBe('BRANCH_SCOPE_INSUFFICIENT');
  });
});
