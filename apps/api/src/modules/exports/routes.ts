import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { EXPORT_FORMATS } from '@erp/shared';
import { renderCsv } from '../../files/csv-write';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../../files/xlsx-write';
import { AppError, badRequest } from '../../http/errors';
import { tenantRoute } from '../../http/context';
import { EXPORTS } from './registry';

const formatSchema = z.object({ format: z.enum(EXPORT_FORMATS).default('xlsx') });

/**
 * `GET /api/exports/<rapor>?format=xlsx|csv&…rapor sorgusu`: raporu dosya olarak indirir. Her uç, ekrandaki
 * raporla aynı modül ve izinle korunur; içerik aynı servis fonksiyonlarından gelir (ayrı sorgu yok).
 * Tüm istek tek işlemde çalışır; RLS şirket dışı veriyi zaten göstermez.
 */
export const exportRoutes: FastifyPluginAsync = async (app) => {
  for (const def of EXPORTS) {
    app.get(
      `/api/exports/${def.key}`,
      tenantRoute(app, { module: def.module, permission: def.permission, limit: { name: 'export', max: 30, windowMs: 60_000 } }, async ({ tx, req, reply, company }) => {
        const { format } = formatSchema.parse(req.query);
        if (!def.formats.includes(format)) throw badRequest(`Bu rapor yalnızca ${def.formats.join(', ').toUpperCase()} olarak alınabilir`, 'EXPORT_FORMAT_UNSUPPORTED');
        const q = def.schema.parse(req.query);
        // Dışa aktarmalar bellekte üretilir: aynı anda en çok EXPORT_CONCURRENCY tane (aşılırsa beklemeden 429).
        if (!app.exportGate.tryAcquire()) {
          void reply.header('retry-after', '5');
          throw new AppError(429, 'EXPORT_BUSY', 'Şu anda başka dışa aktarmalar çalışıyor; birkaç saniye sonra tekrar deneyin');
        }
        try {
          const tables = await def.build({ tx, company }, q as never);
          const name = def.fileName(q as never);

          void reply
            .header('cache-control', 'no-store')
            .header('content-disposition', `attachment; filename="${name}.${format}"`);
          if (format === 'csv') {
            void reply.header('content-type', 'text/csv; charset=utf-8');
            return renderCsv(tables[0]!);
          }
          void reply.header('content-type', XLSX_CONTENT_TYPE);
          return Buffer.from(writeXlsx(tables));
        } finally {
          app.exportGate.release();
        }
      }),
    );
  }
};
