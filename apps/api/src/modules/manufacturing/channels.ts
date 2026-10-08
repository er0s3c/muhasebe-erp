import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { uuid, manufacturingChannelMappingSchema } from '@erp/shared';
import type { Tx } from '../../db/client';
import type { StockCtx } from '../inventory/documents';
import { tenantRoute } from '../../http/context';
import { forbidden, AppError } from '../../http/errors';
import { all, one, fail, type Row } from '../leather/common';
import { createRecord, getRecord, listRecords, recordShape, updateRecord } from './service';
import { stockAvailability } from './availability';
import { command } from './commands';
import { manufacturingCtx } from './routes';
import { decryptField } from '../hr/crypto';

export const channelMappingSchema = manufacturingChannelMappingSchema;
export async function queueInventoryChanges(
  tx: Tx,
  ctx: StockCtx,
  sourceKey: string,
  itemIds: readonly string[],
) {
  if (!itemIds.length) return;
  const mappings = (await listRecords(tx, 'channel_mapping')).filter(
    (m) => m.status === 'active' && itemIds.includes(m.itemId),
  );
  for (const m of mappings) {
    const code = sourceKey + ':' + m.id;
    if (
      (
        await all(
          tx,
          sql`select id from manufacturing_records where kind='inventory_outbox' and code=${code}`,
        )
      ).length
    )
      continue;
    const stock = await stockAvailability(tx, m.itemId, m.warehouseId);
    await createRecord(
      tx,
      { ...ctx, reportingCurrency: null, allowNegativeStock: false },
      'inventory_outbox',
      {
        code,
        mappingId: m.id,
        connectionId: m.connectionId,
        itemId: m.itemId,
        warehouseId: m.warehouseId,
        quantity: Math.floor(Number(stock.available)),
        sourceKey,
        attempts: 0,
      },
      'queued',
    );
  }
}
export async function sendInventoryOutbox(
  tx: Tx,
  ctx: StockCtx,
  id: string,
  secret: string,
  fetcher: typeof fetch = fetch,
  manualReason?: string,
) {
  const event = await getRecord(tx, id, 'inventory_outbox', true);
  if (['processed', 'superseded'].includes(event.status)) return recordShape(event);
  const company = await one(
    tx,
    sql`select tax_number from companies where id=${ctx.companyId}::uuid`,
  );
  if (company.tax_number === 'DEMO-MFG-V1')
    throw forbidden('Demo şirketi dış stok göndermez', 'DEMO_EXTERNAL_CONNECTION_DISABLED');
  if (
    !manualReason &&
    (event.status === 'dead_letter' ||
      (event.config.retryAfter && Date.parse(event.config.retryAfter) > Date.now()))
  )
    return { ...recordShape(event), retryEligible: false };
  const newer = await all(
    tx,
    sql`select id from manufacturing_records where kind='inventory_outbox' and config->>'mappingId'=${event.config.mappingId} and created_at>${event.created_at} and status<>'superseded' limit 1`,
  );
  if (newer.length)
    return updateRecord(tx, id, 'superseded', { ...event.config, replacedBy: newer[0]!.id });
  const mapping = await getRecord(tx, event.config.mappingId, 'channel_mapping'),
    connection = await getRecord(tx, event.config.connectionId, 'connection');
  if (
    mapping.status !== 'active' ||
    connection.status !== 'configured' ||
    !connection.config.credentials
  )
    throw fail('Etkin ürün kodu eşlemesi ve bağlı kanal gerekli');
  const attempts = manualReason ? 0 : Number(event.config.attempts ?? 0);
  const config: Row = {
    ...event.config,
    ...(manualReason ? { manualRetryReason: manualReason, manualRetryBy: ctx.userId } : {}),
    attempts: attempts + 1,
  };
  try {
    const { shopifyGraphql, ticimaxSoap, validateIntegrationEndpoint } =
      await import('./integrations');
    const token = decryptField(connection.config.credentials, 'integrations:' + secret),
      m = mapping.config;
    if (connection.config.provider === 'shopify') {
      // Retries after an ambiguous timeout retain exactly the same CAS input and idempotency key.
      if (config.changeFromQuantity === undefined) {
        const response = await shopifyGraphql(
          connection.config.shop,
          connection.config.apiVersion ?? '2026-10',
          token,
          'query Stock($id:ID!,$location:ID!){inventoryItem(id:$id){inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}}',
          { id: m.inventoryItemId, location: m.locationId },
          fetcher,
        );
        const quantity = response.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
        if (!Number.isInteger(quantity)) throw fail('Shopify stok konumu bulunamadı');
        config.changeFromQuantity = quantity;
      }
      const data = await shopifyGraphql(
        connection.config.shop,
        connection.config.apiVersion ?? '2026-10',
        token,
        'mutation Set($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){userErrors{message}}}',
        {
          input: {
            name: 'available',
            reason: 'correction',
            quantities: [
              {
                inventoryItemId: m.inventoryItemId,
                locationId: m.locationId,
                quantity: config.quantity,
                changeFromQuantity: config.changeFromQuantity,
              },
            ],
          },
          key: id,
        },
        fetcher,
      );
      if (data.inventorySetQuantities.userErrors.length)
        throw fail(
          'Shopify stok değişimini reddetti: ' + data.inventorySetQuantities.userErrors[0].message,
        );
    } else if (connection.config.provider === 'ticimax') {
      const endpoint = new URL(connection.config.endpoint);
      if (/\/SiparisServis\.svc$/i.test(endpoint.pathname))
        endpoint.pathname = endpoint.pathname.replace(/SiparisServis\.svc$/i, 'UrunServis.svc');
      await validateIntegrationEndpoint(endpoint.toString());
      const response = await ticimaxSoap(
        endpoint.toString(),
        token,
        'StokAdediGuncelle',
        {
          'tem:Urunler': { 'a:Varyasyon': { 'a:ID': m.variantId, 'a:StokAdedi': config.quantity } },
        },
        fetcher,
      );
      if (response?.IsError || response?.IsErros || response === false || response === 'false')
        throw fail('Ticimax stok değişimini reddetti');
    } else throw fail('Bu kanal stok yayını desteklemiyor');
    return updateRecord(tx, id, 'processed', {
      ...config,
      error: null,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    return updateRecord(tx, id, attempts + 1 >= 5 ? 'dead_letter' : 'failed', {
      ...config,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Kanal hatası',
      retryAfter: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)).toISOString(),
    });
  }
}

