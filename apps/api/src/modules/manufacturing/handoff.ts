import { sql } from 'drizzle-orm';
import { dec, type LeatherIssueInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, fail, json, type Row, type LeatherCtx } from '../leather/common';
import { command } from './commands';
import { createRecord, getRecord, updateRecord } from './service';
import { stockAvailability } from './availability';
import { requireOpenPeriod } from '../settings/periods';

/** An internal handoff within the order's warehouse; ownership/value changes only at the existing issue command. */
export async function materialHandoff(
  tx: Tx,
  ctx: LeatherCtx,
  orderId: string,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'material-handoff:' + orderId, input, async () => {
    await requireOpenPeriod(tx, input.date);
    const order = await one(
      tx,
      sql`select * from leather_production_orders where id=${orderId}::uuid for update`,
    );
    if (
      order.config.executionPhase === 'closed' ||
      (input.action === 'deliver' &&
        (!['released', 'in_progress'].includes(order.status) ||
          order.config.executionPhase === 'on_hold'))
    )
      throw fail('Malzeme teslimi için açık üretim gerekli');
    if (!order.config.materials.some((m: Row) => m.itemId === input.itemId))
      throw fail('Malzeme onaylı reçetede bulunmalı');
    if (input.action === 'return') {
      const handoff = await getRecord(tx, input.handoffId, 'material_handoff', true);
      if (handoff.order_id !== orderId || handoff.item_id !== input.itemId)
        throw fail('İade kaynak teslimin emrine ve malzemesine bağlı olmalı');
      const remaining = dec(handoff.config.quantity)
        .minus(handoff.config.consumedQty ?? 0)
        .minus(handoff.config.returnedQty ?? 0);
      if (dec(input.quantity).gt(remaining))
        throw fail('Kullanılmamış teslim miktarı iade için yetersiz');
      const returnedQty = dec(handoff.config.returnedQty ?? 0)
        .plus(input.quantity)
        .toFixed(4);
      return updateRecord(
        tx,
        handoff.id,
        dec(input.quantity).eq(remaining) ? 'settled' : 'delivered',
        { ...handoff.config, returnedQty, returns: [...(handoff.config.returns ?? []), input] },
      );
    }
    if (input.receiverId)
      await one(
        tx,
        sql`select user_id from memberships m join users u on u.id=m.user_id where m.company_id=${ctx.companyId}::uuid and m.user_id=${input.receiverId}::uuid and u.is_active`,
        'Teslim alan',
      );
    const reserved = await one(
      tx,
      sql`select coalesce(sum(quantity-consumed_qty),0)::text as qty from leather_reservations where order_id=${orderId}::uuid and item_id=${input.itemId}::uuid and warehouse_id=${order.warehouse_id}::uuid and status='reserved'`,
    );
    const handed = await one(
      tx,
      sql`select coalesce(sum((config->>'quantity')::numeric-coalesce((config->>'consumedQty')::numeric,0)-coalesce((config->>'returnedQty')::numeric,0)),0)::text as qty from manufacturing_records where kind='material_handoff' and order_id=${orderId}::uuid and item_id=${input.itemId}::uuid`,
    );
    const available = await stockAvailability(tx, input.itemId, order.warehouse_id, orderId);
    if (
      dec(handed.qty).plus(input.quantity).gt(reserved.qty) ||
      dec(handed.qty).plus(input.quantity).gt(available.available)
    )
      throw fail('Teslim, kullanılabilir rezerve malzemeyi aşamaz');
    return createRecord(
      tx,
      ctx,
      'material_handoff',
      {
        ...input,
        orderId,
        itemId: input.itemId,
        warehouseId: order.warehouse_id,
        consumedQty: '0',
        returnedQty: '0',
      },
      'delivered',
    );
  });
}

export async function consumeMaterialHandoffs(
  tx: Tx,
  orderId: string,
  warehouseId: string,
  lines: LeatherIssueInput['lines'],
) {
  const parts: { handoffId: string; lineNo: number; quantity: string }[] = [];
  for (const [index, line] of lines.entries()) {
    let remaining = dec(line.quantity);
    const handoffs = await all(
      tx,
      sql`select * from manufacturing_records where kind='material_handoff' and order_id=${orderId}::uuid and item_id=${line.itemId}::uuid and warehouse_id=${warehouseId}::uuid and status='delivered' order by created_at,id for update`,
    );
    for (const handoff of handoffs) {
      const left = dec(handoff.config.quantity)
        .minus(handoff.config.consumedQty ?? 0)
        .minus(handoff.config.returnedQty ?? 0);
      const take = left.lt(remaining) ? left : remaining;
      if (take.lte(0)) continue;
      const consumedQty = dec(handoff.config.consumedQty ?? 0)
        .plus(take)
        .toFixed(4);
      await tx.execute(
        sql`update manufacturing_records set status=${take.eq(left) ? 'settled' : 'delivered'},config=config||${json({ consumedQty })},updated_at=now() where id=${handoff.id}::uuid`,
      );
      parts.push({ handoffId: handoff.id, lineNo: index + 1, quantity: take.toFixed(4) });
      remaining = remaining.minus(take);
      if (remaining.isZero()) break;
    }
  }
  return parts;
}
