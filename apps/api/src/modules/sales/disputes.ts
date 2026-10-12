import { eq, sql } from 'drizzle-orm';
import { dec, type CreateDisputeInput, type DisputeActionInput, type DisputeStatus, type ListDisputesQuery } from '@erp/shared';
import type { Tx } from '../../db/client';
import { commercialDisputeEvents, commercialDisputes, parties } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { assertSalesRep } from './reps';

/**
 * Ticari itiraz ve anlaşmazlık dosyası (öneri 39). Müşterinin fiyat/miktar/kalite/teslim/ödeme itirazı açılır, isteğe bağlı
 * olarak fatura, irsaliye ya da siparişe bağlanır; sorumluya atanır, notlanır ve gerekçeyle çözülür ya da reddedilir.
 * Dosya muhasebe kaydı oluşturmaz: tutar, itirazın büyüklüğünü gösterir; düzeltme (iade/fiyat farkı faturası) ayrıca kesilir.
 */

const SOURCE_TABLE = {
  invoice: sql`select party_id from invoices where id = `,
  delivery_note: sql`select party_id from delivery_notes where id = `,
  sales_order: sql`select party_id from sales_orders where id = `,
} as const;

async function assertSource(tx: Tx, partyId: string, type: keyof typeof SOURCE_TABLE, id: string) {
  const r = await tx.execute<{ party_id: string }>(sql`${SOURCE_TABLE[type]}${id}`);
  const row = r.rows[0];
  if (!row) throw unprocessable('Kaynak belge bulunamadı', 'DISPUTE_SOURCE_NOT_FOUND');
  if (row.party_id !== partyId) throw unprocessable('Kaynak belge itirazın carisine ait değil', 'DISPUTE_SOURCE_PARTY');
}

export async function createDispute(tx: Tx, ctx: { companyId: string; userId: string }, input: CreateDisputeInput) {
  const [party] = await tx.select({ id: parties.id, currencyCode: parties.currencyCode }).from(parties).where(eq(parties.id, input.partyId));
  if (!party) throw notFound('Cari');
  if (input.sourceType && input.sourceId) await assertSource(tx, party.id, input.sourceType, input.sourceId);
  if (input.ownerId) await assertSalesRep(tx, ctx.companyId, input.ownerId);
  const [row] = await tx
    .insert(commercialDisputes)
    .values({
      companyId: ctx.companyId,
      partyId: party.id,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      category: input.category,
      subject: input.subject,
      amount: input.amount ?? null,
      currencyCode: input.amount ? (input.currency ?? party.currencyCode) : null,
      ownerId: input.ownerId ?? null,
      dueDate: input.dueDate ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: commercialDisputes.id });
  await tx.insert(commercialDisputeEvents).values({ companyId: ctx.companyId, disputeId: row!.id, kind: 'created', toStatus: 'open', note: input.note ?? null, createdBy: ctx.userId });
  return getDispute(tx, row!.id);
}

const NEXT: Record<'review' | 'resolve' | 'reject', { from: DisputeStatus[]; to: DisputeStatus }> = {
  review: { from: ['open'], to: 'in_review' },
  resolve: { from: ['open', 'in_review'], to: 'resolved' },
  reject: { from: ['open', 'in_review'], to: 'rejected' },
};

