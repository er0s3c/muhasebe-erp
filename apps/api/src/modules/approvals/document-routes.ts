import type { FastifyPluginAsync } from 'fastify';
import { createApprovalRuleSchema, decideApprovalSchema, idParam, uuid } from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden, notFound, unprocessable } from '../../http/errors';
import { requireResourceOperation } from '../access/effective';
import { requireDocumentAccess } from './document-access';
import { GENERAL_APPROVAL_TYPES, isGeneralApprovalType } from './document-policy';
import {
  approvalContext,
  generalRequest,
  getFinancialDraft,
  listFinancialDrafts,
  registerDocumentApprovalHandlers,
  saveFinancialDraft,
  submitFinancialDraft,
  submitSourceDocument,
} from './financial-service';
import {
  cancelRequest,
  canDecideRequest,
  createRule,
  decide,
  deleteRule,
  listRules,
  pendingForMe,
  requestsForDoc,
  setRuleActive,
} from './service';

const sourceParams = z.object({ type: z.enum(['invoice', 'sales_quote']), id: uuid });
const draftSchema = z.object({
  docType: z.enum(['payment', 'expense']),
  payload: z.record(z.string(), z.unknown()),
});
function manageRules(c: TenantCtx) {
  c.require('settings.manage');
  requireResourceOperation(c.access, 'core.settings', 'update');
  if (!['owner', 'admin'].includes(c.role) || c.branch.mode !== 'all')
    throw forbidden(
      'Şirket onay kuralları tüm şubelere erişimi olan yönetici tarafından düzenlenir',
      'APPROVAL_RULE_ADMIN_REQUIRED',
    );
}
async function rulesFor(c: TenantCtx) {
  const rules = (await listRules(c.tx)).filter((r) => isGeneralApprovalType(r.docType));
  if (c.can('settings.read')) return rules;
  return rules.filter((r) => {
    try {
      requireDocumentAccess(c, r.docType as (typeof GENERAL_APPROVAL_TYPES)[number], 'read');
      return true;
    } catch {
      return false;
    }
  });
}
async function existingRule(c: TenantCtx, id: string) {
  const rule = (await listRules(c.tx)).find((r) => r.id === id && isGeneralApprovalType(r.docType));
  if (!rule) throw notFound('Mali onay kuralı');
  return rule;
}

export const documentApprovalRoutes: FastifyPluginAsync = async (app) => {
  registerDocumentApprovalHandlers();
  app.get(
    '/api/document-approvals/rules',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => ({ rules: await rulesFor(c) })),
  );
  app.post(
    '/api/document-approvals/rules',
    tenantRoute(
      app,
      { permission: 'settings.manage', module: 'core.settings', operation: 'create' },
      async (c) => {
        manageRules(c);
        const input = createApprovalRuleSchema.parse(c.req.body);
        if (!isGeneralApprovalType(input.docType))
          throw unprocessable('Bu ekranda mali belge onay türü seçin', 'APPROVAL_DOC_TYPE');
        const rule = await createRule(c.tx, c.company.id, input);
        void c.reply.code(201);
        return { rule };
      },
    ),
  );
  app.patch(
    '/api/document-approvals/rules/:id',
    tenantRoute(app, { permission: 'settings.manage', module: 'core.settings' }, async (c) => {
      manageRules(c);
      const id = idParam.parse(c.req.params).id;
      await existingRule(c, id);
      await setRuleActive(c.tx, id, z.object({ isActive: z.boolean() }).parse(c.req.body).isActive);
      return { rules: await rulesFor(c) };
    }),
  );
  app.delete(
    '/api/document-approvals/rules/:id',
    tenantRoute(app, { permission: 'settings.manage', module: 'core.settings' }, async (c) => {
      manageRules(c);
      const id = idParam.parse(c.req.params).id;
      await existingRule(c, id);
      await deleteRule(c.tx, id);
      void c.reply.code(204);
    }),
  );
  app.get(
    '/api/document-approvals/inbox',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const requests = [];
      for (const request of await pendingForMe(c.tx, approvalContext(c))) {
        if (!isGeneralApprovalType(request.docType)) continue;
        try {
          requireDocumentAccess(c, request.docType, 'read');
          requests.push(request);
        } catch {
          /* Yetkisiz türün içeriğini verme. */
        }
      }
      return { requests };
    }),
  );
  app.get(
    '/api/document-approvals/documents/:type/:id',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const { type, id } = sourceParams.parse(c.req.params);
      requireDocumentAccess(c, type, 'read');
      const requests = (await requestsForDoc(c.tx, type, id)).map((request) => ({
        ...request,
        canDecide: canDecideRequest(request, approvalContext(c)),
      }));
      return { requests };
    }),
  );
  app.post(
    '/api/document-approvals/documents/:type/:id/submit',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const { type, id } = sourceParams.parse(c.req.params);
      const request = await submitSourceDocument(c, type, id);
      void c.reply.code(201);
      return { request };
    }),
  );
  app.get(
    '/api/document-approvals/:id',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => ({
      request: await generalRequest(c, idParam.parse(c.req.params).id),
    })),
  );
  app.post(
    '/api/document-approvals/:id/decide',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const request = await generalRequest(c, idParam.parse(c.req.params).id);
      requireDocumentAccess(
        c,
        request.docType as (typeof GENERAL_APPROVAL_TYPES)[number],
        'approve',
      );
      return {
        request: await decide(
          c.tx,
          approvalContext(c),
          request.id,
          decideApprovalSchema.parse(c.req.body),
        ),
      };
    }),
  );
  app.post(
    '/api/document-approvals/:id/cancel',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const request = await generalRequest(c, idParam.parse(c.req.params).id);
      requireDocumentAccess(
        c,
        request.docType as (typeof GENERAL_APPROVAL_TYPES)[number],
        'manage',
      );
      return { request: await cancelRequest(c.tx, approvalContext(c), request.id) };
    }),
  );
  app.get(
    '/api/financial-approval-drafts',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => ({ drafts: await listFinancialDrafts(c) })),
  );
  app.post(
    '/api/financial-approval-drafts',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const input = draftSchema.parse(c.req.body);
      const draft = await saveFinancialDraft(c, input.docType, input.payload);
      void c.reply.code(201);
      return { draft };
    }),
  );
  app.get(
    '/api/financial-approval-drafts/:id',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const draft = await getFinancialDraft(c.tx, idParam.parse(c.req.params).id);
      requireDocumentAccess(c, draft.docType, 'read');
      return { draft, requests: await requestsForDoc(c.tx, draft.docType, draft.id) };
    }),
  );
  app.put(
    '/api/financial-approval-drafts/:id',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => {
      const input = draftSchema.parse(c.req.body);
      return {
        draft: await saveFinancialDraft(
          c,
          input.docType,
          input.payload,
          idParam.parse(c.req.params).id,
        ),
      };
    }),
  );
  app.post(
    '/api/financial-approval-drafts/:id/submit',
    tenantRoute(app, { permission: 'workspace.use' }, async (c) => ({
      request: await submitFinancialDraft(c, idParam.parse(c.req.params).id),
    })),
  );
};
