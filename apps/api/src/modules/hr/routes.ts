import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  attendanceLaborQuerySchema,
  attendanceMonthQuerySchema,
  closeAttendanceMonthSchema,
  createDsrSchema,
  createEmployeeSchema,
  employeeListQuerySchema,
  exportEmployeeDataSchema,
  hasPermission,
  idParam,
  rehireEmployeeSchema,
  reopenAttendanceMonthSchema,
  resolveDsrSchema,
  revealFieldSchema,
  terminateEmployeeSchema,
  updateEmployeeSchema,
  updateInventorySchema,
  upsertAttendanceSchema,
  verifyInventorySchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import {
  createEmployee,
  exportEmployeeData,
  getEmployee,
  listEmployees,
  rehireEmployee,
  revealField,
  terminateEmployee,
  updateEmployee,
  type HrCtx,
} from './employees';
import { closeMonth, getMonthSheet, laborByProject, monthlySummary, reopenMonth, saveAttendance } from './attendance';
import { createRequest, listAccessLog, listInventory, listRequests, resolveRequest, updateInventory, verifyInventory } from './privacy';

export const hrRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.core';
  const read = { module: MODULE, permission: 'hr.read' } as const;
  const manage = { module: MODULE, permission: 'hr.manage' } as const;
  const sensitive = { module: MODULE, permission: 'hr.sensitive' } as const;
  const privacy = { module: MODULE, permission: 'privacy.manage' } as const;
  const hrCtx = ({ company, user }: TenantCtx): HrCtx => ({ companyId: company.id, userId: user.id, secret: app.config.JWT_SECRET });
  const listQuery = z.object({ status: z.enum(['open', 'completed', 'rejected']).optional() });
  const logQuery = z.object({ employeeId: z.string().uuid().optional() });

  // --- Personel -------------------------------------------------------------------------------------
  app.get('/api/employees', tenantRoute(app, read, async ({ tx, req }) => listEmployees(tx, employeeListQuerySchema.parse(req.query))));
  app.get('/api/employees/:id', tenantRoute(app, read, async ({ tx, req }) => getEmployee(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/employees',
    tenantRoute(app, manage, async (c) => {
      const out = await createEmployee(c.tx, hrCtx(c), createEmployeeSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.patch('/api/employees/:id', tenantRoute(app, manage, async (c) => updateEmployee(c.tx, hrCtx(c), idParam.parse(c.req.params).id, updateEmployeeSchema.parse(c.req.body))));
  app.post('/api/employees/:id/terminate', tenantRoute(app, manage, async ({ tx, req }) => terminateEmployee(tx, idParam.parse(req.params).id, terminateEmployeeSchema.parse(req.body).leaveDate)));
  app.post('/api/employees/:id/rehire', tenantRoute(app, manage, async ({ tx, req }) => rehireEmployee(tx, idParam.parse(req.params).id, rehireEmployeeSchema.parse(req.body ?? {}).hireDate)));

  // Hassas alanın açık okunması: gerekçe + erişim günlüğü (aynı işlemde)
  app.post(
    '/api/employees/:id/reveal',
    tenantRoute(app, sensitive, async (c) => {
      const body = revealFieldSchema.parse(c.req.body);
      return revealField(c.tx, hrCtx(c), idParam.parse(c.req.params).id, body.field, body.reason);
    }),
  );

  // --- Puantaj (Faz D2) -----------------------------------------------------------------------------
  app.get('/api/attendance/month', tenantRoute(app, read, async ({ tx, req }) => getMonthSheet(tx, attendanceMonthQuerySchema.parse(req.query).month)));
  // Toplu kayıt: grid ve günlük giriş aynı ucu kullanır (eklenir/güncellenir + silinir; tek işlem)
  app.put('/api/attendance/entries', tenantRoute(app, manage, async (c) => saveAttendance(c.tx, { companyId: c.company.id, userId: c.user.id }, upsertAttendanceSchema.parse(c.req.body))));
  app.post(
    '/api/attendance/months/close',
    tenantRoute(app, manage, async (c) => {
      const body = closeAttendanceMonthSchema.parse(c.req.body);
      return { lock: await closeMonth(c.tx, { companyId: c.company.id, userId: c.user.id }, body.month, body.note) };
    }),
  );
  app.post(
    '/api/attendance/months/reopen',
    tenantRoute(app, manage, async (c) => {
      const body = reopenAttendanceMonthSchema.parse(c.req.body);
      return { lock: await reopenMonth(c.tx, { companyId: c.company.id, userId: c.user.id }, body.month, body.reason) };
    }),
  );
  app.get('/api/attendance/reports/summary', tenantRoute(app, read, async ({ tx, req }) => monthlySummary(tx, attendanceMonthQuerySchema.parse(req.query).month)));
  app.get('/api/attendance/reports/labor', tenantRoute(app, read, async ({ tx, req }) => laborByProject(tx, attendanceLaborQuerySchema.parse(req.query))));

  // --- Veri koruma ----------------------------------------------------------------------------------
  app.get('/api/privacy/inventory', tenantRoute(app, privacy, async (c) => listInventory(c.tx, c.company.id)));
  app.patch('/api/privacy/inventory/:id', tenantRoute(app, privacy, async ({ tx, req }) => ({ item: await updateInventory(tx, idParam.parse(req.params).id, updateInventorySchema.parse(req.body)) })));
  app.post(
    '/api/privacy/inventory/:id/verify',
    tenantRoute(app, privacy, async (c) => ({ item: await verifyInventory(c.tx, idParam.parse(c.req.params).id, c.user.id, verifyInventorySchema.parse(c.req.body ?? {}).note) })),
  );
  app.get('/api/privacy/requests', tenantRoute(app, privacy, async ({ tx, req }) => listRequests(tx, listQuery.parse(req.query))));
  app.post(
    '/api/privacy/requests',
    tenantRoute(app, privacy, async (c) => {
      const row = await createRequest(c.tx, { companyId: c.company.id, userId: c.user.id }, createDsrSchema.parse(c.req.body));
      void c.reply.code(201);
      return { request: row };
    }),
  );
  app.post(
    '/api/privacy/requests/:id/resolve',
    tenantRoute(app, privacy, async (c) => ({ request: await resolveRequest(c.tx, { userId: c.user.id }, idParam.parse(c.req.params).id, resolveDsrSchema.parse(c.req.body)) })),
  );
  app.get('/api/privacy/access-log', tenantRoute(app, privacy, async ({ tx, req }) => listAccessLog(tx, logQuery.parse(req.query))));
  // Bir personelin tüm verisi (ilgili kişi erişim/dışa aktarma talebi): açık metin içerir → hem gizlilik hem hassas veri izni
  app.post(
    '/api/privacy/employees/:id/export',
    tenantRoute(app, privacy, async (c) => {
      if (!hasPermission(c.role, 'hr.sensitive')) throw forbidden();
      return exportEmployeeData(c.tx, hrCtx(c), idParam.parse(c.req.params).id, exportEmployeeDataSchema.parse(c.req.body).reason);
    }),
  );
};
