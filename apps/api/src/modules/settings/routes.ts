import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createCustomCodeSchema,
  createTaxRateSchema,
  currencyCode,
  isoDate,
  todayIso,
  upsertRateSchema,
  uuid,
  verifyTaxRateSchema,
  CUSTOM_CODE_SCOPES,
  dec,
  toDbRate,
  fxProviderSchema,
  fxPurposeSchema,
  fxRateTypeSchema,
} from '@erp/shared';
import { currencies, customCodes, exchangeRates, taxRates } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { badRequest, notFound } from '../../http/errors';
import { closePeriod, generatePeriods, listPeriods, reopenPeriod } from './periods';
import { lookupRate } from './rates';
import { companyFxProvider, requireCompanyFxProvider, FX_PROVIDER_REGISTRY } from './fx-providers';
import { importPublishedRates } from './fx-import';

const idParam = z.object({ id: uuid });

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const settings = (permission?: 'settings.read' | 'settings.manage' | 'rates.manage') =>
    ({ module: 'core.settings', permission }) as const;

  // ---- Para birimleri ---------------------------------------------------
  app.get(
    '/api/currencies',
    tenantRoute(app, settings('settings.read'), async ({ tx }) => {
      const rows = await tx.select().from(currencies).orderBy(asc(currencies.code));
      return { currencies: rows };
    }),
  );

  // ---- Döviz kurları ----------------------------------------------------
  app.get(
    '/api/exchange-rates',
    tenantRoute(app, settings('settings.read'), async ({ tx, req, company }) => {
      const q = z
        .object({
          currency: currencyCode.optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      const rows = await tx
        .select()
        .from(exchangeRates)
        .where(
          and(
            q.currency ? eq(exchangeRates.currencyCode, q.currency) : undefined,
            q.from ? gte(exchangeRates.rateDate, q.from) : undefined,
            q.to ? lte(exchangeRates.rateDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(exchangeRates.rateDate), asc(exchangeRates.currencyCode))
        .limit(q.limit);
      const provider = companyFxProvider(company);
      return {
        rates: rows,
        provider,
        providerLabel: provider ? FX_PROVIDER_REGISTRY[provider].label : null,
        sourceUrl: provider ? FX_PROVIDER_REGISTRY[provider].url() : null,
        jurisdiction: company.jurisdiction,
        timeZone: company.timeZone,
      };
    }),
  );

  app.put(
    '/api/exchange-rates',
    tenantRoute(app, settings('rates.manage'), async ({ tx, req, user, company }) => {
      const input = upsertRateSchema.parse(req.body);
      if (input.currencyCode === input.quoteCode) {
        throw badRequest('Kur için iki farklı para birimi seçin', 'RATE_SAME_CURRENCY');
      }
      if (
        [input.buy, input.sell, input.effectiveBuy, input.effectiveSell].some(
          (v) => v && dec(v).lte(0),
        )
      ) {
        throw badRequest('Kur sıfırdan büyük olmalı', 'RATE_NOT_POSITIVE');
      }
      const buy = toDbRate(input.buy);
      const sell = toDbRate(input.sell ?? input.buy);
      const effectiveBuy = input.effectiveBuy ? toDbRate(input.effectiveBuy) : null;
      const effectiveSell = input.effectiveSell ? toDbRate(input.effectiveSell) : null;
      const [row] = await tx
        .insert(exchangeRates)
        .values({
          companyId: company.id,
          rateDate: input.rateDate,
          currencyCode: input.currencyCode,
          quoteCode: input.quoteCode,
          buy,
          sell,
          source: input.source,
          provider: 'manual',
          effectiveBuy,
          effectiveSell,
          sourceUrl: null,
          fetchedAt: null,
          createdBy: user.id,
        })
        .onConflictDoUpdate({
          target: [
            exchangeRates.companyId,
            exchangeRates.rateDate,
            exchangeRates.currencyCode,
            exchangeRates.quoteCode,
          ],
          set: {
            buy,
            sell,
            effectiveBuy,
            effectiveSell,
            provider: 'manual',
            sourceUrl: null,
            fetchedAt: null,
            source: input.source,
            createdBy: user.id,
          },
        })
        .returning();
      return { rate: row };
    }),
  );

  app.delete(
    '/api/exchange-rates/:id',
    tenantRoute(app, settings('rates.manage'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const deleted = await tx
        .delete(exchangeRates)
        .where(eq(exchangeRates.id, id))
        .returning({ id: exchangeRates.id });
      if (deleted.length === 0) throw notFound('Kur');
      return { ok: true };
    }),
  );

  /** Belirli tarihte from->to kuru (tolerans süresi içindeki son kayıt). */
  app.get(
    '/api/exchange-rates/lookup',
    tenantRoute(app, settings('settings.read'), async ({ tx, req, company }) => {
      const q = z
        .object({
          from: currencyCode,
          to: currencyCode,
          date: isoDate.default(todayIso()),
          purpose: fxPurposeSchema.optional(),
          rateType: fxRateTypeSchema.optional(),
        })
        .parse(req.query);
      return lookupRate(tx, q.from, q.to, q.date, company.baseCurrency, {
        ...q,
        legacyInverse: !q.purpose && !q.rateType,
      });
    }),
  );

  /**
   * Merkez Bankası kurlarını içe aktarır: resmî adresten (source: 'kktcmb', isteğe bağlı tarih) ya da
   * yüklenen XML dosyasından (source: 'xml'). Aynı gün için tekrar çalıştırmak güvenlidir.
   */
  app.post(
    '/api/exchange-rates/import',
    tenantRoute(
      app,
      { ...settings('rates.manage'), limit: { name: 'rate-import', max: 10, windowMs: 60_000 } },
      async ({ tx, req, user, company }) => {
        const body = z
          .discriminatedUnion('source', [
            z.object({ source: z.literal('kktcmb'), date: isoDate.optional() }),
            z.object({ source: z.literal('tcmb'), date: isoDate.optional() }),
            z.object({ source: z.literal('company'), date: isoDate.optional() }),
            z.object({
              source: z.literal('xml'),
              provider: fxProviderSchema.optional(),
              xml: z.string().min(50).max(500_000),
            }),
          ])
          .parse(req.body);
        const selected = companyFxProvider(company);
        const provider =
          body.source === 'company'
            ? requireCompanyFxProvider(company)
            : body.source === 'xml'
              ? (body.provider ??
                selected ??
                (body.xml.includes('<Tarih_Date') ? 'tcmb' : 'kktcmb'))
              : body.source;
        if (selected && selected !== provider)
          throw badRequest(
            'Kur kaynağı şirketin çalışma ülkesiyle uyuşmuyor.',
            'FX_PROVIDER_MISMATCH',
          );
        const definition = FX_PROVIDER_REGISTRY[provider];
        const xml = body.source === 'xml' ? body.xml : await app.fxRateFetcher(provider, body.date);
        const day = definition.parse(xml);
        if (body.source !== 'xml' && body.date && day.date !== body.date)
          throw badRequest(
            'İndirilen XML tarihi istenen kur tarihiyle uyuşmuyor.',
            'FX_RATE_DATE_MISMATCH',
          );
        return importPublishedRates(tx, { companyId: company.id, userId: user.id }, day, {
          provider,
          uploaded: body.source === 'xml',
          sourceUrl: definition.url(day.date),
        });
      },
    ),
  );

  // ---- KDV / vergi oranları --------------------------------------------
  app.get(
    '/api/tax-rates',
    tenantRoute(app, settings('settings.read'), async ({ tx }) => {
      const rows = await tx
        .select()
        .from(taxRates)
        .orderBy(asc(taxRates.code), desc(taxRates.validFrom));
      return { taxRates: rows };
    }),
  );

  app.post(
    '/api/tax-rates',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req, reply, company }) => {
      const input = createTaxRateSchema.parse(req.body);
      const [row] = await tx
        .insert(taxRates)
        .values({
          companyId: company.id,
          code: input.code,
          name: input.name,
          jurisdiction: company.jurisdiction,
          rate: input.rate,
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          sourceNote: input.sourceNote ?? null,
          sourceUrl: input.sourceUrl ?? null,
          rulePackVersion: input.rulePackVersion ?? null,
          verifiedBy: null,
          verifiedAt: null,
        })
        .returning();
      void reply.code(201);
      return { taxRate: row };
    }),
  );

  app.post(
    '/api/tax-rates/:id/verify',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const input = verifyTaxRateSchema.parse(req.body);
      const [row] = await tx
        .update(taxRates)
        .set({
          verifiedBy: input.verifiedBy,
          verifiedAt: new Date(),
          ...(input.sourceNote ? { sourceNote: input.sourceNote } : {}),
        })
        .where(eq(taxRates.id, id))
        .returning();
      if (!row) throw notFound('Vergi oranı');
      return { taxRate: row };
    }),
  );

  app.delete(
    '/api/tax-rates/:id',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const deleted = await tx
        .delete(taxRates)
        .where(eq(taxRates.id, id))
        .returning({ id: taxRates.id });
      if (deleted.length === 0) throw notFound('Vergi oranı');
      return { ok: true };
    }),
  );

  // ---- Mali dönemler ----------------------------------------------------
  app.get(
    '/api/periods',
    tenantRoute(app, settings('settings.read'), async ({ tx, req }) => {
      const q = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
      return { periods: await listPeriods(tx, q.year) };
    }),
  );

  app.get(
    '/api/periods/years',
    tenantRoute(app, settings('settings.read'), async ({ tx }) => {
      const rows = await tx.execute<{ year: number }>(
        sql`select distinct year from fiscal_periods order by year desc`,
      );
      return { years: rows.rows.map((r) => r.year) };
    }),
  );

  app.post(
    '/api/periods/generate',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req, company }) => {
      const q = z.object({ year: z.number().int().min(2000).max(2100) }).parse(req.body);
      await generatePeriods(tx, company.id, q.year);
      return { periods: await listPeriods(tx, q.year) };
    }),
  );

  app.post(
    '/api/periods/:id/close',
    tenantRoute(
      app,
      { module: 'core.ledger', permission: 'ledger.close_period' },
      async ({ tx, req, user }) => {
        const { id } = idParam.parse(req.params);
        return { period: await closePeriod(tx, id, user.id) };
      },
    ),
  );

  app.post(
    '/api/periods/:id/reopen',
    tenantRoute(
      app,
      { module: 'core.ledger', permission: 'ledger.close_period' },
      async ({ tx, req }) => {
        const { id } = idParam.parse(req.params);
        return { period: await reopenPeriod(tx, id) };
      },
    ),
  );

  // ---- Özel kodlar ------------------------------------------------------
  app.get(
    '/api/custom-codes',
    tenantRoute(app, settings('settings.read'), async ({ tx, req }) => {
      const q = z.object({ scope: z.enum(CUSTOM_CODE_SCOPES).optional() }).parse(req.query);
      const rows = await tx
        .select()
        .from(customCodes)
        .where(q.scope ? eq(customCodes.scope, q.scope) : undefined)
        .orderBy(asc(customCodes.scope), asc(customCodes.code));
      return { customCodes: rows };
    }),
  );

  app.post(
    '/api/custom-codes',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req, reply, company }) => {
      const input = createCustomCodeSchema.parse(req.body);
      const [row] = await tx
        .insert(customCodes)
        .values({ companyId: company.id, ...input })
        .returning();
      void reply.code(201);
      return { customCode: row };
    }),
  );

  app.delete(
    '/api/custom-codes/:id',
    tenantRoute(app, settings('settings.manage'), async ({ tx, req }) => {
      const { id } = idParam.parse(req.params);
      const deleted = await tx
        .delete(customCodes)
        .where(eq(customCodes.id, id))
        .returning({ id: customCodes.id });
      if (deleted.length === 0) throw notFound('Özel kod');
      return { ok: true };
    }),
  );
};
