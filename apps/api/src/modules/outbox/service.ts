import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withContext, type Db, type Tx } from '../../db/client';
import { outboxMessages } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import type { Mailer } from '../mail/mailer';
import { OUTBOX_LEASE_MS, outboxOutcome } from './contract';

export type OutboxRow = typeof outboxMessages.$inferSelect;
export interface EnqueueEmail {
  companyId: string;
  kind: OutboxRow['kind'];
  dedupeKey: string;
  recipient: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  document?: OutboxRow['document'];
  createdBy?: string | null;
}

/**
 * İletiyi iş kaydıyla aynı işlemde kuyruğa yazar. Aynı `dedupeKey` ikinci kez gelirse yeni ileti doğmaz; mevcut kayıt döner
 * (`created: false`). İşlem geri alınırsa ileti de yazılmamış olur.
 */
export async function enqueueEmail(tx: Tx, input: EnqueueEmail): Promise<{ message: OutboxRow; created: boolean }> {
  const [inserted] = await tx
    .insert(outboxMessages)
    .values({ id: randomUUID(), ...input, bodyHtml: input.bodyHtml ?? null, channel: 'email' })
    .onConflictDoNothing({ target: [outboxMessages.companyId, outboxMessages.dedupeKey] })
    .returning();
  if (inserted) return { message: inserted, created: true };
  const [existing] = await tx.select().from(outboxMessages).where(eq(outboxMessages.dedupeKey, input.dedupeKey));
  return { message: existing!, created: false };
}

export interface DispatchResult { companies: number; delivered: number; failed: number; deadLetter: number }

/**
 * Kuyruktaki e-postaları gönderir. Her şirket kendi işleminde ve kendi RLS bağlamında işlenir; ileti kira alınarak talep
 * edilir (başka örnek aynı iletiyi aynı anda almaz), SMTP çağrısı işlem dışındadır, sonuç yalnız kira hâlâ bizdeyse yazılır.
 * Posta kapalıysa hiçbir şey yapılmaz; iletiler beklemede kalır.
 */
export async function dispatchEmailOutbox(db: Db, mailer: Mailer, opts: { now?: () => Date; perCompany?: number } = {}): Promise<DispatchResult> {
  const result: DispatchResult = { companies: 0, delivered: 0, failed: 0, deadLetter: 0 };
  if (!mailer.enabled) return result;
  const now = opts.now ?? (() => new Date());
  const targets = (await db.execute<{ company_id: string; organization_id: string }>(sql`select company_id, organization_id from outbox_due_targets()`)).rows;
  for (const target of targets) {
    const ctx = { companyId: target.company_id, orgId: target.organization_id };
    let touched = false;
    for (let count = 0; count < (opts.perCompany ?? 20); count++) {
      const at = now();
      const claimed = await withContext(db, ctx, async (tx) => {
        const [row] = await tx.select().from(outboxMessages)
          .where(and(
            inArray(outboxMessages.status, ['pending', 'sending']),
            sql`${outboxMessages.nextAttemptAt} <= ${at.toISOString()}::timestamptz`,
            sql`(${outboxMessages.leaseUntil} is null or ${outboxMessages.leaseUntil} < ${at.toISOString()}::timestamptz)`,
          ))
          .orderBy(outboxMessages.nextAttemptAt, outboxMessages.id)
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        const leaseToken = randomUUID();
        await tx.update(outboxMessages)
          .set({ status: 'sending', attempts: row.attempts + 1, leaseToken, leaseUntil: new Date(at.getTime() + OUTBOX_LEASE_MS) })
          .where(eq(outboxMessages.id, row.id));
        return { row: { ...row, attempts: row.attempts + 1 }, leaseToken };
      });
      if (!claimed) break;
      touched = true;
      let error: string | null = null;
      try {
        // Message-ID iletinin outbox kimliğidir: kira dolup yeniden gönderilen ileti alıcıda aynı kimliği taşır
        await mailer.send({ to: claimed.row.recipient, subject: claimed.row.subject, text: claimed.row.bodyText, html: claimed.row.bodyHtml ?? undefined, messageId: `<${claimed.row.id}@outbox.ada-erp>` });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'E-posta gönderilemedi';
      }
      const outcome = outboxOutcome(claimed.row.attempts, claimed.row.maxAttempts, error, now());
      await withContext(db, ctx, (tx) => tx.update(outboxMessages)
        .set({ ...outcome, leaseToken: null, leaseUntil: null })
        .where(and(eq(outboxMessages.id, claimed.row.id), eq(outboxMessages.leaseToken, claimed.leaseToken))));
      if (outcome.status === 'delivered') result.delivered++;
      else if (outcome.status === 'dead_letter') result.deadLetter++;
      else result.failed++;
    }
    if (touched) result.companies++;
  }
  return result;
}

/** Sınırı dolmuş ya da bekleyen iletiyi hemen yeniden denemeye alır; üç ek deneme hakkı verir. */
export async function retryOutboxMessage(tx: Tx, id: string): Promise<OutboxRow> {
  const [row] = await tx.select().from(outboxMessages).where(eq(outboxMessages.id, id)).for('update');
  if (!row) throw notFound('Gönderim kaydı');
  if (!['dead_letter', 'pending'].includes(row.status)) throw unprocessable('Yalnız bekleyen veya teslim edilemeyen ileti yeniden denenebilir', 'OUTBOX_NOT_RETRYABLE');
  const [updated] = await tx.update(outboxMessages)
    .set({ status: 'pending', nextAttemptAt: new Date(), maxAttempts: Math.min(row.attempts + 3, 20) })
    .where(eq(outboxMessages.id, id))
    .returning();
  return updated!;
}

/** Bir kaydın gönderim geçmişi (en yeni önce). İçerik gövdesi listede dönmez. */
export async function sourceDeliveries(tx: Tx, sourceType: string, sourceId: string) {
  return tx.select({
    id: outboxMessages.id, kind: outboxMessages.kind, recipient: outboxMessages.recipient, subject: outboxMessages.subject,
    document: outboxMessages.document, status: outboxMessages.status, attempts: outboxMessages.attempts, maxAttempts: outboxMessages.maxAttempts,
    nextAttemptAt: outboxMessages.nextAttemptAt, deliveredAt: outboxMessages.deliveredAt, lastError: outboxMessages.lastError,
    createdBy: outboxMessages.createdBy, createdAt: outboxMessages.createdAt,
  }).from(outboxMessages)
    .where(and(eq(outboxMessages.sourceType, sourceType), eq(outboxMessages.sourceId, sourceId)))
    .orderBy(desc(outboxMessages.createdAt), desc(outboxMessages.id))
    .limit(50);
}
