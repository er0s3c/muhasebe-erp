import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { dec, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { exchangeRates } from '../../db/schema';
import { unprocessable } from '../../http/errors';

/** Kayıtlı kur bu kadar günden eskiyse "yok" sayılır (hafta sonu/bayram tolerans payı). */
export const MAX_RATE_AGE_DAYS = 10;

function minusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** from -> to için doğrudan (buy) ya da ters (1/buy) kur; yoksa null. */
async function directOrInverse(
  tx: Tx,
  from: string,
  to: string,
  date: string,
): Promise<MoneyValue | null> {
  const since = minusDays(date, MAX_RATE_AGE_DAYS);
  const [direct] = await tx
    .select({ buy: exchangeRates.buy })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.currencyCode, from),
        eq(exchangeRates.quoteCode, to),
        lte(exchangeRates.rateDate, date),
        gte(exchangeRates.rateDate, since),
      ),
    )
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  if (direct) return dec(direct.buy);

  const [inverse] = await tx
    .select({ buy: exchangeRates.buy })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.currencyCode, to),
        eq(exchangeRates.quoteCode, from),
        lte(exchangeRates.rateDate, date),
        gte(exchangeRates.rateDate, since),
      ),
    )
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  if (inverse) return dec(1).div(dec(inverse.buy));
  return null;
}

/**
 * 1 birim `from` kaç birim `to`? Doğrudan/ters kur yoksa şirketin defter para birimi
 * üzerinden üçgenler. Bulunamazsa null.
 */
export async function findRate(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  via: string,
): Promise<MoneyValue | null> {
  if (from === to) return dec(1);
  const direct = await directOrInverse(tx, from, to, date);
  if (direct) return direct;
  if (from === via || to === via) return null;
  const first = await directOrInverse(tx, from, via, date);
  const second = await directOrInverse(tx, via, to, date);
  if (first && second) return first.times(second);
  return null;
}

export async function requireRate(
  tx: Tx,
  from: string,
  to: string,
  date: string,
  via: string,
): Promise<MoneyValue> {
  const rate = await findRate(tx, from, to, date, via);
  if (!rate) {
    throw unprocessable(
      `${from}/${to} kuru bulunamadı (${date} ve önceki ${MAX_RATE_AGE_DAYS} gün). Önce kur girin.`,
      'FX_RATE_MISSING',
      { from, to, date },
    );
  }
  return rate;
}
