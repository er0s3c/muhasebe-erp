import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  manufacturingMrpSchema,
  manufacturingResourceSchema,
  manufacturingCalendarSchema,
  manufacturingMaintenanceSchema,
  manufacturingScheduleSchema,
  manufacturingTransferSchema,
  manufacturingTransferActionSchema,
  manufacturingRecordActionSchema,
  leatherProductionFromSalesSchema,
  uuid,
  dec,
  todayIso,
  isoDate,
  manufacturingDepartmentSchema,
  manufacturingCustomFieldSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { all, one, fail, json, lockLeatherCosts, type LeatherCtx } from '../leather/common';
import { manufacturingCoreRoutes } from '../leather/routes';
import {
  mrp,
  createMrpOrders,
  listRecords,
  createRecord,
  getRecord,
  recordShape,
  updateRecord,
  schedule,
  publishSchedule,
  maintenance,
  finishMaintenance,
  transferAction,
} from './service';
import { createRequest } from '../procurement/requests';
import { manufacturingMetrics } from './metrics';
import { manufacturingSupportRoutes } from './support';

export const manufacturingCtx = (c: TenantCtx): LeatherCtx => ({
  companyId: c.company.id,
  userId: c.user.id,
  baseCurrency: c.company.baseCurrency,
  reportingCurrency: c.company.reportingCurrency,
  allowNegativeStock: false,
});
const id = (c: TenantCtx) => z.object({ id: uuid }).parse(c.req.params).id;
export const manufacturingRoutes: FastifyPluginAsync = async (app) => {
  await app.register(manufacturingCoreRoutes);
  await app.register(manufacturingSupportRoutes);
  const gate = (area: string, write = false) => ({
    module: area,
    permission: (area + (write ? '.manage' : '.read')) as never,
  });
  for (const [kind, path, area] of [
    ['resource', 'resources', 'manufacturing.planning'],
    ['calendar', 'calendars', 'manufacturing.planning'],
    ['schedule', 'planning/schedules', 'manufacturing.planning'],
    ['maintenance', 'maintenance', 'manufacturing.maintenance'],
    ['transfer', 'transfers', 'manufacturing.production'],
  ] as const) {
    app.get(
      '/api/manufacturing/' + path,
      tenantRoute(app, gate(area), async (c) => ({
        records: (await listRecords(c.tx, kind)).filter(
          (r) =>
            c.role !== 'operator' ||
            kind === 'maintenance' ||
            !r.orderId ||
            r.assignedUserId === c.user.id,
        ),
      })),
    );
  }
  app.post(
    '/api/manufacturing/resources',
    tenantRoute(app, gate('manufacturing.planning', true), async (c) => {
      const input = manufacturingResourceSchema.parse(c.req.body);
      if (input.assignedUserId)
        await one(
          c.tx,
          sql`select user_id from memberships where company_id=${c.company.id} and user_id=${input.assignedUserId}`,
          'Kaynak görevlisi',
        );
      if (input.employeeId)
        await one(
          c.tx,
          sql`select id from employees where id=${input.employeeId}::uuid`,
          'Personel',
        );
      if (input.assetId)
        await one(c.tx, sql`select id from fixed_assets where id=${input.assetId}`, 'Demirbaş');
      return { record: await createRecord(c.tx, manufacturingCtx(c), 'resource', input, 'active') };
    }),
  );
  app.get(
    '/api/manufacturing/planning/lookups',
    tenantRoute(app, gate('manufacturing.planning'), async (c) => ({
      employees: await all(
        c.tx,
        sql`select id,code,full_name as name from employees where status='active'`,
      ),
    })),
  );
  for (const [kind, path, schema] of [
    ['department', 'departments', manufacturingDepartmentSchema],
    ['custom_field', 'custom-fields', manufacturingCustomFieldSchema],
  ] as const) {
    app.get(
      '/api/manufacturing/' + path,
      tenantRoute(app, gate('manufacturing.planning'), async (c) => ({
        records: (await listRecords(c.tx, kind)).filter((r) => r.status !== 'values'),
      })),
    );
    app.post(
      '/api/manufacturing/' + path,
      tenantRoute(app, gate('manufacturing.planning', true), async (c) => {
        const input = schema.parse(c.req.body);
        if ('parentId' in input && input.parentId)
          await getRecord(c.tx, input.parentId, 'department');
        return { record: await createRecord(c.tx, manufacturingCtx(c), kind, input, 'active') };
      }),
    );
  }
  app.post(
    '/api/manufacturing/calendars',
    tenantRoute(app, gate('manufacturing.planning', true), async (c) => {
      const input = manufacturingCalendarSchema.parse(c.req.body);
      await getRecord(c.tx, input.resourceId, 'resource');
      return { record: await createRecord(c.tx, manufacturingCtx(c), 'calendar', input, 'active') };
    }),
  );
  app.post(
    '/api/manufacturing/mrp',
    tenantRoute(app, gate('manufacturing.mrp'), async (c) => ({
      needs: await mrp(c.tx, manufacturingMrpSchema.parse(c.req.body)),
    })),
  );
  app.post(
    '/api/manufacturing/mrp/orders',
    tenantRoute(app, gate('manufacturing.mrp', true), async (c) => {
      c.require('manufacturing.production.manage');
      const input = manufacturingMrpSchema
        .extend({ outputWarehouseId: uuid, assignedUserId: uuid.optional(), requestKey: uuid })
        .parse(c.req.body);
      return { orders: await createMrpOrders(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.post(
    '/api/manufacturing/mrp/purchase-request',
    tenantRoute(app, gate('manufacturing.mrp', true), async (c) => {
      c.require('procurement.manage');
      const input = manufacturingMrpSchema.extend({ requestKey: uuid }).parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const prev = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='integration_event' and code=${'mrp-purchase:' + input.requestKey}`,
      );
      if (prev.length) return { requestId: prev[0]!.config.requestId };
      const needs = (await mrp(c.tx, input)).filter(
        (n) => n.action === 'purchase' && dec(n.net).gt(0),
      );
      if (!needs.length) throw fail('Satın alma eksiği yok');
      const request = await createRequest(c.tx, manufacturingCtx(c), {
        projectId: null,
        title: 'Üretim ihtiyaç talebi',
        needDate: input.dueDate ?? null,
        lines: needs.map((n) => ({
          itemId: n.itemId,
          description: n.name,
          unit: n.unit,
          quantity: n.net,
          projectId: null,
          wbsId: null,
        })),
      } as never);
      await createRecord(
        c.tx,
        manufacturingCtx(c),
        'integration_event',
        {
          code: 'mrp-purchase:' + input.requestKey,
          requestId: (request.request as Record<string, unknown>).id,
        },
        'processed',
      );
      return { requestId: (request.request as Record<string, unknown>).id };
    }),
  );
  app.post(
    '/api/manufacturing/planning/schedules',
    tenantRoute(app, gate('manufacturing.planning', true), async (c) => {
      const input = manufacturingScheduleSchema.parse(c.req.body);
      return {
        record: await createRecord(c.tx, manufacturingCtx(c), 'schedule', {
          ...input,
          operations: await schedule(c.tx, input),
        }),
      };
    }),
  );
  app.put(
    '/api/manufacturing/planning/schedules/:id',
    tenantRoute(app, gate('manufacturing.planning', true), async (c) => {
      const r = await getRecord(c.tx, id(c), 'schedule', true);
      if (r.status !== 'draft') throw fail('Yayımlanan plan değişmez; yeni senaryo açın');
      const input = manufacturingScheduleSchema.parse(c.req.body);
      return {
        record: await updateRecord(c.tx, r.id, 'draft', {
          ...input,
          operations: await schedule(c.tx, input, r.id),
        }),
      };
    }),
  );
  app.post(
    '/api/manufacturing/planning/schedules/:id/publish',
    tenantRoute(
      app,
      { module: 'manufacturing.planning', permission: 'manufacturing.planning.approve' },
      async (c) => ({ record: await publishSchedule(c.tx, manufacturingCtx(c), id(c)) }),
    ),
  );
  app.post(
    '/api/manufacturing/planning/schedules/:id/cancel',
    tenantRoute(
      app,
      { module: 'manufacturing.planning', permission: 'manufacturing.planning.approve' },
      async (c) => {
        await lockLeatherCosts(c.tx, c.company.id);
        const r = await getRecord(c.tx, id(c), 'schedule', true);
        return {
          record: await updateRecord(c.tx, r.id, 'cancelled', {
            ...r.config,
            cancelledBy: c.user.id,
            cancelledAt: new Date().toISOString(),
          }),
        };
      },
    ),
  );
  app.get(
    '/api/manufacturing/maintenance/resources',
    tenantRoute(app, gate('manufacturing.maintenance'), async (c) => ({
      records: await listRecords(c.tx, 'resource'),
    })),
  );
  app.get(
    '/api/manufacturing/maintenance/lookups',
    tenantRoute(app, gate('manufacturing.maintenance'), async (c) => ({
      items: await all(c.tx, sql`select id,code,name from items where is_active and kind='goods'`),
      warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
    })),
  );
  app.get(
    '/api/manufacturing/maintenance/metrics',
    tenantRoute(app, gate('manufacturing.maintenance'), async (c) => {
      const q = z
        .object({ from: isoDate, to: isoDate })
        .refine(
          (v) => v.from <= v.to && Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
          'En fazla bir yıllık aralık seçin',
        )
        .parse(c.req.query);
      return { metrics: await manufacturingMetrics(c.tx, q.from, q.to) };
    }),
  );
  app.post(
    '/api/manufacturing/maintenance',
    tenantRoute(app, gate('manufacturing.maintenance', true), async (c) => ({
      record: await maintenance(
        c.tx,
        manufacturingCtx(c),
        manufacturingMaintenanceSchema.parse(c.req.body),
      ),
    })),
  );
  app.post(
    '/api/manufacturing/maintenance/:id/complete',
    tenantRoute(app, gate('manufacturing.maintenance', true), async (c) => {
      const input = manufacturingRecordActionSchema.parse(c.req.body);
      return {
        record: await finishMaintenance(c.tx, manufacturingCtx(c), id(c), {
          ...input,
          date: input.date ?? todayIso(),
        }),
      };
    }),
  );
  app.post(
    '/api/manufacturing/transfers',
    tenantRoute(app, gate('manufacturing.production', true), async (c) => {
      const input = manufacturingTransferSchema.parse(c.req.body);
      const o = await one(
        c.tx,
        sql`select config,status from leather_production_orders where id=${input.orderId}::uuid`,
      );
      if (c.role === 'operator' && o.config.assignedUserId !== c.user.id)
        throw forbidden('Yalnız atanmış üretim');
      if (
        !['released', 'in_progress'].includes(o.status) ||
        ![input.fromOperation, input.toOperation].every((k) =>
          o.config.operations.some((p: { key: string }) => p.key === k),
        )
      )
        throw fail('Transfer açık üretim rotasında olmalı');
      return {
        record: await createRecord(c.tx, manufacturingCtx(c), 'transfer', {
          ...input,
          assignedUserId: o.config.assignedUserId,
          receivedQty: '0',
        }),
      };
    }),
  );
  app.post(
    '/api/manufacturing/transfers/:id/actions',
    tenantRoute(app, gate('manufacturing.production', true), async (c) => {
      const input = manufacturingTransferActionSchema.parse(c.req.body);
      const r = await getRecord(c.tx, id(c), 'transfer');
      if (c.role === 'operator' && r.config.assignedUserId !== c.user.id)
        throw forbidden('Yalnız atanmış üretim');
      if (input.action === 'approve') c.require('manufacturing.production.approve');
      return { record: await transferAction(c.tx, manufacturingCtx(c), r.id, input) };
    }),
  );
  app.get(
    '/api/manufacturing/reports',
    tenantRoute(app, gate('manufacturing.production'), async (c) => {
      const operations = await all(
        c.tx,
        sql`select d.date,d.config,o.code,o.due_date from leather_production_documents d join leather_production_orders o on o.id=d.order_id where d.kind='operation' ${c.role === 'operator' ? sql`and o.config->>'assignedUserId'=${c.user.id}` : sql``}`,
      );
      const planned = await all(
        c.tx,
        sql`select code,quantity,config from leather_production_orders where status<>'cancelled' ${c.role === 'operator' ? sql`and config->>'assignedUserId'=${c.user.id}` : sql``}`,
      );
      const standards = planned.map((o) => ({
        order: o.code,
        minutesPerUnit: (o.config.operations ?? [])
          .reduce(
            (s: ReturnType<typeof dec>, p: { plannedMinutes?: string }) =>
              s.plus(p.plannedMinutes ?? 0),
            dec(0),
          )
          .toFixed(4),
        quantity: o.quantity,
      }));
      const plannedQty = standards.reduce((s, o) => s.plus(o.quantity), dec(0)),
        plannedMinutes = standards.reduce(
          (s, o) => s.plus(dec(o.minutesPerUnit).times(o.quantity)),
          dec(0),
        );
      const fallback = plannedQty.gt(0) ? plannedMinutes.div(plannedQty).toFixed(4) : null;
      const history = [7, 30, 90].map((days) => {
        const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const rows = operations.filter((o) => o.date >= since && dec(o.config.goodQty ?? 0).gt(0));
        const qty = rows.reduce((s, o) => s.plus(o.config.goodQty), dec(0));
        const minutes = rows.reduce((s, o) => s.plus(o.config.minutes), dec(0));
        return {
          days,
          goodQty: qty.toFixed(4),
          minutes: minutes.toFixed(4),
          minutesPerUnit: qty.gt(0) ? minutes.div(qty).toFixed(4) : fallback,
          source: rows.length ? 'actual' : fallback === null ? 'no_data' : 'standard',
        };
      });
      return {
        history,
        standards,
        operations: operations.map((o) => ({ date: o.date, order: o.code, ...o.config })),
      };
    }),
  );
  app.get(
    '/api/manufacturing/trace/items/:id',
    tenantRoute(app, gate('manufacturing.production'), async (c) => {
      if (c.role === 'operator' && !c.can('inventory.read'))
        throw forbidden('İzlenebilirlik için depo okuma yetkisi gerekli');
      const itemId = id(c);
      return {
        orders: await all(
          c.tx,
          sql`select id,code,status,quantity,completed_qty as "completedQty" from leather_production_orders where item_id=${itemId}::uuid or id in (select order_id from leather_reservations where item_id=${itemId}::uuid)`,
        ),
        lots: (await listRecords(c.tx, 'lot')).filter((l) => l.itemId === itemId),
        movements: await all(
          c.tx,
          sql`select m.id,m.document_id,m.qty,d.source_type,d.source_id,d.doc_date from stock_movements m join stock_documents d on d.id=m.document_id where m.item_id=${itemId}::uuid order by d.doc_date`,
        ),
      };
    }),
  );
  // Keep the import part of the public shared interface used by integrations and sales.
  void leatherProductionFromSalesSchema;
  void json;
  void recordShape;
};
