import type { FastifyPluginAsync } from 'fastify';
import {
  cancelDeliveryNoteSchema,
  createDeliveryNoteSchema,
  hasPermission,
  idParam,
  listDeliveryNotesQuerySchema,
  openDeliveryLinesQuerySchema,
  returnableLinesQuerySchema,
  updateDeliveryNoteSchema,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { forbidden } from '../../http/errors';
import { lockItems } from '../inventory/balances';
import { lockDeliveryLines } from '../invoices/delivery-link';
import { lockOrderLines } from '../sales/usage';
import { returnableLines } from './returns';
import { cancelDeliveryNote, postDeliveryNote } from './posting';
import {
  createDeliveryDraft,
  deleteDeliveryDraft,
  deliverySummary,
  getDeliveryNote,
  listDeliveryNotes,
  openDeliveryLines,
  updateDeliveryDraft,
  type DeliveryCtx,
} from './service';

const deliveryCtx = ({ company, user }: TenantCtx): DeliveryCtx => ({
  companyId: company.id,
  userId: user.id,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

/** Oluştur/güncelle + kaydet tek istekte: kilit sırası kayıt işlemindekiyle aynı (orijinal irsaliye satırları, sipariş satırları, kartlar). */
async function lockForPosting(tx: Tx, lines: readonly { itemId: string; sourceLineId?: string | null; salesOrderLineId?: string | null }[]) {
  await lockDeliveryLines(tx, lines.flatMap((l) => (l.sourceLineId ? [l.sourceLineId] : [])));
  await lockOrderLines(tx, lines.flatMap((l) => (l.salesOrderLineId ? [l.salesOrderLineId] : [])));
  await lockItems(tx, lines.map((l) => l.itemId));
}

export const deliveryRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.invoices', permission: 'deliveries.read' } as const;
  const manage = { module: 'core.invoices', permission: 'deliveries.manage' } as const;
  const post = { module: 'core.invoices', permission: 'deliveries.post' } as const;

  app.get(
    '/api/delivery-notes',
    tenantRoute(app, read, async ({ tx, req }) => listDeliveryNotes(tx, listDeliveryNotesQuerySchema.parse(req.query))),
  );

  app.get('/api/delivery-notes/summary', tenantRoute(app, read, async ({ tx }) => deliverySummary(tx)));

  app.get(
    '/api/delivery-notes/open-lines',
    tenantRoute(app, read, async ({ tx, req }) => openDeliveryLines(tx, openDeliveryLinesQuerySchema.parse(req.query))),
  );

  app.get(
    '/api/delivery-notes/returnable-lines',
    tenantRoute(app, read, async ({ tx, req }) => returnableLines(tx, returnableLinesQuerySchema.parse(req.query))),
  );

  app.get(
    '/api/delivery-notes/:id',
    tenantRoute(app, read, async ({ tx, req }) => getDeliveryNote(tx, idParam.parse(req.params).id)),
  );

  app.post(
    '/api/delivery-notes',
    tenantRoute(app, manage, async (c) => {
      const input = createDeliveryNoteSchema.parse(c.req.body);
      // Taslak hazırlama ile stok hareketini işleme ayrı yetkilerdir
      if (input.post && !hasPermission(c.role, 'deliveries.post')) throw forbidden();
      const ctx = deliveryCtx(c);
      // Kartlar, satırlar yazılmadan ÖNCE kilitlenir (yabancı anahtar KEY SHARE -> FOR UPDATE yükseltmesi kilitlenme yaratır)
      if (input.post) await lockForPosting(c.tx, input.lines);
      const id = await createDeliveryDraft(c.tx, ctx, input);
      const result = input.post ? await postDeliveryNote(c.tx, ctx, id) : await getDeliveryNote(c.tx, id);
      void c.reply.code(201);
      return result;
    }),
  );

  app.put(
    '/api/delivery-notes/:id',
    tenantRoute(app, manage, async (c) => {
      const { id } = idParam.parse(c.req.params);
      const input = updateDeliveryNoteSchema.parse(c.req.body);
      if (input.post && !hasPermission(c.role, 'deliveries.post')) throw forbidden();
      const ctx = deliveryCtx(c);
      if (input.post && input.lines) await lockForPosting(c.tx, input.lines);
      await updateDeliveryDraft(c.tx, ctx, id, input);
      return input.post ? postDeliveryNote(c.tx, ctx, id) : getDeliveryNote(c.tx, id);
    }),
  );

  app.delete(
    '/api/delivery-notes/:id',
    tenantRoute(app, manage, async ({ tx, req }) => {
      await deleteDeliveryDraft(tx, idParam.parse(req.params).id);
      return { ok: true };
    }),
  );

  app.post(
    '/api/delivery-notes/:id/post',
    tenantRoute(app, post, async (c) => postDeliveryNote(c.tx, deliveryCtx(c), idParam.parse(c.req.params).id)),
  );

  app.post(
    '/api/delivery-notes/:id/cancel',
    tenantRoute(app, post, async (c) =>
      cancelDeliveryNote(c.tx, deliveryCtx(c), idParam.parse(c.req.params).id, cancelDeliveryNoteSchema.parse(c.req.body)),
    ),
  );
};
