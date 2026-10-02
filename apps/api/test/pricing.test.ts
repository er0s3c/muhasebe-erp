import { describe, expect, it } from 'vitest';
import { asOwner, day, expectDbError, makeApp } from './helpers';
import { x2Kit } from './x2-helpers';

describe('fiyat listeleri, cari özel fiyat ve iskonto (X3)', async () => {
  const { app } = await makeApp();
  const k = x2Kit(app);

  const mkList = async (c: any, body: Record<string, unknown>) => {
    const res = await c.post('/api/price-lists', { currency: 'TRY', kind: 'sales', ...body });
    if (res.statusCode !== 201) throw new Error(`price list failed: ${res.body}`);
    return res.json().list as { id: string; code: string };
  };
  const addRow = (c: any, listId: string, itemId: string, price: string, extra: Record<string, unknown> = {}) =>
    c.post(`/api/price-lists/${listId}/items`, { itemId, price, ...extra });
  const suggest = async (c: any, q: Record<string, string>) => {
    const res = await c.get(`/api/price-resolution?${new URLSearchParams({ kind: 'sales', date: day(6, 15), currency: 'TRY', quantity: '1', ...q })}`);
    return res.json();
  };

  async function base(name: string) {
    const ctx = await k.setup(name);
    const cust = await k.mkParty(ctx.c, 'Ali Yılmaz');
    const item = await k.mkItem(ctx.c, 'Çimento', { salePrice: '100', purchasePrice: '40' });
    return { ...ctx, cust, item };
  }

  it('çözümleme sırası: kart → şirket varsayılan listesi → cari listesi → cariye özel fiyat; kaynak döner', async () => {
    const { c, cust, item } = await base('Siralama');
    expect(await suggest(c, { partyId: cust.id, itemId: item.id })).toMatchObject({ unitPrice: '100.000000', priceSource: 'item_card', discountPct: '0' });

    const def = await mkList(c, { code: 'GENEL', name: 'Genel liste', isDefault: true });
    await addRow(c, def.id, item.id, '95');
    expect(await suggest(c, { partyId: cust.id, itemId: item.id })).toMatchObject({ unitPrice: '95.000000', priceSource: 'default_list', priceListName: 'Genel liste' });

    const bayi = await mkList(c, { code: 'BAYI', name: 'Bayi' });
    await addRow(c, bayi.id, item.id, '85');
    expect((await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: bayi.id, salesDiscountPct: '5' })).statusCode).toBe(200);
    expect(await suggest(c, { partyId: cust.id, itemId: item.id })).toMatchObject({ unitPrice: '85.000000', priceSource: 'party_list', priceListName: 'Bayi', discountPct: '5.0000', discountSource: 'party_default' });

    const sp = await c.post('/api/party-prices', { partyId: cust.id, itemId: item.id, kind: 'sales', currency: 'TRY', price: '70' });
    expect(sp.statusCode).toBe(201);
    // Özel fiyat kendi iskontosu yoksa genel iskontoyu uygulatmaz
    expect(await suggest(c, { partyId: cust.id, itemId: item.id })).toMatchObject({ unitPrice: '70.000000', priceSource: 'party_item', discountPct: '0', discountSource: 'none' });

    // Para birimi uyuşmazsa kaynak atlanır (çeviri yok): EUR belgede hiçbir kaynak eşleşmez
    expect(await suggest(c, { partyId: cust.id, itemId: item.id, currency: 'EUR' })).toMatchObject({ unitPrice: null, priceSource: 'none' });
    // Alış tarafı kart alış fiyatından gelir
    expect(await suggest(c, { partyId: cust.id, itemId: item.id, kind: 'purchase' })).toMatchObject({ unitPrice: '40.000000', priceSource: 'item_card' });
  });

  it('miktar kademesi, geçerlilik tarihi ve pasif liste', async () => {
    const { c, cust, item } = await base('Kademe');
    const l = await mkList(c, { code: 'K1', name: 'Kademeli' });
    await addRow(c, l.id, item.id, '90');
    await addRow(c, l.id, item.id, '80', { minQty: '10' });
    await addRow(c, l.id, item.id, '60', { minQty: '100', validFrom: day(7, 1) });
    await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: l.id });
    expect((await suggest(c, { partyId: cust.id, itemId: item.id, quantity: '9' })).unitPrice).toBe('90.000000');
    expect((await suggest(c, { partyId: cust.id, itemId: item.id, quantity: '12' })).unitPrice).toBe('80.000000');
    // 100'lük kademe temmuzda başlar: haziranda 80
    expect((await suggest(c, { partyId: cust.id, itemId: item.id, quantity: '500' })).unitPrice).toBe('80.000000');
    expect((await suggest(c, { partyId: cust.id, itemId: item.id, quantity: '500', date: day(7, 2) })).unitPrice).toBe('60.000000');
    // Aynı kalem/kademe/başlangıç ikinci kez eklenemez
    expect((await addRow(c, l.id, item.id, '91')).statusCode).toBe(409);
    // Pasif liste atlanır
    expect((await c.put(`/api/price-lists/${l.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await suggest(c, { partyId: cust.id, itemId: item.id, quantity: '12' })).priceSource).toBe('item_card');
    // Liste geçerlilik aralığı
    await c.put(`/api/price-lists/${l.id}`, { isActive: true, validFrom: day(1, 1), validTo: day(3, 31) });
    expect((await suggest(c, { partyId: cust.id, itemId: item.id })).priceSource).toBe('item_card');
  });

  it('kalem iskontosu ve cari genel iskontosu; kullanıcı fiyatı/iskontoyu her zaman verebilir', async () => {
    const { c, cust, item, main } = await base('Iskonto');
    await c.put(`/api/parties/${cust.id}/pricing`, { salesDiscountPct: '10' });
    await c.post('/api/party-prices', { partyId: cust.id, itemId: item.id, kind: 'sales', discountPct: '15' });
    const r = await suggest(c, { partyId: cust.id, itemId: item.id });
    expect(r).toMatchObject({ unitPrice: '100.000000', priceSource: 'item_card', discountPct: '15.0000', discountSource: 'party_item' });
    // Fiyat ve iskonto en az biri gerekli
    expect((await c.post('/api/party-prices', { partyId: cust.id, itemId: item.id, kind: 'sales', minQty: '5' })).statusCode).toBe(400);
    // Satış teklifi: fiyat ve iskonto boş bırakılınca çözümlenir
    const q = await c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: day(6, 15), warehouseId: main.id, lines: [{ itemId: item.id, quantity: '2' }] });
    expect(q.statusCode).toBe(201);
    expect(q.json().lines[0]).toMatchObject({ unitPrice: '100.000000', discountPct: '15.0000', net: '170.0000' });
    // Kullanıcı verirse çözümleme ezilir
    const q2 = await c.post('/api/sales-docs', { kind: 'quote', partyId: cust.id, docDate: day(6, 15), lines: [{ itemId: item.id, quantity: '2', unitPrice: '90', discountPct: '0' }] });
    expect(q2.json().lines[0]).toMatchObject({ unitPrice: '90.000000', discountPct: '0.0000', net: '180.0000' });
  });

  it('sipariş ve toplu faturalama aynı çözümleyiciyi kullanır', async () => {
    const { c, cust, item, main } = await base('Kablo');
    const l = await mkList(c, { code: 'L', name: 'Liste' });
    await addRow(c, l.id, item.id, '77');
    await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: l.id });
    const o = await c.post('/api/sales-docs', { kind: 'order', partyId: cust.id, docDate: day(6, 15), warehouseId: main.id, lines: [{ itemId: item.id, quantity: '1' }] });
    expect(o.json().lines[0]).toMatchObject({ unitPrice: '77.000000' });
    await k.receipt(c, day(3, 1), main.id, item.id, '5', '30');
    await k.posted(c, { type: 'sales', partyId: cust.id, noteDate: day(6, 15), warehouseId: main.id, lines: [k.dline(item.id, '2')] });
    const prev = await c.get(`/api/invoice-batches/preview?grouping=party`);
    expect(prev.statusCode).toBe(200);
    expect(prev.json().parties[0].notes[0].lines[0]).toMatchObject({ unitPrice: '77.000000', priceSource: 'party_list' });
  });

  it('toplu bakım: kopyala + yüzde zam, yüzde ayarı, toplu giriş, dışa aktarma; liste/özel fiyat silinir', async () => {
    const { c, cust, item } = await base('Bakim');
    const l = await mkList(c, { code: 'A', name: 'Ana' });
    await addRow(c, l.id, item.id, '100');
    const cp = await c.post(`/api/price-lists/${l.id}/copy`, { code: 'A10', name: 'Ana +10%', adjustPct: '10' });
    expect(cp.statusCode).toBe(201);
    const copyId = cp.json().list.id;
    expect((await c.get(`/api/price-lists/${copyId}/items`)).json().items[0]).toMatchObject({ price: '110.000000' });
    expect((await c.post(`/api/price-lists/${copyId}/adjust`, { pct: '-50', decimals: 2 })).json()).toEqual({ updated: 1 });
    expect((await c.get(`/api/price-lists/${copyId}/items`)).json().items[0].price).toBe('55.000000');
    const bulk = await c.post(`/api/price-lists/${l.id}/items/bulk`, { rows: [{ itemCode: item.code, price: '101' }, { itemCode: 'YOK-1', price: '5' }, { itemCode: item.code, minQty: '10', price: '95' }] });
    expect(bulk.json()).toEqual({ created: 1, updated: 1, unknown: ['YOK-1'] });
    const csv = await c.get(`/api/exports/price-list-items?listId=${l.id}&format=csv`);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(item.code);
    expect((await c.get('/api/exports/party-prices?format=csv')).statusCode).toBe(200);
    // Atanmış liste silinemez; boşaltılınca silinir
    await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: copyId });
    expect((await c.delete(`/api/price-lists/${copyId}`)).json().error.code).toBe('PRICE_LIST_IN_USE');
    await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: null });
    expect((await c.delete(`/api/price-lists/${copyId}`)).statusCode).toBe(204);
  });

  it('şirket varsayılanı tür başına tek; tür/para birimi satırı olan listede değişmez (veritabanı)', async () => {
    const { c, company, item, cust } = await base('Varsayilan');
    const a = await mkList(c, { code: 'D1', name: 'Bir', isDefault: true });
    const b = await mkList(c, { code: 'D2', name: 'İki', isDefault: true });
    const lists = (await c.get('/api/price-lists?kind=sales')).json().lists;
    expect(lists.find((l: any) => l.id === a.id).isDefault).toBe(false);
    expect(lists.find((l: any) => l.id === b.id).isDefault).toBe(true);
    await addRow(c, b.id, item.id, '10');
    expect((await c.put(`/api/price-lists/${b.id}`, { currency: 'EUR' })).json().error.code).toBe('PRICE_RULE_VIOLATION');
    // Cariye yanlış türde liste atanamaz
    const purch = await mkList(c, { code: 'P1', name: 'Alış', kind: 'purchase' });
    expect((await c.put(`/api/parties/${cust.id}/pricing`, { salesPriceListId: purch.id })).json().error.code).toBe('PRICE_RULE_VIOLATION');
    // Tedarikçiye satış fiyatı girilemez
    const sup = await k.mkParty(c, 'Tedarikçi', 'supplier');
    expect((await c.post('/api/party-prices', { partyId: sup.id, itemId: item.id, kind: 'sales', currency: 'TRY', price: '1' })).json().error.code).toBe('PRICE_RULE_VIOLATION');
    await asOwner(async (q) => {
      const e = await expectDbError(q, `update price_lists set is_default = true, is_active = false where id = $1`, [b.id]);
      expect(e.code).toBe('ERP16');
      const e2 = await expectDbError(q, `insert into price_list_items (id, company_id, price_list_id, item_id, price) values (gen_random_uuid(), $1, $2, $3, -1)`, [company.id, b.id, item.id]);
      expect(e2.code).toBe('23514');
    });
  });

  it('fiyat satırı değişiklikleri denetim izine yazılır', async () => {
    const { c, company, item } = await base('Denetim');
    const l = await mkList(c, { code: 'AU', name: 'Denetimli' });
    const row = (await addRow(c, l.id, item.id, '10')).json();
    await c.put(`/api/price-lists/${l.id}/items/${row.id}`, { price: '12' });
    await asOwner(async (q) => {
      const r = await q(`select action from audit_log where company_id = $1 and table_name = 'price_list_items' order by id`, [company.id]);
      expect(r.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['INSERT', 'UPDATE']));
    });
  });

  it('yetki ve kiracı yalıtımı: görüntüleyici okur, yazamaz; başka şirket göremez', async () => {
    const x = await base('Yetki');
    const { c, company, item } = x;
    const l = await mkList(c, { code: 'Y', name: 'Yetki' });
    const viewer = await k.memberClient(c, company.id, 'viewer');
    expect((await viewer.get('/api/price-lists')).statusCode).toBe(200);
    expect((await viewer.post('/api/price-lists', { code: 'Z', name: 'Z', kind: 'sales', currency: 'TRY' })).statusCode).toBe(403);
    expect((await viewer.post(`/api/price-lists/${l.id}/items`, { itemId: item.id, price: '1' })).statusCode).toBe(403);
    const other = await k.setup('Baska');
    expect((await other.c.get('/api/price-lists')).json().lists).toEqual([]);
    expect((await other.c.get(`/api/price-lists/${l.id}`)).statusCode).toBe(404);
  });
});
