import { describe, expect, it } from 'vitest';
import { makeApp, registerUser, createCompany, client, TODAY_LOCAL } from './helpers';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Son kullanma ve raf ömrü (öneri 47): kart raf ömrü partiye taşınır, düzeltme gerekçeyle izlenir, risk raporu sınıflar. */
describe('son kullanma ve raf ömrü riski', async () => {
  const { app } = await makeApp(),
    owner = await registerUser(app, 'Expiry');
  const company = await createCompany(app, owner.token, { sector: 'MANUFACTURING_WHOLESALE' }),
    c = client(app, owner.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const warehouse = (await ok(c.get('/api/warehouses'))).warehouses[0].id;

  it('raf ömrü kabul partisine son kullanma tarihi verir; risk raporu süresi geçmiş ve kritik partileri gösterir', async () => {
    expect((await c.post('/api/items', { code: 'EXP-BAD', name: 'Hatalı raf ömrü', shelfLifeDays: 0 })).statusCode).toBe(400);
    const raw = (await ok(c.post('/api/items', { code: 'EXP-RAW', name: 'Tutkal', unit: 'kg', inventoryRole: 'raw_material', shelfLifeDays: 30 }), 201)).item;
    expect(raw.shelfLifeDays).toBe(30);
    const fg = (await ok(c.post('/api/items', { code: 'EXP-FG', name: 'Paketli ürün', inventoryRole: 'finished_goods', shelfLifeDays: 10 }), 201)).item;

    const receipt = (
      await ok(
        c.post('/api/stock-documents', { type: 'receipt', docDate: TODAY_LOCAL, warehouseId: warehouse, lines: [{ itemId: raw.id, quantity: '100', unitCost: '2' }] }),
        201,
      )
    ).document.id;
    const lots = (await ok(c.get('/api/wms/lots'))).records;
    const auto = lots.find((l: { code: string }) => l.code.startsWith(`RECEIPT:${receipt}`));
    expect(auto).toMatchObject({ status: 'quarantine', expiryDate: addDays(TODAY_LOCAL, 30) });

    // Elle parti: tarih verilmezse kart raf ömrü (açılış belgesi tarihi + 10 gün)
    const opening = (
      await ok(c.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: warehouse, lines: [{ itemId: fg.id, quantity: '40', unitCost: '5' }] }), 201)
    ).document.id;
    const manual = (await ok(c.post('/api/wms/lots', { code: 'EXP-L1', itemId: fg.id, warehouseId: warehouse, sourceDocumentId: opening, quantity: '40', status: 'available' }))).record;
    expect(manual.expiryDate).toBe(addDays(TODAY_LOCAL, 10));

    // Düzeltme gerekçe ister ve geçmişte izlenir
    expect((await c.post(`/api/wms/lots/${auto.id}/expiry`, { expiryDate: addDays(TODAY_LOCAL, -1), reason: '' })).statusCode).toBe(400);
    const fixed = await ok(c.post(`/api/wms/lots/${auto.id}/expiry`, { expiryDate: addDays(TODAY_LOCAL, -1), reason: 'Tedarikçi etiketi' }));
    expect(fixed.record.expiryDate).toBe(addDays(TODAY_LOCAL, -1));
    expect(fixed.record.expiryHistory).toHaveLength(1);

    expect((await c.get('/api/inventory/expiry-risk?horizonDays=5&criticalDays=10')).statusCode).toBe(400);
    const risk = await ok(c.get('/api/inventory/expiry-risk?horizonDays=60&criticalDays=15'));
    expect(risk.today).toBe(TODAY_LOCAL);
    const expired = risk.lots.find((l: { lotId: string }) => l.lotId === auto.id);
    expect(expired).toMatchObject({ state: 'expired', daysLeft: -1, quantity: '100.0000', value: '200.00' });
    const critical = risk.lots.find((l: { lotId: string }) => l.lotId === manual.id);
    expect(critical).toMatchObject({ state: 'critical', daysLeft: 10, value: '200.00' });
    expect(risk.summary.expired).toMatchObject({ count: 1, value: '200.00' });
    expect(risk.summary.critical.count).toBe(1);
    // Ufuk dışındaki parti listelenmez
    const narrow = await ok(c.get('/api/inventory/expiry-risk?horizonDays=5&criticalDays=2'));
    expect(narrow.lots.map((l: { lotId: string }) => l.lotId)).toEqual([auto.id]);

    // Raf ömrü kaldırılabilir
    expect((await ok(c.patch(`/api/items/${raw.id}`, { shelfLifeDays: null }))).item.shelfLifeDays).toBeNull();
  });
});
