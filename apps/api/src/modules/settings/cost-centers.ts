import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { costCenters } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { notFound } from '../../http/errors';

const createSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/, 'Kod yalnız harf, rakam ve . _ - içerebilir (en çok 20)'),
  name: z.string().trim().min(2).max(80),
});
const updateSchema = z.object({ name: z.string().trim().min(2).max(80).optional(), isActive: z.boolean().optional() });

/**
 * Departman / maliyet merkezi tanımları (öneri 11). Merkezler silinmez, pasifleştirilir; pasif merkeze yeni kayıt yazılmaz,
 * geçmiş kayıtlar değişmez. Merkez seçimi isteğe bağlıdır; boş satır "bilinmiyor" sayılır ve tahmin edilmez.
 */
export const costCenterRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/cost-centers', tenantRoute(app, { module: 'core.settings', permission: 'settings.read' }, async ({ tx }) => ({
    costCenters: await tx.select().from(costCenters).orderBy(asc(costCenters.code)),
  })));
  app.post('/api/cost-centers', tenantRoute(app, { module: 'core.settings', permission: 'settings.manage', operation: 'create' }, async (c) => {
    const input = createSchema.parse(c.req.body);
    const [row] = await c.tx.insert(costCenters).values({ id: randomUUID(), companyId: c.company.id, code: input.code.toUpperCase(), name: input.name }).returning();
    void c.reply.code(201);
    return { costCenter: row };
  }));
  app.patch('/api/cost-centers/:id', tenantRoute(app, { module: 'core.settings', permission: 'settings.manage', operation: 'update' }, async (c) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(c.req.params);
    const input = updateSchema.parse(c.req.body);
    const [row] = await c.tx.update(costCenters).set(input).where(eq(costCenters.id, id)).returning();
    if (!row) throw notFound('Maliyet merkezi');
    return { costCenter: row };
  }));
};
