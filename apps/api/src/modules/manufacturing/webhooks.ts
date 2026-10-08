import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { dec, uuid, resolveEnabledModules, type Role, type Sector } from '@erp/shared';
import { withContext, setContext } from '../../db/client';
import { forbidden, AppError } from '../../http/errors';
import { assertLicensed } from '../../licensing/gate';
import { loadMemberAccess, requirePermission, isModuleDenied } from '../access/effective';
import { decryptField } from '../hr/crypto';
import { all, one, type Row } from '../leather/common';
import { getRecord } from './service';
import {
  enqueueIntegrationEvent,
  externalOrderSchema,
  verifyIntegrationSignature,
} from './integrations';

export function normalizeShopifyWebhook(data: Row, mapping: Row) {
  const lines = (data.line_items ?? [])
    .filter((l: Row) => (l.current_quantity ?? l.quantity) > 0)
    .map((l: Row) => {
      const quantity = dec(l.current_quantity ?? l.quantity),
        discount = (l.discount_allocations ?? []).reduce(
          (s: ReturnType<typeof dec>, d: Row) => s.plus(d.amount),
          dec(0),
        );
      return {
        sku: l.sku,
        quantity: quantity.toFixed(4),
        unitPrice: dec(l.price).minus(discount.div(l.quantity)).toFixed(4),
        vatRate: (l.tax_lines ?? [])
          .reduce((s: ReturnType<typeof dec>, t: Row) => s.plus(t.rate), dec(0))
          .times(100)
          .toFixed(4),
      };
    });
  const shipping = dec(
    data.current_shipping_price_set?.shop_money?.amount ??
      data.total_shipping_price_set?.shop_money?.amount ??
      0,
  );
  if (shipping.gt(0)) {
    if (!mapping.shippingSku)
      throw new AppError(422, 'SHIPPING_MAPPING_REQUIRED', 'Kargo hizmet SKU eşlemesi gerekli');
    lines.push({
      sku: mapping.shippingSku,
      quantity: '1.0000',
      unitPrice: shipping.toFixed(4),
      vatRate: (data.shipping_lines?.[0]?.tax_lines ?? [])
        .reduce((s: ReturnType<typeof dec>, t: Row) => s.plus(t.rate), dec(0))
        .times(100)
        .toFixed(4),
    });
  }
  return externalOrderSchema.parse({
    externalId: data.admin_graphql_api_id ?? String(data.id),
    externalVersion: data.updated_at ?? data.created_at,
    partyId: mapping.webhookPartyId,
    warehouseId: mapping.webhookWarehouseId,
    date: String(data.created_at).slice(0, 10),
    currency: data.currency,
    vatIncluded: data.taxes_included ?? false,
    paymentStatus: data.financial_status,
    lines,
  });
}

/** Encapsulated raw-body parser; signature is verified before parsing JSON or enqueueing. */
export const manufacturingWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.post('/api/integrations/webhooks/:companyId/:connectionId/shopify', async (req, reply) => {
    const license = await assertLicensed(app.license, req);
    const p = z.object({ companyId: uuid, connectionId: uuid }).parse(req.params);
    const limit = await app.limiter.consume('webhook:' + req.ip, 60, 60000);
    if (!limit.ok) {
      reply.header('retry-after', String(limit.retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', 'Webhook istek sınırı aşıldı');
    }
    return withContext(app.db, { companyId: p.companyId, ip: req.ip }, async (tx) => {
      const connection = await getRecord(tx, p.connectionId, 'connection');
      const c = connection.config;
      if (c.provider !== 'shopify' || !c.webhookSecret || !c.orgId || !Buffer.isBuffer(req.body))
        throw forbidden('Webhook doğrulanamadı');
      const signature = req.headers['x-shopify-hmac-sha256'],
        shop = req.headers['x-shopify-shop-domain'],
        topic = req.headers['x-shopify-topic'];
      if (
        typeof signature !== 'string' ||
        shop !== c.shop ||
        !verifyIntegrationSignature(
          req.body,
          signature,
          decryptField(c.webhookSecret, 'integrations:' + app.config.JWT_SECRET),
        )
      )
        throw forbidden('Webhook doğrulanamadı');
      if (!['orders/create', 'orders/updated'].includes(String(topic)))
        throw new AppError(422, 'WEBHOOK_TOPIC_UNSUPPORTED', 'Sipariş webhook konusu gerekli');
      await setContext(tx, {
        companyId: p.companyId,
        userId: connection.created_by,
        orgId: c.orgId,
        ip: req.ip,
      });
      const company = await one(
        tx,
        sql`select sector,base_currency,reporting_currency,tax_number from companies where id=${p.companyId}::uuid`,
      );
      if (company.tax_number === 'DEMO-MFG-V1')
        throw forbidden('Demo şirketi dış webhook kabul etmez');
      if (license && !app.license.sectorAllowed(license, company.sector))
        throw forbidden('Lisans sektörü kapsamıyor');
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('erp-maintenance-write'))`);
      if ((await all(tx, sql`select id from app_updates where status='applying'`)).length)
        throw new AppError(503, 'UPDATE_MAINTENANCE', 'Güncelleme sürüyor');
      const member = await one(
        tx,
        sql`select m.role from memberships m join users u on u.id=m.user_id where m.company_id=${p.companyId}::uuid and m.user_id=${connection.created_by}::uuid and u.is_active`,
      );
      const enabled = resolveEnabledModules(
        company.sector as Sector,
        (await all(tx, sql`select module,enabled from company_modules`)).map((r) => ({
          module: r.module as string,
          enabled: r.enabled as boolean,
        })),
      );
      const access = await loadMemberAccess(
        tx,
        p.companyId,
        connection.created_by,
        member.role as Role,
      );
      if (!enabled.has('core.integrations') || isModuleDenied(access, 'core.integrations'))
        throw forbidden('Entegrasyon kapalı');
      requirePermission(access, 'core.integrations.manage');
      let data: Row;
      try {
        data = JSON.parse(req.body.toString('utf8')) as Row;
      } catch {
        throw new AppError(400, 'INVALID_JSON', 'Webhook JSON geçersiz');
      }
      const record = await enqueueIntegrationEvent(
        tx,
        {
          companyId: p.companyId,
          userId: connection.created_by,
          baseCurrency: company.base_currency,
          reportingCurrency: company.reporting_currency,
          allowNegativeStock: false,
        },
        p.connectionId,
        normalizeShopifyWebhook(data, c),
      );
      reply.code(202);
      return { id: record.id, status: record.status };
    });
  });
};
