import type { FastifyPluginAsync } from 'fastify';
import {
  createApprovalRuleSchema,
  createConstructionParamSchema,
  createRevisionSchema,
  createSubcontractSchema,
  decideApprovalSchema,
  idParam,
  putBoqLinesSchema,
  subcontractListQuerySchema,
  subcontractStatusSchema,
  updateSubcontractSchema,
  verifyConstructionParamSchema,
} from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import {
  cancelRequest,
  createRule,
  decide,
  deleteRule,
  getRequest,
  listRules,
  pendingForMe,
  setRuleActive,
  type ApprovalCtx,
} from '../approvals/service';
import {
  approveRevision,
  createRevision,
  createSubcontract,
  deleteRevision,
  deleteSubcontract,
  getRevision,
  getSubcontract,
  listSubcontracts,
  putBoqLines,
  setSubcontractStatus,
  updateSubcontract,
  type SubcontractCtx,
} from './service';
import { createParam, deleteParam, listParams, verifyParam } from './params';

const subCtx = ({ company, user }: TenantCtx): SubcontractCtx => ({ companyId: company.id, userId: user.id });
const approvalCtx = ({ company, user, role }: TenantCtx): ApprovalCtx => ({ companyId: company.id, userId: user.id, role });

export const subcontractRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'construction.subcontracts';
  const read = { module: MODULE, permission: 'subcontracts.read' } as const;
  const manage = { module: MODULE, permission: 'subcontracts.manage' } as const;
  const approve = { module: MODULE, permission: 'subcontracts.approve' } as const;

  // --- İnşaat parametreleri (teminat, stopaj, avans mahsubu) -----------------------
  app.get('/api/construction-params', tenantRoute(app, read, async ({ tx }) => ({ params: await listParams(tx) })));

  app.post(
    '/api/construction-params',
    tenantRoute(app, approve, async (c) => {
      const row = await createParam(c.tx, c.company.id, createConstructionParamSchema.parse(c.req.body));
      void c.reply.code(201);
      return { param: row };
    }),
  );

  app.post(
    '/api/construction-params/:id/verify',
    tenantRoute(app, approve, async ({ tx, req }) => {
      const input = verifyConstructionParamSchema.parse(req.body);
      return { param: await verifyParam(tx, idParam.parse(req.params).id, input.verifiedBy, input.sourceNote) };
    }),
  );

  app.delete(
    '/api/construction-params/:id',
    tenantRoute(app, approve, async ({ tx, req, reply }) => {
      await deleteParam(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- Onay kuralları ------------------------------------------------------------------
  app.get('/api/approval-rules', tenantRoute(app, read, async ({ tx }) => ({ rules: await listRules(tx) })));

  app.post(
    '/api/approval-rules',
    tenantRoute(app, approve, async (c) => {
      const rule = await createRule(c.tx, c.company.id, createApprovalRuleSchema.parse(c.req.body));
      void c.reply.code(201);
      return { rule };
    }),
  );

  app.patch(
    '/api/approval-rules/:id',
    tenantRoute(app, approve, async ({ tx, req }) => {
      const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
      await setRuleActive(tx, idParam.parse(req.params).id, isActive);
      return { rules: await listRules(tx) };
    }),
  );

  app.delete(
    '/api/approval-rules/:id',
    tenantRoute(app, approve, async ({ tx, req, reply }) => {
      await deleteRule(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- Onay kutusu ve karar --------------------------------------------------------------
  app.get('/api/approvals/inbox', tenantRoute(app, read, async (c) => ({ requests: await pendingForMe(c.tx, approvalCtx(c)) })));

  app.get('/api/approvals/:id', tenantRoute(app, read, async ({ tx, req }) => ({ request: await getRequest(tx, idParam.parse(req.params).id) })));

  // Karar yetkisi adımdan gelir (rol/kullanıcı); uç yalnızca modülü ve okuma iznini ister
  app.post(
    '/api/approvals/:id/decide',
    tenantRoute(app, read, async (c) => ({
      request: await decide(c.tx, approvalCtx(c), idParam.parse(c.req.params).id, decideApprovalSchema.parse(c.req.body)),
    })),
  );

  app.post(
    '/api/approvals/:id/cancel',
    tenantRoute(app, read, async (c) => ({ request: await cancelRequest(c.tx, approvalCtx(c), idParam.parse(c.req.params).id) })),
  );

  // --- Taşeron sözleşmeleri ---------------------------------------------------------------
  app.get('/api/subcontracts', tenantRoute(app, read, async ({ tx, req }) => listSubcontracts(tx, subcontractListQuerySchema.parse(req.query))));

  app.post(
    '/api/subcontracts',
    tenantRoute(app, manage, async (c) => {
      const row = await createSubcontract(c.tx, subCtx(c), createSubcontractSchema.parse(c.req.body));
      void c.reply.code(201);
      return getSubcontract(c.tx, row.id);
    }),
  );

  app.get('/api/subcontracts/:id', tenantRoute(app, read, async ({ tx, req }) => getSubcontract(tx, idParam.parse(req.params).id)));

  app.patch(
    '/api/subcontracts/:id',
    tenantRoute(app, manage, async ({ tx, req }) => updateSubcontract(tx, idParam.parse(req.params).id, updateSubcontractSchema.parse(req.body))),
  );

  app.post(
    '/api/subcontracts/:id/status',
    tenantRoute(app, approve, async ({ tx, req }) => setSubcontractStatus(tx, idParam.parse(req.params).id, subcontractStatusSchema.parse(req.body).status)),
  );

  app.delete(
    '/api/subcontracts/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteSubcontract(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- Revizyon ve BOQ ---------------------------------------------------------------------------
  app.post(
    '/api/subcontracts/:id/revisions',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const row = await createRevision(c.tx, subCtx(c), id, createRevisionSchema.parse(c.req.body ?? {}));
      void c.reply.code(201);
      return getRevision(c.tx, row.id);
    }),
  );

  app.get('/api/subcontract-revisions/:id', tenantRoute(app, read, async ({ tx, req }) => getRevision(tx, idParam.parse(req.params).id)));

  app.put(
    '/api/subcontract-revisions/:id/lines',
    tenantRoute(app, manage, async (c) => putBoqLines(c.tx, subCtx(c), idParam.parse(c.req.params).id, putBoqLinesSchema.parse(c.req.body))),
  );

  // Revizyon onayı sözleşmenin yürürlüğünü ve tutarını değiştirir: onaylayıcı izni ister
  app.post(
    '/api/subcontract-revisions/:id/approve',
    tenantRoute(app, approve, async (c) => approveRevision(c.tx, subCtx(c), idParam.parse(c.req.params).id)),
  );

  app.delete(
    '/api/subcontract-revisions/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteRevision(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );
};
