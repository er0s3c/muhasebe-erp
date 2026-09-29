import type { FastifyPluginAsync } from 'fastify';
import {
  agingQuerySchema,
  createPartySchema,
  listPartiesQuerySchema,
  openItemsQuerySchema,
  partyIdParam,
  partyStatementQuerySchema,
  updatePartySchema,
} from '@erp/shared';
import { tenantRoute } from '../../http/context';
import {
  createParty,
  deleteParty,
  getParty,
  listParties,
  partyAging,
  partyOpenItems,
  partyStatement,
  updateParty,
} from './service';

export const partyRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.parties', permission: 'parties.read' } as const;
  const manage = { module: 'core.parties', permission: 'parties.manage' } as const;

  app.get(
    '/api/parties',
    tenantRoute(app, read, async ({ tx, req }) => listParties(tx, listPartiesQuerySchema.parse(req.query))),
  );

  app.post(
    '/api/parties',
    tenantRoute(app, manage, async ({ tx, req, reply, company }) => {
      const party = await createParty(tx, company.id, createPartySchema.parse(req.body));
      void reply.code(201);
      return { party };
    }),
  );

  app.get(
    '/api/parties/:id',
    tenantRoute(app, read, async ({ tx, req }) => getParty(tx, partyIdParam.parse(req.params).id)),
  );

  app.patch(
    '/api/parties/:id',
    tenantRoute(app, manage, async ({ tx, req }) => ({
      party: await updateParty(tx, partyIdParam.parse(req.params).id, updatePartySchema.parse(req.body)),
    })),
  );

  app.delete(
    '/api/parties/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteParty(tx, partyIdParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.get(
    '/api/parties/:id/statement',
    tenantRoute(app, read, async ({ tx, req }) =>
      partyStatement(tx, partyIdParam.parse(req.params).id, partyStatementQuerySchema.parse(req.query)),
    ),
  );

  app.get(
    '/api/parties/:id/open-items',
    tenantRoute(app, read, async ({ tx, req }) =>
      partyOpenItems(tx, partyIdParam.parse(req.params).id, openItemsQuerySchema.parse(req.query)),
    ),
  );

  app.get(
    '/api/reports/party-aging',
    tenantRoute(app, read, async ({ tx, req }) => partyAging(tx, agingQuerySchema.parse(req.query))),
  );
};
