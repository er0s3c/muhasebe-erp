import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';
import type { LightMyRequestResponse } from 'fastify';

/**
 * F8 ilk kapsamı: kalıp ölçek/revizyon koruması (73), ton uyumu (74), kusur bölgelerinin kullanım alanına etkisi (75),
 * kalan parça arama (76), parti ileri izi (79), deri malzemesinden ürün maliyetine görünüm (15).
 */
const body = (r: LightMyRequestResponse, status = 200) => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
};
const key = () => ({ requestKey: randomUUID(), reason: 'F8 testi' });
const action = (extra: Record<string, unknown> = {}) => ({ date: TODAY_LOCAL, requestKey: randomUUID(), note: 'Test', ...extra });
const square = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

describe('deri atölyesi (F8)', async () => {
  const { app } = await makeApp();
  const owner = await registerUser(app, 'DeriF8');
  const company = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
  const c = client(app, owner.token, company.id);
  const wh = body(await c.get('/api/warehouses')).warehouses[0].id;
  const supplier = body(await c.post('/api/parties', { name: 'Tabakhane', kind: 'supplier' }), 201).party.id;
  const raw = body(await c.post('/api/items', { name: 'Dana deri', kind: 'goods', unit: 'm2', inventoryRole: 'raw_material' }), 201).item.id;
  const fg = body(await c.post('/api/items', { name: 'Çanta', kind: 'goods', unit: 'adet', inventoryRole: 'finished_goods' }), 201).item.id;
  const model = body(await c.post('/api/leather/catalog/models', { code: 'F8-MODEL', name: 'Çanta', family: 'bag' }), 201).model;
  const revision = body(
    await c.post(`/api/leather/catalog/models/${model.id}/revisions`, {
      name: 'Reçete',
      materials: [{ itemId: raw, quantity: '0.5' }],
      operations: [{ key: 'stitching', name: 'Dikiş' }],
      sampleApproved: true,
    }),
    201,
  ).revision;
  body(await c.post(`/api/leather/catalog/revisions/${revision.id}/approve`));
  const variant = body(await c.post('/api/leather/catalog/variants', { modelId: model.id, revisionId: revision.id, itemId: fg, color: 'Taba' }), 201).variant;
  const piece = async (code: string, area: string, tone: string) => {
    const lot = body(
      await c.post('/api/leather/materials/receipts', {
        partyId: supplier,
        itemId: raw,
        warehouseId: wh,
        date: TODAY_LOCAL,
        externalNo: code,
        provisionalUnitCost: '100',
        pieces: [{ code, area, tone, thicknessMin: '1.2', thicknessMax: '1.4' }],
      }),
      201,
    ).lot;
    const p = body(await c.get('/api/leather/materials/pieces')).pieces.find((x: { lotId: string }) => x.lotId === lot.id);
    body(await c.post(`/api/leather/materials/pieces/${p.id}/accept`, { decision: 'accept', note: 'Kabul' }));
    return p.id as string;
  };
  const order = async (quantity = '8') =>
    body(await c.post('/api/leather/production/orders', { variantId: variant.id, revisionId: revision.id, warehouseId: wh, outputWarehouseId: wh, quantity }), 201).order.id as string;
  const pattern = async (code: string, area: string, extra: Record<string, unknown> = {}) =>
    c.post('/api/leather/catalog/patterns', { ...key(), modelId: model.id, code, name: code, area, ...extra });
  const plan = (orderId: string, pieces: string[], patternId: string, extra: Record<string, unknown> = {}) =>
    c.post('/api/leather/materials/cutting/plans', { ...key(), orderId, pieces, sets: 1, patterns: [{ patternId, perSet: 1 }], ...extra });

  it('kalıp ölçeği, revizyon koruması ve ton uyumu', async () => {
    // 0.5 m² kalıp 100×100 mm kutuya sığmaz: ölçek hatası
    expect((await pattern('KLP-X', '0.5', { widthMm: 100, heightMm: 100 })).json().error.code).toBe('PATTERN_SCALE_MISMATCH');
    const rev1 = body(await pattern('KLP-A', '0.5', { widthMm: 1000, heightMm: 1000 })).record;
    const rev2 = body(await pattern('KLP-A', '0.6')).record;
    expect(rev2).toMatchObject({ patternCode: 'KLP-A', revision: 2, code: 'KLP-A-R2' });
    const a = await piece('F8-A', '10', 'Taba 1');
    const b = await piece('F8-B', '10', 'taba  1');
    const k = await piece('F8-K', '10', 'Koyu');
    const o1 = await order();
    expect((await plan(o1, [a], rev1.id)).json().error.code).toBe('PATTERN_REVISION_SUPERSEDED');
    const p1 = body(await plan(o1, [a], rev2.id)).record;
    expect(p1).toMatchObject({ toneGroup: 'TABA 1', requiredArea: '0.6000' });
    // Yeni revizyon geldi; bu emirde kullanılan revizyon korunur
    const rev3 = body(await pattern('KLP-A', '0.7')).record;
    expect((await plan(o1, [b], rev3.id)).json().error.code).toBe('PATTERN_REVISION_PINNED');
    body(await plan(o1, [b], rev2.id));
    // Farklı ton grubu gerekçe ister
    expect((await plan(o1, [k], rev2.id)).json().error.code).toBe('LEATHER_TONE_MISMATCH');
    const mixed = body(await plan(o1, [k], rev2.id, { toneOverrideReason: 'Müşteri iki tonu onayladı' })).record;
    expect(mixed.toneOverrideReason).toBe('Müşteri iki tonu onayladı');
  });

  it('kusur bölgeleri görünür ve gizli parçalarda farklı alan bırakır; kalan parça arama', async () => {
    const d = await piece('F8-D', '10', 'Taba 1');
    // Delik %10 (1 m²), çizik %25 (2,5 m²): gizli parça için 9, görünür parça için 6,5 m²
    body(
      await c.post(`/api/leather/materials/pieces/${d}/geometry`, {
        ...key(),
        grainAngle: 0,
        outline: square(0, 0, 1, 1),
        defects: [
          { code: 'DLK', kind: 'hole', points: square(0, 0, 0.5, 0.2) },
          { code: 'CZK', kind: 'scratch', points: square(0, 0.5, 0.5, 1) },
        ],
      }),
    );
    const visible = body(await pattern('KLP-DIS', '1')).record;
    const hidden = body(await pattern('KLP-IC', '1', { visibility: 'hidden' })).record;
    const o2 = await order();
    const many = (patternId: string) => c.post('/api/leather/materials/cutting/plans', { ...key(), orderId: o2, pieces: [d], sets: 7, patterns: [{ patternId, perSet: 1 }] });
    expect((await many(visible.id)).json().error.code).toBe('LEATHER_DEFECT_AREA');
    const ok = body(await many(hidden.id)).record;
    expect(ok).toMatchObject({ availableArea: '9.0000', availableVisibleArea: '6.5000', requiredArea: '7.0000', requiredVisibleArea: '0.0000' });

    const e = await piece('F8-E', '3', 'Koyu');
    let found = body(await c.get('/api/leather/materials/remnants?tone=koyu&minArea=1')).pieces;
    // F8-K açık kesim planında: aramada çıkmaz
    expect(found.map((p: { id: string }) => p.id)).toEqual([e]);
    expect(found[0]).toMatchObject({ freeArea: '3.0000', tone: 'Koyu' });
    found = body(await c.get('/api/leather/materials/remnants?tone=koyu&minArea=5')).pieces;
    expect(found).toEqual([]);
  });

  it('deri malzemesinden ürün maliyetine görünüm', async () => {
    const p = await piece('F8-M', '10', 'Taba 1');
    const o3 = await order('8');
    body(await c.post(`/api/leather/production/orders/${o3}/release`, action()));
    body(await c.post(`/api/leather/production/orders/${o3}/issues`, action({ lines: [{ itemId: raw, quantity: '4', pieces: [{ pieceId: p, quantity: '4' }] }] })));
    const view = body(await c.get(`/api/leather/production/orders/${o3}/leather-cost`));
    expect(view.area).toMatchObject({ issued: '4.0000', remnantReturned: '0.0000', netUsed: '4.0000', perUnit: '0.5000', yieldPct: null });
    expect(view.value).toMatchObject({ leather: '400.00', leatherPerM2: '100.00' });
    expect(view.perUnit.leather).toBe('50.00');
  });
});