export async function actOnDispute(tx: Tx, ctx: { companyId: string; userId: string }, id: string, input: DisputeActionInput) {
  const [d] = await tx.select().from(commercialDisputes).where(eq(commercialDisputes.id, id)).for('update');
  if (!d) throw notFound('İtiraz dosyası');
  if (d.status === 'resolved' || d.status === 'rejected') throw unprocessable('Kapanmış itiraz dosyası değiştirilemez', 'DISPUTE_CLOSED');
  const event = { companyId: ctx.companyId, disputeId: id, createdBy: ctx.userId };
  switch (input.action) {
    case 'note':
      await tx.insert(commercialDisputeEvents).values({ ...event, kind: 'note', note: input.note });
      await tx.update(commercialDisputes).set({ updatedAt: new Date() }).where(eq(commercialDisputes.id, id));
      break;
    case 'assign':
      if (input.ownerId) await assertSalesRep(tx, ctx.companyId, input.ownerId);
      await tx.update(commercialDisputes).set({ ownerId: input.ownerId, updatedAt: new Date() }).where(eq(commercialDisputes.id, id));
      await tx.insert(commercialDisputeEvents).values({ ...event, kind: 'assign', note: input.note ?? null });
      break;
    default: {
      const step = NEXT[input.action];
      if (!step.from.includes(d.status)) throw unprocessable(`İtiraz "${d.status}" durumundan bu adıma geçemez`, 'DISPUTE_INVALID_TRANSITION');
      const closing = step.to === 'resolved' || step.to === 'rejected';
      const resolution = 'resolution' in input ? input.resolution : null;
      await tx
        .update(commercialDisputes)
        .set({
          status: step.to,
          updatedAt: new Date(),
          ...(closing ? { resolution, resolvedAt: new Date(), resolvedBy: ctx.userId } : {}),
        })
        .where(eq(commercialDisputes.id, id));
      await tx.insert(commercialDisputeEvents).values({ ...event, kind: 'status', fromStatus: d.status, toStatus: step.to, note: 'note' in input ? (input.note ?? null) : resolution });
    }
  }
  return getDispute(tx, id);
}

interface DisputeRow extends Record<string, unknown> {
  id: string;
  partyId: string;
  partyName: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceNo: string | null;
  category: string;
  subject: string;
  amount: string | null;
  currencyCode: string | null;
  status: DisputeStatus;
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  createdByName: string | null;
}

const DISPUTE_SELECT = sql`
  select d.id, d.party_id as "partyId", p.name as "partyName", d.source_type as "sourceType", d.source_id as "sourceId",
         coalesce(i.invoice_no, n.note_no, so.doc_no) as "sourceNo",
         d.category, d.subject, d.amount::text as amount, d.currency_code as "currencyCode", d.status,
         d.owner_id as "ownerId", ou.full_name as "ownerName", d.due_date::text as "dueDate", d.resolution,
         d.resolved_at as "resolvedAt", d.created_at as "createdAt", cu.full_name as "createdByName"
    from commercial_disputes d
    join parties p on p.id = d.party_id
    left join invoices i on d.source_type = 'invoice' and i.id = d.source_id
    left join delivery_notes n on d.source_type = 'delivery_note' and n.id = d.source_id
    left join sales_orders so on d.source_type = 'sales_order' and so.id = d.source_id
    left join users ou on ou.id = d.owner_id
    left join users cu on cu.id = d.created_by`;

const out = (r: DisputeRow) => ({ ...r, amount: r.amount === null ? null : dec(r.amount).toFixed(4) });

export async function getDispute(tx: Tx, id: string) {
  const r = await tx.execute<DisputeRow>(sql`${DISPUTE_SELECT} where d.id = ${id}`);
  const row = r.rows[0];
  if (!row) throw notFound('İtiraz dosyası');
  const events = await tx.execute<{ id: string; kind: string; fromStatus: string | null; toStatus: string | null; note: string | null; createdAt: string; userName: string | null }>(sql`
    select e.id, e.kind, e.from_status as "fromStatus", e.to_status as "toStatus", e.note, e.created_at as "createdAt", u.full_name as "userName"
      from commercial_dispute_events e left join users u on u.id = e.created_by
     where e.dispute_id = ${id} order by e.created_at, e.id`);
  return { dispute: out(row), events: events.rows };
}

export async function listDisputes(tx: Tx, q: ListDisputesQuery) {
  const conds = [sql`true`];
  if (q.partyId) conds.push(sql`d.party_id = ${q.partyId}`);
  if (q.status === 'open') conds.push(sql`d.status in ('open','in_review')`);
  if (q.status === 'closed') conds.push(sql`d.status in ('resolved','rejected')`);
  if (q.sourceType) conds.push(sql`d.source_type = ${q.sourceType}`);
  if (q.sourceId) conds.push(sql`d.source_id = ${q.sourceId}`);
  const r = await tx.execute<DisputeRow>(sql`${DISPUTE_SELECT} where ${sql.join(conds, sql` and `)} order by d.created_at desc limit 300`);
  return { disputes: r.rows.map(out) };
}
