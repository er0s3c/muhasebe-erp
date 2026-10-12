import type { FastifyPluginAsync } from 'fastify';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { savedViews, users } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { notFound, unprocessable } from '../../http/errors';

/**
 * Liste ekranlarının kayıtlı görünümleri (öneri 5). Cihazdan bağımsız, kullanıcı/şirket/şube kapsamında saklanır.
 * Ortak görünüm yalnız bir filtre düzenidir: listeyi açan herkes sonuçları kendi güncel yetkisiyle görür.
 * Görünürlük ve yalnız-sahip-değiştirir kuralı RLS'tedir; burada ek olarak kapsam, boyut ve adet sınırları denetlenir.
 */
const pageSchema = z.string().regex(/^[a-z][a-z0-9-]{1,60}$/);
const branchScopeSchema = z.string().regex(/^(all|unassigned|[0-9a-f-]{36})$/);
const filtersSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,40}$/), z.union([z.string().max(100), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 30, 'En fazla 30 filtre alanı saklanabilir');
const nameSchema = z.string().trim().min(1).max(40);
const createSchema = z.object({ page: pageSchema, branchScope: branchScopeSchema, name: nameSchema, filters: filtersSchema, shared: z.boolean().default(false) }).strict();
const updateSchema = z.object({ name: nameSchema.optional(), shared: z.boolean().optional() }).strict();
const listQuery = z.object({ page: pageSchema, branchScope: branchScopeSchema });
const idParam = z.object({ id: z.uuid() });

const MAX_PERSONAL = 20;
const MAX_SHARED = 30;

export const viewRoutes: FastifyPluginAsync = async (app) => {
  // Kişisel veridir (şirket ayarı değil): salt okunur üye de kendi görünümünü yönetir; kapı her rolde bulunan `settings.read`
  const member = { permission: 'settings.read' } as const;
  const write = { ...member, operation: 'read', limit: { name: 'saved-views', max: 60, windowMs: 60_000 } } as const;
  const shape = (row: { id: string; name: string; filters: Record<string, string | boolean>; shared: boolean; ownerUserId: string; ownerName: string | null }, userId: string) => ({
    id: row.id,
    name: row.name,
    filters: row.filters,
    shared: row.shared,
    mine: row.ownerUserId === userId,
    ownerName: row.ownerUserId === userId ? null : row.ownerName,
  });

  app.get(
    '/api/saved-views',
    tenantRoute(app, member, async ({ tx, req, user, company }) => {
      const q = listQuery.parse(req.query);
      const rows = await tx
        .select({ id: savedViews.id, name: savedViews.name, filters: savedViews.filters, shared: savedViews.shared, ownerUserId: savedViews.ownerUserId, ownerName: users.fullName })
        .from(savedViews)
        .innerJoin(users, eq(users.id, savedViews.ownerUserId))
        .where(and(eq(savedViews.companyId, company.id), eq(savedViews.page, q.page), eq(savedViews.branchScope, q.branchScope)))
        .orderBy(desc(savedViews.shared), asc(savedViews.name));
      return { views: rows.map((row) => shape(row, user.id)) };
    }),
  );

  app.post(
    '/api/saved-views',
    tenantRoute(app, write, async ({ tx, req, reply, user, company }) => {
      const input = createSchema.parse(req.body);
      const scope = and(eq(savedViews.companyId, company.id), eq(savedViews.page, input.page), eq(savedViews.branchScope, input.branchScope));
      const [mine] = await tx.select({ n: count() }).from(savedViews).where(and(scope, eq(savedViews.ownerUserId, user.id)));
      if ((mine?.n ?? 0) >= MAX_PERSONAL) throw unprocessable(`Bu ekranda en fazla ${MAX_PERSONAL} görünüm saklayabilirsiniz; eskilerden birini kaldırın`, 'SAVED_VIEW_LIMIT');
      if (input.shared) {
        const [shared] = await tx.select({ n: count() }).from(savedViews).where(and(scope, eq(savedViews.shared, true)));
        if ((shared?.n ?? 0) >= MAX_SHARED) throw unprocessable(`Bu ekranda en fazla ${MAX_SHARED} ortak görünüm olabilir`, 'SAVED_VIEW_SHARED_LIMIT');
      }
      const [row] = await tx
        .insert(savedViews)
        .values({ companyId: company.id, ownerUserId: user.id, branchScope: input.branchScope, page: input.page, name: input.name, filters: input.filters, shared: input.shared })
        .returning();
      void reply.code(201);
      return { view: shape({ ...row!, ownerName: null }, user.id) };
    }),
  );

  app.patch(
    '/api/saved-views/:id',
    tenantRoute(app, write, async ({ tx, req, user, company }) => {
      const { id } = idParam.parse(req.params);
      const input = updateSchema.parse(req.body);
      // RLS yalnız sahibinin satırını günceller; başkasının ortak görünümü bulunamadı sayılır
      const [row] = await tx
        .update(savedViews)
        .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.shared !== undefined ? { shared: input.shared } : {}) })
        .where(and(eq(savedViews.id, id), eq(savedViews.companyId, company.id), eq(savedViews.ownerUserId, user.id)))
        .returning();
      if (!row) throw notFound('Görünüm');
      return { view: shape({ ...row, ownerName: null }, user.id) };
    }),
  );

  app.delete(
    '/api/saved-views/:id',
    tenantRoute(app, write, async ({ tx, req, reply, user, company }) => {
      const { id } = idParam.parse(req.params);
      const [row] = await tx
        .delete(savedViews)
        .where(and(eq(savedViews.id, id), eq(savedViews.companyId, company.id), eq(savedViews.ownerUserId, user.id)))
        .returning({ id: savedViews.id });
      if (!row) throw notFound('Görünüm');
      void reply.code(204);
      return null;
    }),
  );
};
