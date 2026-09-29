import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { unprocessable, notFound } from '../../http/errors';
import type { Tx } from '../../db/client';
import { fiscalPeriods, journalEntries } from '../../db/schema';

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Yılın 12 aylık dönemini üretir; varsa dokunmaz. */
export async function generatePeriods(tx: Tx, companyId: string, year: number): Promise<void> {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    return {
      companyId,
      year,
      month,
      startDate: `${year}-${pad(month)}-01`,
      endDate: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`,
    };
  });
  await tx.insert(fiscalPeriods).values(rows).onConflictDoNothing();
}

export async function findPeriodForDate(tx: Tx, date: string) {
  const [period] = await tx
    .select()
    .from(fiscalPeriods)
    .where(and(lte(fiscalPeriods.startDate, date), gte(fiscalPeriods.endDate, date)));
  return period ?? null;
}

export async function listPeriods(tx: Tx, year: number) {
  return tx
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.year, year))
    .orderBy(asc(fiscalPeriods.month));
}

export async function closePeriod(tx: Tx, periodId: string, userId: string) {
  const [period] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.id, periodId));
  if (!period) throw notFound('Dönem');
  const [drafts] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(and(eq(journalEntries.periodId, periodId), eq(journalEntries.status, 'draft')));
  if (drafts && drafts.n > 0) {
    throw unprocessable(
      `Dönemde ${drafts.n} taslak yevmiye var; kaydedin veya silin`,
      'PERIOD_HAS_DRAFTS',
    );
  }
  const [updated] = await tx
    .update(fiscalPeriods)
    .set({ status: 'closed', closedAt: new Date(), closedBy: userId })
    .where(eq(fiscalPeriods.id, periodId))
    .returning();
  return updated!;
}

export async function reopenPeriod(tx: Tx, periodId: string) {
  const [updated] = await tx
    .update(fiscalPeriods)
    .set({ status: 'open', closedAt: null, closedBy: null })
    .where(eq(fiscalPeriods.id, periodId))
    .returning();
  if (!updated) throw notFound('Dönem');
  return updated;
}
