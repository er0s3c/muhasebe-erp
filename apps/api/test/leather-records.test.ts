import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { effectivePermissions, resolveEnabledModules } from '@erp/shared';
import { addMember, client, createCompany, makeApp, registerUser, TODAY_LOCAL } from './helpers';
import { leatherDataTables } from '../src/modules/exports/leather-data';
import type { BuildCtx } from '../src/modules/exports/builders';
import { sanitizeAudit } from '../src/modules/administration/report';
import { productionOrderScope } from '../src/modules/leather/visibility';

const { app } = await makeApp();
const document = { filename: 'uretim.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\nplan').toString('base64') };
const created = (r: { statusCode: number; body: string; json: () => any }) => { expect(r.statusCode, r.body).toBe(201); return r.json(); };

describe('leather shared record tools', () => {
  it.each([randomUUID(), 'PRODUCTION:01a11a54-a1d2-7dae-b566-c4dd50aaa5b1:0'])('eski UUID kodu %s listede ve aramada okunabilir, aynı şirket kaydına bağlanır', async (legacyCode) => {
    const owner = await registerUser(app,'ReadableManufacturing');
    const company = await createCompany(app,owner.token,{sector:'MANUFACTURING_WHOLESALE'});
    const c = client(app,owner.token,company.id);
    const response = await c.post('/api/manufacturing/resources',{code:legacyCode,name:'Okunabilir makine',type:'machine'});
    expect(response.statusCode,response.body).toBe(200);
    const record = response.json().record;
    expect(record.code).not.toContain(legacyCode);
    const listed = (await c.get('/api/manufacturing/resources')).json().records.find((r:{id:string})=>r.id===record.id);
    expect(listed.code).toBe(record.code);
    const another = await c.post('/api/manufacturing/resources',{code:randomUUID(),name:'İkinci okunabilir makine',type:'machine'});
    expect(another.statusCode,another.body).toBe(200);
    expect(another.json().record.code).not.toBe(record.code);
    const search = await c.get(`/api/workspace/search?q=${encodeURIComponent(record.code)}&kind=manufacturing_resource`);
    expect(search.statusCode,search.body).toBe(200);
    expect(search.json().items).toEqual([expect.objectContaining({id:record.id,label:'Okunabilir makine',path:`/manufacturing/planning?open=${record.id}`})]);
    const isolated = await createCompany(app,owner.token,{sector:'MANUFACTURING_WHOLESALE'});
    expect((await client(app,owner.token,isolated.id).get(`/api/workspace/search?q=${record.code}&kind=manufacturing_resource`)).json().items).toEqual([]);
  });
  it('model search, tasks and documents follow source access and company scope', async () => {
    const owner = await registerUser(app, 'ModelArchive');
    const company = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
    const c = client(app, owner.token, company.id);
    const model = created(await c.post('/api/leather/catalog/models', { code: 'M-DOC', name: 'Belge cüzdan modeli', family: 'wallet' })).model;
    const source = await c.get(`/api/workspace/record?kind=leather_model&id=${model.id}`);
    expect(source.statusCode, source.body).toBe(200);
    expect(source.json()).toMatchObject({ path: `/leather/models?open=${model.id}`, canWrite: true });
    expect((await c.get('/api/workspace/search?q=Belge&kind=leather_model')).json().items[0].id).toBe(model.id);
    const worker = await addMember(app, c, company.id, 'operator');
    await c.put(`/api/company/members/${worker.userId}/module-access`, { levels: { 'leather.catalog': 'read' } });
    const ref = { kind: 'leather_model', id: model.id };
    expect((await worker.client.post('/api/workspace/documents', { ...document, record: ref })).statusCode).toBe(403);
    await c.put(`/api/company/members/${worker.userId}/module-access`, { levels: { 'leather.catalog': 'write' } });
    created(await worker.client.post('/api/workspace/documents', { ...document, record: ref }));
    created(await worker.client.post('/api/workspace/tasks', { title: 'Numune belgesini kontrol et', dueDate: TODAY_LOCAL, record: ref }));
    expect((await worker.client.get('/api/workspace/documents')).json().items).toHaveLength(1);
    expect((await worker.client.get('/api/workspace/tasks')).json().items).toHaveLength(1);
    await c.put(`/api/company/members/${worker.userId}/module-access`, { levels: { 'leather.catalog': 'none' } });
    expect((await worker.client.get('/api/workspace/documents')).json().items).toHaveLength(0);
    expect((await worker.client.get('/api/workspace/tasks')).json().items).toHaveLength(0);
    const other = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION', name: 'İkinci atölye' });
    expect((await client(app, owner.token, other.id).get(`/api/workspace/record?kind=leather_model&id=${model.id}`)).statusCode).toBe(404);
  });

  it('a second cashier cannot discover another session through records, archive or task counts', async () => {
    const owner = await registerUser(app, 'PosArchive');
    const company = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
    const c = client(app, owner.token, company.id);
    const cashier = await addMember(app, c, company.id, 'operator', 'KasiyerBir');
    const other = await addMember(app, c, company.id, 'operator', 'KasiyerIki');
    for (const user of [cashier, other]) await c.put(`/api/company/members/${user.userId}/module-access`, { levels: { 'sales.pos': 'write' } });
    const bootstrap = (await c.get('/api/pos/bootstrap')).json();
    const warehouseId = bootstrap.warehouses[0].id;
    const account = created(await c.post('/api/treasury/accounts', { kind: 'cash', name: 'Arşiv kasası', currency: 'TRY' })).account;
    const till = created(await c.post('/api/pos/tills', { name: 'Arşiv mağaza kasası', warehouseId, cashAccountId: account.id, assignedUserIds: [cashier.userId, other.userId] })).till;
    const item = created(await c.post('/api/items', { name: 'Deri kartlık', salePrice: '100', saleCurrency: 'TRY', inventoryRole: 'finished_goods' })).item;
    created(await c.post('/api/stock-documents', { type: 'receipt', docDate: TODAY_LOCAL, warehouseId, lines: [{ itemId: item.id, quantity: '2', unitCost: '40' }] }));
    const session = created(await cashier.client.post('/api/pos/sessions', { tillId: till.id, openingCash: '0' })).session;
    const sale = created(await cashier.client.post(`/api/pos/sessions/${session.id}/sales`, { requestId: randomUUID(), lines: [{ itemId: item.id, quantity: '1' }], payments: [{ method: 'cash', amount: '100' }] })).sale;
    const ref = { kind: 'pos_sale', id: sale.id };
    const uploaded = created(await cashier.client.post('/api/workspace/documents', { ...document, record: ref }));
    created(await c.post('/api/workspace/tasks', { title: 'Satış evrakını kontrol et', dueDate: TODAY_LOCAL, ownerId: other.userId, record: ref }));
    expect((await cashier.client.get(`/api/workspace/record?kind=pos_sale&id=${sale.id}`)).statusCode).toBe(200);
    expect((await other.client.get(`/api/workspace/record?kind=pos_sale&id=${sale.id}`)).statusCode).toBe(404);
    expect((await other.client.get(`/api/workspace/search?q=${sale.id.slice(0, 8)}&kind=pos_sale`)).json().items).toHaveLength(0);
    expect((await other.client.get('/api/workspace/documents')).json().items).toHaveLength(0);
    expect((await other.client.get(`/api/workspace/documents/${uploaded.id}/download`)).statusCode).toBe(404);
    const tasks = (await other.client.get('/api/workspace/tasks')).json();
    expect(tasks.items).toHaveLength(0);
    expect(tasks.counts.open).toBe(0);
    expect((await c.get('/api/workspace/tasks')).json().items).toHaveLength(1);
  });

  it('full data exports scope POS rows and omit cost columns without the separate cost grant', async () => {
    const permissions = effectivePermissions('operator', { 'sales.pos': 'write', 'leather.production': 'read' });
    const captured: string[] = [];
    const dialect = new PgDialect();
    const config = { operations: [{ key: 'cutting', cost: '99', nested: { provisionalUnitCost: '123', quantity: '2' } }], materials: [{ itemId: randomUUID(), quantity: '3', value: '456' }], trace: [{ rootId: randomUUID(), value: '888' }], journalEntryId: randomUUID() };
    const fake = { tx: { execute: async (query: SQL) => { captured.push(dialect.sqlToQuery(query).sql); return { rows: [{ id: randomUUID(), wip_value: '100', config: JSON.stringify(config) }] }; } }, company: { name: 'Test', baseCurrency: 'TRY', reportingCurrency: null }, user: { id: randomUUID(), role: 'operator' }, access: { companyId: randomUUID(), permissions, enabledModules: resolveEnabledModules('LEATHER_FASHION') } } as unknown as BuildCtx;
    const tables = await leatherDataTables(fake, {}, 100);
    expect(tables.some(t => t.key.startsWith('leather_cost_'))).toBe(false);
    const orders = tables.find(t => t.key === 'leather_production_orders')!;
    expect(orders.columns.some(c => c.key === 'wip_value')).toBe(false);
    expect(captured.find(s => s.includes('from "pos_sales"'))).toContain('ps.user_id=');
    expect(captured.find(s => s.includes('from "pos_sales"'))).toContain('assigned_user_ids');
    expect(captured.some(s => s.includes('request_hash'))).toBe(false);
    expect(captured.find(s => s.includes('from "leather_production_orders" r'))).toContain("coalesce(\"r\".config->>'assignedUserId'");
    for (const table of ['leather_reservations', 'leather_production_documents']) {
      const query = captured.find(s => s.includes(`from "${table}" r`))!;
      expect(query).toContain('po.id=r.order_id');
      expect(query).toContain("coalesce(\"po\".config->>'assignedUserId'");
    }
    const redacted = JSON.parse(orders.rows[0]!.config as string);
    expect(redacted).toMatchObject({ operations: [{ cost: null, nested: { provisionalUnitCost: null, quantity: '2' } }], materials: [{ quantity: '3', value: null }], journalEntryId: null });
    expect(redacted.trace).toBeUndefined();
    expect(tables.find(t => t.key === 'leather_production_documents')!.columns.some(c => c.key === 'journal_entry_id')).toBe(false);
    expect(sanitizeAudit({ code: 'URE-1', quantity: '2', wip_value: '987', config }, 'leather_production_orders')).toEqual({ code: 'URE-1', quantity: '2' });
    expect(sanitizeAudit({ value: '123', journal_entry_id: randomUUID(), config }, 'leather_production_documents')).toEqual({});
    expect(dialect.sqlToQuery(productionOrderScope('accountant', fake.user!.id, 'r')).sql).toBe('true');
    expect(dialect.sqlToQuery(productionOrderScope(undefined, fake.user!.id, 'r')).sql).toBe('false');
  });
});
