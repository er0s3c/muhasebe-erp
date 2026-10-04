import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  aggregateConsolidation,
  buildStatements,
  type ConsolidationCompanyInput,
  type ConsolidationReportQuery,
  type EliminationInput,
} from '@erp/shared';
import { accounts } from '../../db/schema';
import type { AuthCtx } from '../../http/context';
import { trialBalance } from '../ledger/reports';
import { forEachScope, resolveGroupAccess, type ExcludedMember } from './access';
import { listEliminations } from './groups';
import { closingRate, periodRate, type RateSource } from './rates';

export const NOT_VERIFIED_NOTE =
  'Doğrulanmadı: konsolidasyon, kur çevrimi ve eliminasyon yöntemi bir muhasebe standardına dayandırılmamıştır; iç yönetim raporudur, yasal konsolide finansal tablo yerine geçmez (LEGAL-NOTES §22).';

export interface ConsolidatedReport {
  group: { id: string; name: string; reportingCurrency: string };
  period: { from: string; to: string; closingDate: string; plMethod: string; mapLevel: string };
  companies: { id: string; name: string; baseCurrency: string; closingRate: string; closingSource: RateSource; plRate: string; plSource: RateSource }[];
  /** Rapordan düşen şirketler (üyelik/rol/modül/lisans değişmiş); bu durumda `complete` false'tur. */
  excluded: ExcludedMember[];
  complete: boolean;
  rows: ReturnType<typeof aggregateConsolidation>['rows'];
  unmapped: ReturnType<typeof aggregateConsolidation>['rows'];
  translationDiff: Record<string, string>;
  totals: ReturnType<typeof aggregateConsolidation>['totals'];
  statements: ReturnType<typeof buildStatements>;
  eliminations: { id: string; description: string; kind: string; periodFrom: string; periodTo: string; lines: { accountCode: string; debit: string; credit: string }[] }[];
  note: string;
}

export const CONSOLIDATED_COLUMN = 'consolidated';

/** Konsolide mizan + bilanço + gelir tablosu: her şirketin mizanı kendi bağlamında okunur, hesap koduna göre eşlenir, kurla çevrilir. */
export async function consolidatedReport(app: FastifyInstance, ctx: AuthCtx, groupId: string, q: ConsolidationReportQuery): Promise<ConsolidatedReport> {
  const access = await resolveGroupAccess(app, ctx, groupId);
  const closingDate = q.closingDate ?? q.to;
  const group = access.group.reportingCurrency;

  const results = await forEachScope(ctx.tx, access, async (scope) => {
    const tb = await trialBalance(ctx.tx, {
      from: q.from,
      to: q.to,
      currency: 'base',
      baseCurrency: scope.baseCurrency,
      reportingCurrency: scope.reportingCurrency,
      // Yıl sonu kapanış/devir fişleri varsayılan olarak hariç: gelir tablosu kapanışla sıfırlanmaz (includeClosing ile dahil edilir)
      excludeClosing: !q.includeClosing,
    });
    const chart = await ctx.tx.select({ code: accounts.code, name: accounts.name }).from(accounts).orderBy(asc(accounts.code));
    const closing = await closingRate(ctx.tx, scope, group, closingDate, q.closingRates);
    const pl = await periodRate(ctx.tx, scope, group, { from: q.from, to: q.to, closing, method: q.plMethod, manual: q.plRates });
    // Üst gruplar alt hesapları zaten topladığı için yalnızca hareket görebilen (yaprak) hesaplar alınır
    const input: ConsolidationCompanyInput = {
      companyId: scope.companyId,
      name: scope.name,
      baseCurrency: scope.baseCurrency,
      rates: { closing: closing.rate, pl: pl.rate },
      rows: tb.rows.filter((r) => r.isPostable).map((r) => ({ code: r.code, name: r.name, opening: r.opening, debit: r.debit, credit: r.credit })),
      chart,
    };
    return { input, closing, pl };
  });

  // Eliminasyonlar kullanıcıya aittir: şirket bağlamı dışında (kullanıcı bağlamında) okunur
  const elims = await listEliminations(ctx, groupId, { from: q.from, to: q.to });
  const eliminationInputs: EliminationInput[] = elims.map((e) => ({ id: e.id, description: e.description, kind: e.kind, lines: e.lines }));

  const companies = results.map((r) => r.value.input);
  const agg = aggregateConsolidation(companies, eliminationInputs, q.mapLevel);

  const names = new Map(agg.rows.map((r) => [r.code, r.name]));
  const columns = [
    ...companies.map((c) => ({
      id: c.companyId,
      rows: agg.rows.map((r) => ({ code: r.code, name: names.get(r.code)!, net: r.perCompany[c.companyId]!, prior: r.perCompanyPrior[c.companyId]! })),
      translationDiff: agg.translationDiff[c.companyId]!,
    })),
    {
      id: CONSOLIDATED_COLUMN,
      // Konsolide sütun: şirket toplamları + eliminasyon (satır başına), çevrim farkı ayrı
      rows: agg.rows.map((r) => ({ code: r.code, name: names.get(r.code)!, net: r.consolidated, prior: r.consolidatedPrior })),
      translationDiff: agg.totals.translationDiff,
    },
  ];

  return {
    group: { id: access.group.id, name: access.group.name, reportingCurrency: group },
    period: { from: q.from, to: q.to, closingDate, plMethod: q.plMethod, mapLevel: q.mapLevel },
    companies: results.map((r) => ({
      id: r.scope.companyId,
      name: r.scope.name,
      baseCurrency: r.scope.baseCurrency,
      closingRate: r.value.closing.rate,
      closingSource: r.value.closing.source,
      plRate: r.value.pl.rate,
      plSource: r.value.pl.source,
    })),
    excluded: access.excluded,
    complete: access.excluded.length === 0,
    rows: agg.rows,
    unmapped: agg.rows.filter((r) => r.unmapped),
    translationDiff: agg.translationDiff,
    totals: agg.totals,
    statements: buildStatements(columns),
    eliminations: elims.map((e) => ({ id: e.id, description: e.description, kind: e.kind, periodFrom: e.periodFrom, periodTo: e.periodTo, lines: e.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })) })),
    note: NOT_VERIFIED_NOTE,
  };
}
