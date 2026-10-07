import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  dec,
  tryDec,
  isoDate,
  uuid,
  manufacturingCustomValuesSchema,
  manufacturingPieceRateSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { all, one, fail, lockLeatherCosts } from '../leather/common';
import { createRecord, getRecord, recordShape, updateRecord } from './service';
import { setAdjustment } from '../payroll/runs';

const ctx = (c: TenantCtx) => ({
  companyId: c.company.id,
  userId: c.user.id,
  baseCurrency: c.company.baseCurrency,
  reportingCurrency: c.company.reportingCurrency,
  allowNegativeStock: false,
});
export const manufacturingSupportRoutes: FastifyPluginAsync = async (app) => {
  const params = z.object({ id: uuid });
  for (const [entity, area, table] of [
    ['resource', 'manufacturing.planning', 'manufacturing_records'],
    ['model', 'manufacturing.catalog', 'leather_models'],
    ['production', 'manufacturing.production', 'leather_production_orders'],
    ['item', 'inventory', 'items'],
  ] as const) {
    const path = '/api/manufacturing/custom-values/' + entity + '/:id';
    const load = async (c: TenantCtx) => {
      const id = params.parse(c.req.params).id;
      await one(
        c.tx,
        sql`select id from ${sql.identifier(table)} where id=${id}::uuid ${entity === 'resource' ? sql`and kind='resource'` : sql``}`,
      );
      if (entity === 'production' && c.role === 'operator') {
        const o = await one(
          c.tx,
          sql`select config from leather_production_orders where id=${id}::uuid`,
        );
        if (o.config.assignedUserId !== c.user.id) throw forbidden('Yalnız atanmış üretim');
      }
      return id;
    };
    app.get(
      path,
      tenantRoute(app, { module: area, permission: (area + '.read') as never }, async (c) => {
        const id = await load(c);
        const definitions = await all(
          c.tx,
          sql`select config from manufacturing_records where kind='custom_field' and status='active' and config->>'entity'=${entity}`,
        );
        const values = await all(
          c.tx,
          sql`select config from manufacturing_records where kind='custom_field' and code=${'values:' + entity + ':' + id}`,
        );
        return { fields: definitions.map((r) => r.config), values: values[0]?.config.values ?? {} };
      }),
    );
    app.put(
      path,
      tenantRoute(app, { module: area, permission: (area + '.manage') as never }, async (c) => {
        const id = await load(c),
          input = manufacturingCustomValuesSchema.parse(c.req.body);
        await lockLeatherCosts(c.tx, c.company.id);
        const definitions = await all(
          c.tx,
          sql`select config from manufacturing_records where kind='custom_field' and status='active' and config->>'entity'=${entity}`,
        );
        const keys = new Set(definitions.map((r) => r.config.code));
        if (Object.keys(input.values).some((k) => !keys.has(k))) throw fail('Tanımsız özel alan');
        for (const { config: f } of definitions) {
          const value = input.values[f.code];
          if (f.required && !value?.trim()) throw fail(f.name + ' zorunlu');
          if (!value) continue;
          if (
            (f.type === 'number' && !tryDec(value)) ||
            (f.type === 'date' && !isoDate.safeParse(value).success) ||
            (f.type === 'choice' && !f.choices.includes(value))
          )
            throw fail(f.name + ' geçersiz');
        }
        const code = 'values:' + entity + ':' + id,
          config = {
            code,
            entity,
            entityId: id,
            values: input.values,
            ...(entity === 'item'
              ? { itemId: id }
              : entity === 'production'
                ? { orderId: id }
                : {}),
          };
        const prior = await all(
          c.tx,
          sql`select id from manufacturing_records where kind='custom_field' and code=${code}`,
        );
        return {
          record: prior.length
            ? await updateRecord(c.tx, prior[0]!.id, 'values', config)
            : await createRecord(c.tx, ctx(c), 'custom_field', config, 'values'),
        };
      }),
    );
  }
  const costs = {
    module: 'manufacturing.costs',
    permission: 'manufacturing.costs.manage',
  } as const;
  app.get(
    '/api/manufacturing/piece-rates/lookups',
    tenantRoute(
      app,
      { module: 'manufacturing.costs', permission: 'manufacturing.costs.read' },
      async (c) => {
        c.require('hr.payroll');
        return {
          resources: await all(
            c.tx,
            sql`select id,config->>'name' as name from manufacturing_records where kind='resource' and config->>'employeeId' is not null`,
          ),
          runs: await all(
            c.tx,
            sql`select id,number,month from payroll_runs where status='draft' order by month desc`,
          ),
          items: await all(
            c.tx,
            sql`select id,name from payroll_items where is_active and kind='earning'`,
          ),
        };
      },
    ),
  );
  app.post(
    '/api/manufacturing/piece-rates',
    tenantRoute(app, costs, async (c) => {
      c.require('hr.payroll_manage');
      const input = manufacturingPieceRateSchema.parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='attendance' and request_key=${input.requestKey}::uuid`,
      );
      if (previous.length) {
        if (previous[0]!.config.payloadHash !== payloadHash)
          throw fail('İstek kimliği farklı primde kullanıldı');
        return { record: recordShape(previous[0]!) };
      }
      const resource = await getRecord(c.tx, input.resourceId, 'resource');
      if (!resource.config.employeeId) throw fail('Kaynak bir personele bağlanmalı');
      const run = await one(
        c.tx,
        sql`select month,status from payroll_runs where id=${input.payrollRunId}::uuid for update`,
      );
      if (run.status !== 'draft') throw fail('Taslak bordro gerekli');
      await one(
        c.tx,
        sql`select id from payroll_items where id=${input.payrollItemId}::uuid and kind='earning' and is_active`,
        'Ek ödeme kalemi',
      );
      const existing = await all(
        c.tx,
        sql`select id from payroll_adjustments where run_id=${input.payrollRunId}::uuid and employee_id=${resource.config.employeeId}::uuid and item_id=${input.payrollItemId}::uuid`,
      );
      if (existing.length)
        throw fail('Bu personel ve kalemde ek ödeme var; mevcut bordro kalemini kontrol edin');
      const documents = await all(
        c.tx,
        sql`select id,config from leather_production_documents where kind='operation' and config->>'resourceId'=${resource.id} and config->>'key'=${input.operationKey} and to_char(date,'YYYY-MM')=${run.month}`,
      );
      const quantity = documents.reduce((s, d) => s.plus(d.config.goodQty ?? 0), dec(0)),
        hours = documents.reduce((s, d) => s.plus(d.config.minutes ?? 0), dec(0)).div(60);
      const amount = (input.mode === 'piece' ? quantity : hours)
        .times(input.unitRate)
        .toDecimalPlaces(2);
      if (amount.lte(0)) throw fail('Prim için gerçek üretim veya süre gerekli');
      await setAdjustment(c.tx, ctx(c), input.payrollRunId, {
        employeeId: resource.config.employeeId,
        itemId: input.payrollItemId,
        amount: amount.toFixed(2),
        note: 'Üretim ' + input.operationKey + ' · ' + input.mode + ' · ' + input.unitRate,
      });
      return {
        record: await createRecord(
          c.tx,
          ctx(c),
          'attendance',
          {
            ...input,
            code: 'piece-rate:' + input.requestKey,
            payloadHash,
            employeeId: resource.config.employeeId,
            quantity: quantity.toFixed(4),
            hours: hours.toFixed(4),
            amount: amount.toFixed(2),
            sourceIds: documents.map((d) => d.id),
          },
          'processed',
        ),
      };
    }),
  );
};
