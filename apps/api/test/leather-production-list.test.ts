import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { LightMyRequestResponse } from 'fastify';
import type { Tx } from '../src/db/client';
import { setContext } from '../src/db/client';
import { getProductions } from '../src/modules/leather/production';
import {
  addMember, client, createCompany, execAsOwner, makeApp, orgOf, registerUser,
} from './helpers';

const body = (response: LightMyRequestResponse, status = 200) => {
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
};

describe('deri üretim listesi toplu sorgusu', async () => {
  const { app, handle } = await makeApp();

  it('300 emri iki sorguda getirir, istek sırasını ve rezervasyon eşleşmesini korur', async () => {
    const ids = Array.from({ length: 300 }, () => randomUUID());
    const statements: { sql: string; params: unknown[] }[] = [];
    const dialect = new PgDialect();
    const tx = {
      execute: async (query: SQL) => {
        const statement = dialect.sqlToQuery(query);
        statements.push(statement);
        if (statement.sql.includes('from leather_production_orders')) {
          return { rows: [...ids].reverse().map(id => ({ id, config: {}, quantity: '1' })) };
        }
        return {
          rows: [
            { orderId: ids[1], id: 'reservation-second', quantity: '2' },
            { orderId: ids[0], id: 'reservation-first', quantity: '1' },
          ],
        };
      },
    } as unknown as Tx;

    const orders = await getProductions(tx, ids);
    expect(statements).toHaveLength(2);
    expect(statements.every(statement => statement.params.length === 300)).toBe(true);
    expect(orders.map(order => order.id)).toEqual(ids);
    expect(orders[0]!.reservations).toEqual([{ id: 'reservation-first', quantity: '1' }]);
    expect(orders[1]!.reservations).toEqual([{ id: 'reservation-second', quantity: '2' }]);
    expect(orders[2]!.reservations).toEqual([]);
    expect(await getProductions(tx, [])).toEqual([]);
    expect(statements).toHaveLength(2);
  });

  it('liste ve detay aynı veriyi verir; şirket ve operatör sınırı ile eksik kayıt 404 kalır', async () => {
    const owner = await registerUser(app, 'LeatherProductionList');
    const company = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
    const c = client(app, owner.token, company.id);
    const worker = await addMember(app, c, company.id, 'operator', 'ListOperator');
    body(await c.put(`/api/company/members/${worker.userId}/module-access`, {
      levels: { 'leather.production': 'read' },
    }));
    const warehouseId = body(await c.get('/api/warehouses')).warehouses[0].id;
    const raw = body(await c.post('/api/items', {
      name: 'Liste deri malzemesi', kind: 'goods', unit: 'm2', inventoryRole: 'raw_material',
    }), 201).item;
    const finished = body(await c.post('/api/items', {
      name: 'Liste cüzdanı', kind: 'goods', unit: 'adet', inventoryRole: 'finished_goods',
    }), 201).item;
    const model = body(await c.post('/api/leather/catalog/models', {
      code: 'LIST-MODEL', name: 'Liste modeli', family: 'wallet',
    }), 201).model;
    const revision = body(await c.post(`/api/leather/catalog/models/${model.id}/revisions`, {
      name: 'Liste reçetesi', materials: [{ itemId: raw.id, quantity: '1' }],
      operations: [{ key: 'stitching', name: 'Dikiş' }], sampleApproved: true,
    }), 201).revision;
    body(await c.post(`/api/leather/catalog/revisions/${revision.id}/approve`));
    const variant = body(await c.post('/api/leather/catalog/variants', {
      modelId: model.id, revisionId: revision.id, itemId: finished.id, color: 'Taba',
    }), 201).variant;
    const created = [];
    for (const quantity of ['1', '2', '3']) {
      created.push(body(await c.post('/api/leather/production/orders', {
        variantId: variant.id, revisionId: revision.id, warehouseId,
        outputWarehouseId: warehouseId, quantity,
        ...(quantity === '2' ? { assignedUserId: worker.userId } : {}),
      }), 201).order);
    }
    for (const [index, order] of created.entries()) {
      await execAsOwner('update leather_production_orders set created_at=$1 where id=$2', [
        new Date(Date.UTC(2025, 0, index + 1)).toISOString(), order.id,
      ]);
    }

    const listed = body(await c.get('/api/leather/production/orders')).orders;
    expect(listed.map((order: { id: string }) => order.id)).toEqual(
      [...created].reverse().map(order => order.id),
    );
    for (const order of listed) {
      const detail = body(await c.get(`/api/leather/production/orders/${order.id}`)).order;
      expect(order).toEqual(detail);
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0].quantity).toBe(order.quantity);
      expect(order.reservations[0]).not.toHaveProperty('orderId');
    }
    const requestedIds = [created[1].id, created[0].id, created[2].id, created[1].id];
    const requested = await handle.db.transaction(async tx => {
      await setContext(tx, {
        userId: owner.userId, orgId: await orgOf(app, owner.token), companyId: company.id,
      });
      await tx.execute(sql`select set_config('app.branch_selection','all',true),set_config('app.branch_id','',true)`);
      return getProductions(tx, requestedIds);
    });
    expect(requested.map(order => order.id)).toEqual(requestedIds);
    const assigned = body(await worker.client.get('/api/leather/production/orders')).orders;
    expect(assigned.map((order: { id: string }) => order.id)).toEqual([created[1].id]);
    expect((await worker.client.get(`/api/leather/production/orders/${created[0].id}`)).statusCode).toBe(403);
    expect((await c.get(`/api/leather/production/orders/${randomUUID()}`)).statusCode).toBe(404);

    const other = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
    const otherClient = client(app, owner.token, other.id);
    expect(body(await otherClient.get('/api/leather/production/orders')).orders).toEqual([]);
    expect((await otherClient.get(`/api/leather/production/orders/${created[0].id}`)).statusCode).toBe(404);
  });
});
