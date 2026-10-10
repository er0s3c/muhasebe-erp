import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { EXPORT_FORMATS, areaOfModule, resourceOperationAllowed } from '@erp/shared';
import { exportEvents, users } from '../../db/schema';
import { renderCsv } from '../../files/csv-write';
import { writeXlsxStream, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import { AppError, badRequest, forbidden } from '../../http/errors';
import { tenantRoute } from '../../http/context';
import { EXPORTS } from './registry';
import { isModuleDenied, requireResourceOperation } from '../access/effective';

const formatSchema = z.object({ format: z.enum(EXPORT_FORMATS).default('xlsx') });

/**
 * `GET /api/exports/<rapor>?format=xlsx|csv&…rapor sorgusu`: raporu dosya olarak indirir. Her uç, ekrandaki
 * raporla aynı modül ve izinle korunur; içerik aynı servis fonksiyonlarından gelir (ayrı sorgu yok).
 * Tüm istek tek işlemde çalışır; RLS şirket dışı veriyi zaten göstermez.
 */
export const exportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/exports/access', tenantRoute(app, {}, async ({ access, enabledModules }) => ({ reports: Object.fromEntries(EXPORTS.map(def => [def.key,
    access.permissions.has(def.permission) && [def.module, ...(def.alternateModules ?? [])].some(module => {
      const area = areaOfModule(module);
      return enabledModules.has(module) && !isModuleDenied(access, module) && (!area || resourceOperationAllowed(access.permissions, access.overrides, area, 'export'));
    })])) })));
  app.get('/api/company/export-events', tenantRoute(app, {}, async ({ tx, company }) => ({ events: await tx.select({ id: exportEvents.id, reportKey: exportEvents.reportKey, format: exportEvents.format, rowCount: exportEvents.rowCount, occurredAt: exportEvents.occurredAt, requestId: exportEvents.requestId, userId: exportEvents.userId, fullName: users.fullName }).from(exportEvents).innerJoin(users, eq(users.id, exportEvents.userId)).where(eq(exportEvents.companyId, company.id)).orderBy(desc(exportEvents.occurredAt), desc(exportEvents.id)).limit(100) })));
  for (const def of EXPORTS) {
    app.get(
      `/api/exports/${def.key}`,
      tenantRoute(app, { module: def.alternateModules ? undefined : def.module, permission: def.permission, limit: { name: 'export', max: 30, windowMs: 60_000 } }, async ({ tx, req, reply, company, user, role, access, enabledModules }) => {
        if (def.alternateModules && ![def.module,...def.alternateModules].some(module=>enabledModules.has(module)&&!isModuleDenied(access,module)))
          throw forbidden('Bu raporun modülü şirketinizde etkin değil veya erişiminiz yok.');
        if (def.alternateModules) {
          const module = [def.module, ...def.alternateModules].find(module => {
            const area = areaOfModule(module);
            return enabledModules.has(module) && !isModuleDenied(access, module) && (!area || resourceOperationAllowed(access.permissions, access.overrides, area, 'export'));
          });
          if (!module) throw forbidden('Bu rapor için dışa aktarma yetkiniz yok.', 'RESOURCE_OPERATION_DENIED');
          requireResourceOperation(access, module, 'export');
        }
        const { format } = formatSchema.parse(req.query);
        if (!def.formats.includes(format)) throw badRequest(`Bu rapor yalnızca ${def.formats.join(', ').toUpperCase()} olarak alınabilir`, 'EXPORT_FORMAT_UNSUPPORTED');
        const q = def.schema.parse(req.query);
        // Queries retain report rows; XLSX XML/ZIP output streams with backpressure.
        if (!app.exportGate.tryAcquire()) {
          void reply.header('retry-after', '5');
          throw new AppError(429, 'EXPORT_BUSY', 'Şu anda başka dışa aktarmalar çalışıyor; birkaç saniye sonra tekrar deneyin');
        }
        let streamOwnsGate=false;
        try {
          const tables = await def.build({ tx, company, user: { id: user.id, role }, access: { companyId: company.id, permissions: access.permissions, enabledModules } }, q as never);
          const name = def.fileName(q as never);
          const recordExport = async () => {
            await tx.insert(exportEvents).values({ companyId: company.id, userId: user.id, reportKey: def.key, format, rowCount: (format === 'csv' ? [tables[0]!] : tables).reduce((n, table) => n + table.rows.length, 0), requestId: req.id, ip: req.ip });
          };

          void reply
            .header('cache-control', 'no-store')
            .header('content-disposition', `attachment; filename="${name}.${format}"`);
          if (format === 'csv') {
            void reply.header('content-type', 'text/csv; charset=utf-8');
            const csv = renderCsv(tables[0]!);
            await recordExport();
            return csv;
          }
          void reply.header('content-type', XLSX_CONTENT_TYPE);
          const stream=writeXlsxStream(tables);
          try { await recordExport(); } catch (error) { stream.destroy(); throw error; }
          stream.once('close',()=>app.exportGate.release());
          streamOwnsGate=true;
          return stream;
        } finally {
          if(!streamOwnsGate)app.exportGate.release();
        }
      }),
    );
  }
};
