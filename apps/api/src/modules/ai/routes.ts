import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { aiChatRequestSchema, todayIso } from '@erp/shared';
import { tenantReadSessionRoute } from '../../http/context';
import { users } from '../../db/schema';
import { generateAiChatResponse } from './service';
import type { AiSessionContext } from './types';
import { aiToolAccess } from './access';
import { toolRegistry } from './tools';

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/ai/chat',
    // Sağlayıcı cevabı beklenirken veritabanı işlemi ve bağlantısı tutulmaz; bağlam ve her araç okuması ayrı kısa işlemdir
    tenantReadSessionRoute(
      app,
      {
        module: 'core.dashboard',
        permission: 'workspace.use',
        limit: { name: 'ai-chat', max: 20, windowMs: 60_000 },
      },
      async (session) => {
        const body = aiChatRequestSchema.parse(session.req.body);

        const context = await session.read(async (c): Promise<AiSessionContext> => {
          const [userRow] = await c.tx
            .select({ fullName: users.fullName })
            .from(users)
            .where(eq(users.id, c.user.id))
            .limit(1);
          return {
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
        });

        return generateAiChatResponse({
          message: body.message,
          history: body.history,
          context,
          apiKey: app.config.GEMINI_API_KEY,
          model: app.config.GEMINI_MODEL,
          // Yetki sohbet sırasında değişmiş olabilir: araç erişimi her okumada güncel üyelik ve izinlerden yeniden hesaplanır
          runTool: (name, args) =>
            session.read((c) => toolRegistry.execute(name, args, { ...context, ...aiToolAccess(c) }, c.tx)),
        });
      },
    ),
  );
};
