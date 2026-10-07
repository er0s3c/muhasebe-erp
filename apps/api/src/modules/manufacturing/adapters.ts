import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { uuid, upsertAttendanceSchema, bankStatementOptionsSchema } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { saveAttendance } from '../hr/attendance';
import { bankStatementHandler } from '../imports/handlers/bank-statement';
import { all, fail, lockLeatherCosts } from '../leather/common';
import { createRecord, getRecord, recordShape } from './service';
import { manufacturingCtx } from './routes';

/** Provider-independent file commands reuse the existing HR/bank import services. */
export const manufacturingAdapterRoutes: FastifyPluginAsync = async (app) => {
  const gate = { module: 'core.integrations', permission: 'core.integrations.manage' } as const;
  const params = z.object({ id: uuid });
  app.get(
    '/api/integrations/adapters',
    tenantRoute(
      app,
      { module: 'core.integrations', permission: 'core.integrations.read' },
      async () => ({
        adapters: [
          {
            provider: 'pdks',
            command: 'attendance-file',
            format: 'upsertAttendanceSchema',
            live: false,
          },
          {
            provider: 'bank',
            command: 'bank-file',
            format: 'bankStatementOptionsSchema + mapped rows',
            live: false,
          },
          {
            provider: 'edocument',
            command: 'invoice-outbox',
            format: 'posted invoice id',
            live: false,
          },
        ],
      }),
    ),
  );
  app.post(
    '/api/integrations/connections/:id/attendance-file',
    tenantRoute(app, gate, async (c) => {
      c.require('hr.manage');
      const id = params.parse(c.req.params).id,
        input = z
          .object({ requestKey: uuid, attendance: upsertAttendanceSchema })
          .parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const connection = await getRecord(c.tx, id, 'connection');
      if (connection.config.provider !== 'pdks') throw fail('PDKS adaptörü gerekli');
      const code = 'attendance:' + id + ':' + input.requestKey,
        payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='integration_event' and code=${code}`,
      );
      if (previous.length) {
        if (previous[0]!.config.payloadHash !== payloadHash)
          throw fail('İstek kimliği farklı PDKS dosyasında kullanıldı');
        return { record: recordShape(previous[0]!) };
      }
      const result = await saveAttendance(c.tx, manufacturingCtx(c), input.attendance);
      for (const entry of input.attendance.entries) {
        const resources = await all(
          c.tx,
          sql`select id from manufacturing_records where kind='resource' and config->>'employeeId'=${entry.employeeId}`,
        );
        for (const r of resources) {
          const calendarCode = 'attendance:' + r.id + ':' + entry.workDate;
          const rows = await all(
            c.tx,
            sql`select id from manufacturing_records where kind='calendar' and code=${calendarCode}`,
          );
          const absent = ['absent', 'annual_leave', 'sick_leave', 'unpaid_leave'].includes(
            entry.dayType,
          );
          const config = {
            code: calendarCode,
            resourceId: r.id,
            start: entry.workDate + 'T00:00:00Z',
            end: new Date(Date.parse(entry.workDate + 'T00:00:00Z') + 86400000).toISOString(),
            available: false,
            reason: 'absence',
            employeeId: entry.employeeId,
          };
          if (rows.length)
            await c.tx.execute(
              sql`update manufacturing_records set status=${absent ? 'active' : 'cancelled'} where id=${rows[0]!.id}`,
            );
          else if (absent)
            await createRecord(c.tx, manufacturingCtx(c), 'calendar', config, 'active');
        }
      }
      for (const entry of input.attendance.clear) {
        await c.tx.execute(
          sql`update manufacturing_records set status='cancelled',updated_at=now() where kind='calendar' and code in (select 'attendance:'||id::text||':'||${entry.workDate} from manufacturing_records where kind='resource' and config->>'employeeId'=${entry.employeeId})`,
        );
      }
      return {
        record: await createRecord(
          c.tx,
          manufacturingCtx(c),
          'integration_event',
          { code, connectionId: id, payloadHash, result, attempts: 1 },
          'processed',
        ),
      };
    }),
  );
  app.post(
    '/api/integrations/connections/:id/bank-file',
    tenantRoute(app, gate, async (c) => {
      c.require('treasury.post');
      const id = params.parse(c.req.params).id,
        input = z
          .object({
            requestKey: uuid,
            options: bankStatementOptionsSchema,
            rows: z
              .array(
                z.object({
                  row: z.number().int().positive(),
                  cells: z.record(z.string().max(64), z.string().max(500)),
                }),
              )
              .min(1)
              .max(3100),
          })
          .parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const connection = await getRecord(c.tx, id, 'connection');
      if (connection.config.provider !== 'bank') throw fail('Banka dosya adaptörü gerekli');
      const code = 'bank-file:' + id + ':' + input.requestKey,
        payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='integration_event' and code=${code}`,
      );
      if (previous.length) {
        if (previous[0]!.config.payloadHash !== payloadHash)
          throw fail('İstek kimliği farklı banka dosyasında kullanıldı');
        return { record: recordShape(previous[0]!) };
      }
      const plan = await bankStatementHandler.plan(
        { tx: c.tx, company: c.company, userId: c.user.id },
        input.rows,
        input.options,
      );
      if (
        plan.general.some((m) => m.severity === 'error') ||
        plan.rows.some((r) => r.status === 'error')
      )
        throw fail(
          'Banka dosyası doğrulanamadı; mevcut ekstre içe aktarma ekranında satırları kontrol edin',
        );
      const result = await plan.apply();
      return {
        record: await createRecord(
          c.tx,
          manufacturingCtx(c),
          'integration_event',
          { code, connectionId: id, payloadHash, result, attempts: 1 },
          'processed',
        ),
      };
    }),
  );
  app.post(
    '/api/integrations/connections/:id/invoice-outbox',
    tenantRoute(app, gate, async (c) => {
      c.require('invoices.read');
      const id = params.parse(c.req.params).id,
        input = z.object({ invoiceId: uuid, requestKey: uuid }).parse(c.req.body);
      const connection = await getRecord(c.tx, id, 'connection');
      if (connection.config.provider !== 'edocument') throw fail('E-belge adaptörü gerekli');
      await lockLeatherCosts(c.tx, c.company.id);
      const invoice = await all(
        c.tx,
        sql`select id from invoices where id=${input.invoiceId}::uuid and status='posted'`,
      );
      if (!invoice.length) throw fail('Kayıtlı fatura gerekli');
      const code = 'edocument:' + id + ':' + input.invoiceId;
      const previous = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='integration_event' and code=${code}`,
      );
      return {
        record: previous.length
          ? recordShape(previous[0]!)
          : await createRecord(
              c.tx,
              manufacturingCtx(c),
              'integration_event',
              {
                code,
                connectionId: id,
                invoiceId: input.invoiceId,
                requestKey: input.requestKey,
                attempts: 0,
                error: 'Sağlayıcı adaptörü ve bağlantı bilgileri bekleniyor',
              },
              'adapter_required',
            ),
      };
    }),
  );
};
