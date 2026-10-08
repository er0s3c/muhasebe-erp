import { sql } from 'drizzle-orm';
import { dec, todayIso, type LeatherQualityInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  all,
  one,
  newId,
  json,
  fail,
  requireParty,
  requireGoods,
  mapped,
  lockLeatherCosts,
  type LeatherCtx,
  type Row,
} from './common';
import { allocateCost } from './costs';
import { acceptPiece } from './materials';
import { physicalMovement } from './movements';
import { scrapProduction } from './production';

export const qualityShape = (r: Row) => ({
  ...r.config,
  id: r.id,
  scope: r.scope,
  sourceId: r.source_id,
  stage: r.stage,
  inspectedQty: r.inspected_qty,
  passedQty: r.passed_qty,
  status: r.status,
  createdAt: r.created_at,
});
export async function createQuality(tx: Tx, ctx: LeatherCtx, input: LeatherQualityInput) {
  await lockLeatherCosts(tx, ctx.companyId);
  let available: string;
  if (input.scope === 'material') {
    const p = await one(
      tx,
      sql`select * from leather_pieces where id=${input.sourceId}::uuid`,
      'Deri parçası',
    );
    available = p.remaining_area;
  } else if (input.scope === 'production') {
    const o = await one(
      tx,
      sql`select * from leather_production_orders where id=${input.sourceId}::uuid`,
      'Üretim emri',
    );
    available = dec(o.quantity)
      .minus(o.completed_qty)
      .minus(o.config.scrappedQty ?? 0)
      .toFixed(4);
  } else {
    await one(
      tx,
      sql`select id from leather_service_cases where id=${input.sourceId}::uuid`,
      'Servis kaydı',
    );
    available = '1';
  }
  if (dec(input.inspectedQty).gt(available))
    throw fail('Kalite kontrol miktarı kaynağın kalan miktarını aşamaz');
  if (input.batchId) {
    if (input.scope !== 'production') throw fail('Üretim partisi yalnız üretim kalite kontrolüne bağlanır');
    const batch = await one(
      tx,
      sql`select config from manufacturing_records where id=${input.batchId}::uuid and kind='batch' and order_id=${input.sourceId}::uuid`,
      'Kaynak üretim partisi',
    );
    if (
      dec(input.inspectedQty).gt(dec(batch.config.quantity).minus(batch.config.completedQty ?? 0))
    )
      throw fail('Kalite miktarı üretim partisi bakiyesini aşamaz');
  }
  return qualityShape(
    await one(
      tx,
      sql`insert into leather_quality_checks(id,company_id,created_by,scope,source_id,stage,inspected_qty,passed_qty,config) values(${newId()},${ctx.companyId},${ctx.userId},${input.scope},${input.sourceId},${input.stage},${input.inspectedQty},${input.passedQty},${json(input)}) returning *`,
    ),
  );
}
export async function decideQuality(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: { decision: string; note: string },
) {
  await lockLeatherCosts(tx, ctx.companyId);
  const q = await one(
    tx,
    sql`select * from leather_quality_checks where id=${id}::uuid for update`,
    'Kalite kontrolü',
  );
  if (q.status !== 'pending') throw fail('Kalite kontrolü zaten sonuçlandırılmış');
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  if (status === 'approved' && q.scope === 'material' && q.stage === 'incoming') {
    const piece = await one(tx, sql`select * from leather_pieces where id=${q.source_id}::uuid`);
    if (!dec(q.inspected_qty).eq(piece.remaining_area))
      throw fail('Mal kabul kalite onayı parçanın tamamını kapsamalı');
    if (dec(q.passed_qty).eq(q.inspected_qty))
      await acceptPiece(tx, ctx, q.source_id, { decision: 'accept', note: input.note });
    else if (dec(q.config.secondQty ?? 0).eq(q.inspected_qty))
      await acceptPiece(tx, ctx, q.source_id, { decision: 'second', note: input.note });
    else if (dec(q.config.scrapQty ?? 0).eq(q.inspected_qty))
      await physicalMovement(tx, ctx, {
        sourceType: 'leather_quality',
        sourceId: q.id,
        date: todayIso(),
        warehouseId: piece.warehouse_id,
        kind: 'waste',
        allowQuarantine: true,
        lines: [
          {
            itemId: piece.item_id,
            quantity: q.inspected_qty,
            pieces: [{ pieceId: piece.id, quantity: q.inspected_qty }],
          },
        ],
      });
    else
      throw fail(
        'Parça kısmen uygunsuzsa önce parça ölçümlerini ayırın; bütün parçayı yanlış kaliteye açmayın',
      );
  }
  if (status === 'approved' && q.scope === 'production' && dec(q.config.scrapQty ?? 0).gt(0))
    await scrapProduction(tx, ctx, q.source_id, q.id, q.config.scrapQty, todayIso());
  if (status === 'approved' && q.config.reworkId) {
    const r = await one(
      tx,
      sql`select * from manufacturing_records where id=${q.config.reworkId}::uuid and kind='rework' and order_id=${q.source_id}::uuid for update`,
    );
    if (r.config.recheckId !== q.id || r.status !== 'quality_waiting')
      throw fail('Yeniden işleme kontrol bağlantısı uyuşmuyor');
    const order = await one(
        tx,
        sql`select * from leather_production_orders where id=${q.source_id}::uuid for update`,
      ),
      op = order.config.operations.find(
        (p: Row) => p.key === (r.config.sourceOperationKey ?? r.config.operationKey),
      );
    if (
      dec(op.goodQty ?? 0)
        .plus(q.passed_qty)
        .gt(order.quantity)
    )
      throw fail('Düzeltilen iyi adet üretim miktarını aşamaz');
    op.goodQty = dec(op.goodQty ?? 0)
      .plus(q.passed_qty)
      .toFixed(4);
    const remainingRework = dec(op.reworkQty ?? 0).minus(q.inspected_qty);
    op.reworkQty = (remainingRework.gt(0) ? remainingRework : dec(0)).toFixed(4);
    if (r.config.batchId) {
      const batch = await one(
        tx,
        sql`select * from manufacturing_records where id=${r.config.batchId}::uuid and kind='batch' and order_id=${order.id}::uuid for update`,
      );
      const operations = batch.config.operations ?? {};
      const result = operations[op.key] ?? {
        goodQty: '0',
        reworkQty: '0',
        scrapQty: '0',
        minutes: '0',
      };
      const good = dec(result.goodQty).plus(q.passed_qty);
      if (good.gt(batch.config.quantity)) throw fail('Düzeltilen iyi adet üretim partisi miktarını aşamaz');
      operations[op.key] = {
        ...result,
        goodQty: good.toFixed(4),
        reworkQty: dec(result.reworkQty ?? 0)
          .minus(q.inspected_qty)
          .gt(0)
          ? dec(result.reworkQty).minus(q.inspected_qty).toFixed(4)
          : '0.0000',
      };
      await tx.execute(
        sql`update manufacturing_records set config=config||${json({ operations })},updated_at=now() where id=${batch.id}::uuid`,
      );
    }
    await tx.execute(
      sql`update leather_production_orders set config=config||${json({ operations: order.config.operations })} where id=${order.id}::uuid`,
    );
    await tx.execute(
      sql`update manufacturing_records set status='completed',config=config||${json({ qualityApprovedBy: ctx.userId, qualityApprovedAt: new Date().toISOString() })},updated_at=now() where id=${r.id}::uuid`,
    );
  }
  return qualityShape(
    await one(
      tx,
      sql`update leather_quality_checks set status=${status},approved_by=${ctx.userId},approved_at=now(),config=config || ${json({ decisionNote: input.note })} where id=${id}::uuid returning *`,
    ),
  );
}
export async function listSubcontracts(tx: Tx) {
  return (
    await all(
      tx,
      sql`select j.*,p.name as "partyName" from leather_subcontract_jobs j join parties p on p.id=j.party_id order by j.created_at desc limit 500`,
    )
  ).map((r) => ({
    ...r.config,
    id: r.id,
    orderId: r.order_id,
    partyId: r.party_id,
    partyName: r.partyName,
    operationKey: r.operation_key,
    quantity: r.quantity,
    returnedQty: r.returned_qty,
    status: r.status,
    dueDate: r.due_date,
  }));
}
export async function createSubcontract(tx: Tx, ctx: LeatherCtx, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const o = await one(
    tx,
    sql`select * from leather_production_orders where id=${input.orderId}::uuid for update`,
    'Üretim emri',
  );
  if (!['released', 'in_progress'].includes(o.status)) throw fail('Fason işi açık emre bağlanmalı');
  const operation = (o.config.operations ?? []).find(
    (x: Row) => x.key === input.operationKey && x.outsourced,
  );
  if (!operation) throw fail('Fason operasyonu onaylı rotada fason olarak tanımlı olmalı');
  const p = await requireParty(tx, input.partyId);
  if (p.kind === 'customer') throw fail('Fason tedarikçi carisine açılır');
  if (dec(input.quantity).gt(o.quantity)) throw fail('Fason miktarı emri aşamaz');
  const r = await one(
    tx,
    sql`insert into leather_subcontract_jobs(id,company_id,created_by,order_id,party_id,operation_key,quantity,due_date,config) values(${newId()},${ctx.companyId},${ctx.userId},${input.orderId},${input.partyId},${input.operationKey},${input.quantity},${input.dueDate ?? null},${json(input)}) returning id`,
  );
  return (await listSubcontracts(tx)).find((j) => j.id === r.id)!;
}
export async function subcontractAction(tx: Tx, ctx: LeatherCtx, id: string, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const j = await one(
    tx,
    sql`select * from leather_subcontract_jobs where id=${id}::uuid for update`,
    'Fason işi',
  );
  const actions = (j.config.actions ?? []) as Row[];
  if (actions.some((a) => a.requestKey === input.requestKey))
    return (await listSubcontracts(tx)).find((r) => r.id === id)!;
  let status = j.status;
  let returned = dec(j.returned_qty);
  if (input.action === 'dispatch') {
    if (status !== 'planned') throw fail('Fason işi sevk edilmiş');
    status = 'dispatched';
  } else if (input.action === 'return') {
    if (status !== 'dispatched') throw fail('Fason iadesi sevk edilmiş işten alınır');
    if (!input.quantity) throw fail('Teslim alınan miktar gerekli');
    returned = returned.plus(input.quantity);
    if (returned.gt(j.quantity)) throw fail('Fasondan dönüş miktarı sevki aşamaz');
    if (returned.eq(j.quantity)) status = 'received';
  } else {
    if (status !== 'planned') throw fail('Sevk edilen fason işi doğrudan iptal edilemez');
    status = 'cancelled';
  }
  if (input.sourceJournalLineId && input.cost)
    await allocateCost(tx, ctx, {
      orderId: j.order_id,
      sourceJournalLineId: input.sourceJournalLineId,
      amount: input.cost,
      kind: 'subcontract',
      date: input.date,
      requestKey: input.requestKey,
      note: input.note,
    });
  actions.push(input);
  await tx.execute(
    sql`update leather_subcontract_jobs set status=${status},returned_qty=${returned.toFixed(4)},config=config || ${json({ actions })} where id=${id}::uuid`,
  );
  return (await listSubcontracts(tx)).find((r) => r.id === id)!;
}
export async function listCustomOrders(tx: Tx) {
  return (
    await all(
      tx,
      sql`select o.*,p.name as "partyName",i.name as "itemName" from leather_custom_orders o join parties p on p.id=o.party_id join leather_variants v on v.id=o.variant_id join items i on i.id=v.item_id order by o.created_at desc limit 500`,
    )
  ).map((r) => ({
    ...r.config,
    id: r.id,
    partyId: r.party_id,
    partyName: r.partyName,
    itemName: r.itemName,
    variantId: r.variant_id,
    quantity: r.quantity,
    dueDate: r.due_date,
    status: r.status,
    depositTransactionId: r.deposit_transaction_id,
    invoiceId: r.invoice_id,
  }));
}
export async function createCustomOrder(tx: Tx, ctx: LeatherCtx, input: Row) {
  await requireParty(tx, input.partyId);
  const v = await one(
    tx,
    sql`select * from leather_variants where id=${input.variantId}::uuid`,
    'Varyant',
  );
  if (input.monogram && !v.config.allowsPersonalization)
    throw fail('Bu varyant kişiselleştirmeye açık değil');
  const r = await one(
    tx,
    sql`insert into leather_custom_orders(id,company_id,created_by,party_id,variant_id,quantity,due_date,config) values(${newId()},${ctx.companyId},${ctx.userId},${input.partyId},${input.variantId},${input.quantity},${input.dueDate},${json(input)}) returning id`,
  );
  return (await listCustomOrders(tx)).find((o) => o.id === r.id)!;
}
export async function customAction(tx: Tx, ctx: LeatherCtx, id: string, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const o = await one(
    tx,
    sql`select * from leather_custom_orders where id=${id}::uuid for update`,
    'Kişiye özel sipariş',
  );
  let status = o.status;
  let deposit = o.deposit_transaction_id;
  let invoiceId = o.invoice_id;
  if (input.action === 'confirm') {
    if (status !== 'draft') throw fail('Yalnızca taslak kişisel sipariş onaylanır');
    if (input.treasuryTransactionId) {
      const t = await one(
        tx,
        sql`select * from treasury_transactions where id=${input.treasuryTransactionId}::uuid for update`,
        'Kapora tahsilatı',
      );
      if (
        t.status !== 'posted' ||
        t.type !== 'other_receipt' ||
        t.gl_account_id !== (await mapped(tx, 'advance_received')) ||
        t.party_id !== o.party_id ||
        t.currency_code !== o.config.currency
      )
        throw fail(
          'Kapora, aynı müşterinin para biriminde alınan avans hesabına kayıtlı tahsilat olmalı',
        );
      if (dec(t.amount).gt(dec(o.quantity).times(o.config.unitPrice)))
        throw fail('Kapora sipariş tutarını aşamaz');
      deposit = t.id;
    }
    status = 'confirmed';
  } else if (input.action === 'cancel') {
    if (!['draft', 'confirmed'].includes(status))
      throw fail('Teslime hazırlanan sipariş iptal edilemez');
    const production = await one(
      tx,
      sql`select count(*)::int as n from leather_production_orders where config->>'customOrderId'=${id} and status<>'cancelled'`,
    );
    if (production.n || deposit)
      throw fail('Önce üretimi ve varsa kapora iade/tahsilat kaydını çözümleyin');
    status = 'cancelled';
  } else if (input.action === 'ready') {
    if (status !== 'confirmed') throw fail('Onaylı sipariş gerekli');
    const made = await one(
      tx,
      sql`select coalesce(sum(completed_qty),0)::text as qty from leather_production_orders where config->>'customOrderId'=${id}`,
    );
    if (dec(made.qty).lt(o.quantity)) throw fail('Sipariş üretimi henüz tamamlanmadı');
    status = 'ready';
  } else {
    if (status !== 'ready' || !input.invoiceId)
      throw fail('Teslimde hazır sipariş ve satış faturası gerekli');
    const v = await one(tx, sql`select item_id from leather_variants where id=${o.variant_id}`);
    const inv = await one(
      tx,
      sql`select * from invoices where id=${input.invoiceId}::uuid`,
      'Teslim faturası',
    );
    if (inv.status !== 'posted' || inv.type !== 'sales' || inv.party_id !== o.party_id)
      throw fail('Aynı müşterinin kayıtlı satış faturası gerekli');
    const sold = await one(
      tx,
      sql`select coalesce(sum(quantity),0)::text as qty from invoice_lines where invoice_id=${inv.id} and item_id=${v.item_id}`,
    );
    if (dec(sold.qty).lt(o.quantity))
      throw fail('Fatura sipariş ürününü ve miktarını karşılamıyor');
    invoiceId = inv.id;
    status = 'delivered';
  }
  await tx.execute(
    sql`update leather_custom_orders set status=${status},deposit_transaction_id=${deposit},invoice_id=${invoiceId},config=config || ${json({ lastActionNote: input.note })} where id=${id}::uuid`,
  );
  return (await listCustomOrders(tx)).find((x) => x.id === id)!;
}
export async function listServiceCases(tx: Tx) {
  return (
    await all(
      tx,
      sql`select s.*,p.name as "partyName",i.name as "itemName" from leather_service_cases s join parties p on p.id=s.party_id join items i on i.id=s.item_id order by s.created_at desc limit 500`,
    )
  ).map((r) => ({
    ...r.config,
    id: r.id,
    partyId: r.party_id,
    partyName: r.partyName,
    itemId: r.item_id,
    itemName: r.itemName,
    invoiceLineId: r.invoice_line_id,
    serialId: r.serial_id,
    date: r.date,
    status: r.status,
    invoiceId: r.invoice_id,
    assessment: r.config.assessment ?? '',
    fee: r.config.fee ?? '0',
  }));
}
export async function createServiceCase(tx: Tx, ctx: LeatherCtx, input: Row) {
  await requireParty(tx, input.partyId);
  await requireGoods(tx, input.itemId, 'finished_goods');
  await one(
    tx,
    sql`select id from leather_variants where item_id=${input.itemId}::uuid`,
    'Kendi ürün varyantı',
  );
  if (input.invoiceLineId) {
    const l = await one(
      tx,
      sql`select l.item_id,i.party_id,i.type,i.status from invoice_lines l join invoices i on i.id=l.invoice_id where l.id=${input.invoiceLineId}::uuid`,
      'Satış satırı',
    );
    if (
      l.item_id !== input.itemId ||
      l.party_id !== input.partyId ||
      l.type !== 'sales' ||
      l.status !== 'posted'
    )
      throw fail('Servis kendi ürününüzün müşteriye kayıtlı satışına bağlanmalı');
  }
  if (input.serialId) {
    const s = await one(
      tx,
      sql`select * from item_serials where id=${input.serialId}::uuid`,
      'Ürün serisi',
    );
    if (s.item_id !== input.itemId) throw fail('Seri ürün kartıyla uyuşmuyor');
    const e = await one(
      tx,
      sql`select party_id from serial_events where serial_id=${s.id} and to_status='issued' order by seq desc limit 1`,
      'Seri satış izi',
    );
    if (e.party_id !== input.partyId) throw fail('Seri numarası müşteriye satılmamış');
  }
  const r = await one(
    tx,
    sql`insert into leather_service_cases(id,company_id,created_by,party_id,item_id,invoice_line_id,serial_id,date,config) values(${newId()},${ctx.companyId},${ctx.userId},${input.partyId},${input.itemId},${input.invoiceLineId ?? null},${input.serialId ?? null},${input.date},${json(input)}) returning id`,
  );
  return (await listServiceCases(tx)).find((c) => c.id === r.id)!;
}
export async function serviceAction(tx: Tx, ctx: LeatherCtx, id: string, input: Row) {
  await lockLeatherCosts(tx, ctx.companyId);
  const c = await one(
    tx,
    sql`select * from leather_service_cases where id=${id}::uuid for update`,
    'Servis kaydı',
  );
  const history = (c.config.history ?? []) as Row[];
  if (history.some((h) => h.requestKey === input.requestKey))
    return (await listServiceCases(tx)).find((s) => s.id === id)!;
  const allowed: Record<string, string[]> = {
    diagnose: ['received'],
    repair: ['diagnosed'],
    ready: ['diagnosed', 'repairing'],
    deliver: ['ready'],
    cancel: ['received', 'diagnosed'],
  };
  if (!allowed[input.action]?.includes(c.status)) throw fail('Servis durum geçişi uygun değil');
  if (c.config.warranty && dec(input.fee).gt(0))
    throw fail('Garanti kapsamındaki servis ücretlendirilemez');
  let invoiceId = c.invoice_id;
  if (input.invoiceId) {
    const i = await one(
      tx,
      sql`select * from invoices where id=${input.invoiceId}::uuid`,
      'Servis faturası',
    );
    if (i.party_id !== c.party_id || i.status !== 'posted' || i.type !== 'sales')
      throw fail('Servis için müşterinin kayıtlı satış faturası gerekli');
    invoiceId = i.id;
  }
  if (input.action === 'deliver' && dec(input.fee).gt(0) && !invoiceId)
    throw fail('Ücretli servis tesliminde fatura gerekli');
  const status = {
    diagnose: 'diagnosed',
    repair: 'repairing',
    ready: 'ready',
    deliver: 'delivered',
    cancel: 'cancelled',
  }[input.action as 'diagnose'];
  history.push(input);
  await tx.execute(
    sql`update leather_service_cases set status=${status},invoice_id=${invoiceId},config=config || ${json({ assessment: input.assessment, fee: input.fee, history, lastActionDate: input.date })} where id=${id}::uuid`,
  );
  return (await listServiceCases(tx)).find((s) => s.id === id)!;
}
export async function overview(tx: Tx) {
  return one(
    tx,
    sql`select (select count(*)::int from leather_models) as models,(select count(*)::int from leather_production_orders where status in ('released','in_progress')) as "activeOrders",(select count(*)::int from leather_production_orders where status in ('planned','released','in_progress') and due_date<${todayIso()}::date) as "dueOrders",(select count(*)::int from leather_pieces where status='quarantine') as "quarantinePieces",(select count(*)::int from leather_quality_checks where status='pending') as "openQuality",(select count(*)::int from leather_subcontract_jobs where status in ('planned','dispatched')) as "openSubcontracts",(select count(*)::int from leather_custom_orders where status not in ('cancelled','delivered')) as "customOrders",(select count(*)::int from leather_service_cases where status not in ('cancelled','delivered')) as "serviceCases",(select coalesce(sum(wip_value),0)::text from leather_production_orders) as "wipValue",(select count(*)::int from leather_cost_roots where accrued and settled_qty<quantity and not coalesce((config->>'cancelled')::boolean,false)) as "provisionalReceipts"`,
  );
}
