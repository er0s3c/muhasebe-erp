import type { FastifyPluginAsync } from 'fastify';
import {
  createBudgetSchema,
  createProgressSchema,
  createProjectSchema,
  createWbsSchema,
  idParam,
  projectListQuerySchema,
  projectStatusSchema,
  putBudgetLinesSchema,
  todayIso,
  updateProjectSchema,
  updateWbsSchema,
} from '@erp/shared';
import { z } from 'zod';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { approveBudget, createBudget, deleteBudget, getBudget, listBudgets, putBudgetLines } from './budgets';
import { progressOverview, recordProgress } from './progress';
import { createProject, deleteProject, getProject, listProjects, setProjectStatus, updateProject, type ProjectCtx } from './service';
import { createWbs, deleteWbs, listWbs, updateWbs } from './wbs';

const projectCtx = ({ company, user }: TenantCtx): ProjectCtx => ({ companyId: company.id, userId: user.id });

const progressQuery = z.object({ asOf: z.iso.date().optional() });

export const projectRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'construction.projects', permission: 'projects.read' } as const;
  const manage = { module: 'construction.projects', permission: 'projects.manage' } as const;
  const budget = { module: 'construction.projects', permission: 'projects.budget' } as const;

  // --- Proje ---------------------------------------------------------------

  app.get('/api/projects', tenantRoute(app, read, async ({ tx, req }) => listProjects(tx, projectListQuerySchema.parse(req.query))));

  app.post(
    '/api/projects',
    tenantRoute(app, manage, async (c) => {
      const row = await createProject(c.tx, projectCtx(c), createProjectSchema.parse(c.req.body));
      void c.reply.code(201);
      return { project: await getProject(c.tx, row.id) };
    }),
  );

  app.get(
    '/api/projects/:id',
    tenantRoute(app, read, async ({ tx, req }) => ({ project: await getProject(tx, idParam.parse(req.params).id) })),
  );

  app.patch(
    '/api/projects/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      await updateProject(tx, id, updateProjectSchema.parse(req.body));
      return { project: await getProject(tx, id) };
    }),
  );

  app.post(
    '/api/projects/:id/status',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      await setProjectStatus(tx, id, projectStatusSchema.parse(req.body).status);
      return { project: await getProject(tx, id) };
    }),
  );

  app.delete(
    '/api/projects/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteProject(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- İş kırılımı (WBS) ---------------------------------------------------

  app.get('/api/projects/:id/wbs', tenantRoute(app, read, async ({ tx, req }) => listWbs(tx, idParam.parse(req.params).id)));

  app.post(
    '/api/projects/:id/wbs',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      await createWbs(c.tx, c.company.id, id, createWbsSchema.parse(c.req.body));
      void c.reply.code(201);
      return listWbs(c.tx, id);
    }),
  );

  app.patch(
    '/api/project-wbs/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const row = await updateWbs(tx, idParam.parse(req.params).id, updateWbsSchema.parse(req.body));
      return listWbs(tx, row.projectId);
    }),
  );

  app.delete(
    '/api/project-wbs/:id',
    tenantRoute(app, manage, async ({ tx, req, reply }) => {
      await deleteWbs(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- Bütçe revizyonları --------------------------------------------------

  app.get('/api/projects/:id/budgets', tenantRoute(app, read, async ({ tx, req }) => listBudgets(tx, idParam.parse(req.params).id)));

  app.post(
    '/api/projects/:id/budgets',
    tenantRoute(app, budget, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const row = await createBudget(c.tx, projectCtx(c), id, createBudgetSchema.parse(c.req.body ?? {}));
      void c.reply.code(201);
      return getBudget(c.tx, row.id);
    }),
  );

  app.get('/api/project-budgets/:id', tenantRoute(app, read, async ({ tx, req }) => getBudget(tx, idParam.parse(req.params).id)));

  app.put(
    '/api/project-budgets/:id/lines',
    tenantRoute(app, budget, async (c) =>
      putBudgetLines(c.tx, c.company.id, idParam.parse(c.req.params).id, putBudgetLinesSchema.parse(c.req.body)),
    ),
  );

  app.post(
    '/api/project-budgets/:id/approve',
    tenantRoute(app, budget, async (c) => approveBudget(c.tx, projectCtx(c), idParam.parse(c.req.params).id)),
  );

  app.delete(
    '/api/project-budgets/:id',
    tenantRoute(app, budget, async ({ tx, req, reply }) => {
      await deleteBudget(tx, idParam.parse(req.params).id);
      void reply.code(204);
    }),
  );

  // --- İlerleme ------------------------------------------------------------

  app.get(
    '/api/projects/:id/progress',
    tenantRoute(app, read, async ({ tx, req }) =>
      progressOverview(tx, idParam.parse(req.params).id, progressQuery.parse(req.query).asOf ?? todayIso()),
    ),
  );

  app.post(
    '/api/projects/:id/progress',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const out = await recordProgress(c.tx, projectCtx(c), id, createProgressSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
};
