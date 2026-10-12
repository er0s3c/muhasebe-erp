import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeApp, registerUser, createCompany, client, TODAY_LOCAL } from './helpers';

/**
 * F7 ilk kapsamı: sıraya bağlı hazırlık (63), kalıp/takım kapasitesi (64), operatör becerisi (65), yakın dönem plan koruması (66),
 * planlanan–gerçekleşen (14) ve maliyet sapma bileşenleri (72).
 */
describe('üretim planlama kuralları (F7)', async () => {
  const { app } = await makeApp();
  const owner = await registerUser(app, 'UretimKural');
  const company = await createCompany(app, owner.token, { sector: 'MANUFACTURING_WHOLESALE' });
  const c = client(app, owner.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const key = () => ({ requestKey: randomUUID(), reason: 'F7 testi' });
  const warehouse = (await ok(c.get('/api/warehouses'))).warehouses[0].id;
  const item = async (code: string, role: string) => (await ok(c.post('/api/items', { code, name: code, unit: 'adet', inventoryRole: role }), 201)).item.id as string;
  const fg = await item('F7-FG', 'finished_goods');
  const raw = await item('F7-RAW', 'raw_material');
  await ok(c.post('/api/stock-documents', { type: 'opening', docDate: TODAY_LOCAL, warehouseId: warehouse, lines: [{ itemId: raw, quantity: '1000', unitCost: '2' }] }), 201);
  const machine = (await ok(c.post('/api/manufacturing/resources', { code: 'F7-M', name: 'Pres', type: 'machine' }))).record.id as string;
  const tool = (await ok(c.post('/api/manufacturing/resources', { code: 'F7-KALIP', name: 'Kalıp', type: 'tool' }))).record.id as string;
  const tomorrow = new Date(Date.parse(TODAY_LOCAL + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  for (const day of [TODAY_LOCAL, tomorrow])
    await ok(c.post('/api/manufacturing/calendars', { resourceId: machine, start: day + 'T00:00:00Z', end: day + 'T23:59:00Z', available: true, reason: 'shift' }));
  const model = (await ok(c.post('/api/manufacturing/catalog/models', { code: 'F7-MODEL', name: 'Model', family: 'Genel' }), 201)).model.id;
  const revision = (
    await ok(
      c.post(`/api/manufacturing/catalog/models/${model}/revisions`, {
        name: 'Rota',
        sampleApproved: true,
        materials: [{ itemId: raw, quantity: '1' }],
        operations: [{ key: 'press', name: 'Presleme', plannedMinutes: '2', resources: [{ resourceId: machine, minutesPerUnit: '1' }] }],
      }),
      201,
    )
  ).revision.id;
  await ok(c.post(`/api/manufacturing/catalog/revisions/${revision}/approve`, {}));
  const variant = (await ok(c.post('/api/manufacturing/catalog/variants', { modelId: model, revisionId: revision, itemId: fg, color: 'Standart' }), 201)).variant.id;
  const order = async (quantity = '5') =>
    (await ok(c.post('/api/manufacturing/production/orders', { variantId: variant, revisionId: revision, quantity, warehouseId: warehouse, outputWarehouseId: warehouse }), 201)).order.id as string;
  const o1 = await order(), o2 = await order(), o3 = await order();

  it('sıraya bağlı hazırlık ve kalıp kısıtı plana yansır', async () => {
    await ok(c.put(`/api/manufacturing/resources/${machine}/rules`, { defaultSetupMinutes: 30, setupMatrix: [{ from: 'A', to: 'B', minutes: 15 }], hourlyCost: '60' }));
    expect((await c.put(`/api/manufacturing/resources/${tool}/rules`, { defaultSetupMinutes: 10 })).statusCode).toBe(422);
    const anchor = tomorrow + 'T08:00:00Z';
    const plan = (
      await ok(
        c.post('/api/manufacturing/planning/schedules', {
          anchor,
          direction: 'forward',
          jobs: [
            { orderId: o1, operationKey: 'press', resourceId: machine, minutes: 60, priority: 2, setupFamily: 'A', toolIds: [tool] },
            { orderId: o2, operationKey: 'press', resourceId: machine, minutes: 60, priority: 1, setupFamily: 'B', toolIds: [tool] },
          ],
        }),
      )
    ).record;
    expect(plan.operations.map((o: { start: string; end: string; setupMinutes?: number }) => [o.start, o.end, o.setupMinutes ?? 0])).toEqual([
      [tomorrow + 'T08:00:00.000Z', tomorrow + 'T09:30:00.000Z', 30],
      [tomorrow + 'T09:30:00.000Z', tomorrow + 'T10:45:00.000Z', 15],
    ]);
    // Kalıp iş kaynağı olamaz; makine kalıp yerine verilemez
    expect((await c.post('/api/manufacturing/planning/schedules', { anchor, direction: 'forward', jobs: [{ orderId: o3, operationKey: 'press', resourceId: tool, minutes: 10 }] })).statusCode).toBe(422);
    const bad = await c.post('/api/manufacturing/planning/schedules', { anchor, direction: 'forward', jobs: [{ orderId: o3, operationKey: 'press', resourceId: machine, minutes: 10, toolIds: [machine] }] });
    expect(bad.json().error.code).toBe('MANUFACTURING_TOOL_INVALID');
    await ok(c.post(`/api/manufacturing/planning/schedules/${plan.id}/cancel`, {}));
  });

  it('dondurma penceresi: yayımlı planın senaryosu pencerede değişiklik yaparsa gerekçe ister, sonra yerine geçer', async () => {
    await ok(c.put('/api/manufacturing/planning/policy', { freezeHours: 720 }));
    expect((await ok(c.get('/api/manufacturing/planning/policy'))).freezeHours).toBe(720);
    const plan = (await ok(c.post('/api/manufacturing/planning/schedules', { anchor: tomorrow + 'T12:00:00Z', direction: 'forward', jobs: [{ orderId: o1, operationKey: 'press', resourceId: machine, minutes: 30 }] }))).record;
    await ok(c.post(`/api/manufacturing/planning/schedules/${plan.id}/publish`, {}));
    const scenario = (await ok(c.post('/api/manufacturing/planning/scenarios', { ...key(), parentId: plan.id, anchor: tomorrow + 'T13:00:00Z' }))).record;
    expect(scenario.operations[0].start).toBe(tomorrow + 'T13:00:00.000Z');
    const blocked = await c.post(`/api/manufacturing/planning/schedules/${scenario.id}/publish`, {});
    expect(blocked.json().error.code).toBe('MANUFACTURING_FROZEN_WINDOW');
    const published = await ok(c.post(`/api/manufacturing/planning/schedules/${scenario.id}/publish`, { overrideReason: 'Acil müşteri siparişi' }));
    expect(published.record).toMatchObject({ status: 'published', replaces: plan.id, frozenOverride: { reason: 'Acil müşteri siparişi', violations: [expect.objectContaining({ change: 'moved' })] } });
    const plans = (await ok(c.get('/api/manufacturing/planning/schedules'))).records as { id: string; status: string }[];
    expect(plans.find((p) => p.id === plan.id)?.status).toBe('superseded');
    await ok(c.put('/api/manufacturing/planning/policy', { freezeHours: 0 }));
    await ok(c.post(`/api/manufacturing/planning/schedules/${scenario.id}/cancel`, {}));
  });

  it('beceri olmadan iş başlamaz; planlanan–gerçekleşen ve maliyet sapması', async () => {
    await ok(c.put(`/api/manufacturing/resources/${machine}/rules`, { requiredSkills: ['PRES'], hourlyCost: '60' }));
    await ok(c.post(`/api/manufacturing/production/orders/${o3}/release`, { date: TODAY_LOCAL, requestKey: randomUUID() }));
    // Şirket tarihi UTC tarihinden farklı olabilir: vardiya ve rapor aralığı gerçek "şimdi"ye göre kurulur
    const now = Date.now();
    await ok(c.post('/api/manufacturing/calendars', { resourceId: machine, start: new Date(now - 2 * 3600000).toISOString(), end: new Date(now + 2 * 3600000).toISOString(), available: true, reason: 'shift' }));
    const anchor = new Date(Math.floor((now - 20 * 60000) / 60000) * 60000).toISOString();
    const plan = (await ok(c.post('/api/manufacturing/planning/schedules', { anchor, direction: 'forward', jobs: [{ orderId: o3, operationKey: 'press', resourceId: machine, minutes: 10 }] }))).record;
    await ok(c.post(`/api/manufacturing/planning/schedules/${plan.id}/publish`, {}));

    const start = { ...key(), action: 'start', operationKey: 'press', resourceId: machine, date: TODAY_LOCAL };
    expect((await c.post(`/api/manufacturing/production/orders/${o3}/work`, start)).json().error.code).toBe('MANUFACTURING_SKILL_REQUIRED');
    // Süresi geçmiş sertifika sayılmaz
    await ok(c.put('/api/manufacturing/operator-skills', { userId: owner.userId, skill: 'PRES', level: 3, validUntil: '2020-01-01' }));
    expect((await c.post(`/api/manufacturing/production/orders/${o3}/work`, { ...start, ...key() })).json().error.code).toBe('MANUFACTURING_SKILL_REQUIRED');
    expect((await ok(c.get(`/api/manufacturing/resources/${machine}/qualified-operators`))).operators).toEqual([]);
    await ok(c.put('/api/manufacturing/operator-skills', { userId: owner.userId, skill: 'PRES', level: 3, validUntil: null }));
    expect((await ok(c.get(`/api/manufacturing/resources/${machine}/qualified-operators`))).operators).toEqual([expect.objectContaining({ id: owner.userId })]);
    await ok(c.post(`/api/manufacturing/production/orders/${o3}/work`, { ...start, ...key() }));
    await ok(c.post(`/api/manufacturing/production/orders/${o3}/work`, { ...key(), action: 'complete', operationKey: 'press', date: TODAY_LOCAL, quantity: '5', goodQty: '5' }));

    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const pa = await ok(c.get(`/api/manufacturing/reports/plan-actual?from=${day(now - 86400000)}&to=${day(now + 86400000)}`));
    const row = pa.rows.find((r: { orderId: string }) => r.orderId === o3);
    expect(row).toMatchObject({ operationKey: 'press', plannedMinutes: 10, status: 'done', goodQty: 5 });
    expect(row.startDelayMinutes).toBeGreaterThanOrEqual(15);
    expect(pa.summary).toMatchObject({ done: 1 });

    const close = await ok(c.get(`/api/manufacturing/production/orders/${o3}/cost-close`));
    expect(close.variance.material.items).toEqual([
      expect.objectContaining({ itemId: raw, standardQty: '5.0000', standardUnitCost: '2.0000', actualQty: '0.0000', usageVariance: '-10.00', priceVariance: '0.00' }),
    ]);
    expect(close.variance.labor.operations[0]).toMatchObject({ operationKey: 'press', standardMinutes: '5.00', hourlyCost: '60' });
    expect(close.variance.labor.efficiencyVariance).not.toBeNull();
  });
});
