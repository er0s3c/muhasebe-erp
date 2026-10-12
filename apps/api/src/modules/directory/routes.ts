import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  agendaListQuerySchema,
  agendaSummaryQuerySchema,
  anonymizeContactSchema,
  buildVCards,
  contactListQuerySchema,
  createAgendaSchema,
  createContactSchema,
  createNoteSchema,
  createOrganizationSchema,
  duplicateQuerySchema,
  exportContactDataSchema,
  followUpSchema,
  idParam,
  mergeContactSchema,
  noteListQuerySchema,
  organizationListQuerySchema,
  todayIso,
  updateAgendaSchema,
  updateContactSchema,
  updateNoteSchema,
  updateOrganizationSchema,
  type VCardContact,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { pageOf } from '../../http/paging';
import { agendaSummary, createAgendaItem, createFollowUp, getAgendaItem, listAgenda, setAgendaStatus, updateAgendaItem, type AgendaCtx } from './agenda';
import {
  anonymizeContact,
  createContact,
  createNote,
  createOrganization,
  distinctTags,
  exportContactData,
  findDuplicates,
  getContact,
  getNote,
  getOrganization,
  listContacts,
  listNotes,
  listOrganizations,
  mergeContacts,
  setContactArchived,
  setOrganizationArchived,
  updateContact,
  updateNote,
  updateOrganization,
} from './service';

const vcfQuery = contactListQuerySchema.extend({ archived: z.enum(['active', 'archived', 'all']).default('active') });

