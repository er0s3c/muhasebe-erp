import { randomUUID, createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { makeApp, registerUser, createCompany, client, TODAY_LOCAL } from './helpers';

describe('üretim kanal güvenilirliği', async () => {
  const { app } = await makeApp(),
    user = await registerUser(app, 'Channel');
  const company = await createCompany(app, user.token, { sector: 'MANUFACTURING_WHOLESALE' }),
    c = client(app, user.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const warehouse = (await ok(c.get('/api/warehouses'))).warehouses[0].id;
  const party = (
    await ok(
      c.post('/api/parties', { code: 'CH-C', name: 'Kanal müşterisi', kind: 'customer' }),
      201,
    )
  ).party.id;
  const item = (
    await ok(
      c.post('/api/items', {
        code: 'CH-SKU',
        name: 'Kanal ürünü',
        unit: 'adet',
        inventoryRole: 'finished_goods',
      }),
      201,
    )
  ).item.id;
  const secret = 'webhook-kabul-secret-12345';
  const connection = (
    await ok(
      c.post('/api/integrations/connections', {
        provider: 'shopify',
        name: 'Kanal',
        shop: 'ada-test.myshopify.com',
        token: 'test-token',
        webhookSecret: secret,
        webhookPartyId: party,
        webhookWarehouseId: warehouse,
      }),
    )
  ).record;
  const key = () => ({ requestKey: randomUUID(), reason: 'Kabul testi' });
  it('ham gövde HMAC, yanlış imza, tekrar ve dış sürüm değişikliği', async () => {
    expect(connection.webhookSecret).toBeUndefined();
    expect(connection.credentials).toBeUndefined();
    const payload = {
      admin_graphql_api_id: 'gid://shopify/Order/100',
      created_at: TODAY_LOCAL + 'T08:00:00Z',
      updated_at: TODAY_LOCAL + 'T08:00:00Z',
      currency: 'TRY',
      taxes_included: false,
      financial_status: 'pending',
      line_items: [{ sku: 'CH-SKU', quantity: 2, price: '10', tax_lines: [] }],
    };
    const raw = JSON.stringify(payload),
      url = `/api/integrations/webhooks/${company.id}/${connection.id}/shopify`;
    const headers = {
      'content-type': 'application/json',
      'x-shopify-shop-domain': 'ada-test.myshopify.com',
      'x-shopify-topic': 'orders/create',
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'),
    };
    const bad = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'x-shopify-hmac-sha256': 'invalid' },
      payload: raw,
    });
    expect(bad.statusCode, bad.body).toBe(403);
    const first = await app.inject({ method: 'POST', url, headers, payload: raw });
    expect(first.statusCode, first.body).toBe(202);
    const second = await app.inject({ method: 'POST', url, headers, payload: raw });
    expect(second.json().id).toBe(first.json().id);
    const changed = JSON.stringify({
      ...payload,
      updated_at: TODAY_LOCAL + 'T09:00:00Z',
      line_items: [{ ...payload.line_items[0], quantity: 3 }],
    });
    const update = await app.inject({
      method: 'POST',
      url,
      headers: {
        ...headers,
        'x-shopify-topic': 'orders/updated',
        'x-shopify-hmac-sha256': createHmac('sha256', secret).update(changed).digest('base64'),
      },
      payload: changed,
    });
    expect(update.statusCode, update.body).toBe(202);
    expect(update.json().status).toBe('needs_review');
    expect((await ok(c.get('/api/sales-docs?kind=order'))).docs).toHaveLength(0);
  });
  it('backoff erken tekrarı engeller; beş hata dead-letter, eşleme sonrası manuel tekrar tek sipariş', async () => {
    const record = (
      await ok(
        c.post(`/api/integrations/connections/${connection.id}/events`, {
          externalId: 'bad-sku',
          partyId: party,
          warehouseId: warehouse,
          date: TODAY_LOCAL,
          currency: 'TRY',
          lines: [{ sku: 'CHANNEL-UNKNOWN', quantity: '1', unitPrice: '10' }],
        }),
      )
    ).record;
    const path = `/api/integrations/events/${record.id}/retry`;
    const first = (await ok(c.post(path, {}))).record;
    expect(first.status).toBe('failed');
    expect(first.attempts).toBe(1);
    const early = (await ok(c.post(path, {}))).record;
    expect(early.attempts).toBe(1);
    expect(early.retryEligible).toBe(false);
    let current = first;
    const clock = vi.spyOn(Date, 'now');
    try {
      for (let i = 1; i < 5; i++) {
        clock.mockReturnValue(Date.parse(current.retryAfter) + 1);
        current = (await ok(c.post(path, {}))).record;
      }
    } finally {
      clock.mockRestore();
    }
    expect(current.status).toBe('dead_letter');
    expect(current.attempts).toBe(5);
    expect((await ok(c.post(path, {}))).record.retryEligible).toBe(false);
    await ok(
      c.post('/api/integrations/channel-mappings', {
        ...key(),
        connectionId: connection.id,
        itemId: item,
        warehouseId: warehouse,
        channelSku: 'CHANNEL-UNKNOWN',
        inventoryItemId: 'gid://shopify/InventoryItem/1',
        locationId: 'gid://shopify/Location/1',
      }),
    );
    const processed = (await ok(c.post(path, { force: true, reason: 'SKU eşlemesi düzeltildi' })))
      .record;
    expect(processed.status).toBe('processed');
    expect((await ok(c.post(path, {}))).record.salesOrderId).toBe(processed.salesOrderId);
    expect((await ok(c.get('/api/sales-docs?kind=order'))).docs).toHaveLength(1);
  });
  it('SKU eşlemesi ve gerçek stok değişimi kalıcı stok yayınına tek kayıt ekler', async () => {
    const before = (await ok(c.get('/api/integrations/inventory-outbox'))).records.length;
    await ok(
      c.post('/api/stock-documents', {
        type: 'opening',
        docDate: TODAY_LOCAL,
        warehouseId: warehouse,
        lines: [{ itemId: item, quantity: '12', unitCost: '1' }],
      }),
      201,
    );
    const after = await ok(c.get('/api/integrations/inventory-outbox'));
    expect(after.stockAuthority).toBe('ada');
    expect(after.records).toHaveLength(before + 1);
    expect(after.records[0].quantity).toBe(12);
  });
  it('Shopify belirsiz zaman aşımında aynı CAS ve işlem kimliğini tekrar kullanır', async () => {
    const outbox = (await ok(c.get('/api/integrations/inventory-outbox'))).records;
    const latest = outbox[0];
    const payloads: {
      query: string;
      variables: { key?: string; input?: { quantities: unknown[] } };
    }[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      payloads.push(payload);
      if (payload.query.startsWith('query'))
        return new Response(
          JSON.stringify({
            data: {
              inventoryItem: {
                inventoryLevel: { quantities: [{ name: 'available', quantity: 7 }] },
              },
            },
          }),
          { status: 200 },
        );
      if (payloads.length === 2) throw new Error('Timeout after remote acceptance');
      return new Response(
        JSON.stringify({ data: { inventorySetQuantities: { userErrors: [] } } }),
        { status: 200 },
      );
    });
    try {
      const path = '/api/integrations/inventory-outbox/' + latest.id + '/retry';
      const failed = (await ok(c.post(path, {}))).record;
      expect(failed.status).toBe('failed');
      expect(failed.changeFromQuantity).toBe(7);
      expect((await ok(c.post(path, {}))).record.retryEligible).toBe(false);
      expect(payloads).toHaveLength(2);
      expect(
        (await ok(c.post(path, { force: true, reason: 'Belirsiz yanıtı aynı komutla doğrula' })))
          .record.status,
      ).toBe('processed');
      expect((await ok(c.post(path, {}))).record.status).toBe('processed');
      expect(payloads).toHaveLength(3);
      expect(payloads[2]).toEqual(payloads[1]);
      expect(payloads[2].variables.key).toBe(latest.id);
    } finally {
      network.mockRestore();
    }
  });
});
