import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  uuid,
  dec,
  wmsBinSchema,
  wmsLotSchema,
  wmsPlacementSchema,
  logisticsShipmentSchema,
  manufacturingRecordActionSchema,
} from '@erp/shared';
import { tenantRoute, type TenantCtx } from '../../http/context';
import { all, one, fail, lockLeatherCosts } from '../leather/common';
import { manufacturingCtx } from './routes';
import { createRecord, getRecord, listRecords, recordShape, updateRecord } from './service';
import { queueInventoryChanges } from './channels';

const id = (c: TenantCtx) => z.object({ id: uuid }).parse(c.req.params).id;
export const manufacturingWarehouseRoutes: FastifyPluginAsync = async (app) => {
  const gate = (area: string, write = false) => ({
    module: area,
    permission: (area + (write ? '.manage' : '.read')) as never,
  });
  app.get(
    '/api/wms/lookups',
    tenantRoute(app, gate('inventory.wms'), async (c) => ({
      items: await all(c.tx, sql`select id,code,name from items where is_active limit 1000`),
      warehouses: await all(c.tx, sql`select id,name from warehouses where is_active`),
      documents: await all(
        c.tx,
        sql`select id,doc_no as code,warehouse_id from stock_documents where reversed_by_id is null and reversal_of_id is null and type in ('receipt','opening') order by doc_date desc limit 300`,
      ),
    })),
  );
  app.get(
    '/api/logistics/lookups',
    tenantRoute(app, gate('sales.logistics'), async (c) => {
      const notes = await all(
        c.tx,
        sql`select id,note_no as code,warehouse_id as "warehouseId" from delivery_notes where status='posted' and type='sales' order by note_date desc limit 300`,
      );
      for (const n of notes)
        n.lines = await all(
          c.tx,
          sql`select item_id as "itemId",quantity from delivery_note_lines where note_id=${n.id}`,
        );
      return { notes };
    }),
  );
  for (const kind of ['bin', 'lot', 'placement'] as const)
    app.get(
      '/api/wms/' + kind + 's',
      tenantRoute(app, gate('inventory.wms'), async (c) => ({
        records: await listRecords(c.tx, kind),
      })),
    );
  app.post(
    '/api/wms/bins',
    tenantRoute(app, gate('inventory.wms', true), async (c) => {
      const input = wmsBinSchema.parse(c.req.body);
      await one(
        c.tx,
        sql`select id from warehouses where id=${input.warehouseId}::uuid and is_active`,
      );
      return { record: await createRecord(c.tx, manufacturingCtx(c), 'bin', input, 'active') };
    }),
  );
  app.post(
    '/api/wms/lots',
    tenantRoute(app, gate('inventory.wms', true), async (c) => {
      await lockLeatherCosts(c.tx, c.company.id);
      const input = wmsLotSchema.parse(c.req.body);
      if (input.status === 'available') c.require('manufacturing.quality.approve');
      if (input.serials.length) {
        if (new Set(input.serials).size !== input.serials.length)
          throw fail('Seri numaraları tekil olmalı');
        const serials = await all(
          c.tx,
          sql`select config->'serials' as serials from manufacturing_records where kind='lot'`,
        );
        if (serials.some((r) => (r.serials ?? []).some((s: string) => input.serials.includes(s))))
          throw fail('Seri numarası başka partide kayıtlı');
      }
      const doc = await one(
        c.tx,
        sql`select id,source_id from stock_documents where id=${input.sourceDocumentId}::uuid and reversed_by_id is null and reversal_of_id is null`,
        'Stok kabul belgesi',
      );
      const source = await one(
        c.tx,
        sql`select coalesce(sum(qty),0)::text as qty from stock_movements where document_id=${doc.id} and item_id=${input.itemId}::uuid and warehouse_id=${input.warehouseId}::uuid and qty>0`,
      );
      // An untouched automatic receipt lot can be partitioned into labelled physical lots.
      const automatic = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='lot' and source_document_id=${doc.id}::uuid and item_id=${input.itemId}::uuid and warehouse_id=${input.warehouseId}::uuid and status='quarantine' and config->>'automatic'='true' for update`,
      );
      let partition = dec(input.quantity);
      for (const lot of automatic) {
        const left = dec(lot.config.remainingQty ?? lot.config.quantity);
        if (!left.eq(lot.config.quantity)) continue;
        const take = left.lt(partition) ? left : partition;
        await updateRecord(c.tx, lot.id, left.eq(take) ? 'partitioned' : 'quarantine', {
          ...lot.config,
          quantity: left.minus(take).toFixed(4),
          remainingQty: left.minus(take).toFixed(4),
        });
        partition = partition.minus(take);
        if (partition.isZero()) break;
      }
      const assigned = await one(
        c.tx,
        sql`select coalesce(sum((a.config->>'quantity')::numeric),0)::text as qty from manufacturing_records a where a.item_id=${input.itemId}::uuid and ((a.kind='lot' and a.source_document_id=${doc.id}) or (a.kind='lot_event' and a.status='returned' and (a.source_document_id=${doc.id} or a.source_document_id=${doc.source_id ?? null}::uuid) and exists(select 1 from manufacturing_records l where l.kind='lot' and l.id::text=a.config->>'lotId' and l.source_document_id<>${doc.id})))`,
      );
      if (dec(assigned.qty).plus(input.quantity).gt(source.qty))
        throw fail('Parti adedi kaynak kabul miktarını aşamaz');
      if (input.serials.length && !dec(input.quantity).eq(input.serials.length))
        throw fail('Seri sayısı miktarla eşleşmeli');
      const record = await createRecord(c.tx, manufacturingCtx(c), 'lot', input, input.status);
      await queueInventoryChanges(c.tx, manufacturingCtx(c), 'lot-create:' + record.id, [
        input.itemId,
      ]);
      return { record };
    }),
  );
  app.post(
    '/api/wms/lots/:id/actions',
    tenantRoute(app, gate('inventory.wms', true), async (c) => {
      c.require('manufacturing.quality.approve');
      const input = manufacturingRecordActionSchema.parse(c.req.body);
      if (!['release', 'block'].includes(input.action)) throw fail('Parti kararı uygun değil');
      await lockLeatherCosts(c.tx, c.company.id);
      const lot = await getRecord(c.tx, id(c), 'lot', true);
      if (['leather_traced', 'partitioned'].includes(lot.status))
        throw fail('Bu kabul fiziksel parça kayıtlarından yönetilir');
      const record = await updateRecord(
        c.tx,
        lot.id,
        input.action === 'release' ? 'available' : 'blocked',
        {
          ...lot.config,
          releasedQty:
            input.action === 'release'
              ? dec(lot.config.remainingQty ?? lot.config.quantity)
                  .minus(lot.config.damagedQty ?? 0)
                  .toFixed(4)
              : '0',
          approvedBy: c.user.id,
          approvedAt: new Date().toISOString(),
        },
      );
      await queueInventoryChanges(
        c.tx,
        manufacturingCtx(c),
        'lot-action:' + lot.id + ':' + new Date().toISOString(),
        [lot.item_id],
      );
      return {
        record,
      };
    }),
  );
  app.post(
    '/api/wms/placements',
    tenantRoute(app, gate('inventory.wms', true), async (c) => {
      const input = wmsPlacementSchema.parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const prev = await all(
        c.tx,
        sql`select * from manufacturing_records where kind='placement' and request_key=${input.requestKey}::uuid`,
      );
      if (prev.length) {
        if (
          prev[0]!.config.lotId !== input.lotId ||
          prev[0]!.config.binId !== input.binId ||
          !dec(prev[0]!.config.quantity).eq(input.quantity)
        )
          throw fail('İstek kimliği farklı yerleştirmede kullanıldı');
        return { record: recordShape(prev[0]!) };
      }
      const lot = await getRecord(c.tx, input.lotId, 'lot', true),
        bin = await getRecord(c.tx, input.binId, 'bin', true);
      if (lot.warehouse_id !== bin.warehouse_id) throw fail('Raf aynı depoda olmalı');
      const placed = await one(
        c.tx,
        sql`select coalesce(sum(coalesce(config->>'remainingQty',config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='placement' and config->>'lotId'=${lot.id}`,
      );
      const occupied = await one(
        c.tx,
        sql`select coalesce(sum(coalesce(config->>'remainingQty',config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='placement' and config->>'binId'=${bin.id}`,
      );
      if (
        dec(placed.qty)
          .plus(input.quantity)
          .gt(lot.config.remainingQty ?? lot.config.quantity) ||
        (dec(bin.config.capacity).gt(0) &&
          dec(occupied.qty).plus(input.quantity).gt(bin.config.capacity))
      )
        throw fail('Parti miktarı veya raf kapasitesi aşılır');
      return {
        record: await createRecord(
          c.tx,
          manufacturingCtx(c),
          'placement',
          { ...input, itemId: lot.item_id, warehouseId: lot.warehouse_id },
          'placed',
        ),
      };
    }),
  );
  app.get(
    '/api/logistics/shipments',
    tenantRoute(app, gate('sales.logistics'), async (c) => ({
      records: await listRecords(c.tx, 'shipment'),
    })),
  );
  app.post(
    '/api/logistics/shipments',
    tenantRoute(app, gate('sales.logistics', true), async (c) => {
      const input = logisticsShipmentSchema.parse(c.req.body);
      await lockLeatherCosts(c.tx, c.company.id);
      const note = await one(
        c.tx,
        sql`select id,type,status,warehouse_id from delivery_notes where id=${input.deliveryNoteId}::uuid`,
        'İrsaliye',
      );
      if (
        note.type !== 'sales' ||
        note.status !== 'posted' ||
        note.warehouse_id !== input.warehouseId
      )
        throw fail('Kayıtlı satış irsaliyesi ve aynı depo gerekli');
      const prior = (await listRecords(c.tx, 'shipment')).filter(
        (r) => r.deliveryNoteId === note.id && r.status !== 'cancelled',
      );
      if (prior.length) throw fail('İrsaliyenin paketleme kaydı var');
      const lines = await all(
        c.tx,
        sql`select item_id,sum(quantity)::text as quantity from delivery_note_lines where note_id=${note.id} group by item_id`,
      );
      const packed = new Map<string, ReturnType<typeof dec>>();
      for (const p of input.packages)
        for (const l of p.lines)
          packed.set(l.itemId, (packed.get(l.itemId) ?? dec(0)).plus(l.quantity));
      if (
        new Set(input.packages.map((p) => p.code)).size !== input.packages.length ||
        lines.some((l) => !dec(l.quantity).eq(packed.get(l.item_id) ?? 0)) ||
        packed.size !== lines.length
      )
        throw fail('Paketler irsaliye miktarlarıyla tam eşleşmeli');
      return { record: await createRecord(c.tx, manufacturingCtx(c), 'shipment', input, 'packed') };
    }),
  );
  app.post(
    '/api/logistics/shipments/:id/actions',
    tenantRoute(app, gate('sales.logistics', true), async (c) => {
      const input = manufacturingRecordActionSchema.parse(c.req.body);
      const r = await getRecord(c.tx, id(c), 'shipment', true);
      if (
        (r.config.actions ?? []).some(
          (a: { requestKey: string }) => a.requestKey === input.requestKey,
        )
      )
        return { record: recordShape(r) };
      if (
        (input.action === 'deliver' && !['packed', 'dispatched'].includes(r.status)) ||
        (input.action === 'cancel' && r.status !== 'packed') ||
        !['deliver', 'cancel', 'publish'].includes(input.action) ||
        (input.action === 'publish' && r.status !== 'packed')
      )
        throw fail('Sevkiyat aşaması uygun değil');
      return {
        record: await updateRecord(
          c.tx,
          r.id,
          input.action === 'deliver'
            ? 'delivered'
            : input.action === 'publish'
              ? 'dispatched'
              : 'cancelled',
          {
            ...r.config,
            actions: [...(r.config.actions ?? []), { ...input, at: new Date().toISOString() }],
          },
        ),
      };
    }),
  );
};
