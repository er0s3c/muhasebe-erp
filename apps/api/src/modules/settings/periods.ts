import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { isoYear } from '@erp/shared';
import { conflict, unprocessable, notFound } from '../../http/errors';
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

/** Tarihin dönemini döndürür; dönem tanımsızsa veya kapalıysa 422 fırlatır (yevmiye ve stok ortak). */
export async function requireOpenPeriod(tx: Tx, date: string) {
  const period = await findPeriodForDate(tx, date);
  if (!period) {
    throw unprocessable(
      `${date} tarihi için dönem tanımlı değil. Ayarlar > Dönemler'den ${isoYear(date)} yılını oluşturun.`,
      'PERIOD_MISSING',
    );
  }
  if (period.status !== 'open') {
    throw unprocessable(
      `${period.year}-${String(period.month).padStart(2, '0')} dönemi kapalı`,
      'PERIOD_CLOSED',
    );
  }
  return period;
}

export async function listPeriods(tx: Tx, year: number) {
  return tx
    .select()
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.year, year))
    .orderBy(asc(fiscalPeriods.month));
}

export async function closePeriod(tx: Tx, periodId: string, userId: string) {
  // Dönem satırı kilitlenir: bu döneme kayıt atan (koruyucuda FOR SHARE alan) işlemler bitene dek beklenir, sonra
  // taslak sayımı ve kapanış onların sonucunu görür; kapanıştan sonra gelen kayıt kapalı dönemi görüp reddedilir.
  const [period] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.id, periodId)).for('update');
  if (!period) throw notFound('Dönem');
  // Tekrarlanan istek kapanış bilgisini (tarih/kullanıcı) ezmesin (API-11)
  if (period.status === 'closed') throw conflict('Dönem zaten kapalı', 'PERIOD_ALREADY_CLOSED');
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
  const [period] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.id, periodId)).for('update');
  if (!period) throw notFound('Dönem');
  if (period.status === 'open') throw conflict('Dönem zaten açık', 'PERIOD_ALREADY_OPEN');
  const [updated] = await tx
    .update(fiscalPeriods)
    .set({ status: 'open', closedAt: null, closedBy: null })
    .where(eq(fiscalPeriods.id, periodId))
    .returning();
  if (!updated) throw notFound('Dönem');
  return updated;
}
