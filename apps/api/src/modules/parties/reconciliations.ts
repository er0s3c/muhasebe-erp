import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dec, formatTR, isoDate, todayIso } from '@erp/shared';
import { parties, partyReconciliations } from '../../db/schema';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { notFound, unprocessable } from '../../http/errors';
import { partyReconciliationMail } from '../mail/templates';
import { enqueueEmail } from '../outbox/service';
import { partyOpenItems } from './service';

const createSchema = z.object({
  asOf: isoDate,
  sendTo: z.string().trim().toLowerCase().email().max(254).optional().nullable().transform((v) => v || null),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
});
const responseSchema = z.object({
  result: z.enum(['agreed', 'disputed']),
  /** Karşı tarafın kendi kayıtlarındaki bakiye (bizim işaretimizle: borç +, alacak −); mutabık değilse zorunlu. */
  counterBalance: z.string().regex(/^-?\d{1,15}(\.\d{1,2})?$/).optional().nullable(),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
}).refine((r) => r.result === 'agreed' || r.counterBalance != null, { message: 'Mutabık olunmayan cevapta karşı tarafın bakiyesi gerekli', path: ['counterBalance'] });
const params = z.object({ id: z.string().uuid(), recId: z.string().uuid().optional() });
/** Bu süreyi geçen açık mektup "cevap gecikti" sayılır. */
const RESPONSE_DAYS = 15;

/**
 * Cari mutabakat mektubu ve cevap takibi (öneri 59). Mektup, seçilen tarihteki bakiyenin (defter ve işlem para birimleri)
 * ve açık kalemlerin değişmez görüntüsüyle oluşturulur; isteğe bağlı olarak kalıcı e-posta outbox'ından gönderilir. Cevap
 * kullanıcı tarafından işlenir; mutabık olunmayan cevapta fark hesaplanır.
 */
