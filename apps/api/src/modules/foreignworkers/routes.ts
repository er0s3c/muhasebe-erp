import type { FastifyPluginAsync } from 'fastify';
import {
  createDocTypeSchema,
  createForeignDocSchema,
  createForeignParamSchema,
  createGuaranteeSchema,
  foreignDocListQuerySchema,
  guaranteeListQuerySchema,
  idParam,
  renewForeignDocSchema,
  resolveGuaranteeSchema,
  revealForeignDocNoSchema,
  revokeForeignDocSchema,
  updateDocTypeSchema,
  updateForeignDocSchema,
  updateForeignParamSchema,
  verifyForeignParamSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import { createDoc, createType, deleteDoc, getDoc, listDocs, listTypes, renewDoc, revealDocNo, revokeDoc, updateDoc, updateType } from './docs';
import { createGuarantee, deleteGuarantee, guaranteeReport, listGuarantees, resolveGuarantee } from './guarantees';
import { createParam, deleteParam, listParams, updateParam, verifyParam, warningAt, type ForeignCtx } from './params';
import { todayIso } from '@erp/shared';

export const foreignWorkerRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.foreign';
  const read = { module: MODULE, permission: 'hr.read' } as const;
  const manage = { module: MODULE, permission: 'hr.manage' } as const;
  const sensitive = { module: MODULE, permission: 'hr.sensitive' } as const;
  const fctx = ({ company, user }: TenantCtx): ForeignCtx => ({ companyId: company.id, userId: user.id, secret: app.config.JWT_SECRET });

  // --- Belge türleri (kullanıcı kataloğu; yalnızca genel adlar tohumlanır) --------------------------------
  app.get('/api/foreign-workers/doc-types', tenantRoute(app, read, async ({ tx, company }) => ({ types: await listTypes(tx, company.id) })));
  app.post(
    '/api/foreign-workers/doc-types',
    tenantRoute(app, manage, async ({ tx, company, req, reply }) => {
      const type = await createType(tx, company.id, createDocTypeSchema.parse(req.body));
      void reply.code(201);
      return { type };
    }),
  );
  app.patch('/api/foreign-workers/doc-types/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ type: await updateType(tx, idParam.parse(req.params).id, updateDocTypeSchema.parse(req.body)) })));

  // --- Parametreler (tarihli, doğrulama alanlı, varsayılan kapalı) -----------------------------------------
  app.get('/api/foreign-workers/params', tenantRoute(app, read, async ({ tx }) => ({ params: await listParams(tx), warning: await warningAt(tx, todayIso()) })));
  app.post(
    '/api/foreign-workers/params',
    tenantRoute(app, manage, async (c) => {
      const param = await createParam(c.tx, fctx(c), createForeignParamSchema.parse(c.req.body));
      void c.reply.code(201);
      return { param };
    }),
  );
  app.patch('/api/foreign-workers/params/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ param: await updateParam(tx, idParam.parse(req.params).id, updateForeignParamSchema.parse(req.body)) })));
  app.post('/api/foreign-workers/params/:id/verify', tenantRoute(app, manage, async (c) => ({ param: await verifyParam(c.tx, idParam.parse(c.req.params).id, c.user.id, verifyForeignParamSchema.parse(c.req.body ?? {}).note) })));
  app.delete(
    '/api/foreign-workers/params/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteParam(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );

  // --- Belgeler -----------------------------------------------------------------------------------------------
  app.get('/api/foreign-workers/documents', tenantRoute(app, read, async ({ tx, req }) => {
    const q = foreignDocListQuerySchema.parse(req.query);
    return listDocs(tx, q, pageOf(q));
  }));
  app.post(
    '/api/foreign-workers/documents',
    tenantRoute(app, manage, async (c) => {
      const doc = await createDoc(c.tx, fctx(c), createForeignDocSchema.parse(c.req.body));
      void c.reply.code(201);
      return { doc };
    }),
  );
  app.get('/api/foreign-workers/documents/:id', tenantRoute(app, read, async ({ tx, req }) => getDoc(tx, idParam.parse(req.params).id)));
  app.patch('/api/foreign-workers/documents/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ doc: await updateDoc(tx, idParam.parse(req.params).id, updateForeignDocSchema.parse(req.body)) })));
  app.post('/api/foreign-workers/documents/:id/renew', tenantRoute(app, manage, async (c) => ({ doc: await renewDoc(c.tx, fctx(c), idParam.parse(c.req.params).id, renewForeignDocSchema.parse(c.req.body)) })));
  app.post('/api/foreign-workers/documents/:id/revoke', tenantRoute(app, manage, async (c) => ({ doc: await revokeDoc(c.tx, fctx(c), idParam.parse(c.req.params).id, revokeForeignDocSchema.parse(c.req.body).reason) })));
  app.post('/api/foreign-workers/documents/:id/reveal', tenantRoute(app, sensitive, async (c) => revealDocNo(c.tx, fctx(c), idParam.parse(c.req.params).id, revealForeignDocNoSchema.parse(c.req.body).reason)));
  app.delete(
    '/api/foreign-workers/documents/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteDoc(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );

  // --- Teminat ----------------------------------------------------------------------------------------------
  app.get('/api/foreign-workers/guarantees', tenantRoute(app, read, async ({ tx, req }) => {
    const q = guaranteeListQuerySchema.parse(req.query);
    return listGuarantees(tx, q, pageOf(q));
  }));
  app.post(
    '/api/foreign-workers/guarantees',
    tenantRoute(app, manage, async (c) => {
      const guarantee = await createGuarantee(c.tx, fctx(c), createGuaranteeSchema.parse(c.req.body));
      void c.reply.code(201);
      return { guarantee };
    }),
  );
  app.post('/api/foreign-workers/guarantees/:id/resolve', tenantRoute(app, manage, async ({ tx, req }) => ({ guarantee: await resolveGuarantee(tx, idParam.parse(req.params).id, resolveGuaranteeSchema.parse(req.body)) })));
  app.delete(
    '/api/foreign-workers/guarantees/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteGuarantee(tx, idParam.parse(req.params).id);
      void reply.code(204);
      return undefined;
    }),
  );
  app.get('/api/foreign-workers/reports/guarantees', tenantRoute(app, read, async ({ tx, req }) => guaranteeReport(tx, guaranteeListQuerySchema.pick({ projectId: true }).parse(req.query))));
};
