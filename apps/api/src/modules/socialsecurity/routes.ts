import type { FastifyPluginAsync } from 'fastify';
import {
  buildDeclarationSchema,
  createEligibilitySchema,
  createSocialProfileSchema,
  createSupportRuleSchema,
  declarationListQuerySchema,
  finalizeDeclarationSchema,
  idParam,
  premiumSummaryQuerySchema,
  reopenDeclarationSchema,
  revealSocialNoSchema,
  socialProfileListQuerySchema,
  updateSupportRuleSchema,
  verifySupportRuleSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { createEligibility, createProfile, createRule, deleteEligibility, deleteProfile, deleteRule, listEligibility, listProfiles, listRules, revealSocialNo, updateRule, verifyRule, type SocialCtx } from './config';
import { buildDeclaration, deleteDeclaration, finalizeDeclaration, getDeclaration, listDeclarations, reopenDeclaration } from './declarations';
import { premiumSummary } from './reports';

export const socialSecurityRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'hr.socialsecurity';
  const read = { module: MODULE, permission: 'hr.payroll' } as const;
  const manage = { module: MODULE, permission: 'hr.payroll_manage' } as const;
  const sensitive = { module: MODULE, permission: 'hr.sensitive' } as const;
  const sctx = ({ company, user }: TenantCtx): SocialCtx => ({ companyId: company.id, userId: user.id, secret: app.config.JWT_SECRET });
  const noContent = async ({ tx, req, reply }: { tx: Parameters<typeof deleteProfile>[0]; req: { params: unknown }; reply: { code: (n: number) => unknown } }, fn: (tx: Parameters<typeof deleteProfile>[0], id: string) => Promise<void>) => {
    await fn(tx, idParam.parse(req.params).id);
    void reply.code(204);
    return undefined;
  };

  // --- Profiller (numara maskeli; açık okuma gerekçe + günlük) -------------------------------------------
  app.get('/api/social-security/profiles', tenantRoute(app, read, async ({ tx, req }) => listProfiles(tx, socialProfileListQuerySchema.parse(req.query))));
  app.post(
    '/api/social-security/profiles',
    tenantRoute(app, manage, async (c) => {
      const profile = await createProfile(c.tx, sctx(c), createSocialProfileSchema.parse(c.req.body));
      void c.reply.code(201);
      return { profile };
    }),
  );
  app.delete('/api/social-security/profiles/:id', tenantRoute(app, manage, (c) => noContent(c, deleteProfile)));
  app.post(
    '/api/social-security/profiles/:id/reveal',
    tenantRoute(app, sensitive, async (c) => revealSocialNo(c.tx, sctx(c), idParam.parse(c.req.params).id, revealSocialNoSchema.parse(c.req.body).reason)),
  );

  // --- Prim desteği kuralları ve uygunluk (tarihli, doğrulama alanlı, varsayılan kapalı) -------------------
  app.get('/api/social-security/support-rules', tenantRoute(app, read, async ({ tx }) => ({ rules: await listRules(tx) })));
  app.post(
    '/api/social-security/support-rules',
    tenantRoute(app, manage, async (c) => {
      const rule = await createRule(c.tx, sctx(c), createSupportRuleSchema.parse(c.req.body));
      void c.reply.code(201);
      return { rule };
    }),
  );
  app.patch('/api/social-security/support-rules/:id', tenantRoute(app, manage, async ({ tx, req }) => ({ rule: await updateRule(tx, idParam.parse(req.params).id, updateSupportRuleSchema.parse(req.body)) })));
  app.post('/api/social-security/support-rules/:id/verify', tenantRoute(app, manage, async (c) => ({ rule: await verifyRule(c.tx, idParam.parse(c.req.params).id, c.user.id, verifySupportRuleSchema.parse(c.req.body ?? {}).note) })));
  app.delete('/api/social-security/support-rules/:id', tenantRoute(app, manage, (c) => noContent(c, deleteRule)));
  app.get('/api/social-security/eligibility', tenantRoute(app, read, async ({ tx, req }) => listEligibility(tx, socialProfileListQuerySchema.parse(req.query))));
  app.post(
    '/api/social-security/eligibility',
    tenantRoute(app, manage, async (c) => {
      const row = await createEligibility(c.tx, sctx(c), createEligibilitySchema.parse(c.req.body));
      void c.reply.code(201);
      return { eligibility: row };
    }),
  );
  app.delete('/api/social-security/eligibility/:id', tenantRoute(app, manage, (c) => noContent(c, deleteEligibility)));

  // --- Aylık bildirim -------------------------------------------------------------------------------------
  app.get('/api/social-security/declarations', tenantRoute(app, read, async ({ tx, req }) => listDeclarations(tx, declarationListQuerySchema.parse(req.query))));
  app.post(
    '/api/social-security/declarations',
    tenantRoute(app, manage, async (c) => {
      const out = await buildDeclaration(c.tx, sctx(c), buildDeclarationSchema.parse(c.req.body).month);
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/social-security/declarations/:id', tenantRoute(app, read, async ({ tx, req }) => getDeclaration(tx, idParam.parse(req.params).id)));
  app.post('/api/social-security/declarations/:id/rebuild', tenantRoute(app, manage, async (c) => {
    const cur = await getDeclaration(c.tx, idParam.parse(c.req.params).id, { log: false });
    return buildDeclaration(c.tx, sctx(c), cur.declaration.month);
  }));
  app.post('/api/social-security/declarations/:id/finalize', tenantRoute(app, manage, async (c) => finalizeDeclaration(c.tx, sctx(c), idParam.parse(c.req.params).id, finalizeDeclarationSchema.parse(c.req.body ?? {}).note)));
  app.post('/api/social-security/declarations/:id/reopen', tenantRoute(app, manage, async (c) => reopenDeclaration(c.tx, sctx(c), idParam.parse(c.req.params).id, reopenDeclarationSchema.parse(c.req.body).reason)));
  app.delete('/api/social-security/declarations/:id', tenantRoute(app, manage, (c) => noContent(c, deleteDeclaration)));

  // --- Rapor ----------------------------------------------------------------------------------------------
  app.get('/api/social-security/reports/premium', tenantRoute(app, read, async ({ tx, req }) => premiumSummary(tx, premiumSummaryQuerySchema.parse(req.query))));
};
