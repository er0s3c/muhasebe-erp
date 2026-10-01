import type { FastifyPluginAsync } from 'fastify';
import {
  createApprovalRuleSchema,
  createConstructionParamSchema,
  decideApprovalSchema,
  idParam,
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
import { createParam, deleteParam, listParams, verifyParam } from './params';

const approvalCtx = ({ company, user, role }: TenantCtx): ApprovalCtx => ({ companyId: company.id, userId: user.id, role });

export const subcontractRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'construction.subcontracts';
  const read = { module: MODULE, permission: 'subcontracts.read' } as const;
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
};
