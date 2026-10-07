import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { makeApp, registerUser, createCompany, client, addMember, TODAY_LOCAL } from './helpers';
import {
  verifyIntegrationSignature,
  shopifyGraphql,
  ticimaxSoap,
} from '../src/modules/manufacturing/integrations';

describe('genel üretim sektörü', async () => {
  const { app } = await makeApp();
  const owner = await registerUser(app, 'Manufacturing');
  const company = await createCompany(app, owner.token, { sector: 'MANUFACTURING_WHOLESALE' });
  const c = client(app, owner.token, company.id);
  const body = async (r: ReturnType<typeof c.get>, status = 200) => {
    const res = await r;
    expect(res.statusCode, res.body).toBe(status);
    return res.json();
  };
  const wh = (await body(c.get('/api/warehouses'))).warehouses[0].id;
  const raw = (
    await body(
      c.post('/api/items', {
        code: 'RAW-MFG',
        name: 'Montaj hammaddesi',
        unit: 'adet',
        inventoryRole: 'raw_material',
      }),
      201,
    )
  ).item.id;
  const fg = (
    await body(
      c.post('/api/items', {
        code: 'FG-MFG',
        name: 'Montaj ürünü',
        unit: 'adet',
        inventoryRole: 'finished_goods',
      }),
      201,
    )
  ).item.id;
  await body(
    c.post('/api/stock-documents', {
      type: 'opening',
      docDate: TODAY_LOCAL,
      warehouseId: wh,
      lines: [
        { itemId: raw, quantity: '2000', unitCost: '10' },
        { itemId: fg, quantity: '120', unitCost: '30' },
      ],
    }),
    201,
  );
  const model = (
    await body(
      c.post('/api/manufacturing/catalog/models', {
        code: 'GENERAL',
        name: 'Genel üretim ailesi',
        family: 'Mobilya',
      }),
      201,
    )
  ).model;
  const revision = (
    await body(
      c.post(`/api/manufacturing/catalog/models/${model.id}/revisions`, {
        name: 'Revizyon 1',
        sampleApproved: true,
        materials: [{ itemId: raw, quantity: '2' }],
        operations: [{ key: 'assembly', name: 'Montaj' }],
      }),
      201,
    )
  ).revision;
  await body(c.post(`/api/manufacturing/catalog/revisions/${revision.id}/approve`, {}));
  await body(
    c.post('/api/manufacturing/catalog/variants', {
      modelId: model.id,
      revisionId: revision.id,
      itemId: fg,
      color: 'Standart',
    }),
    201,
  );
  it('yeni sektör ortak modülleri açar, fiziksel deri ve inşaat uçlarını kapatır', async () => {
    const nav = await body(c.get('/api/navigation'));
    expect(nav.modules).toContain('manufacturing.production');
    expect(nav.modules).toContain('core.procurement');
    expect(nav.modules).not.toContain('leather.materials');
    expect((await c.get('/api/leather/materials/pieces')).statusCode).toBe(403);
    expect((await c.get('/api/projects')).statusCode).toBe(403);
  });
  it('net ihtiyaç 380 üretimdir, stok bir kez düşülür', async () => {
    const result = await body(
      c.post('/api/manufacturing/mrp', { itemId: fg, quantity: '500', warehouseId: wh }),
    );
    expect(result.needs[0].net).toBe('380.0000');
    expect(result.needs[1].gross).toBe('760.0000');
  });
  it('genel arama tüm üretim kayıtlarını sorgular; model adı ve hatırlatmalar çalışır', async () => {
    const result = await body(c.get('/api/workspace/search?q=Genel'));
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: model.id, kind: 'manufacturing_model' }),
      ]),
    );
    const alerts = await body(c.get('/api/workspace/alerts'));
    expect(Array.isArray(alerts.items)).toBe(true);
  });
  it('MRP isteği tekrarlandığında bir üretim emri oluşur', async () => {
    const input = {
      itemId: fg,
      quantity: '500',
      warehouseId: wh,
      outputWarehouseId: wh,
      requestKey: randomUUID(),
    };
    const first = await body(c.post('/api/manufacturing/mrp/orders', input));
    const second = await body(c.post('/api/manufacturing/mrp/orders', input));
    expect(first.orders.map((o: { id: string }) => o.id)).toEqual(
      second.orders.map((o: { id: string }) => o.id),
    );
    expect(first.orders[0].quantity).toBe('380.0000');
  });
  it('atölye operatörü başka emri ve maliyeti göremez', async () => {
    const op = await addMember(app, c, company.id, 'operator', 'ManufacturingOperator');
    await body(
      c.put(`/api/company/members/${op.userId}/module-access`, {
        levels: { 'manufacturing.production': 'write' },
      }),
    );
    const orders = await body(c.get('/api/manufacturing/production/orders'));
    const other = orders.orders[0];
    expect(
      (await op.client.get(`/api/manufacturing/production/orders/${other.id}`)).statusCode,
    ).toBe(403);
    expect((await op.client.get('/api/manufacturing/costs/allocations')).statusCode).toBe(403);
  });
  it('satış siparişi net mamulü ve bağlı yarı mamul emrini tek kez oluşturur', async () => {
    const semi = (
      await body(
        c.post('/api/items', {
          code: 'MULTI-SEMI',
          name: 'Yarı mamul',
          unit: 'adet',
          inventoryRole: 'semi_finished',
        }),
        201,
      )
    ).item.id;
    const product = (
      await body(
        c.post('/api/items', {
          code: 'MULTI-FG',
          name: 'Çok seviyeli mamul',
          unit: 'adet',
          inventoryRole: 'finished_goods',
        }),
        201,
      )
    ).item.id;
    await body(
      c.post('/api/stock-documents', {
        type: 'opening',
        docDate: TODAY_LOCAL,
        warehouseId: wh,
        lines: [
          { itemId: semi, quantity: '100', unitCost: '20' },
          { itemId: product, quantity: '120', unitCost: '30' },
        ],
      }),
      201,
    );
    for (const [itemId, materialId] of [
      [semi, raw],
      [product, semi],
    ]) {
      const m = (
        await body(
          c.post('/api/manufacturing/catalog/models', { code: itemId, name: 'Çok seviyeli aile' }),
          201,
        )
      ).model;
      const r = (
        await body(
          c.post(`/api/manufacturing/catalog/models/${m.id}/revisions`, {
            name: 'Onaylı',
            sampleApproved: true,
            materials: [{ itemId: materialId, quantity: '1' }],
            operations: [{ key: 'assembly', name: 'Montaj' }],
          }),
          201,
        )
      ).revision;
      await body(c.post(`/api/manufacturing/catalog/revisions/${r.id}/approve`, {}));
      await body(
        c.post('/api/manufacturing/catalog/variants', {
          modelId: m.id,
          revisionId: r.id,
          itemId,
          color: 'Standart',
        }),
        201,
      );
    }
    const party = (
      await body(c.post('/api/parties', { name: 'Çok seviyeli bayi', kind: 'customer' }), 201)
    ).party.id;
    const sale = (
      await body(
        c.post('/api/sales-docs', {
          kind: 'order',
          partyId: party,
          warehouseId: wh,
          docDate: TODAY_LOCAL,
          currency: 'TRY',
          lines: [{ itemId: product, description: 'Üretim', quantity: '500', unitPrice: '100' }],
        }),
        201,
      )
    ).doc;
    await body(c.post(`/api/sales-docs/${sale.id}/confirm`, { status: 'confirmed' }));
    const input = {
      salesOrderId: sale.id,
      warehouseId: wh,
      outputWarehouseId: wh,
      requestKey: randomUUID(),
    };
    const first = await body(c.post('/api/manufacturing/production/from-sales-order', input), 201),
      again = await body(c.post('/api/manufacturing/production/from-sales-order', input), 201);
    expect(first.orders.map((o: { quantity: string }) => o.quantity)).toEqual([
      '380.0000',
      '280.0000',
    ]);
    expect(first.orders[1].parentOrderId).toBe(first.orders[0].id);
    expect(again.orders.map((o: { id: string }) => o.id)).toEqual(
      first.orders.map((o: { id: string }) => o.id),
    );
    expect(
      (
        await c.post('/api/manufacturing/production/from-sales-order', {
          ...input,
          dueDate: TODAY_LOCAL,
        })
      ).statusCode,
    ).toBe(422);
  });
  it('dış kanal tekrarları tek ortak sipariş üretir', async () => {
    const party = (
      await body(c.post('/api/parties', { name: 'Dış kanal bayi', kind: 'customer' }), 201)
    ).party.id;
    const connection = (
      await body(
        c.post('/api/integrations/connections', {
          provider: 'shopify',
          name: 'Bağlı olmayan test',
        }),
      )
    ).record;
    expect(connection.status).toBe('disconnected');
    const payload = {
      externalId: 'external-001',
      partyId: party,
      warehouseId: wh,
      date: TODAY_LOCAL,
      currency: 'TRY',
      lines: [{ sku: 'FG-MFG', quantity: '3', unitPrice: '100' }],
    };
    const first = (
      await body(c.post(`/api/integrations/connections/${connection.id}/events`, payload))
    ).record;
    const again = (
      await body(c.post(`/api/integrations/connections/${connection.id}/events`, payload))
    ).record;
    expect(again.id).toBe(first.id);
    const processed = (await body(c.post(`/api/integrations/events/${first.id}/retry`, {}))).record;
    expect(processed.status).toBe('processed');
    const retried = (await body(c.post(`/api/integrations/events/${first.id}/retry`, {}))).record;
    expect(retried.salesOrderId).toBe(processed.salesOrderId);
    expect(
      (
        await c.post(`/api/integrations/connections/${connection.id}/events`, {
          ...payload,
          lines: [{ sku: 'FG-MFG', quantity: '4', unitPrice: '100' }],
        })
      ).statusCode,
    ).toBe(422);
  });
});
describe('bağlantı sözleşmeleri', () => {
  it('tam webhook baytlarına HMAC doğrular', () => {
    const raw = Buffer.from('{"id":1}');
    const sig = createHmac('sha256', 'test').update(raw).digest('base64');
    expect(verifyIntegrationSignature(raw, sig, 'test')).toBe(true);
    expect(verifyIntegrationSignature(Buffer.from('{"id":2}'), sig, 'test')).toBe(false);
  });
  it('Shopify GraphQL belirtecini başlıkta iletir', async () => {
    let sent: RequestInit | undefined;
    const fetcher = async (_u: unknown, init?: RequestInit) => {
      sent = init;
      return new Response(JSON.stringify({ data: { orders: [] } }), { status: 200 });
    };
    await shopifyGraphql(
      'test-shop.myshopify.com',
      '2026-10',
      'private-token',
      'query {orders{nodes{id}}}',
      {},
      fetcher as typeof fetch,
    );
    expect((sent!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      'private-token',
    );
  });
  it('Ticimax SOAP üyelik anahtarı XML içinde güvenle kodlanır', async () => {
    let request = '';
    const fetcher = async (_u: unknown, init?: RequestInit) => {
      request = String(init?.body);
      return new Response(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SelectSiparisResponse><SelectSiparisResult/></SelectSiparisResponse></s:Body></s:Envelope>',
      );
    };
    await ticimaxSoap(
      'https://example.com/Servis/SiparisServis.svc',
      'a<&',
      'SelectSiparis',
      {},
      fetcher as typeof fetch,
    );
    expect(request).toContain('a&lt;&amp;');
  });
});
