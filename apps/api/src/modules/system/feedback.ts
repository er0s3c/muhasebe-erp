import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { decodeFeedbackImage, feedbackInputSchema, FEEDBACK_INPUT_BODY_LIMIT } from '@erp/license-core';
import { users } from '../../db/schema';
import { authedRoute, tenantRoute } from '../../http/context';
import { badRequest, forbidden, unauthorized } from '../../http/errors';

export const feedbackRoutes: FastifyPluginAsync = async app => {
  app.get('/api/feedback/availability', authedRoute(app, () => app.license.feedbackAvailability()));
  app.post('/api/companies/:companyId/feedback', { bodyLimit: FEEDBACK_INPUT_BODY_LIMIT }, tenantRoute(app, {
    limit: { name: 'feedback', max: 10, windowMs: 60 * 60_000 },
  }, async ({ tx, req, reply, company, user }) => {
    const { companyId } = z.object({ companyId: z.uuid() }).parse(req.params);
    if (companyId !== company.id) throw forbidden('Bu şirkete erişiminiz yok', 'NOT_A_MEMBER');
    const input = feedbackInputSchema.parse(req.body);
    if (input.screenshot) {
      try { decodeFeedbackImage(input.screenshot); }
      catch (err) { throw badRequest(err instanceof Error ? err.message : 'Ekran görüntüsü geçersiz', 'INVALID_SCREENSHOT'); }
    }
    const [reporter] = await tx.select({ id: users.id, name: users.fullName, email: users.email }).from(users).where(eq(users.id, user.id));
    if (!reporter) throw unauthorized();
    const response = await app.license.submitFeedback({
      feedback: input, reporter,
      company: { id: company.id, name: company.name, sector: company.sector },
    });
    void reply.code(201);
    return response;
  }));
};