describe('parti ileri izi (F8: öneri 79)', async () => {
  const { app } = await makeApp();
  const owner = await registerUser(app, 'PartiIz');
  const company = await createCompany(app, owner.token, { sector: 'MANUFACTURING_WHOLESALE' });
  const c = client(app, owner.token, company.id);

  it('partiden müşteri sevkine iz', async () => {
    const wh = body(await c.get('/api/warehouses')).warehouses[0].id;
    const item = body(await c.post('/api/items', { code: 'AKS-1', name: 'Toka', unit: 'adet' }), 201).item.id;
    const opening = body(await c.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: wh, lines: [{ itemId: item, quantity: '50', unitCost: '2' }] }), 201).document.id;
    const lot = body(await c.post('/api/wms/lots', { code: 'TOKA-L1', itemId: item, warehouseId: wh, sourceDocumentId: opening, quantity: '50', status: 'available' })).record.id;
    const customer = body(await c.post('/api/parties', { name: 'Toka Alıcısı', kind: 'customer' }), 201).party.id;
    const note = body(await c.post('/api/delivery-notes', { type: 'sales', partyId: customer, noteDate: TODAY_LOCAL, warehouseId: wh, post: true, lines: [{ itemId: item, quantity: '20' }] }), 201);
    const trace = body(await c.get(`/api/manufacturing/lots/${lot}/trace-forward`));
    expect(trace.lot).toMatchObject({ code: 'TOKA-L1', remainingQty: '30.0000' });
    expect(trace.directShipments).toEqual([{ noteId: note.note.id, noteNo: note.note.noteNo, partyName: 'Toka Alıcısı', quantity: '20.0000' }]);
    expect(trace.customers).toEqual(['Toka Alıcısı']);
  });
});
