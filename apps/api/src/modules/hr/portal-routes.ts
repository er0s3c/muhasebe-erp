import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  EMPLOYEE_CHECKLIST_KINDS,
  attendanceCorrectionDecisionSchema,
  attendanceCorrectionSchema,
  checklistItemSchema,
  checklistTemplateSchema,
  employeeUserLinkSchema,
  idParam,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden, unprocessable } from '../../http/errors';
import {
  checklistTemplate,
  createCorrection,
  createOwnCorrection,
  decideCorrection,
  employeeChecklistsFor,
  linkEmployeeUser,
  listCorrections,
  portalSlip,
  portalSummary,
  saveChecklistTemplate,
  startChecklist,
  updateChecklistItem,
} from './portal';

/**
 * F10 personel uçları. Portal uçları (`/api/me/...`) her üyeye açıktır ama yalnız oturumdaki kullanıcıya bağlı personel
 * kaydını döndürür; şirkette İK modülü kapalıysa kapalıdır.
 */
export const hrPortalRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.core';
  const read = { module: MODULE, permission: 'hr.read' } as const;
  const manage = { module: MODULE, permission: 'hr.manage' } as const;
  const member = { permission: 'workspace.use' } as const;
  const ctx = (c: TenantCtx) => ({ companyId: c.company.id, userId: c.user.id });
  const hrOn = (c: TenantCtx) => {
    if (!c.enabledModules.has(MODULE)) throw forbidden('İnsan kaynakları modülü kapalı');
  };
  const kindParam = z.object({ kind: z.enum(EMPLOYEE_CHECKLIST_KINDS) });

  // Portal bağlantısı için şirket üyeleri (yalnız ad/e-posta)
  app.get('/api/hr/portal-users', tenantRoute(app, manage, async (c) => ({
    users: (await c.tx.execute<{ id: string; name: string; email: string }>(sql`select u.id, u.full_name as name, u.email from memberships m join users u on u.id = m.user_id and u.is_active where m.company_id = ${c.company.id} order by u.full_name`)).rows,
  })));
  app.put(
    '/api/employees/:id/user',
    tenantRoute(app, manage, async (c) => linkEmployeeUser(c.tx, ctx(c), idParam.parse(c.req.params).id, employeeUserLinkSchema.parse(c.req.body).userId)),
  );

  app.get('/api/me/employee', tenantRoute(app, member, async (c) => {
    hrOn(c);
    return portalSummary(c.tx, c.user.id);
  }));
  app.get('/api/me/employee/payslips/:id', tenantRoute(app, member, async (c) => {
    hrOn(c);
    return portalSlip(c.tx, c.user.id, idParam.parse(c.req.params).id);
  }));
  app.post('/api/me/attendance-corrections', tenantRoute(app, member, async (c) => {
    hrOn(c);
    const input = attendanceCorrectionSchema.parse(c.req.body);
    if (input.employeeId) throw unprocessable('Portaldan yalnız kendi kaydınız için talep açılır', 'CORRECTION_OWN_ONLY');
    void c.reply.code(201);
    return { correction: await createOwnCorrection(c.tx, ctx(c), input) };
  }));

  app.get(
    '/api/attendance-corrections',
    tenantRoute(app, read, async (c) => ({ corrections: await listCorrections(c.tx, z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional(), employeeId: z.uuid().optional() }).parse(c.req.query)) })),
  );
  app.post('/api/attendance-corrections', tenantRoute(app, manage, async (c) => {
    const input = attendanceCorrectionSchema.parse(c.req.body);
    if (!input.employeeId) throw unprocessable('Personel seçin', 'EMPLOYEE_REQUIRED');
    void c.reply.code(201);
    return { correction: await createCorrection(c.tx, ctx(c), { ...input, employeeId: input.employeeId }) };
  }));
  app.post(
    '/api/attendance-corrections/:id/decision',
    tenantRoute(app, manage, async (c) => ({ correction: await decideCorrection(c.tx, ctx(c), idParam.parse(c.req.params).id, attendanceCorrectionDecisionSchema.parse(c.req.body)) })),
  );

  app.get('/api/employee-checklist-templates/:kind', tenantRoute(app, read, async (c) => checklistTemplate(c.tx, kindParam.parse(c.req.params).kind)));
  app.put(
    '/api/employee-checklist-templates/:kind',
    tenantRoute(app, manage, async (c) => saveChecklistTemplate(c.tx, ctx(c), kindParam.parse(c.req.params).kind, checklistTemplateSchema.parse(c.req.body).items.map((i) => i.label))),
  );
  app.get('/api/employees/:id/checklists', tenantRoute(app, read, async (c) => ({ checklists: await employeeChecklistsFor(c.tx, idParam.parse(c.req.params).id) })));
  app.post('/api/employees/:id/checklists', tenantRoute(app, manage, async (c) => {
    const { kind } = z.object({ kind: z.enum(EMPLOYEE_CHECKLIST_KINDS) }).parse(c.req.body);
    void c.reply.code(201);
    return { checklist: await startChecklist(c.tx, ctx(c), idParam.parse(c.req.params).id, kind) };
  }));
  app.post(
    '/api/employee-checklists/:id/items',
    tenantRoute(app, manage, async (c) => ({ checklist: await updateChecklistItem(c.tx, ctx(c), idParam.parse(c.req.params).id, checklistItemSchema.parse(c.req.body)) })),
  );
};
