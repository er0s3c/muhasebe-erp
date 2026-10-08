import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  uuid,
  dec,
  quantityString,
  manufacturingPromiseSchema,
  manufacturingCommandSchema,
  manufacturingAllocationSchema,
  manufacturingSupplierSchema,
  manufacturingDemandPolicySchema,
  manufacturingWorkCommandSchema,
  manufacturingMaterialHandoffSchema,
  manufacturingLifecycleSchema,
  manufacturingBatchSchema,
  manufacturingReworkSchema,
  manufacturingReworkResultSchema,
  manufacturingScenarioSchema,
  manufacturingCalendarTemplateSchema,
  manufacturingLotDecisionSchema,
  manufacturingPatternSchema,
  manufacturingCutPlanSchema,
  manufacturingExceptionSchema,
  manufacturingServiceTimeSchema,
  manufacturingPieceGeometrySchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { all, one, fail, json } from '../leather/common';
import { productionOrderScope, redactLeatherCosts } from '../leather/visibility';
import { manufacturingCtx } from './routes';
import { command } from './commands';
import { allocateSales } from './allocations';
import { stockAvailability } from './availability';
import { promiseSales, procurementSupply, purchaseProposals } from './promise';
import {
  executionSummary,
  workCommand,
  lifecycle,
  createBatch,
  createRework,
  reworkResult,
} from './execution';
import { calendarTemplate, scenario, planHistory } from './scenarios';
import { exceptions, exceptionAction, createPattern, cutPlan, cancelCutPlan } from './control';
import { listRecords, createRecord, updateRecord, getRecord, mrp } from './service';
import { requireOpenPeriod } from '../settings/periods';
import { capacityReport, costCloseReport } from './reports';
import { pieceShape } from '../leather/materials';
import { queueInventoryChanges } from './channels';
import { materialHandoff } from './handoff';

