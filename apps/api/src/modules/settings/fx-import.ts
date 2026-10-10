import { and, eq } from 'drizzle-orm';
import { CURRENCY_CODES, type FxProvider } from '@erp/shared';
import type { Tx } from '../../db/client';
import { exchangeRates } from '../../db/schema';
import { unprocessable } from '../../http/errors';
import type { PublishedRateDay } from './xml-rates';

export interface FxImportResult {
  date: string;
  announcementNo: string | null;
  provider: FxProvider;
  source: string;
  sourceUrl: string | null;
  imported: {
    currency: string;
    buy: string;
    sell: string;
    effectiveBuy: string | null;
    effectiveSell: string | null;
  }[];
  skipped: string[];
}
/** Atomic conflict filtering keeps manual/uploaded values safe even during concurrent imports. */
export async function importPublishedRates(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  day: PublishedRateDay,
  options: { provider: FxProvider; sourceUrl?: string | null; uploaded?: boolean },
): Promise<FxImportResult> {
  const supported = new Set<string>(CURRENCY_CODES.filter((c) => c !== 'TRY'));
  if (!day.rates.some((r) => supported.has(r.symbol)))
    throw unprocessable(
      'Dosyada desteklenen para birimi yok (GBP, EUR, USD)',
      'RATE_XML_NO_SUPPORTED',
    );
  const provider: 'manual' | 'xml' | 'tcmb' | 'kktcmb' = options.uploaded
    ? 'xml'
    : options.provider;
  const source = `${options.provider === 'tcmb' ? 'TCMB' : 'KKTCMB'}${day.announcementNo ? ' ' + day.announcementNo : ''}`;
  const sourceUrl = options.uploaded ? null : (options.sourceUrl ?? null);
  const imported: FxImportResult['imported'] = [],
    skipped: string[] = [];
  for (const r of day.rates) {
    if (!supported.has(r.symbol)) {
      skipped.push(r.symbol);
      continue;
    }
    if (!r.buy || !r.sell)
      throw unprocessable(`${r.symbol}: döviz alış ve satış kuru bulunamadı`, 'RATE_XML_INVALID');
    const row = {
      companyId: ctx.companyId,
      rateDate: day.date,
      currencyCode: r.symbol,
      quoteCode: 'TRY',
      buy: r.buy,
      sell: r.sell,
      effectiveBuy: r.effectiveBuy,
      effectiveSell: r.effectiveSell,
      provider,
      source,
      sourceUrl,
      fetchedAt: options.uploaded ? null : new Date(),
      createdBy: ctx.userId,
    };
    const written = await tx
      .insert(exchangeRates)
      .values(row)
      .onConflictDoUpdate({
        target: [
          exchangeRates.companyId,
          exchangeRates.rateDate,
          exchangeRates.currencyCode,
          exchangeRates.quoteCode,
        ],
        set: {
          buy: row.buy,
          sell: row.sell,
          effectiveBuy: row.effectiveBuy,
          effectiveSell: row.effectiveSell,
          provider,
          source,
          sourceUrl,
          fetchedAt: row.fetchedAt,
          createdBy: ctx.userId,
        },
        setWhere: and(eq(exchangeRates.provider, provider)),
      })
      .returning({ id: exchangeRates.id });
    if (!written.length) {
      skipped.push(r.symbol + ' (elle girilen kur korundu)');
      continue;
    }
    imported.push({
      currency: r.symbol,
      buy: r.buy,
      sell: r.sell,
      effectiveBuy: r.effectiveBuy,
      effectiveSell: r.effectiveSell,
    });
  }
  return {
    date: day.date,
    announcementNo: day.announcementNo,
    provider: options.provider,
    source,
    sourceUrl,
    imported,
    skipped,
  };
}
