import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  allocateImportSchema,
  cancelImportSchema,
  idParam,
  isoDate,
  listImportFilesQuerySchema,
  listImportSourcesQuerySchema,
  postImportSchema,
  saveImportFileSchema,
  uuid,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import {
  allocateImportFile,
  cancelImportFile,
  getImportFile,
  importFileReport,
  importLandedByItem,
  listImportFiles,
  listSources,
  postImportFile,
  reopenImportFile,
  saveImportFile,
  type ImportCtx,
} from './service';

const importCtx = ({ company, user }: TenantCtx): ImportCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

const itemReportQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), itemId: uuid.optional() });

/**
 * İthalat maliyet dağıtımı (inventory.imports). İzinler: okuma inventory.read, taslak/dağıtım invoices.manage,
 * muhasebeleştirme ve iptal invoices.post (yevmiye ve stok maliyeti etkiler).
 */
export const landedRoutes: FastifyPluginAsync = async (app) => {
  const mod = 'inventory.imports';
  const read = { module: mod, permission: 'inventory.read' } as const;
  const manage = { module: mod, permission: 'invoices.manage' } as const;
  const post = { module: mod, permission: 'invoices.post' } as const;

  app.get('/api/import-files', tenantRoute(app, read, async ({ tx, req }) => listImportFiles(tx, listImportFilesQuerySchema.parse(req.query))));
  app.get('/api/import-files/sources', tenantRoute(app, read, async ({ tx, req }) => listSources(tx, listImportSourcesQuerySchema.parse(req.query))));
  app.get('/api/import-files/reports/by-item', tenantRoute(app, read, async ({ tx, req }) => importLandedByItem(tx, itemReportQuery.parse(req.query))));
  app.get('/api/import-files/:id', tenantRoute(app, read, async ({ tx, req }) => getImportFile(tx, idParam.parse(req.params).id)));
  app.get('/api/import-files/:id/report', tenantRoute(app, read, async ({ tx, req }) => importFileReport(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/import-files',
    tenantRoute(app, manage, async (c) => {
      const result = await saveImportFile(c.tx, importCtx(c), null, saveImportFileSchema.parse(c.req.body));
      void c.reply.code(201);
      return result;
    }),
  );
  app.put('/api/import-files/:id', tenantRoute(app, manage, async (c) => saveImportFile(c.tx, importCtx(c), idParam.parse(c.req.params).id, saveImportFileSchema.parse(c.req.body))));
  app.post('/api/import-files/:id/allocate', tenantRoute(app, manage, async (c) => allocateImportFile(c.tx, importCtx(c), idParam.parse(c.req.params).id, allocateImportSchema.parse(c.req.body ?? {}))));
  app.post('/api/import-files/:id/reopen', tenantRoute(app, manage, async (c) => reopenImportFile(c.tx, importCtx(c), idParam.parse(c.req.params).id)));
  app.post('/api/import-files/:id/post', tenantRoute(app, post, async (c) => postImportFile(c.tx, importCtx(c), idParam.parse(c.req.params).id, postImportSchema.parse(c.req.body ?? {}))));
  app.post('/api/import-files/:id/cancel', tenantRoute(app, post, async (c) => cancelImportFile(c.tx, importCtx(c), idParam.parse(c.req.params).id, cancelImportSchema.parse(c.req.body))));
};
