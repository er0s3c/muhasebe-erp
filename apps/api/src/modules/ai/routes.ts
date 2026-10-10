import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { aiChatRequestSchema, todayIso } from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { users } from '../../db/schema';
import { generateAiChatResponse } from './service';
import type { AiSessionContext } from './types';
import { aiToolAccess } from './access';

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/ai/chat',
    tenantRoute(
      app,
      {
        module: 'core.dashboard',
        permission: 'workspace.use',
        limit: { name: 'ai-chat', max: 20, windowMs: 60_000 },
      },
      async (c) => {
        const body = aiChatRequestSchema.parse(c.req.body);

        const [userRow] = await c.tx
          .select({ fullName: users.fullName })
          .from(users)
          .where(eq(users.id, c.user.id))
          .limit(1);

        const context: AiSessionContext = {
          user: {
            id: c.user.id,
            fullName: userRow?.fullName,
            role: c.role,
          },
          company: {
            id: c.company.id,
            name: c.company.name,
            sector: c.company.sector,
            baseCurrency: c.company.baseCurrency,
          },
          today: todayIso(),
          ...aiToolAccess(c),
        };

        const result = await generateAiChatResponse({
          message: body.message,
          history: body.history,
          context,
          apiKey: app.config.GEMINI_API_KEY,
          model: app.config.GEMINI_MODEL,
          tx: c.tx,
        });

        return result;
      },
    ),
  );
};