export const manufacturingChannelRoutes: FastifyPluginAsync = async (app) => {
  const read = { module: 'core.integrations', permission: 'core.integrations.read' } as const,
    write = { module: 'core.integrations', permission: 'core.integrations.manage' } as const;
  app.get(
    '/api/integrations/channel-mappings',
    tenantRoute(app, read, async (c) => ({
      records: await listRecords(c.tx, 'channel_mapping'),
      items: await all(
        c.tx,
        sql`select id,code,name from items where kind='goods' and unit='adet' and is_active`,
      ),
      warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
    })),
  );
  app.post(
    '/api/integrations/channel-mappings',
    tenantRoute(app, write, async (c) => {
      const input = channelMappingSchema.parse(c.req.body);
      return {
        record: await command(c.tx, manufacturingCtx(c), 'channel-mapping', input, async () => {
          const connection = await getRecord(c.tx, input.connectionId, 'connection');
          await one(
            c.tx,
            sql`select id from items where id=${input.itemId}::uuid and kind='goods' and unit='adet' and is_active`,
          );
          await one(
            c.tx,
            sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
          );
          if (
            connection.config.provider === 'shopify' &&
            (!input.inventoryItemId || !input.locationId)
          )
            throw fail('Shopify ürün ve konum kimliği gerekli');
          if (connection.config.provider === 'ticimax' && !input.variantId)
            throw fail('Ticimax varyasyon kimliği gerekli');
          if (!['shopify', 'ticimax'].includes(connection.config.provider))
            throw fail('Stok kanalı gerekli');
          const mappings = await listRecords(c.tx, 'channel_mapping');
          if (
            mappings.some(
              (m) =>
                m.connectionId === input.connectionId &&
                m.status === 'active' &&
                (m.itemId !== input.itemId || m.warehouseId !== input.warehouseId) &&
                (m.channelSku === input.channelSku ||
                  (input.locationId &&
                    m.locationId === input.locationId &&
                    m.inventoryItemId === input.inventoryItemId) ||
                  (input.variantId && m.variantId === input.variantId)),
            )
          )
            throw fail('Kanal ürün kodu ve depo eşlemesi başka stokta kullanılıyor');
          const existing = mappings.find(
            (m) =>
              m.connectionId === input.connectionId &&
              m.itemId === input.itemId &&
              m.warehouseId === input.warehouseId,
          );
          const record = existing
            ? await updateRecord(c.tx, existing.id, 'active', input)
            : await createRecord(c.tx, manufacturingCtx(c), 'channel_mapping', input, 'active');
          await queueInventoryChanges(c.tx, manufacturingCtx(c), 'mapping:' + input.requestKey, [
            input.itemId,
          ]);
          return record;
        }),
      };
    }),
  );
  app.get(
    '/api/integrations/inventory-outbox',
    tenantRoute(app, read, async (c) => ({
      records: await listRecords(c.tx, 'inventory_outbox'),
      stockAuthority: 'ada',
      automaticSending: false,
    })),
  );
  app.post(
    '/api/integrations/inventory-outbox/:id/retry',
    tenantRoute(app, write, async (c) => {
      const id = z.object({ id: uuid }).parse(c.req.params).id,
        input = z
          .object({
            force: z.boolean().default(false),
            reason: z.string().trim().min(1).max(500).optional(),
          })
          .parse(c.req.body);
      if (input.force && !input.reason) throw fail('Manuel tekrar nedeni gerekli');
      const event = await getRecord(c.tx, id, 'inventory_outbox');
      const rate = await app.limiter.consume(
        'inventory-channel:' + c.company.id + ':' + event.config.connectionId,
        30,
        60000,
      );
      if (!rate.ok) {
        c.reply.header('retry-after', String(rate.retryAfterSec));
        throw new AppError(429, 'RATE_LIMITED', 'Kanal sınırı aşıldı');
      }
      return {
        record: await sendInventoryOutbox(
          c.tx,
          manufacturingCtx(c),
          id,
          app.config.JWT_SECRET,
          fetch,
          input.force ? input.reason : undefined,
        ),
      };
    }),
  );
};