const id = (c: TenantCtx) => z.object({ id: uuid }).parse(c.req.params).id;
const gate = (module: string, permission: string) => ({ module, permission: permission as never });
function requireManufacturing(c: TenantCtx) {
  if (!['MANUFACTURING_WHOLESALE', 'LEATHER_FASHION'].includes(c.company.sector))
    throw forbidden('Üretim sektörü gerekli');
}
async function scopedOrder(c: TenantCtx, orderId: string) {
  await one(
    c.tx,
    sql`select o.id from leather_production_orders o where o.id=${orderId}::uuid and ${productionOrderScope(c.role, c.user.id, 'o')}`,
    'Atanmış üretim emri',
  );
}
export const manufacturingExecutionRoutes: FastifyPluginAsync = async (app) => {
  const production = gate('manufacturing.production', 'manufacturing.production.read'),
    write = gate('manufacturing.production', 'manufacturing.production.manage');
  for (const prefix of ['manufacturing', 'leather']) {
    const batchLookups = async (c: TenantCtx) => {
      const orders = await all(
          c.tx,
          sql`select o.id,o.code,o.config->'operations' as operations from leather_production_orders o where ${productionOrderScope(c.role, c.user.id, 'o')}`,
        ),
        visible = new Set(orders.map((o) => o.id));
      return {
        records: (await listRecords(c.tx, 'batch')).filter((b) => visible.has(b.orderId)),
        orders,
      };
    };
    app.get(
      `/api/${prefix}/production/batches`,
      tenantRoute(app, gate(prefix + '.production', prefix + '.production.read'), batchLookups),
    );
    app.get(
      `/api/${prefix}/quality/batches`,
      tenantRoute(app, gate(prefix + '.quality', prefix + '.quality.read'), batchLookups),
    );
  }
  app.post(
    '/api/leather/production/batches',
    tenantRoute(app, gate('leather.production', 'leather.production.manage'), async (c) => {
      const input = manufacturingBatchSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await createBatch(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.get(
    '/api/manufacturing/execution/lookups',
    tenantRoute(app, production, async (c) => {
      const orders = await all(
        c.tx,
        sql`select o.id,o.code,o.status,o.quantity,o.completed_qty as "completedQty",o.config->>'executionPhase' as phase,o.config->'operations' as operations from leather_production_orders o where ${productionOrderScope(c.role, c.user.id, 'o')} order by o.created_at desc limit 500`,
      );
      const visible = new Set(orders.map((o) => o.id));
      return {
        orders,
        resources: (await listRecords(c.tx, 'resource')).map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          status: r.status,
        })),
        batches: (await listRecords(c.tx, 'batch')).filter((r) => visible.has(r.orderId)),
      };
    }),
  );
  app.get(
    '/api/manufacturing/stock-availability',
    tenantRoute(app, gate('inventory.wms', 'inventory.wms.read'), async (c) => {
      const q = z.object({ itemId: uuid, warehouseId: uuid }).parse(c.req.query);
      await one(c.tx, sql`select id from items where id=${q.itemId}::uuid`);
      return stockAvailability(c.tx, q.itemId, q.warehouseId);
    }),
  );
  app.post(
    '/api/manufacturing/promise',
    tenantRoute(app, gate('core.invoices', 'invoices.read'), async (c) => {
      if (!['MANUFACTURING_WHOLESALE', 'LEATHER_FASHION'].includes(c.company.sector))
        throw forbidden('Üretim sektörü gerekli');
      const result = await promiseSales(c.tx, manufacturingPromiseSchema.parse(c.req.body));
      if (!c.can('procurement.read')) for (const line of result.lines) line.proposals = [];
      return result;
    }),
  );
  app.get(
    '/api/manufacturing/promise/lookups',
    tenantRoute(app, gate('core.invoices', 'invoices.read'), async (c) => {
      requireManufacturing(c);
      return {
        orders: await all(
          c.tx,
          sql`select id,doc_no as code from sales_orders where kind='order' and status='confirmed' order by created_at desc limit 500`,
        ),
        warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
      };
    }),
  );
  app.get(
    '/api/manufacturing/allocations',
    tenantRoute(app, gate('core.invoices', 'invoices.read'), async (c) => {
      requireManufacturing(c);
      return {
        records: await all(
          c.tx,
          sql`select a.id,a.quantity,a.fulfilled_qty as "fulfilledQty",a.priority,a.reason,a.status,o.doc_no as "orderCode",i.name as "itemName",w.name as "warehouseName" from manufacturing_sales_allocations a join sales_order_lines l on l.id=a.sales_order_line_id join sales_orders o on o.id=l.order_id join items i on i.id=a.item_id join warehouses w on w.id=a.warehouse_id order by a.updated_at desc limit 500`,
        ),
      };
    }),
  );
  app.post(
    '/api/manufacturing/allocations',
    tenantRoute(app, gate('core.invoices', 'invoices.manage'), async (c) => {
      requireManufacturing(c);
      return {
        record: await allocateSales(
          c.tx,
          manufacturingCtx(c),
          manufacturingAllocationSchema.parse(c.req.body),
        ),
      };
    }),
  );
  app.get(
    '/api/manufacturing/production/orders/:id/execution',
    tenantRoute(app, production, async (c) => {
      await scopedOrder(c, id(c));
      const summary = await executionSummary(c.tx, id(c));
      return c.can('manufacturing.costs.read') ? summary : redactLeatherCosts(summary);
    }),
  );
  for (const prefix of ['manufacturing', 'leather'])
    app.post(
      `/api/${prefix}/production/orders/:id/material-handoff`,
      tenantRoute(
        app,
        prefix === 'leather' ? gate('leather.production', 'leather.production.manage') : write,
        async (c) => {
          await scopedOrder(c, id(c));
          return {
            record: await materialHandoff(
              c.tx,
              manufacturingCtx(c),
              id(c),
              manufacturingMaterialHandoffSchema.parse(c.req.body),
            ),
          };
        },
      ),
    );
  app.post(
    '/api/manufacturing/production/orders/:id/work',
    tenantRoute(app, write, async (c) => {
      await scopedOrder(c, id(c));
      return {
        record: await workCommand(
          c.tx,
          manufacturingCtx(c),
          id(c),
          manufacturingWorkCommandSchema.parse(c.req.body),
        ),
      };
    }),
  );
  app.post(
    '/api/manufacturing/production/orders/:id/phase',
    tenantRoute(
      app,
      gate('manufacturing.production', 'manufacturing.production.approve'),
      async (c) => {
        await scopedOrder(c, id(c));
        return lifecycle(
          c.tx,
          manufacturingCtx(c),
          id(c),
          manufacturingLifecycleSchema.parse(c.req.body),
        );
      },
    ),
  );
  app.post(
    '/api/manufacturing/batches',
    tenantRoute(app, write, async (c) => {
      const input = manufacturingBatchSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await createBatch(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.post(
    '/api/manufacturing/rework',
    tenantRoute(app, gate('manufacturing.quality', 'manufacturing.quality.approve'), async (c) => {
      const input = manufacturingReworkSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await createRework(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.get(
    '/api/manufacturing/supply/lookups',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.read'), async (c) => ({
      items: await all(c.tx, sql`select id,code,name from items where is_active and kind='goods'`),
      parties: await all(
        c.tx,
        sql`select id,name from parties where is_active and kind in ('supplier','both')`,
      ),
      warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
      profiles: await listRecords(c.tx, 'supplier_profile'),
      policies: await listRecords(c.tx, 'demand_policy'),
    })),
  );

  const reworkLookups = async (c: TenantCtx) => {
    const orders = await all(
      c.tx,
      sql`select o.id from leather_production_orders o where ${productionOrderScope(c.role, c.user.id, 'o')}`,
    );
    const visible = new Set(orders.map((o) => o.id));
    const checksById = new Map(
      (await all(c.tx, sql`select id,status from leather_quality_checks`)).map((q) => [
        q.id,
        q.status,
      ]),
    );
    return {
      records: (await listRecords(c.tx, 'rework'))
        .filter((r) => visible.has(r.orderId))
        .map((r) => ({ ...r, recheckStatus: checksById.get(r.recheckId) ?? null })),
      checks: await all(
        c.tx,
        sql`select q.id,o.code as "orderCode",q.source_id as "orderId",q.config->>'reworkQty' as "reworkQty" from leather_quality_checks q join leather_production_orders o on o.id=q.source_id and o.company_id=q.company_id where q.scope='production' and q.status='approved' and coalesce((q.config->>'reworkQty')::numeric,0)>0 and ${productionOrderScope(c.role, c.user.id, 'o')}`,
      ),
    };
  };
  app.get('/api/manufacturing/rework', tenantRoute(app, production, reworkLookups));
  for (const prefix of ['manufacturing', 'leather'])
    app.get(
      '/api/' + prefix + '/quality/rework',
      tenantRoute(app, gate(prefix + '.quality', prefix + '.quality.read'), reworkLookups),
    );
  app.post(
    '/api/leather/rework',
    tenantRoute(app, gate('leather.quality', 'leather.quality.approve'), async (c) => {
      const input = manufacturingReworkSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await createRework(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.post(
    '/api/manufacturing/rework/:id/result',
    tenantRoute(app, write, async (c) => {
      const r = await getRecord(c.tx, id(c), 'rework');
      await scopedOrder(c, r.order_id);
      return {
        record: await reworkResult(
          c.tx,
          manufacturingCtx(c),
          id(c),
          manufacturingReworkResultSchema.parse(c.req.body),
        ),
      };
    }),
  );
  app.get(
    '/api/manufacturing/supply/:id',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.read'), async (c) => {
      await one(c.tx, sql`select id from items where id=${id(c)}::uuid`);
      return procurementSupply(c.tx, id(c));
    }),
  );
  app.post(
    '/api/manufacturing/supplier-profiles',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.manage'), async (c) => {
      const input = manufacturingSupplierSchema.parse(c.req.body);
      return {
        record: await command(c.tx, manufacturingCtx(c), 'supplier-profile', input, async () => {
          await one(
            c.tx,
            sql`select id from items where id=${input.itemId}::uuid and kind='goods'`,
          );
          await one(
            c.tx,
            sql`select id from parties where id=${input.partyId}::uuid and kind in ('supplier','both') and is_active`,
            'Tedarikçi',
          );
          await one(
            c.tx,
            sql`select code from currencies where code=${input.currency}`,
            'Para birimi',
          );
          const existing = (await listRecords(c.tx, 'supplier_profile')).find(
            (p) => p.itemId === input.itemId && p.partyId === input.partyId,
          );
          return existing
            ? updateRecord(c.tx, existing.id, 'active', input)
            : createRecord(c.tx, manufacturingCtx(c), 'supplier_profile', input, 'active');
        }),
      };
    }),
  );
  app.post(
    '/api/manufacturing/demand-policies',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.manage'), async (c) => {
      const input = manufacturingDemandPolicySchema.parse(c.req.body);
      return {
        record: await command(c.tx, manufacturingCtx(c), 'demand-policy', input, async () => {
          if (dec(input.target).lt(input.minimum)) throw fail('Hedef stok minimumdan küçük olamaz');
          await one(
            c.tx,
            sql`select id from items where id=${input.itemId}::uuid and kind='goods'`,
          );
          await one(
            c.tx,
            sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
          );
          const existing = (await listRecords(c.tx, 'demand_policy')).find(
            (p) => p.itemId === input.itemId && p.warehouseId === input.warehouseId,
          );
          return existing
            ? updateRecord(c.tx, existing.id, 'active', input)
            : createRecord(c.tx, manufacturingCtx(c), 'demand_policy', input, 'active');
        }),
      };
    }),
  );
  app.get(
    '/api/manufacturing/replenishment',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.read'), async (c) => {
      const result = [];
      for (const p of await listRecords(c.tx, 'demand_policy')) {
        const stock = await stockAvailability(c.tx, p.itemId, p.warehouseId);
        if (dec(stock.available).lt(p.minimum))
          result.push({
            policyId: p.id,
            itemId: p.itemId,
            warehouseId: p.warehouseId,
            itemName: p.itemName,
            warehouseName: p.warehouseName,
            stock,
            needs: await mrp(c.tx, {
              itemId: p.itemId,
              warehouseId: p.warehouseId,
              quantity: p.target,
            }),
          });
      }
      return { recommendations: result };
    }),
  );
  app.post(
    '/api/manufacturing/mrp/proposals',
    tenantRoute(app, gate('manufacturing.mrp', 'manufacturing.mrp.read'), async (c) => {
      const input = z
        .object({
          needs: z
            .array(
              z.object({
                itemId: uuid,
                net: quantityString,
                action: z.enum(['purchase', 'produce']),
                name: z.string().optional(),
              }),
            )
            .max(500),
          anchor: z.iso.datetime({ offset: true }),
        })
        .parse(c.req.body);
      return { proposals: await purchaseProposals(c.tx, input.needs, input.anchor) };
    }),
  );
  app.post(
    '/api/manufacturing/planning/scenarios',
    tenantRoute(
      app,
      gate('manufacturing.planning', 'manufacturing.planning.manage'),
      async (c) => ({
        record: await scenario(
          c.tx,
          manufacturingCtx(c),
          manufacturingScenarioSchema.parse(c.req.body),
        ),
      }),
    ),
  );
  app.get(
    '/api/manufacturing/planning/schedules/:id/history',
    tenantRoute(app, gate('manufacturing.planning', 'manufacturing.planning.read'), async (c) =>
      planHistory(c.tx, id(c)),
    ),
  );
  app.post(
    '/api/manufacturing/planning/calendar-template',
    tenantRoute(app, gate('manufacturing.planning', 'manufacturing.planning.manage'), async (c) =>
      calendarTemplate(
        c.tx,
        manufacturingCtx(c),
        manufacturingCalendarTemplateSchema.parse(c.req.body),
      ),
    ),
  );
  app.get(
    '/api/manufacturing/exceptions',
    tenantRoute(app, production, async (c) => ({
      records: await exceptions(
        c.tx,
        c.role,
        c.user.id,
        z.object({ includeResolved: z.enum(['true', 'false']).optional() }).parse(c.req.query)
          .includeResolved === 'true',
      ),
    })),
  );
  app.get(
    '/api/manufacturing/planning/capacity',
    tenantRoute(app, gate('manufacturing.planning', 'manufacturing.planning.read'), async (c) => {
      const q = z
        .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
        .refine(
          (v) =>
            Date.parse(v.to) > Date.parse(v.from) &&
            Date.parse(v.to) - Date.parse(v.from) <= 366 * 86400000,
          'Geçerli kapasite aralığı gerekli',
        )
        .parse(c.req.query);
      return capacityReport(c.tx, q.from, q.to);
    }),
  );
  app.get(
    '/api/manufacturing/production/orders/:id/cost-close',
    tenantRoute(app, gate('manufacturing.costs', 'manufacturing.costs.read'), async (c) => {
      await scopedOrder(c, id(c));
      return costCloseReport(c.tx, id(c));
    }),
  );
  app.get(
    '/api/manufacturing/exceptions/lookups',
    tenantRoute(app, production, async (c) => ({
      users: await all(
        c.tx,
        sql`select u.id,u.full_name as name from users u join memberships m on m.user_id=u.id where m.company_id=${c.company.id}::uuid and u.is_active`,
      ),
    })),
  );
  app.post(
    '/api/manufacturing/exceptions',
    tenantRoute(
      app,
      gate('manufacturing.production', 'manufacturing.production.approve'),
      async (c) => ({
        record: await exceptionAction(
          c.tx,
          manufacturingCtx(c),
          manufacturingExceptionSchema.parse(c.req.body),
        ),
      }),
    ),
  );
  app.post(
    '/api/wms/lots/:id/quality-quantity',
    tenantRoute(app, gate('inventory.wms', 'inventory.wms.manage'), async (c) => {
      c.require('manufacturing.quality.approve');
      const input = manufacturingLotDecisionSchema.parse(c.req.body);
      return {
        record: await command(
          c.tx,
          manufacturingCtx(c),
          'lot-quality:' + id(c),
          input,
          async () => {
            const lot = await getRecord(c.tx, id(c), 'lot', true);
            if (['leather_traced', 'partitioned'].includes(lot.status))
              throw fail('Bu kabul fiziksel parça kayıtlarından yönetilir');
            const qty = lot.config.remainingQty ?? lot.config.quantity;
            if (dec(input.releasedQty).plus(input.damagedQty).gt(qty))
              throw fail('Kalite miktarları parti bakiyesini aşamaz');
            const record = await updateRecord(
              c.tx,
              lot.id,
              dec(input.releasedQty).gt(0) ? 'available' : 'quarantine',
              {
                ...lot.config,
                releasedQty: input.releasedQty,
                damagedQty: input.damagedQty,
                qualityReason: input.reason,
                qualityApprovedBy: c.user.id,
              },
            );
            await queueInventoryChanges(c.tx, manufacturingCtx(c), 'quality:' + input.requestKey, [
              lot.item_id,
            ]);
            return record;
          },
        ),
      };
    }),
  );
  app.get(
    '/api/manufacturing/cutting/lookups',
    tenantRoute(app, production, async (c) => {
      const orders = await all(
        c.tx,
        sql`select o.id from leather_production_orders o where ${productionOrderScope(c.role, c.user.id, 'o')}`,
      );
      const visible = new Set(orders.map((o) => o.id));
      return {
        models: await all(c.tx, sql`select id,code,name from leather_models`),
        patterns: await listRecords(c.tx, 'pattern'),
        plans: (await listRecords(c.tx, 'cut_plan')).filter((r) => visible.has(r.orderId)),
      };
    }),
  );
  app.get(
    '/api/leather/materials/cutting/lookups',
    tenantRoute(app, gate('leather.materials', 'leather.materials.read'), async (c) => {
      const orders = await all(
          c.tx,
          sql`select o.id,o.code from leather_production_orders o where ${productionOrderScope(c.role, c.user.id, 'o')}`,
        ),
        visible = new Set(orders.map((o) => o.id));
      return {
        orders,
        models: await all(c.tx, sql`select id,code,name from leather_models`),
        patterns: await listRecords(c.tx, 'pattern'),
        plans: (await listRecords(c.tx, 'cut_plan')).filter((r) => visible.has(r.orderId)),
      };
    }),
  );
  app.post(
    '/api/leather/catalog/patterns',
    tenantRoute(app, gate('leather.catalog', 'leather.catalog.manage'), async (c) => ({
      record: await createPattern(
        c.tx,
        manufacturingCtx(c),
        manufacturingPatternSchema.parse(c.req.body),
      ),
    })),
  );
  app.post(
    '/api/leather/materials/cutting/plans',
    tenantRoute(app, gate('leather.production', 'leather.production.manage'), async (c) => {
      const input = manufacturingCutPlanSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await cutPlan(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.post(
    '/api/leather/materials/pieces/:id/geometry',
    tenantRoute(app, gate('leather.materials', 'leather.materials.manage'), async (c) => {
      const input = manufacturingPieceGeometrySchema.parse(c.req.body);
      return {
        piece: await command(
          c.tx,
          manufacturingCtx(c),
          'piece-geometry:' + id(c),
          input,
          async () => {
            const piece = await one(
              c.tx,
              sql`select * from leather_pieces where id=${id(c)}::uuid for update`,
            );
            if (['consumed', 'split'].includes(piece.status))
              throw fail('Tüketilmiş parçanın geometrisi değişmez');
            return pieceShape(
              await one(
                c.tx,
                sql`update leather_pieces set config=config||${json({ grainAngle: input.grainAngle, outline: input.outline, defects: input.defects, geometryReason: input.reason })} where id=${piece.id}::uuid returning *`,
              ),
            );
          },
        ),
      };
    }),
  );
  for (const path of [
    '/api/leather/materials/cutting/plans/:id/cancel',
    '/api/manufacturing/cutting/plans/:id/cancel',
  ])
    app.post(
      path,
      tenantRoute(
        app,
        path.includes('/leather/')
          ? gate('leather.production', 'leather.production.manage')
          : write,
        async (c) => {
          const plan = await getRecord(c.tx, id(c), 'cut_plan');
          await scopedOrder(c, plan.order_id);
          return {
            record: await cancelCutPlan(
              c.tx,
              manufacturingCtx(c),
              id(c),
              manufacturingCommandSchema.parse(c.req.body),
            ),
          };
        },
      ),
    );
  app.get(
    '/api/leather/service/time',
    tenantRoute(app, gate('leather.service', 'leather.service.read'), async (c) => ({
      records: (await listRecords(c.tx, 'service_time')).map((r) =>
        c.can('leather.costs.read') ? r : redactLeatherCosts(r),
      ),
    })),
  );
  app.post(
    '/api/manufacturing/cutting/patterns',
    tenantRoute(app, gate('manufacturing.catalog', 'manufacturing.catalog.manage'), async (c) => ({
      record: await createPattern(
        c.tx,
        manufacturingCtx(c),
        manufacturingPatternSchema.parse(c.req.body),
      ),
    })),
  );
  app.post(
    '/api/manufacturing/cutting/plans',
    tenantRoute(app, write, async (c) => {
      const input = manufacturingCutPlanSchema.parse(c.req.body);
      await scopedOrder(c, input.orderId);
      return { record: await cutPlan(c.tx, manufacturingCtx(c), input) };
    }),
  );
  app.post(
    '/api/leather/service/time',
    tenantRoute(app, gate('leather.service', 'leather.service.manage'), async (c) => {
      const input = manufacturingServiceTimeSchema.parse(c.req.body);
      return {
        record: await command(c.tx, manufacturingCtx(c), 'service-time', input, async () => {
          await requireOpenPeriod(c.tx, input.date);
          const service = await one(
            c.tx,
            sql`select id,status from leather_service_cases where id=${input.serviceId}::uuid`,
            'Servis',
          );
          if (['cancelled', 'delivered'].includes(service.status))
            throw fail('Açık servis kaydı gerekli');
          await one(
            c.tx,
            sql`select user_id from memberships where company_id=${c.company.id}::uuid and user_id=${input.technicianId}::uuid`,
            'Teknisyen',
          );
          const record = await createRecord(
            c.tx,
            manufacturingCtx(c),
            'service_time',
            {
              ...input,
              estimatedLaborCost: dec(input.minutes).div(60).times(input.hourlyRate).toFixed(2),
            },
            'completed',
          );
          await c.tx.execute(
            sql`update leather_service_cases set config=config||${json({ technicianId: input.technicianId })} where id=${service.id}`,
          );
          return record;
        }),
      };
    }),
  );
};
