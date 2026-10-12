import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { classifyChannelError } from '../src/modules/manufacturing/channels';
import { client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';

/**
 * F11 kanal senaryoları (öneri 108, 109, 110): hata türüne göre tekrar/inceleme, eşleme yaşam döngüsü ve kanal stok farkı.
 * Ağ çağrıları sahte `fetch` ile yanıtlanır; gerçek kanal çağrılmaz.
 */
describe('kanal hata, yetki ve eşleme senaryoları (F11)', async () => {
  const { app } = await makeApp();
  const user = await registerUser(app, 'KanalSenaryo');
  const company = await createCompany(app, user.token, { sector: 'MANUFACTURING_WHOLESALE' });
  const c = client(app, user.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const warehouse = (await ok(c.get('/api/warehouses'))).warehouses[0].id;
  const party = (await ok(c.post('/api/parties', { name: 'Kanal alıcısı', kind: 'customer' }), 201)).party.id;
  const connection = (
    await ok(
      c.post('/api/integrations/connections', {
        provider: 'shopify',
        name: 'Mağaza',
        shop: 'ada-senaryo.myshopify.com',
        token: 'gizli-token-123',
        webhookSecret: 'senaryo-webhook-secret-123',
        webhookPartyId: party,
        webhookWarehouseId: warehouse,
      }),
    )
  ).record;
  let n = 0;
  /** Her senaryo için ayrı kart ve eşleme: eşleme oluşturma bir stok yayını kaydı kuyruğa alır. */
  async function mapped(stock = '0') {
    n++;
    const item = (await ok(c.post('/api/items', { code: `SCN-${n}`, name: `Senaryo ${n}`, unit: 'adet', inventoryRole: 'finished_goods' }), 201)).item.id;
    if (stock !== '0') await ok(c.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: warehouse, lines: [{ itemId: item, quantity: stock, unitCost: '1' }] }), 201);
    const mapping = (
      await ok(
        c.post('/api/integrations/channel-mappings', {
          requestKey: randomUUID(),
          reason: 'Senaryo eşlemesi',
          connectionId: connection.id,
          itemId: item,
          warehouseId: warehouse,
          channelSku: `SKU-${n}`,
          inventoryItemId: `gid://shopify/InventoryItem/${100 + n}`,
          locationId: 'gid://shopify/Location/1',
        }),
      )
    ).record;
    const outbox = (await ok(c.get('/api/integrations/inventory-outbox'))).records.find((r: { mappingId: string }) => r.mappingId === mapping.id);
    return { item, mapping, outbox };
  }
  const shopify = (handler: (payload: { query: string }) => Response) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => handler(JSON.parse(String(init?.body))));
  const stockReply = (quantity: number) => new Response(JSON.stringify({ data: { inventoryItem: { inventoryLevel: { quantities: [{ name: 'available', quantity }] } } } }), { status: 200 });

  it('hata türü sınıflaması', () => {
    expect(classifyChannelError('Shopify HTTP 401')).toBe('auth');
    expect(classifyChannelError('Shopify HTTP 403')).toBe('auth');
    expect(classifyChannelError('Shopify HTTP 429')).toBe('rate_limit');
    expect(classifyChannelError('Shopify stok değişimini reddetti: Invalid location')).toBe('rejected');
    expect(classifyChannelError('Timeout after remote acceptance')).toBe('network');
  });

  it('yetki hatası tekrar beklemeden incelemeye düşer ve gizli bilgi taşımaz; hız sınırı tekrar denenir', async () => {
    const auth = await mapped();
    let net = shopify(() => new Response('{}', { status: 401 }));
    try {
      const r = (await ok(c.post(`/api/integrations/inventory-outbox/${auth.outbox.id}/retry`, {}))).record;
      expect(r).toMatchObject({ status: 'dead_letter', errorKind: 'auth', attempts: 1 });
      expect(JSON.stringify(r)).not.toContain('gizli-token-123');
    } finally {
      net.mockRestore();
    }
    const limited = await mapped();
    net = shopify(() => new Response('{}', { status: 429 }));
    try {
      const r = (await ok(c.post(`/api/integrations/inventory-outbox/${limited.outbox.id}/retry`, {}))).record;
      expect(r).toMatchObject({ status: 'failed', errorKind: 'rate_limit' });
      expect(r.retryAfter).toBeTruthy();
    } finally {
      net.mockRestore();
    }
  });

  it('kanalın reddettiği değişiklik veri düzeltmesi ister', async () => {
    const m = await mapped();
    const net = shopify((p) =>
      p.query.startsWith('query') ? stockReply(3) : new Response(JSON.stringify({ data: { inventorySetQuantities: { userErrors: [{ message: 'Invalid location' }] } } }), { status: 200 }),
    );
    try {
      const r = (await ok(c.post(`/api/integrations/inventory-outbox/${m.outbox.id}/retry`, {}))).record;
      expect(r).toMatchObject({ status: 'failed', errorKind: 'rejected' });
      expect(r.error).toContain('Invalid location');
    } finally {
      net.mockRestore();
    }
  });

  it('eşleme yaşam döngüsü: duraklatılan eşleme göndermez, emekli eşleme yeniden açılmaz', async () => {
    const m = await mapped();
    const net = vi.spyOn(globalThis, 'fetch');
    try {
      const paused = (await ok(c.post(`/api/integrations/channel-mappings/${m.mapping.id}/status`, { status: 'paused', reason: 'Ürün satıştan kalktı' }))).record;
      expect(paused.status).toBe('paused');
      expect((await c.post(`/api/integrations/inventory-outbox/${m.outbox.id}/retry`, {})).statusCode).toBe(422);
      expect(net).not.toHaveBeenCalled();
      const list = (await ok(c.get('/api/integrations/channel-mappings'))).records.find((r: { id: string }) => r.id === m.mapping.id);
      expect(list.health.issues).toContain('paused');
      await ok(c.post(`/api/integrations/channel-mappings/${m.mapping.id}/status`, { status: 'retired', reason: 'Kanal ürünü silindi' }));
      expect((await c.post(`/api/integrations/channel-mappings/${m.mapping.id}/status`, { status: 'active', reason: 'Geri aç' })).json().error.code).toBe('CHANNEL_MAPPING_RETIRED');
      const after = (await ok(c.get('/api/integrations/channel-mappings'))).records.find((r: { id: string }) => r.id === m.mapping.id);
      expect(after.history.map((h: { status: string }) => h.status)).toEqual(['active', 'paused', 'retired']);
    } finally {
      net.mockRestore();
    }
  });

  it('kanal stok farkı: Ada ile kanal karşılaştırılır, istenirse Ada miktarı kuyruğa alınır', async () => {
    const m = await mapped('12');
    const before = (await ok(c.get('/api/integrations/inventory-outbox'))).records.filter((r: { mappingId: string }) => r.mappingId === m.mapping.id).length;
    const net = shopify(() => stockReply(7));
    try {
      const check = await ok(c.post(`/api/integrations/channel-mappings/${m.mapping.id}/check`, { requestKey: randomUUID(), queue: true }));
      expect(check).toMatchObject({ adaQuantity: 12, channelQuantity: 7, difference: 5, queued: true });
    } finally {
      net.mockRestore();
    }
    const after = (await ok(c.get('/api/integrations/inventory-outbox'))).records.filter((r: { mappingId: string }) => r.mappingId === m.mapping.id);
    expect(after).toHaveLength(before + 1);
    expect(after[0].quantity).toBe(12);
    const diffs = (await ok(c.get('/api/integrations/channel-differences'))).records;
    expect(diffs.map((r: { id: string }) => r.id)).toContain(m.mapping.id);
  });
});
