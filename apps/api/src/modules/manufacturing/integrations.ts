import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  integrationConnectionSchema,
  createSalesDocSchema,
  uuid,
  positiveQuantity,
  unitCostString,
  currencyCode,
  isoDate,
  dec,
  percentString,
} from '@erp/shared';
import { tenantRoute } from '../../http/context';
import { forbidden, AppError } from '../../http/errors';
import { encryptField, decryptField } from '../hr/crypto';
import {
  all,
  one,
  fail,
  newId,
  lockLeatherCosts,
  type Row,
  type LeatherCtx,
} from '../leather/common';
import { createSalesDoc, transitionSalesDoc } from '../sales/orders';
import { createRecord, getRecord, listRecords, recordShape, updateRecord } from './service';
import { manufacturingCtx } from './routes';
import type { Tx } from '../../db/client';
import { resolveVat } from '../invoices/service';
import { manufacturingWebhookRoutes } from './webhooks';
import { manufacturingChannelRoutes } from './channels';

export const externalOrderSchema = z.object({
  externalId: z.string().min(1).max(160),
  externalVersion: z.string().max(100).default(''),
  partyId: uuid,
  warehouseId: uuid,
  date: isoDate,
  currency: currencyCode,
  vatIncluded: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(80),
        quantity: positiveQuantity,
        unitPrice: unitCostString,
        vatRate: percentString.optional(),
      }),
    )
    .min(1)
    .max(300),
  paymentStatus: z.string().max(80).default('pending'),
});
const collection = (value: unknown, key: string): Row[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value as Row[];
  const v = (value as Row)[key];
  return v ? (Array.isArray(v) ? v : [v]) : [];
};
/** Price field and unit/line basis must be chosen from the merchant's service contract. */
export function normalizeTicimaxOrder(
  order: Row,
  mapping: {
    partyId: string;
    warehouseId: string;
    priceField: string;
    priceBasis: 'unit' | 'line';
  },
) {
  const lines = collection(order.Urunler, 'WebSiparisUrun');
  return externalOrderSchema.parse({
    externalId: String(order.ID),
    partyId: mapping.partyId,
    warehouseId: mapping.warehouseId,
    date: String(order.SiparisTarihi).slice(0, 10),
    currency: order.ParaBirimi === 'TL' ? 'TRY' : order.ParaBirimi,
    paymentStatus: String(order.OdemeDurumu ?? 'pending'),
    lines: lines.map((l) => ({
      sku: String(l.StokKodu ?? ''),
      quantity: String(l.Adet),
      unitPrice:
        mapping.priceBasis === 'line'
          ? dec(String(l[mapping.priceField])).div(String(l.Adet)).toFixed(4)
          : String(l[mapping.priceField]),
    })),
  });
}
const safeConnection = (r: Row) => {
  const { credentials, webhookSecret, ...publicFields } = r.config ?? r;
  void credentials;
  void webhookSecret;
  return { ...publicFields, id: r.id, status: r.status };
};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Signature is checked against the exact bytes supplied by the provider. */
export function verifyIntegrationSignature(raw: Buffer, signature: string, secret: string) {
  const expected = createHmac('sha256', secret).update(raw).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function validateIntegrationEndpoint(endpoint: string) {
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    throw fail('Servis adresi HTTPS olmalı');
  const addresses = await lookup(u.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((a) =>
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80|::ffff:)/i.test(
        a.address,
      ),
    )
  )
    throw fail('Servis adresi genel internet adresi olmalı');
  return u;
}
export async function shopifyGraphql(
  shop: string,
  version: string,
  token: string,
  query: string,
  variables: unknown,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !/^\d{4}-(01|04|07|10)$/.test(version))
    throw fail('Shopify mağaza/sürüm bilgisi uygun değil');
  const response = await fetcher(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error('Shopify HTTP ' + response.status);
  const body = (await response.json()) as Row;
  if (body.errors?.length) throw new Error('Shopify sorgusu reddedildi');
  return body.data as Row;
}
export async function ticimaxSoap(
  endpoint: string,
  token: string,
  method: 'SelectSiparis' | 'StokAdediGuncelle' | 'SaveSiparisKargoPaketKargoTakipNo',
  params: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
) {
  const builder = new XMLBuilder({ ignoreAttributes: false });
  const inner = builder.build({ 'tem:UyeKodu': token, ...params });
  const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/" xmlns:a="http://schemas.datacontract.org/2004/07/"><soapenv:Body><tem:${method}>${inner}</tem:${method}></soapenv:Body></soapenv:Envelope>`;
  const service = method === 'StokAdediGuncelle' ? 'IUrunServis' : 'ISiparisServis';
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      SOAPAction: `http://tempuri.org/${service}/${method}`,
    },
    body: envelope,
  });
  if (!response.ok) throw new Error('Ticimax HTTP ' + response.status);
  const xml = await response.text();
  if (xml.length > 5_000_000) throw new Error('Ticimax yanıt sınırı aşıldı');
  const parsed = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: true,
    processEntities: false,
  }).parse(xml) as Row;
  if (parsed.Envelope?.Body?.Fault) throw new Error('Ticimax servis hatası');
  return parsed.Envelope?.Body?.[method + 'Response']?.[method + 'Result'];
}
export async function enqueueIntegrationEvent(
  tx: Tx,
  ctx: LeatherCtx,
  connectionId: string,
  input: z.infer<typeof externalOrderSchema>,
) {
  await lockLeatherCosts(tx, ctx.companyId);
  await getRecord(tx, connectionId, 'connection');
  const code = digest({ connectionId, externalId: input.externalId });
  const prior = await all(
    tx,
    sql`select * from manufacturing_records where kind='integration_event' and code=${code}`,
  );
  if (prior.length) {
    if (prior[0]!.config.payloadHash !== digest(input)) {
      if (
        input.externalVersion &&
        input.externalVersion !== prior[0]!.config.payload.externalVersion
      ) {
        const updateCode = digest({
          connectionId,
          externalId: input.externalId,
          version: input.externalVersion,
        });
        const update = await all(
          tx,
          sql`select * from manufacturing_records where kind='integration_event' and code=${updateCode}`,
        );
        if (update[0]) {
          if (update[0].config.payloadHash !== digest(input))
            throw fail('Dış sürüm farklı içerikle tekrar geldi');
          return recordShape(update[0]);
        }
        return createRecord(
          tx,
          ctx,
          'integration_event',
          {
            code: updateCode,
            connectionId,
            payload: input,
            payloadHash: digest(input),
            attempts: 0,
            previousEventId: prior[0]!.id,
            error: 'Sipariş güncellendi; mevcut mali kayıtlarla karşılaştırılarak onaylanmalı',
          },
          'needs_review',
        );
      }
      throw fail(
        'Kaynak sipariş kimliği farklı içerikle tekrar geldi',
        'INTEGRATION_EVENT_CONFLICT',
      );
    }
    return recordShape(prior[0]!);
  }
  await one(
    tx,
    sql`select id from parties where id=${input.partyId}::uuid and kind in ('customer','both')`,
    'Müşteri eşlemesi',
  );
  await one(
    tx,
    sql`select id from warehouses where id=${input.warehouseId}::uuid`,
    'Depo eşlemesi',
  );
  return createRecord(
    tx,
    ctx,
    'integration_event',
    { code, connectionId, payload: input, payloadHash: digest(input), attempts: 0 },
    'queued',
  );
}
export async function processIntegrationEvent(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  manual?: { reason: string },
) {
  await lockLeatherCosts(tx, ctx.companyId);
  const event = await getRecord(tx, id, 'integration_event', true);
  if (event.status === 'processed') return recordShape(event);
  if (event.status === 'needs_review')
    throw fail('Dış sipariş güncellemesi manuel karşılaştırma gerektiriyor');
  if (
    !manual &&
    (event.status === 'dead_letter' ||
      (event.config.retryAfter && Date.parse(event.config.retryAfter) > Date.now()))
  )
    return { ...recordShape(event), retryEligible: false };
  if (manual) {
    event.config.manualRetryReason = manual.reason;
    event.config.manualRetryBy = ctx.userId;
    event.config.manualRetryAt = new Date().toISOString();
    event.config.attempts = 0;
  }
  if (!event.config.payload) throw fail('Sipariş yükü bulunamadı');
  try {
    const salesOrderId = await tx.transaction(async (nested) => {
      const payload = externalOrderSchema.parse(event.config.payload);
      const lines = [];
      for (const line of payload.lines) {
        const item = await one(
          nested,
          sql`select i.id,i.name,i.vat_code,m.warehouse_id as "mappedWarehouseId" from items i left join manufacturing_records m on m.kind='channel_mapping' and m.status='active' and m.item_id=i.id and m.company_id=i.company_id and m.config->>'connectionId'=${event.config.connectionId} and m.config->>'channelSku'=${line.sku} where (m.id is not null or i.code=${line.sku}) and i.is_active order by (m.id is not null) desc limit 1`,
          'SKU eşlemesi: ' + line.sku,
        );
        if (item.mappedWarehouseId && item.mappedWarehouseId !== payload.warehouseId)
          throw fail('Kanal deposu SKU konum eşlemesiyle uyuşmuyor: ' + line.sku);
        if (line.vatRate !== undefined) {
          const rates = await resolveVat(
            nested,
            item.vat_code ? [item.vat_code] : [],
            payload.date,
          );
          if (!dec(rates.get(item.vat_code) ?? 0).eq(line.vatRate))
            throw fail('Kanal vergi oranı SKU vergi eşlemesiyle uyuşmuyor: ' + line.sku);
        }
        lines.push({
          itemId: item.id,
          description: item.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        });
      }
      const id = await createSalesDoc(
        nested,
        ctx,
        createSalesDocSchema.parse({
          kind: 'order',
          partyId: payload.partyId,
          warehouseId: payload.warehouseId,
          docDate: payload.date,
          currency: payload.currency,
          vatIncluded: payload.vatIncluded,
          lines,
          notes: 'Dış kanal ' + payload.externalId,
        }),
      );
      await transitionSalesDoc(nested, ctx, id, 'confirmed');
      return id;
    });
    return updateRecord(tx, id, 'processed', {
      ...event.config,
      salesOrderId,
      attempts: event.config.attempts + 1,
      error: null,
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    return updateRecord(tx, id, Number(event.config.attempts) + 1 >= 5 ? 'dead_letter' : 'failed', {
      ...event.config,
      attempts: event.config.attempts + 1,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Aktarım hatası',
      retryAfter: new Date(
        Date.now() + Math.min(3600000, 30000 * 2 ** event.config.attempts),
      ).toISOString(),
    });
  }
}

export const manufacturingIntegrationRoutes: FastifyPluginAsync = async (app) => {
  await app.register(manufacturingWebhookRoutes);
  await app.register(manufacturingChannelRoutes);
  const read = { module: 'core.integrations', permission: 'core.integrations.read' } as const,
    write = { module: 'core.integrations', permission: 'core.integrations.manage' } as const;
  const id = (p: unknown) => z.object({ id: uuid }).parse(p).id;
  app.get(
    '/api/integrations/lookups',
    tenantRoute(app, read, async (c) => ({
      parties: await all(
        c.tx,
        sql`select id,name from parties where is_active and kind in ('customer','both')`,
      ),
      warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
    })),
  );
  app.get(
    '/api/integrations/connections',
    tenantRoute(app, read, async (c) => ({
      records: (
        await all(c.tx, sql`select * from manufacturing_records where kind='connection'`)
      ).map(safeConnection),
    })),
  );
  app.post(
    '/api/integrations/connections',
    tenantRoute(app, write, async (c) => {
      const input = integrationConnectionSchema.parse(c.req.body);
      const { token, webhookSecret, ...publicConfig } = input;
      if (input.webhookPartyId)
        await one(
          c.tx,
          sql`select id from parties where id=${input.webhookPartyId}::uuid and kind in ('customer','both')`,
        );
      if (input.webhookWarehouseId)
        await one(
          c.tx,
          sql`select id from warehouses where id=${input.webhookWarehouseId}::uuid and is_active`,
        );
      if (input.endpoint) await validateIntegrationEndpoint(input.endpoint);
      const record = await createRecord(
        c.tx,
        manufacturingCtx(c),
        'connection',
        {
          ...publicConfig,
          orgId: c.user.orgId,
          webhookSecret: webhookSecret
            ? encryptField(webhookSecret, 'integrations:' + app.config.JWT_SECRET)
            : undefined,
          credentials: token
            ? encryptField(token, 'integrations:' + app.config.JWT_SECRET)
            : undefined,
        },
        token && ['shopify', 'ticimax'].includes(input.provider) ? 'configured' : 'disconnected',
      );
      return { record: safeConnection({ id: record.id, status: record.status, config: record }) };
    }),
  );
  app.put(
    '/api/integrations/connections/:id',
    tenantRoute(app, write, async (c) => {
      const r = await getRecord(c.tx, id(c.req.params), 'connection', true),
        input = integrationConnectionSchema.parse(c.req.body);
      if (input.provider !== r.config.provider)
        throw fail('Sağlayıcı değiştirmek için yeni bağlantı açın');
      if (input.endpoint) await validateIntegrationEndpoint(input.endpoint);
      const { token, webhookSecret, ...publicConfig } = input;
      if (input.webhookPartyId)
        await one(
          c.tx,
          sql`select id from parties where id=${input.webhookPartyId}::uuid and kind in ('customer','both')`,
        );
      if (input.webhookWarehouseId)
        await one(
          c.tx,
          sql`select id from warehouses where id=${input.webhookWarehouseId}::uuid and is_active`,
        );
      const config = {
        ...r.config,
        ...publicConfig,
        orgId: c.user.orgId,
        webhookSecret: webhookSecret
          ? encryptField(webhookSecret, 'integrations:' + app.config.JWT_SECRET)
          : r.config.webhookSecret,
        credentials: token
          ? encryptField(token, 'integrations:' + app.config.JWT_SECRET)
          : r.config.credentials,
      };
      const updated = await updateRecord(
        c.tx,
        r.id,
        config.credentials && ['shopify', 'ticimax'].includes(config.provider)
          ? 'configured'
          : 'disconnected',
        config,
      );
      return {
        record: safeConnection({ id: updated.id, status: updated.status, config: updated }),
      };
    }),
  );
  app.get(
    '/api/integrations/events',
    tenantRoute(app, read, async (c) => ({
      records: (await listRecords(c.tx, 'integration_event')).map((r) => ({
        id: r.id,
        code: r.payload?.externalId ?? r.code,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
        salesOrderId: r.salesOrderId,
        retryAfter: r.retryAfter,
      })),
    })),
  );
  app.post(
    '/api/integrations/connections/:id/events',
    tenantRoute(app, write, async (c) => ({
      record: await enqueueIntegrationEvent(
        c.tx,
        manufacturingCtx(c),
        id(c.req.params),
        externalOrderSchema.parse(c.req.body),
      ),
    })),
  );
  app.post(
    '/api/integrations/events/:id/retry',
    tenantRoute(app, write, async (c) => {
      c.require('invoices.manage');
      const input = z
        .object({
          force: z.boolean().default(false),
          reason: z.string().trim().min(1).max(500).optional(),
        })
        .parse(c.req.body);
      if (input.force && !input.reason) throw fail('Manuel tekrar nedeni gerekli');
      const event = await getRecord(c.tx, id(c.req.params), 'integration_event');
      const rate = await app.limiter.consume(
        'integration-process:' + c.company.id + ':' + event.config.connectionId,
        30,
        60000,
      );
      if (!rate.ok) {
        c.reply.header('retry-after', String(rate.retryAfterSec));
        throw new AppError(
          429,
          'RATE_LIMITED',
          'Kanal aktarım sınırı aşıldı; daha sonra tekrar deneyin',
        );
      }
      return {
        record: await processIntegrationEvent(
          c.tx,
          manufacturingCtx(c),
          id(c.req.params),
          input.force ? { reason: input.reason! } : undefined,
        ),
      };
    }),
  );
  const live = async (tx: Tx, companyId: string) => {
    const company = await one(tx, sql`select tax_number from companies where id=${companyId}`);
    if (company.tax_number === 'DEMO-MFG-V1')
      throw forbidden('Demo şirketi dış sistemlere bağlanmaz', 'DEMO_EXTERNAL_CONNECTION_DISABLED');
  };
  app.post(
    '/api/integrations/connections/:id/pull-orders',
    tenantRoute(app, write, async (c) => {
      await live(c.tx, c.company.id);
      const r = await getRecord(c.tx, id(c.req.params), 'connection');
      if (!r.config.credentials) throw fail('Bağlantı bilgileri girilmedi');
      const input = z
        .object({
          partyId: uuid,
          warehouseId: uuid,
          cursor: z.string().optional(),
          priceField: z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/)
            .optional(),
          priceBasis: z.enum(['unit', 'line']).optional(),
        })
        .parse(c.req.body);
      const token = decryptField(r.config.credentials, 'integrations:' + app.config.JWT_SECRET);
      if (r.config.provider === 'shopify') {
        const data = await shopifyGraphql(
          r.config.shop,
          r.config.apiVersion ?? '2026-10',
          token,
          'query Orders($after:String){orders(first:50,after:$after,sortKey:UPDATED_AT){pageInfo{hasNextPage endCursor} nodes{id createdAt currencyCode displayFinancialStatus lineItems(first:100){pageInfo{hasNextPage} nodes{sku currentQuantity priceAfterAllDiscountsBeforeTaxesSet{shopMoney{amount}}}}}}}',
          { after: input.cursor ?? null },
        );
        const records = [];
        for (const order of data.orders.nodes) {
          if (order.lineItems.pageInfo.hasNextPage)
            throw fail('Sipariş 100 satırdan fazla; tam dosya aktarımı gerekli');
          records.push(
            await enqueueIntegrationEvent(
              c.tx,
              manufacturingCtx(c),
              r.id,
              externalOrderSchema.parse({
                externalId: order.id,
                partyId: input.partyId,
                warehouseId: input.warehouseId,
                date: order.createdAt.slice(0, 10),
                currency: order.currencyCode,
                paymentStatus: order.displayFinancialStatus,
                lines: order.lineItems.nodes
                  .filter((l: Row) => l.currentQuantity > 0)
                  .map((l: Row) => ({
                    sku: l.sku,
                    quantity: String(l.currentQuantity),
                    unitPrice: dec(l.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount)
                      .div(l.currentQuantity)
                      .toFixed(4),
                  })),
              }),
            ),
          );
        }
        return { records, pageInfo: data.orders.pageInfo };
      }
      if (r.config.provider === 'ticimax') {
        if (!input.priceField || !input.priceBasis)
          throw fail(
            'Ticimax birim fiyat alanını ve birim/satır bazını servis sözleşmesine göre eşleyin',
          );
        await validateIntegrationEndpoint(r.config.endpoint);
        const offset = input.cursor ? Number(input.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw fail('Sayfalama uygun değil');
        const result = await ticimaxSoap(r.config.endpoint, token, 'SelectSiparis', {
          'tem:filtre': {
            'a:SiparisID': -1,
            'a:UyeID': -1,
            'a:SiparisDurumu': -1,
            'a:OdemeDurumu': -1,
            'a:OdemeTipi': -1,
          },
          'tem:sayfalama': {
            'a:BaslangicIndex': offset,
            'a:KayitSayisi': 50,
            'a:SiralamaDegeri': 'ID',
            'a:SiralamaYonu': 'DESC',
          },
        });
        const orders = collection(result, 'WebSiparis'),
          records = [];
        for (const order of orders)
          records.push(
            await enqueueIntegrationEvent(
              c.tx,
              manufacturingCtx(c),
              r.id,
              normalizeTicimaxOrder(order, {
                ...input,
                priceField: input.priceField,
                priceBasis: input.priceBasis,
              }),
            ),
          );
        return {
          records,
          pageInfo: {
            hasNextPage: orders.length === 50,
            endCursor: String(offset + orders.length),
          },
        };
      }
      throw fail('Bu sağlayıcı için dosya/API adaptörü tanımlanmalı');
    }),
  );
  app.post(
    '/api/integrations/connections/:id/shopify-stock',
    tenantRoute(app, write, async (c) => {
      await live(c.tx, c.company.id);
      const r = await getRecord(c.tx, id(c.req.params), 'connection');
      if (r.config.provider !== 'shopify' || !r.config.credentials)
        throw fail('Shopify bağlantısı gerekli');
      const input = z
        .object({
          itemId: uuid,
          warehouseId: uuid,
          inventoryItemId: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/),
          locationId: z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/),
          changeFromQuantity: z.number().int().min(0),
          requestKey: uuid,
        })
        .parse(c.req.body);
      const { availableStock } = await import('../leather/production');
      const qty = Math.max(
        0,
        Math.floor(Number(await availableStock(c.tx, input.itemId, input.warehouseId))),
      );
      const data = await shopifyGraphql(
        r.config.shop,
        r.config.apiVersion ?? '2026-10',
        decryptField(r.config.credentials, 'integrations:' + app.config.JWT_SECRET),
        'mutation Set($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){userErrors{message}}}',
        {
          input: {
            name: 'available',
            reason: 'correction',
            quantities: [
              {
                inventoryItemId: input.inventoryItemId,
                locationId: input.locationId,
                quantity: qty,
                changeFromQuantity: input.changeFromQuantity,
              },
            ],
          },
          key: input.requestKey,
        },
      );
      if (data.inventorySetQuantities.userErrors.length)
        throw fail('Shopify stok güncellemesini reddetti');
      return { quantity: qty };
    }),
  );
  void newId;
};
