import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';
const { app } = await makeApp();
const must = (r: { statusCode: number; body: string; json: () => any }, status = 201) => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
};
async function setup(name: string, sector = 'COMMERCE') {
  const owner = await registerUser(app, name),
    company = await createCompany(app, owner.token, { sector, jurisdiction: 'TR' });
  return { owner, company, c: client(app, owner.token, company.id) };
}
const query = `from=${TODAY_LOCAL}&to=${TODAY_LOCAL}`;
describe('Ticaret ve market ortak akışları ve deterministik raporlar', () => {
  it.each(['COMMERCE', 'RETAIL_MARKET'])(
    '%s satın alma → kabul → fatura → POS satış/iade stok değerini tek kez taşır',
    async (sector) => {
      const { owner, c } = await setup(`Ticaret${sector}`, sector);
      const navigation = must(await c.get('/api/navigation'), 200);
      expect(navigation.modules).toEqual(
        expect.arrayContaining(['core.procurement', 'sales.pos', 'sales.logistics']),
      );
      expect((await c.get('/api/logistics/shipments')).statusCode).toBe(200);
      const warehouseId = must(await c.get('/api/pos/bootstrap'), 200).warehouses[0].id;
      const supplier = must(
        await c.post('/api/parties', { name: 'Ortak tedarikçi', kind: 'supplier' }),
      ).party;
      const item = must(
        await c.post('/api/items', {
          name: 'Ticari ürün',
          salePrice: '100',
          saleCurrency: 'TRY',
          unit: 'adet',
          inventoryRole: 'merchandise',
        }),
      ).item;
      const draft = must(
        await c.post('/api/purchase-orders', {
          partyId: supplier.id,
          currencyCode: 'TRY',
          lines: [
            {
              itemId: item.id,
              description: 'Ticari ürün',
              unit: 'adet',
              quantity: '10',
              unitPrice: '40',
            },
          ],
        }),
      );
      const issued = must(await c.post(`/api/purchase-orders/${draft.order.id}/issue`, {}), 200);
      expect(issued.order.projectId).toBeNull();
      const receipt = must(
        await c.post(`/api/purchase-orders/${draft.order.id}/receipts`, {
          receiptDate: TODAY_LOCAL,
          externalNo: 'TIC-MK-1',
          warehouseId,
          lines: [{ orderLineId: issued.lines[0].id, quantity: '10' }],
        }),
      );
      const note = must(
        await c.get(`/api/delivery-notes/${receipt.receipts[0].deliveryNoteId}`),
        200,
      );
      must(
        await c.post('/api/invoices', {
          type: 'purchase',
          partyId: supplier.id,
          currency: 'TRY',
          invoiceDate: TODAY_LOCAL,
          externalNo: 'TIC-F-1',
          warehouseId,
          post: true,
          lines: [
            {
              itemId: item.id,
              description: item.name,
              quantity: '10',
              unitPrice: '40',
              orderLineId: issued.lines[0].id,
              deliveryLineId: note.lines[0].id,
            },
          ],
        }),
      );
      expect(must(await c.get(`/api/items/${item.id}`), 200).stock).toMatchObject({
        qty: '10.0000',
        value: '400.0000',
      });
      const cash = must(
        await c.post('/api/treasury/accounts', { kind: 'cash', name: 'Kasa', currency: 'TRY' }),
      ).account;
      const till = must(
        await c.post('/api/pos/tills', {
          name: 'Ana kasa',
          warehouseId,
          cashAccountId: cash.id,
          assignedUserIds: [owner.userId],
        }),
      ).till;
      const session = must(
        await c.post('/api/pos/sessions', { tillId: till.id, openingCash: '0' }),
      ).session;
      const sale = must(
        await c.post(`/api/pos/sessions/${session.id}/sales`, {
          requestId: randomUUID(),
          lines: [{ itemId: item.id, quantity: '2' }],
          payments: [{ method: 'cash', amount: '200' }],
        }),
      );
      must(
        await c.post(`/api/pos/sales/${sale.sale.id}/returns`, {
          requestId: randomUUID(),
          sessionId: session.id,
          reason: 'Ürün değişimi',
          lines: [{ sourceLineId: sale.invoice.lines[0].id, quantity: '1' }],
          refunds: [{ method: 'cash', amount: '100' }],
        }),
      );
      expect(must(await c.get(`/api/items/${item.id}`), 200).stock).toMatchObject({
        qty: '9.0000',
        value: '360.0000',
      });
      expect(
        Number(must(await c.get(`/api/treasury/accounts/${cash.id}`), 200).account.balance),
      ).toBe(100);
      const stock = must(await c.get(`/api/reports/stock-analytics?${query}`), 200);
      expect(stock.rows.find((r: { itemId: string }) => r.itemId === item.id)).toMatchObject({
        salesCost: '40.0000',
        closingQty: '9.0000',
        closingValue: '360.0000',
        abcClass: 'A',
        turnover: '0.2222',
      });
      const performance = must(await c.get(`/api/reports/supplier-performance?${query}`), 200);
      expect(performance.rows).toHaveLength(1);
      expect(performance.rows[0]).toMatchObject({
        currency: 'TRY',
        orderCount: 1,
        orderedAmount: '400.0000',
        receivedAmount: '400.0000',
        fulfilmentPct: '100.00',
        receiptCount: 1,
        averageLeadDays: '0.00',
        purchaseAmount: '400.0000',
        returnPct: '0.00',
        priceComparedLines: 1,
        priceVariancePct: '0.00',
      });
    },
  );
  it('boş veriye oran üretmez ve farklı para birimini tek toplamda toplamaz', async () => {
    const { c } = await setup('AnalizBos');
    expect(
      must(await c.get(`/api/reports/stock-analytics?${query}`), 200).totals.turnover,
    ).toBeNull();
    expect(must(await c.get(`/api/reports/supplier-performance?${query}`), 200).rows).toHaveLength(
      0,
    );
    const supplier = must(
      await c.post('/api/parties', { name: 'Döviz tedarikçisi', kind: 'supplier' }),
    ).party;
    must(
      await c.put('/api/exchange-rates', {
        rateDate: TODAY_LOCAL,
        currencyCode: 'USD',
        quoteCode: 'TRY',
        buy: '40',
      }),
      200,
    );
    for (const currency of ['TRY', 'USD'])
      must(
        await c.post('/api/invoices', {
          type: 'purchase',
          partyId: supplier.id,
          currency,
          invoiceDate: TODAY_LOCAL,
          externalNo: `PARA-${currency}`,
          post: true,
          lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '100' }],
        }),
      );
    const rows = must(await c.get(`/api/reports/supplier-performance?${query}`), 200).rows;
    expect(rows.map((r: { currency: string }) => r.currency).sort()).toEqual(['TRY', 'USD']);
    expect(
      rows.every(
        (r: { fulfilmentPct: string | null; priceVariancePct: string | null }) =>
          r.fulfilmentPct === null && r.priceVariancePct === null,
      ),
    ).toBe(true);
  });
  it('depo transferi hareketsizlik süresini sıfırlamaz', async () => {
    const { c } = await setup('Hareketsiz');
    const warehouse = must(await c.get('/api/warehouses'), 200).warehouses[0];
    const other = must(await c.post('/api/warehouses', { name: 'İkinci depo' })).warehouse;
    const item = must(await c.post('/api/items', { name: 'Bekleyen ürün' })).item;
    const start = TODAY_LOCAL.slice(0, 4) + '-01-01';
    must(
      await c.post('/api/stock-documents', {
        type: 'receipt',
        docDate: start,
        warehouseId: warehouse.id,
        lines: [{ itemId: item.id, quantity: '5', unitCost: '20' }],
      }),
    );
    must(
      await c.post('/api/stock-documents', {
        type: 'transfer',
        docDate: TODAY_LOCAL,
        warehouseId: warehouse.id,
        toWarehouseId: other.id,
        lines: [{ itemId: item.id, quantity: '2' }],
      }),
    );
    const row = must(
      await c.get(`/api/reports/stock-analytics?from=${start}&to=${TODAY_LOCAL}&inactiveDays=1`),
      200,
    ).rows.find((r: { itemId: string }) => r.itemId === item.id);
    expect(row).toMatchObject({
      lastMovementDate: start,
      isInactive: true,
      closingQty: '5.0000',
      closingValue: '100.0000',
      abcClass: null,
      turnover: null,
    });
  });
  it('rapor, export ve pano aynı modül erişimini ve şirket izolasyonunu korur', async () => {
    const { c, owner, company } = await setup('AnalizYetki');
    const operator = await addMember(app, c, company.id, 'operator');
    must(
      await c.put(`/api/company/members/${operator.userId}/module-access`, {
        levels: { 'core.procurement': 'none' },
      }),
      200,
    );
    expect(
      (await operator.client.get(`/api/reports/supplier-performance?${query}`)).statusCode,
    ).toBe(403);
    expect(
      (await operator.client.get(`/api/exports/supplier-performance?${query}&format=csv`))
        .statusCode,
    ).toBe(403);
    const other = await createCompany(app, owner.token, {
        name: 'Başka şirket',
        sector: 'COMMERCE',
        jurisdiction: 'TR',
      }),
      otherClient = client(app, owner.token, other.id);
    expect(
      must(await otherClient.get(`/api/reports/supplier-performance?${query}`), 200).rows,
    ).toHaveLength(0);
    must(await c.put('/api/company/modules/core.procurement', { enabled: false }), 200);
    expect((await c.get(`/api/reports/supplier-performance?${query}`)).statusCode).toBe(403);
    expect((await c.get(`/api/exports/supplier-performance?${query}&format=csv`)).statusCode).toBe(
      403,
    );
    expect(
      must(await c.get('/api/workspace/insights/catalog'), 200).items.some(
        (r: { key: string }) => r.key === 'supplier-performance',
      ),
    ).toBe(false);
  });
  it('şantiyenin legacy tedarik modülü export/pano rotalarında da çalışır', async () => {
    const { c } = await setup('AnalizSantiye', 'CONSTRUCTION');
    expect((await c.get(`/api/reports/supplier-performance?${query}`)).statusCode).toBe(200);
    expect((await c.get(`/api/exports/supplier-performance?${query}&format=csv`)).statusCode).toBe(
      200,
    );
    expect(
      must(await c.get('/api/workspace/insights/catalog'), 200).items.some(
        (r: { key: string }) => r.key === 'supplier-performance',
      ),
    ).toBe(true);
  });
});