export const partyReconciliationRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.parties', permission: 'parties.read' } as const;
  const manage = { module: 'core.parties', permission: 'parties.manage' } as const;

  const shape = (r: typeof partyReconciliations.$inferSelect) => {
    const overdue = r.status === 'open' && Date.now() - r.createdAt.getTime() > RESPONSE_DAYS * 86_400_000;
    const difference = r.counterBalance != null ? dec(r.baseBalance).minus(r.counterBalance).toFixed(2) : null;
    return { ...r, overdue, difference };
  };
  async function list(c: TenantCtx, partyId: string) {
    const rows = await c.tx.select().from(partyReconciliations).where(eq(partyReconciliations.partyId, partyId)).orderBy(desc(partyReconciliations.createdAt)).limit(50);
    return rows.map(shape);
  }

  app.get('/api/parties/:id/reconciliations', tenantRoute(app, read, async (c) => ({ reconciliations: await list(c, params.parse(c.req.params).id) })));

  app.post('/api/parties/:id/reconciliations', tenantRoute(app, { ...manage, operation: 'create', idempotent: true }, async (c) => {
    const { id } = params.parse(c.req.params);
    const input = createSchema.parse(c.req.body);
    if (input.asOf > todayIso()) throw unprocessable('Mutabakat tarihi gelecekte olamaz', 'RECONCILIATION_FUTURE_DATE');
    const [party] = await c.tx.select({ id: parties.id, name: parties.name }).from(parties).where(eq(parties.id, id));
    if (!party) throw notFound('Cari');
    const base = c.company.baseCurrency;
    const balances = (await c.tx.execute<{ currency: string; balance: string; base: string }>(sql`
      select l.currency_code as currency, sum(l.debit - l.credit)::text as balance, sum(l.debit_base - l.credit_base)::text as base
        from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
       where l.party_id = ${id}::uuid and e.entry_date <= ${input.asOf}::date
       group by l.currency_code order by l.currency_code`)).rows;
    const baseBalance = balances.reduce((sum, b) => sum.plus(b.base), dec(0));
    const byCurrency = balances.filter((b) => !dec(b.balance).isZero()).map((b) => ({ currency: b.currency, balance: dec(b.balance).toFixed(2) }));
    const open = await partyOpenItems(c.tx, id, { asOf: input.asOf });
    const snapshot = { party: { id: party.id, name: party.name }, asOf: input.asOf, baseCurrency: base, baseBalance: baseBalance.toFixed(2), byCurrency, openItems: open };
    const snapshotHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const recId = randomUUID();
    let outboxMessageId: string | null = null;
    if (input.sendTo) {
      if (!app.mailer.enabled) throw unprocessable('Giden e-posta bu kurulumda yapılandırılmamış', 'MAIL_DISABLED');
      const side = (amount: string, currency: string) => `${formatTR(dec(amount).abs().toFixed(2), 2)} ${currency} ${dec(amount).isNegative() ? '(alacağınız)' : dec(amount).isZero() ? '' : '(borcunuz)'}`.trim();
      const lines = byCurrency.length > 1 || byCurrency[0]?.currency !== base
        ? [...byCurrency.map((b) => side(b.balance, b.currency)), `Defter para birimi karşılığı: ${side(baseBalance.toFixed(2), base)}`]
        : [side(baseBalance.toFixed(2), base)];
      const mail = partyReconciliationMail(input.sendTo, { company: c.company.name, partyName: party.name, asOf: input.asOf, lines, note: input.note, reference: recId.slice(0, 8).toUpperCase() });
      const { message } = await enqueueEmail(c.tx, {
        companyId: c.company.id, kind: 'party_reconciliation', dedupeKey: `party-reconciliation:${recId}`, recipient: mail.to, subject: mail.subject,
        bodyText: mail.text, bodyHtml: mail.html ?? null, sourceType: 'party_reconciliation', sourceId: recId,
        document: { type: 'party_reconciliation', id: recId, no: null, version: snapshotHash.slice(0, 12), status: 'open' }, createdBy: c.user.id,
      });
      outboxMessageId = message.id;
    }
    await c.tx.insert(partyReconciliations).values({
      id: recId, companyId: c.company.id, partyId: id, asOf: input.asOf, baseCurrency: base, baseBalance: baseBalance.toFixed(4), byCurrency,
      snapshot, snapshotHash, sentTo: input.sendTo, outboxMessageId, note: input.note, createdBy: c.user.id,
    });
    void c.reply.code(201);
    return { reconciliations: await list(c, id) };
  }));

  app.post('/api/parties/:id/reconciliations/:recId/response', tenantRoute(app, { ...manage, operation: 'update' }, async (c) => {
    const { id, recId } = params.parse(c.req.params);
    const input = responseSchema.parse(c.req.body);
    const [row] = await c.tx.select().from(partyReconciliations).where(and(eq(partyReconciliations.id, recId!), eq(partyReconciliations.partyId, id))).for('update');
    if (!row) throw notFound('Mutabakat');
    if (row.status !== 'open') throw unprocessable('Bu mutabakat zaten cevaplanmış ya da iptal edilmiş', 'RECONCILIATION_CLOSED');
    // Mutabık cevapta karşı bakiye bizim bakiyemizdir; farklı bir değer girildiyse "mutabık" denemez
    const counter = input.result === 'agreed' ? (input.counterBalance ?? dec(row.baseBalance).toFixed(2)) : input.counterBalance!;
    if (input.result === 'agreed' && !dec(counter).minus(row.baseBalance).abs().lte('0.005')) throw unprocessable('Bakiyeler farklıyken mutabık işaretlenemez', 'RECONCILIATION_BALANCE_MISMATCH');
    await c.tx.update(partyReconciliations).set({ status: input.result, respondedAt: sql`now()`, respondedBy: c.user.id, counterBalance: dec(counter).toFixed(4), responseNote: input.note })
      .where(eq(partyReconciliations.id, recId!));
    return { reconciliations: await list(c, id) };
  }));

  app.post('/api/parties/:id/reconciliations/:recId/cancel', tenantRoute(app, { ...manage, operation: 'update' }, async (c) => {
    const { id, recId } = params.parse(c.req.params);
    const [row] = await c.tx.select().from(partyReconciliations).where(and(eq(partyReconciliations.id, recId!), eq(partyReconciliations.partyId, id))).for('update');
    if (!row) throw notFound('Mutabakat');
    if (row.status !== 'open') throw unprocessable('Bu mutabakat zaten cevaplanmış ya da iptal edilmiş', 'RECONCILIATION_CLOSED');
    await c.tx.update(partyReconciliations).set({ status: 'cancelled' }).where(eq(partyReconciliations.id, recId!));
    return { reconciliations: await list(c, id) };
  }));
};
