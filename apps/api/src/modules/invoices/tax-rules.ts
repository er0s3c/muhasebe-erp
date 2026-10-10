import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  createDocumentTaxRuleSchema,
  documentTaxRuleQuerySchema,
  idParam,
  isoDate,
  type DocumentTaxRuleSnapshot,
} from '@erp/shared';
import { documentTaxRules, parties } from '../../db/schema';
import { tenantRoute } from '../../http/context';
import { conflict, notFound, unprocessable } from '../../http/errors';
import type { Tx } from '../../db/client';
import { resolveLegalProfileSnapshot } from '../tenancy/profiles';

export async function loadDocumentTaxRule(
  tx: Tx,
  id: string,
  date: string,
  type: string,
  partyId: string,
  productClass: string | null | undefined,
  transactionType: string | null | undefined,
): Promise<DocumentTaxRuleSnapshot> {
  const [rule] = await tx.select().from(documentTaxRules).where(eq(documentTaxRules.id, id)).for('share');
  if (!rule) throw notFound('Vergi kuralı');
  if (!rule.enabled || !rule.verifiedAt || !rule.verifiedBy)
    throw unprocessable(
      'Vergi kuralı etkin ve mali incelemeden geçmiş olmalı',
      'TAX_RULE_NOT_VERIFIED',
    );
  const legal = await resolveLegalProfileSnapshot(tx, rule.companyId, date);
  if (
    legal?.jurisdiction !== rule.jurisdiction ||
    date < rule.validFrom ||
    (rule.validTo && date > rule.validTo)
  )
    throw unprocessable(
      'Vergi kuralı şirket ülkesi veya belge tarihinde geçerli değil',
      'TAX_RULE_DATE_COUNTRY',
    );
  const [party] = await tx
    .select({ taxStatus: parties.taxStatus })
    .from(parties)
    .where(eq(parties.id, partyId));
  if (
    !party ||
    party.taxStatus !== rule.partyTaxStatus ||
    type !== rule.invoiceType ||
    productClass !== rule.productClass ||
    transactionType !== rule.transactionType
  )
    throw unprocessable(
      'Vergi kuralı tarafın vergi durumu, ürün/hizmet sınıfı veya işlem türüyle uyuşmuyor',
      'TAX_RULE_CLASSIFICATION',
    );
  return {
    ...createDocumentTaxRuleSchema.parse(rule),
    id: rule.id,
    verifiedAt: rule.verifiedAt.toISOString(),
    verifiedBy: rule.verifiedBy,
  };
}

export const documentTaxRuleRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/document-tax-rules',
    tenantRoute(
      app,
      { module: 'core.invoices', permission: 'invoices.read' },
      async ({ tx, req, company }) => {
        const q = documentTaxRuleQuerySchema.parse(req.query);
        const [party] = q.partyId
          ? await tx
              .select({ taxStatus: parties.taxStatus })
              .from(parties)
              .where(eq(parties.id, q.partyId))
          : [];
        if (q.partyId && !party) throw notFound('Cari');
        const rules = await tx
          .select()
          .from(documentTaxRules)
          .where(
            and(
              company.jurisdiction
                ? eq(documentTaxRules.jurisdiction, company.jurisdiction)
                : sql`false`,
              q.date
                ? sql`${documentTaxRules.validFrom}<=${q.date}::date and (${documentTaxRules.validTo} is null or ${documentTaxRules.validTo}>=${q.date}::date)`
                : undefined,
              q.invoiceType ? eq(documentTaxRules.invoiceType, q.invoiceType) : undefined,
              party ? eq(documentTaxRules.partyTaxStatus, party.taxStatus) : undefined,
            ),
          )
          .orderBy(asc(documentTaxRules.code), asc(documentTaxRules.validFrom));
        return { rules };
      },
    ),
  );
  app.post(
    '/api/document-tax-rules',
    tenantRoute(
      app,
      { module: 'core.invoices', permission: 'settings.manage' },
      async ({ tx, req, company, reply }) => {
        const input = createDocumentTaxRuleSchema.parse(req.body);
        if (input.jurisdiction !== company.jurisdiction)
          throw unprocessable('Kural şirketin ülkesine ait olmalı', 'TAX_RULE_COUNTRY');
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`document-tax-rule:${company.id}:${input.code}`},0))`,
        );
        const duplicate = await tx
          .select({ id: documentTaxRules.id })
          .from(documentTaxRules)
          .where(
            and(
              eq(documentTaxRules.code, input.code),
              sql`${documentTaxRules.validFrom}<=coalesce(${input.validTo}::date,'infinity'::date) and coalesce(${documentTaxRules.validTo},'infinity'::date)>=${input.validFrom}::date`,
            ),
          );
        if (duplicate.length)
          throw conflict('Aynı kodun tarih aralıkları çakışamaz', 'TAX_RULE_OVERLAP');
        const [rule] = await tx
          .insert(documentTaxRules)
          .values({ ...input, companyId: company.id })
          .returning();
        reply.code(201);
        return { rule };
      },
    ),
  );
  app.post(
    '/api/document-tax-rules/:id/verify',
    tenantRoute(
      app,
      { module: 'core.invoices', permission: 'settings.manage' },
      async ({ tx, req, user }) => {
        const { id } = idParam.parse(req.params);
        z.object({ reviewed: z.literal(true) }).parse(req.body);
        const [rule] = await tx
          .select()
          .from(documentTaxRules)
          .where(eq(documentTaxRules.id, id))
          .for('update');
        if (!rule) throw notFound('Vergi kuralı');
        if (rule.verifiedAt)
          throw conflict('Kural daha önce incelenmiş', 'TAX_RULE_ALREADY_VERIFIED');
        const [updated] = await tx
          .update(documentTaxRules)
          .set({ verifiedAt: new Date(), verifiedBy: user.id })
          .where(eq(documentTaxRules.id, id))
          .returning();
        return { rule: updated };
      },
    ),
  );
  app.patch(
    '/api/document-tax-rules/:id',
    tenantRoute(
      app,
      { module: 'core.invoices', permission: 'settings.manage' },
      async ({ tx, req }) => {
        const { id } = idParam.parse(req.params);
        const input = z
          .object({ enabled: z.boolean().optional(), validTo: isoDate.optional() })
          .strict()
          .refine(
            (value) => value.enabled !== undefined || value.validTo !== undefined,
            'Değişiklik gerekli',
          )
          .parse(req.body);
        const [rule] = await tx
          .update(documentTaxRules)
          .set(input)
          .where(eq(documentTaxRules.id, id))
          .returning();
        if (!rule) throw notFound('Vergi kuralı');
        return { rule };
      },
    ),
  );
};
