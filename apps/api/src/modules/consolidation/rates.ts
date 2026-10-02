import { sql } from 'drizzle-orm';
import { dec, parseRateList } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import { findRate } from '../settings/rates';
import type { MemberScope } from './access';

export type RateSource = 'identity' | 'manual' | 'stored' | 'average';

/** Dönem içi kayıtlı kurların aritmetik ortalaması (1 birim `from` = ? `to`): doğrudan kur yoksa ters kurların ortalamasının tersi. */
export async function averageStoredRate(tx: Tx, from: string, to: string, periodFrom: string, periodTo: string) {
  const direct = await tx.execute<{ r: string | null }>(sql`
    select avg(buy)::text as r from exchange_rates
     where currency_code = ${from} and quote_code = ${to} and rate_date between ${periodFrom}::date and ${periodTo}::date`);
  if (direct.rows[0]?.r) return dec(direct.rows[0].r);
  const inverse = await tx.execute<{ r: string | null }>(sql`
    select avg(buy)::text as r from exchange_rates
     where currency_code = ${to} and quote_code = ${from} and rate_date between ${periodFrom}::date and ${periodTo}::date`);
  if (inverse.rows[0]?.r) return dec(1).div(dec(inverse.rows[0].r));
  return null;
}

const missing = (scope: MemberScope, from: string, to: string, date: string) =>
  unprocessable(`${scope.name}: ${from}/${to} kuru bulunamadı (${date}). Şirkette kur girin ya da elle kur verin.`, 'FX_RATE_MISSING', {
    companyId: scope.companyId,
    from,
    to,
    date,
  });

/**
 * Şirketin defter para biriminden grup para birimine kur. Öncelik: elle girilen kur → kayıtlı kur. Kullanılan yöntem kullanıcı seçimidir
 * (kapanış tarihi, dönem ortalaması ya da elle kur); hiçbiri bir muhasebe standardı iddiası taşımaz (LEGAL-NOTES §22).
 */
export async function closingRate(tx: Tx, scope: MemberScope, group: string, date: string, manual: string | undefined) {
  const base = scope.baseCurrency;
  if (base === group) return { rate: '1', source: 'identity' as RateSource };
  const m = parseRateList(manual).get(base);
  if (m) return { rate: m, source: 'manual' as RateSource };
  const r = await findRate(tx, base, group, date, base);
  if (!r) throw missing(scope, base, group, date);
  return { rate: r.toFixed(8), source: 'stored' as RateSource };
}

export async function periodRate(
  tx: Tx,
  scope: MemberScope,
  group: string,
  q: { from: string; to: string; closing: { rate: string; source: RateSource }; method: 'closing' | 'average'; manual: string | undefined },
) {
  const base = scope.baseCurrency;
  if (base === group) return { rate: '1', source: 'identity' as RateSource };
  const m = parseRateList(q.manual).get(base);
  if (m) return { rate: m, source: 'manual' as RateSource };
  if (q.method === 'closing') return { rate: q.closing.rate, source: q.closing.source };
  const avg = await averageStoredRate(tx, base, group, q.from, q.to);
  if (!avg) throw missing(scope, base, group, `${q.from} – ${q.to} ortalaması`);
  return { rate: avg.toFixed(8), source: 'average' as RateSource };
}
