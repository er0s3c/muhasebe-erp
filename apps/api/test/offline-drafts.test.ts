import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, makeApp, orgOf, registerUser, TODAY_LOCAL, thisYear } from './helpers';

const { app, handle } = await makeApp();
function must(response: { statusCode: number; body: string; json: () => any }, status = 201) { expect(response.statusCode, response.body).toBe(status); return response.json(); }
async function setup() {
  const user = await registerUser(app, 'Offline');
  const company = await createCompany(app, user.token, { sector: 'COMMERCE', jurisdiction: 'TR' });
  const c = client(app, user.token, company.id);
  const warehouse = must(await c.get('/api/warehouses'), 200).warehouses[0];
  const item = must(await c.post('/api/items', { name: 'Sayılacak ürün' })).item;
  return { user, company, c, warehouse, item };
}
const count = (s: Awaited<ReturnType<typeof setup>>, clientId = randomUUID()) => ({ clientId, draft: { kind: 'stock_count', warehouseId: s.warehouse.id, date: TODAY_LOCAL, description: 'Çevrimdışı sayım', lines: [{ itemId: s.item.id, countedQty: '4.25' }] } });

describe('Genel çevrimdışı taslak eşitleme', () => {
  it('eşzamanlı tekrarlar tek taslak üretir, mali hareket oluşturmaz ve farklı içerik reddedilir', async () => {
    const s = await setup(), input = count(s);
    const results = await Promise.all([s.c.post('/api/offline-drafts/sync', input), s.c.post('/api/offline-drafts/sync', input)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(results[0].json().resultId).toBe(results[1].json().resultId);
    const receipt = results[0].json();
    const saved = must(await s.c.get(`/api/stock-counts/${receipt.resultId}`), 200);
    expect(saved.count.status).toBe('draft'); expect(saved.lines[0].countedQty).toBe('4.2500'); expect(Number(saved.lines[0].systemQty)).toBe(0);
    expect(must(await s.c.get(`/api/items/${s.item.id}`), 200).stock.qty).toBe('0.0000');
    const mismatch = await s.c.post('/api/offline-drafts/sync', { ...input, draft: { ...input.draft, description: 'Değişen içerik' } });
    expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error.code).toBe('OFFLINE_DRAFT_CONFLICT');
    await asDb(handle, { companyId: s.company.id, userId: s.user.userId, orgId: await orgOf(app, s.user.token) }, async q => {
      expect((await q('select count(*)::int as n from stock_counts')).rows[0].n).toBe(1);
      expect((await q('select count(*)::int as n from stock_movements')).rows[0].n).toBe(0);
      expect((await q('select count(*)::int as n from journal_entries')).rows[0].n).toBe(0);
    });
  });
  it('aynı kimlikle farklı kullanıcı veya şirketin taslağını döndürmez', async () => {
    const a = await setup(), b = await setup();
    const member = await addMember(app, a.c, a.company.id, 'admin', 'offline-admin');
    const clientId = randomUUID();
    const draft = { kind: 'field_task', title: 'Saha kontrolü', description: '', date: TODAY_LOCAL, priority: 'normal' };
    const first = must(await a.c.post('/api/offline-drafts/sync', { clientId, draft }));
    const second = must(await member.client.post('/api/offline-drafts/sync', { clientId, draft }));
    const third = must(await b.c.post('/api/offline-drafts/sync', { clientId, draft }));
    expect(new Set([first.resultId, second.resultId, third.resultId]).size).toBe(3);
    expect((await b.c.post('/api/offline-drafts/sync', count(a))).statusCode).toBe(409);
  });
  it('pasif kart, yinelenen satır ve kapanmış dönemi tekrar kontrol eder', async () => {
    const s = await setup();
    const duplicate = count(s); duplicate.draft.lines.push(duplicate.draft.lines[0]);
    expect((await s.c.post('/api/offline-drafts/sync', duplicate)).json().error.code).toBe('OFFLINE_STOCK_CHANGED');
    must(await s.c.patch(`/api/items/${s.item.id}`, { isActive: false }), 200);
    expect((await s.c.post('/api/offline-drafts/sync', count(s))).json().error.code).toBe('OFFLINE_STOCK_CHANGED');
    must(await s.c.patch(`/api/items/${s.item.id}`, { isActive: true }), 200);
    const month = Number(TODAY_LOCAL.slice(5, 7));
    const period = must(await s.c.get(`/api/periods?year=${thisYear}`), 200).periods.find((row: { month: number }) => row.month === month);
    must(await s.c.post(`/api/periods/${period.id}/close`), 200);
    const blocked = await s.c.post('/api/offline-drafts/sync', count(s));
    expect(blocked.statusCode).toBe(422); expect(blocked.json().error.code).toBe('PERIOD_CLOSED');
  });
  it('güncel modül/işlem hakkı ve şube kapsamını kullanır', async () => {
    const s = await setup();
    const reader = await addMember(app, s.c, s.company.id, 'viewer', 'offline-viewer');
    expect(must(await reader.client.get('/api/offline-drafts/bootstrap'), 200).kinds).toEqual([]);
    expect((await reader.client.post('/api/offline-drafts/sync', count(s))).statusCode).toBe(403);
    const a = must(await s.c.post('/api/company/branches', { code: 'OFF-A', name: 'A şubesi' })).branch;
    const b = must(await s.c.post('/api/company/branches', { code: 'OFF-B', name: 'B şubesi' })).branch;
    must(await s.c.post('/api/company/branch-assignments', { branchId: a.id, warehouseIds: [s.warehouse.id] }), 200);
    const member = await addMember(app, s.c, s.company.id, 'admin', 'offline-limited');
    must(await s.c.put(`/api/company/members/${member.userId}/branches`, { mode: 'restricted', branchIds: [b.id], allowUnassigned: false }), 200);
    const denied = await app.inject({ method: 'POST', url: '/api/offline-drafts/sync', headers: { authorization: `Bearer ${member.token}`, 'x-company-id': s.company.id, 'x-branch-id': b.id }, payload: count(s) });
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.json().error.code).toBe('WAREHOUSE_NOT_FOUND');
    must(await s.c.put(`/api/company/members/${member.userId}/module-access`, { permissions: { 'inventory.move': 'deny' } }), 200);
    const permissionDenied = await member.client.post('/api/offline-drafts/sync', count(s));
    expect(permissionDenied.statusCode, permissionDenied.body).toBe(403);
  });
});