export const directoryRoutes: FastifyPluginAsync = async (app) => {
  const MODULE = 'core.directory';
  const read = { module: MODULE, permission: 'directory.read' } as const;
  const personalAgenda = { ...read, personalAgenda: true } as const;
  const manage = { module: MODULE, permission: 'directory.manage' } as const;
  const dctx = ({ company, user }: TenantCtx) => ({ companyId: company.id, userId: user.id });
  const actx = (c: TenantCtx): AgendaCtx => ({ companyId: c.company.id, userId: c.user.id, canManage: c.can('directory.manage') });

  // --- Kurumlar -------------------------------------------------------------------------------------
  app.get('/api/directory/organizations', tenantRoute(app, read, async ({ tx, req }) => {
    const q = organizationListQuerySchema.parse(req.query);
    return listOrganizations(tx, q, pageOf(q));
  }));
  app.get('/api/directory/organizations/:id', tenantRoute(app, read, async ({ tx, req }) => getOrganization(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/directory/organizations',
    tenantRoute(app, manage, async (c) => {
      const out = await createOrganization(c.tx, dctx(c), createOrganizationSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.patch('/api/directory/organizations/:id', tenantRoute(app, manage, async ({ tx, req }) => updateOrganization(tx, idParam.parse(req.params).id, updateOrganizationSchema.parse(req.body))));
  app.post('/api/directory/organizations/:id/archive', tenantRoute(app, manage, async ({ tx, req }) => setOrganizationArchived(tx, idParam.parse(req.params).id, true)));
  app.post('/api/directory/organizations/:id/unarchive', tenantRoute(app, manage, async ({ tx, req }) => setOrganizationArchived(tx, idParam.parse(req.params).id, false)));

  // --- Kişiler --------------------------------------------------------------------------------------
  app.get('/api/directory/contacts', tenantRoute(app, read, async ({ tx, req }) => listContacts(tx, contactListQuerySchema.parse(req.query))));
  app.get('/api/directory/contacts/tags', tenantRoute(app, read, async ({ tx }) => distinctTags(tx)));
  // Yinelenen kişi ipucu (telefon son 10 hane / e-posta): yazarken ve içe aktarırken kullanılır; engellemez
  app.get(
    '/api/directory/contacts/duplicates',
    tenantRoute(app, manage, async ({ tx, req }) => {
      const q = duplicateQuerySchema.parse(req.query);
      return { duplicates: await findDuplicates(tx, { phones: [q.phone], emails: [q.email], excludeId: q.excludeId }) };
    }),
  );
  // Toplu vCard: üçüncü kişilerin kişisel verisi → yönetim izni + oran sınırı. Notlar dosyaya girmez.
  app.get(
    '/api/directory/contacts/export.vcf',
    tenantRoute(app, { ...manage, limit: { name: 'export', max: 30, windowMs: 60_000 } }, async ({ tx, req, reply }) => {
      const { contacts } = await listContacts(tx, vcfQuery.parse(req.query));
      void reply
        .header('cache-control', 'no-store')
        .header('content-type', 'text/vcard; charset=utf-8')
        .header('content-disposition', `attachment; filename="rehber-${todayIso()}.vcf"`);
      return buildVCards(contacts.filter((c) => !c.anonymizedAt && !c.mergedIntoId).map(toVCard));
    }),
  );
  app.get(
    '/api/directory/contacts/:id/vcard',
    tenantRoute(app, read, async ({ tx, req, reply }) => {
      const { contact } = await getContact(tx, idParam.parse(req.params).id);
      void reply.header('cache-control', 'no-store').header('content-type', 'text/vcard; charset=utf-8').header('content-disposition', `attachment; filename="kisi-${todayIso()}.vcf"`);
      return buildVCards([toVCard(contact)]);
    }),
  );
  app.get('/api/directory/contacts/:id', tenantRoute(app, read, async ({ tx, req }) => getContact(tx, idParam.parse(req.params).id)));
  app.post(
    '/api/directory/contacts',
    tenantRoute(app, manage, async (c) => {
      const out = await createContact(c.tx, dctx(c), createContactSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.patch('/api/directory/contacts/:id', tenantRoute(app, manage, async ({ tx, req }) => updateContact(tx, idParam.parse(req.params).id, updateContactSchema.parse(req.body))));
  app.post('/api/directory/contacts/:id/archive', tenantRoute(app, manage, async ({ tx, req }) => setContactArchived(tx, idParam.parse(req.params).id, true)));
  app.post('/api/directory/contacts/:id/unarchive', tenantRoute(app, manage, async ({ tx, req }) => setContactArchived(tx, idParam.parse(req.params).id, false)));
  app.post('/api/directory/contacts/:id/merge', tenantRoute(app, manage, async ({ tx, req }) => mergeContacts(tx, idParam.parse(req.params).id, mergeContactSchema.parse(req.body).mergeId)));
  // Anonimleştirme: ad/telefon/e-posta/adres yer tutucu, notların serbest metni temizlenir; gerekçe zorunlu, erişim günlüğüne yazılır
  app.post(
    '/api/directory/contacts/:id/anonymize',
    tenantRoute(app, manage, async (c) => anonymizeContact(c.tx, dctx(c), idParam.parse(c.req.params).id, anonymizeContactSchema.parse(c.req.body).reason)),
  );
  // İlgili kişi dışa aktarması: kişi + TÜM notlar (başkalarının özel notları dahil) + ajanda; hem gizlilik hem rehber yönetim izni, günlüklü
  app.post(
    '/api/privacy/contacts/:id/export',
    tenantRoute(app, { module: MODULE, permission: 'privacy.manage' }, async (c) => {
      c.require('directory.manage');
      return exportContactData(c.tx, dctx(c), idParam.parse(c.req.params).id, exportContactDataSchema.parse(c.req.body).reason);
    }),
  );

  // --- Görüşme notları ---------------------------------------------------------------------------------
  app.get('/api/directory/notes', tenantRoute(app, read, async (c) => listNotes(c.tx, noteListQuerySchema.parse(c.req.query), c.user.id)));
  app.post(
    '/api/directory/notes',
    tenantRoute(app, manage, async (c) => {
      const out = await createNote(c.tx, dctx(c), createNoteSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/directory/notes/:id', tenantRoute(app, read, async (c) => getNote(c.tx, idParam.parse(c.req.params).id, c.user.id)));
  app.patch('/api/directory/notes/:id', tenantRoute(app, manage, async (c) => updateNote(c.tx, dctx(c), idParam.parse(c.req.params).id, updateNoteSchema.parse(c.req.body))));
  app.post(
    '/api/directory/notes/:id/follow-up',
    tenantRoute(app, personalAgenda, async (c) => {
      const out = await createFollowUp(c.tx, actx(c), idParam.parse(c.req.params).id, followUpSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );

  // --- Ajanda -----------------------------------------------------------------------------------------
  app.get('/api/agenda', tenantRoute(app, personalAgenda, async (c) => listAgenda(c.tx, actx(c), agendaListQuerySchema.parse(c.req.query))));
  app.get('/api/agenda/summary', tenantRoute(app, personalAgenda, async (c) => agendaSummary(c.tx, actx(c), agendaSummaryQuerySchema.parse(c.req.query))));
  // Kendi ajanda kalemini her okuyucu açar/düzenler; başkası ya da şirket adına açmak yönetim izni ister (servis denetler)
  app.post(
    '/api/agenda',
    tenantRoute(app, personalAgenda, async (c) => {
      const out = await createAgendaItem(c.tx, actx(c), createAgendaSchema.parse(c.req.body));
      void c.reply.code(201);
      return out;
    }),
  );
  app.get('/api/agenda/:id', tenantRoute(app, personalAgenda, async (c) => getAgendaItem(c.tx, idParam.parse(c.req.params).id, actx(c))));
  app.patch('/api/agenda/:id', tenantRoute(app, personalAgenda, async (c) => updateAgendaItem(c.tx, actx(c), idParam.parse(c.req.params).id, updateAgendaSchema.parse(c.req.body))));
  for (const [path, status] of [['complete', 'done'], ['cancel', 'cancelled'], ['reopen', 'open']] as const) {
    app.post(`/api/agenda/:id/${path}`, tenantRoute(app, personalAgenda, async (c) => setAgendaStatus(c.tx, actx(c), idParam.parse(c.req.params).id, status)));
  }
};

function toVCard(c: Record<string, unknown>): VCardContact {
  return {
    fullName: c.fullName as string,
    title: c.title as string | null,
    organizationName: c.organizationName as string | null,
    phone: c.phone as string | null,
    phone2: c.phone2 as string | null,
    email: c.email as string | null,
    email2: c.email2 as string | null,
    address: c.address as string | null,
    tags: (c.tags as string[]) ?? [],
  };
}
