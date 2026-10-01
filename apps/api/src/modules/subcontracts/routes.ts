import type { FastifyPluginAsync } from 'fastify';
import {
  createApprovalRuleSchema,
  cancelProgressPaymentSchema,
  clientAcceptVariationSchema,
  clientRejectVariationSchema,
  createConstructionParamSchema,
  createProgressPaymentSchema,
  createRevisionSchema,
  createSubcontractSchema,
  createVariationSchema,
  decideApprovalSchema,
  giveAdvanceSchema,
  idParam,
  progressPaymentListQuerySchema,
  putBoqLinesSchema,
  releaseRetentionSchema,
  subcontractListQuerySchema,
  subcontractStatusSchema,
  updateProgressPaymentSchema,
  updateSubcontractSchema,
  updateVariationSchema,
  variationListQuerySchema,
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
import {
  cancelProgress,
  createProgress,
  deleteProgress,
  employerSummary,
  getBalances,
  getProgressBasis,
  getProgress,
  giveAdvance,
  listProgress,
  releaseRetention,
  submitProgress,
  updateProgress,
  withdrawProgress,
  type ProgressCtx,
} from './progress';
import { createParam, deleteParam, listParams, verifyParam } from './params';
import {
  acceptByClient,
  cancelVariation,
  createVariation,
  getVariation,
  listVariations,
  rejectByClient,
  submitVariation,
  updateVariation,
} from './variations';

const subCtx = ({ company, user }: TenantCtx): SubcontractCtx => ({ companyId: company.id, userId: user.id });
const progressCtx = ({ company, user }: TenantCtx): ProgressCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});
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

  // Onay uçları belge türünden bağımsızdır (taşeron hakedişi, işveren hakedişi, satın alma talebi): modül kapısı yok,
  // yetki izin ve adımın rolü/kullanıcısıyla denetlenir.
  const readAny = { permission: 'subcontracts.read' } as const;
  const approveAny = { permission: 'subcontracts.approve' } as const;

  // --- Onay kuralları ------------------------------------------------------------------
  app.get('/api/approval-rules', tenantRoute(app, readAny, async ({ tx }) => ({ rules: await listRules(tx) })));

  app.post(
    '/api/approval-rules',
    tenantRoute(app, approveAny, async (c) => {
      const rule = await createRule(c.tx, c.company.id, createApprovalRuleSchema.parse(c.req.body));
      void c.reply.code(201);
      return { rule };
    }),
  );

  app.patch(
    '/api/approval-rules/:id',
    tenantRoute(app, approveAny, async ({ tx, req }) => {
      const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
      await setRuleActive(tx, idParam.parse(req.params).id, isActive);
      return { rules: await listRules(tx) };
    }),
  );

  app.delete(
    '/api/approval-rules/:id',
    tenantRoute(app, approveAny, async ({ tx, req, reply }) => {
      await deleteRule(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- Onay kutusu ve karar --------------------------------------------------------------
  app.get('/api/approvals/inbox', tenantRoute(app, readAny, async (c) => ({ requests: await pendingForMe(c.tx, approvalCtx(c)) })));

  app.get('/api/approvals/:id', tenantRoute(app, readAny, async ({ tx, req }) => ({ request: await getRequest(tx, idParam.parse(req.params).id) })));

  // Karar yetkisi adımdan gelir (rol/kullanıcı); uç yalnızca modülü ve okuma iznini ister
  app.post(
    '/api/approvals/:id/decide',
    tenantRoute(app, readAny, async (c) => ({
      request: await decide(c.tx, approvalCtx(c), idParam.parse(c.req.params).id, decideApprovalSchema.parse(c.req.body)),
    })),
  );

  app.post(
    '/api/approvals/:id/cancel',
    tenantRoute(app, readAny, async (c) => ({ request: await cancelRequest(c.tx, approvalCtx(c), idParam.parse(c.req.params).id) })),
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

  // --- Değişiklik emri ------------------------------------------------------------------------------
  app.post(
    '/api/subcontracts/:id/variations',
    tenantRoute(app, manage, async (c) => {
      const out = await createVariation(c.tx, subCtx(c), idParam.parse(c.req.params).id, createVariationSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get(
    '/api/subcontracts/:id/variations',
    tenantRoute(app, read, async ({ tx, req }) => listVariations(tx, { subcontractId: idParam.parse(req.params).id })),
  );
  app.get('/api/variation-orders', tenantRoute(app, read, async ({ tx, req }) => listVariations(tx, variationListQuerySchema.parse(req.query))));
  app.get('/api/variation-orders/:id', tenantRoute(app, read, async ({ tx, req }) => getVariation(tx, idParam.parse(req.params).id)));
  app.put(
    '/api/variation-orders/:id',
    tenantRoute(app, manage, async ({ tx, req }) => updateVariation(tx, idParam.parse(req.params).id, updateVariationSchema.parse(req.body))),
  );
  // Silme yok: iptal edilir (taslak revizyon silinir, kayıt kalır)
  app.delete(
    '/api/variation-orders/:id',
    tenantRoute(app, manage, async (c) => cancelVariation(c.tx, approvalCtx(c), idParam.parse(c.req.params).id)),
  );
  app.post(
    '/api/variation-orders/:id/submit',
    tenantRoute(app, manage, async (c) => submitVariation(c.tx, approvalCtx(c), idParam.parse(c.req.params).id)),
  );
  app.post(
    '/api/variation-orders/:id/client-accept',
    tenantRoute(app, manage, async (c) => acceptByClient(c.tx, subCtx(c), idParam.parse(c.req.params).id, clientAcceptVariationSchema.parse(c.req.body))),
  );
  app.post(
    '/api/variation-orders/:id/client-reject',
    tenantRoute(app, manage, async (c) => rejectByClient(c.tx, idParam.parse(c.req.params).id, clientRejectVariationSchema.parse(c.req.body).note)),
  );

  // --- Hakediş (verilen) -----------------------------------------------------------------------------
  app.get('/api/progress-payments', tenantRoute(app, read, async ({ tx, req }) => listProgress(tx, progressPaymentListQuerySchema.parse(req.query))));

  app.post(
    '/api/progress-payments',
    tenantRoute(app, manage, async (c) => {
      const out = await createProgress(c.tx, progressCtx(c), createProgressPaymentSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );

  app.get('/api/progress-payments/:id', tenantRoute(app, read, async ({ tx, req }) => getProgress(tx, idParam.parse(req.params).id)));

  app.put(
    '/api/progress-payments/:id',
    tenantRoute(app, manage, async (c) => updateProgress(c.tx, progressCtx(c), idParam.parse(c.req.params).id, updateProgressPaymentSchema.parse(c.req.body))),
  );

  app.delete(
    '/api/progress-payments/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteProgress(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  app.post(
    '/api/progress-payments/:id/submit',
    tenantRoute(app, manage, async (c) => submitProgress(c.tx, progressCtx(c), approvalCtx(c), idParam.parse(c.req.params).id)),
  );

  app.post(
    '/api/progress-payments/:id/withdraw',
    tenantRoute(app, manage, async (c) => withdrawProgress(c.tx, approvalCtx(c), idParam.parse(c.req.params).id)),
  );

  // Kaydedilmiş hakedişin iptali yevmiyeyi ters çevirir: onaylayıcı izni ister
  app.post(
    '/api/progress-payments/:id/cancel',
    tenantRoute(app, approve, async (c) => cancelProgress(c.tx, progressCtx(c), idParam.parse(c.req.params).id, cancelProgressPaymentSchema.parse(c.req.body))),
  );

  app.get('/api/subcontracts/:id/progress-basis', tenantRoute(app, read, async ({ tx, req }) => getProgressBasis(tx, idParam.parse(req.params).id)));

  app.get('/api/projects/:id/employer-contract', tenantRoute(app, read, async ({ tx, req }) => ({ summary: await employerSummary(tx, idParam.parse(req.params).id) })));

  // --- Avans ve teminat ----------------------------------------------------------------------------------
  app.get('/api/subcontracts/:id/balances', tenantRoute(app, read, async ({ tx, req }) => ({ balances: await getBalances(tx, idParam.parse(req.params).id) })));

  app.post(
    '/api/subcontracts/:id/advances',
    tenantRoute(app, approve, async (c) => {
      const balances = await giveAdvance(c.tx, progressCtx(c), idParam.parse(c.req.params).id, giveAdvanceSchema.parse(c.req.body));
      void c.reply.code(201);
      return { balances };
    }),
  );

  app.post(
    '/api/subcontracts/:id/retention-releases',
    tenantRoute(app, approve, async (c) => {
      const balances = await releaseRetention(c.tx, progressCtx(c), idParam.parse(c.req.params).id, releaseRetentionSchema.parse(c.req.body));
      void c.reply.code(201);
      return { balances };
    }),
  );
};
