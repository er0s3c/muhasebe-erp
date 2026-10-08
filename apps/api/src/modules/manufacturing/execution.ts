import { sql } from 'drizzle-orm';
import { dec, todayIso, leatherOperationSchema, leatherQualitySchema, processingQueue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { all, one, fail, json, newId, type LeatherCtx, type Row } from '../leather/common';
import { getProduction, recordOperation, saveDocument } from '../leather/production';
import { requireOpenPeriod } from '../settings/periods';
import { command } from './commands';
import { createRecord, getRecord, recordShape, updateRecord } from './service';
import { createQuality } from '../leather/workflows';

export async function executionSummary(tx: Tx, id: string) {
  const order = await getProduction(tx, id);
  const raw = await one(tx, sql`select config from leather_production_orders where id=${id}::uuid`);
  const sessions = await all(
    tx,
    sql`select * from manufacturing_records where kind='work_session' and order_id=${id}::uuid order by created_at desc`,
  );
  const batches = await all(
    tx,
    sql`select * from manufacturing_records where kind='batch' and order_id=${id}::uuid order by created_at`,
  );
  const documents = await all(
    tx,
    sql`select kind,quantity,value,config from leather_production_documents where order_id=${id}::uuid order by created_at`,
  );
  const material = new Map<
    string,
    {
      itemId: string;
      issued: string;
      returned: string;
      net: string;
      handed?: string;
      unusedReturned?: string;
      handedConsumed?: string;
      stagedBalance?: string;
    }
  >();
  for (const m of raw.config.materials ?? [])
    material.set(m.itemId, {
      itemId: m.itemId,
      issued: '0',
      returned: '0',
      net: '0',
      handed: '0',
      unusedReturned: '0',
      handedConsumed: '0',
      stagedBalance: '0',
    });
  const handoffs = await all(
    tx,
    sql`select * from manufacturing_records where kind='material_handoff' and order_id=${id}::uuid order by created_at,id`,
  );
  for (const h of handoffs) {
    const m = material.get(h.item_id);
    if (m) {
      m.handed = dec(m.handed ?? 0)
        .plus(h.config.quantity)
        .toFixed(4);
      m.unusedReturned = dec(m.unusedReturned ?? 0)
        .plus(h.config.returnedQty ?? 0)
        .toFixed(4);
      m.handedConsumed = dec(m.handedConsumed ?? 0)
        .plus(h.config.consumedQty ?? 0)
        .toFixed(4);
      m.stagedBalance = dec(m.handed).minus(m.unusedReturned).minus(m.handedConsumed).toFixed(4);
    }
  }
  for (const d of documents.filter((d) => d.kind === 'issue'))
    for (const l of d.config.lines ?? []) {
      const current = material.get(l.itemId) ?? {
        itemId: l.itemId,
        issued: '0',
        returned: '0',
        net: '0',
      };
      current.issued = dec(current.issued).plus(l.quantity).toFixed(4);
      material.set(l.itemId, current);
    }
  const returns = await all(
    tx,
    sql`select d.config,i.config as original from leather_production_documents d join leather_production_documents i on i.id=(d.config->>'issueId')::uuid and i.company_id=d.company_id where d.order_id=${id}::uuid and d.kind='return'`,
  );
  for (const d of returns)
    for (const l of d.config.lines ?? []) {
      const source = d.original.lines[l.lineNo - 1],
        current = material.get(source?.itemId);
      if (current) current.returned = dec(current.returned).plus(l.quantity).toFixed(4);
    }
  for (const value of material.values())
    value.net = dec(value.issued).minus(value.returned).toFixed(4);
  const labels = await all(tx, sql`select id,code,name from items`);
  const transfers = await all(
    tx,
    sql`select status,config from manufacturing_records where kind='transfer' and order_id=${id}::uuid and status in ('dispatched','part_received','received')`,
  );
  return {
    order,
    phase: raw.config.executionPhase ?? order.status,
    sessions: sessions.map(recordShape),
    batches: batches.map(recordShape),
    handoffs: handoffs.map(recordShape),
    materials: [...material.values()].map((m) => ({
      ...m,
      itemName: labels.find((i) => i.id === m.itemId)?.name,
      code: labels.find((i) => i.id === m.itemId)?.code,
    })),
    operations: order.operations.map((op: Row) => ({
      ...op,
      queuedQty: Math.max(
        0,
        Number(
          transfers
            .filter((t) => t.config.toOperation === op.key)
            .reduce((s, t) => s.plus(t.config.receivedQty ?? 0), dec(0))
            .minus(op.completedQty ?? 0),
        ),
      ).toFixed(4),
      inTransitQty: transfers
        .filter((t) => t.config.toOperation === op.key)
        .reduce((s, t) => s.plus(dec(t.config.quantity).minus(t.config.receivedQty ?? 0)), dec(0))
        .toFixed(4),
      averageQueueMinutes: (() => {
        const received = transfers.filter(
          (t) => t.config.toOperation === op.key && t.config.receiveAt && t.config.dispatchAt,
        );
        return received.length
          ? received.reduce(
              (s, t) =>
                s + (Date.parse(t.config.receiveAt) - Date.parse(t.config.dispatchAt)) / 60000,
              0,
            ) / received.length
          : null;
      })(),
      processingQueue: (() => {
        const arrivals = transfers
          .filter((t) => t.config.toOperation === op.key)
          .flatMap((t) => {
            const accepted = (t.config.actions ?? [])
              .filter((a: Row) => a.action === 'receive')
              .map((a: Row) => ({ at: a.at, quantity: Number(a.quantity ?? t.config.quantity) }));
            return accepted.length
              ? accepted
              : t.config.receiveAt
                ? [{ at: t.config.receiveAt, quantity: Number(t.config.receivedQty ?? 0) }]
                : [];
          })
          .filter((a) => a.quantity > 0)
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const work = sessions
          .filter(
            (s) =>
              s.config.operationKey === op.key &&
              s.status === 'completed' &&
              Number(s.config.quantity) > 0,
          )
          .map((s) => ({ at: s.config.processingStartedAt ?? s.config.startedAt, quantity: Number(s.config.quantity) }))
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        return processingQueue(arrivals, work, Date.now());
      })(),
      waitingQty: dec(order.quantity)
        .minus(op.goodQty ?? 0)
        .toFixed(4),
    })),
  };
}
export async function lifecycle(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'lifecycle:' + id, input, async () => {
    const o = await one(
      tx,
      sql`select * from leather_production_orders where id=${id}::uuid for update`,
      'Üretim emri',
    );
    if (o.status === 'cancelled') throw fail('İptal emrin aşaması değişmez');
    const phase = o.config.executionPhase ?? o.status;
    const allowed: Record<string, string[]> = {
      material_waiting: ['planned', 'ready'],
      ready: ['planned', 'material_waiting', 'released', 'paused', 'on_hold'],
      paused: ['in_progress', 'released'],
      quality_waiting: ['in_progress', 'released', 'rework'],
      rework: ['quality_waiting'],
      on_hold: [
        'planned',
        'material_waiting',
        'ready',
        'released',
        'in_progress',
        'paused',
        'quality_waiting',
        'rework',
      ],
      closed: ['completed'],
    };
    if (!allowed[input.phase]?.includes(phase)) throw fail('Üretim aşaması geçişi uygun değil');
    const active = await one(
      tx,
      sql`select count(*)::int as n from manufacturing_records where kind='work_session' and order_id=${id}::uuid and status='running'`,
    );
    if (active.n) throw fail('Önce çalışan operasyon oturumlarını durdurun');
    if (input.phase === 'closed') {
      await requireOpenPeriod(tx, todayIso());
      const pending = await one(
        tx,
        sql`select count(*)::int as n from leather_quality_checks where scope='production' and source_id=${id}::uuid and status='pending'`,
      );
      const external = await one(
        tx,
        sql`select count(*)::int as n from leather_subcontract_jobs where order_id=${id}::uuid and status not in ('received','cancelled')`,
      );
      const handoffs = await one(
        tx,
        sql`select count(*)::int as n from manufacturing_records where kind='material_handoff' and order_id=${id}::uuid and (config->>'quantity')::numeric>coalesce((config->>'consumedQty')::numeric,0)+coalesce((config->>'returnedQty')::numeric,0)`,
      );
      if (handoffs.n)
        throw fail('Maliyet kapanışından önce atölyedeki kullanılmamış teslimleri iade edin');
      const rework = await one(
        tx,
        sql`select count(*)::int as n from manufacturing_records where kind='rework' and order_id=${id}::uuid and status<>'completed'`,
      );
      if (
        o.status !== 'completed' ||
        dec(o.wip_value).abs().gt('0.01') ||
        pending.n ||
        external.n ||
        rework.n
      )
        throw fail(
          'Maliyet kapanışı için tamamlanmış üretim, sıfırlanmış devam eden üretim maliyeti, kalite ve fason mutabakatı gerekli',
        );
      await createRecord(
        tx,
        ctx,
        'cost_close',
        { orderId: id, reason: input.reason, closedAt: new Date().toISOString() },
        'closed',
      );
    }
    await tx.execute(
      sql`update leather_production_orders set config=config||${json({ executionPhase: input.phase, phaseReason: input.reason })} where id=${id}::uuid`,
    );
    return { id, phase: input.phase };
  });
}
export async function createBatch(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'batch', input, async () => {
    const o = await getProduction(tx, input.orderId);
    if (['cancelled', 'completed'].includes(o.status)) throw fail('Açık üretim emri gerekli');
    const booked = await one(
      tx,
      sql`select coalesce(sum((config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='batch' and order_id=${o.id}::uuid and status<>'cancelled'`,
    );
    if (dec(booked.qty).plus(input.quantity).gt(o.quantity))
      throw fail('Üretim partilerinin toplamı emir miktarını aşamaz');
    return createRecord(
      tx,
      ctx,
      'batch',
      { orderId: o.id, quantity: input.quantity, operations: {}, reason: input.reason },
      'planned',
    );
  });
}
export async function workCommand(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'work:' + id, input, async () => {
    await requireOpenPeriod(tx, input.date);
    const o = await one(
      tx,
      sql`select * from leather_production_orders where id=${id}::uuid for update`,
      'Üretim emri',
    );
    if (
      !['released', 'in_progress'].includes(o.status) ||
      ['on_hold', 'closed', 'quality_waiting'].includes(o.config.executionPhase)
    )
      throw fail('Çalışma için üretime açık emir gerekli');
    const op = o.config.operations.find((p: Row) => p.key === input.operationKey);
    if (!op) throw fail('Operasyon sabitlenmiş rotada yok');
    if (input.batchId) {
      const batch = await getRecord(tx, input.batchId, 'batch');
      if (batch.order_id !== id) throw fail('Üretim partisi başka emre bağlı');
    }
    const sessions = await all(
      tx,
      sql`select * from manufacturing_records where kind='work_session' and order_id=${id}::uuid and config->>'operationKey'=${input.operationKey} and status='running' for update`,
    );
    if (input.action === 'start') {
      if (input.date !== todayIso()) throw fail('Canlı çalışma oturumu bugünün tarihini kullanır');
      if (sessions.length) throw fail('Operasyon zaten çalışıyor');
      if (!input.resourceId) throw fail('Çalışma kaynağı gerekli');
      const r = await getRecord(tx, input.resourceId, 'resource');
      if (r.status !== 'active') throw fail('Aktif kaynak gerekli');
      const now = new Date().toISOString();
      const calendar = await one(
        tx,
        sql`select count(*) filter(where (calendar.config->>'available')::boolean)::int as working,count(*) filter(where not (calendar.config->>'available')::boolean)::int as blocked from manufacturing_records calendar left join manufacturing_records maintenance on maintenance.kind='maintenance' and maintenance.id::text=calendar.config->>'maintenanceId' and maintenance.company_id=calendar.company_id where calendar.kind='calendar' and calendar.status='active' and calendar.config->>'resourceId'=${r.id} and (calendar.config->>'start')::timestamptz<=${now}::timestamptz and (maintenance.status='open' or calendar.config->>'end' is null or (calendar.config->>'end')::timestamptz>${now}::timestamptz)`,
      );
      if (!calendar.working || calendar.blocked)
        throw fail('Kaynak şu anda vardiya dışında veya bakım/devamsızlık nedeniyle kapalı');
      if (op.resources?.length && !op.resources.some((p: Row) => p.resourceId === r.id))
        throw fail('Kaynak onaylı operasyon için uygun değil');
      const overlapping = await one(
        tx,
        sql`select count(*) filter(where config->>'resourceId'=${r.id})::int as resource_jobs,count(*) filter(where created_by=${ctx.userId}::uuid)::int as user_jobs from manufacturing_records where kind='work_session' and status='running'`,
      );
      if (overlapping.resource_jobs >= Number(r.config.capacity) || overlapping.user_jobs)
        throw fail('Kaynak veya operatör başka işte çalışıyor');
      const previous = (await all(tx, sql`select status,created_by,config from manufacturing_records where kind='work_session' and order_id=${id}::uuid and config->>'operationKey'=${input.operationKey} order by created_at desc,id desc limit 1`))[0];
      const processingStartedAt = previous?.status === 'paused' && previous.created_by === ctx.userId && (previous.config.batchId ?? null) === (input.batchId ?? null)
        ? previous.config.processingStartedAt ?? previous.config.startedAt
        : now;
      await tx.execute(
        sql`update leather_production_orders set config=config||${json({ executionPhase: 'in_progress' })} where id=${id}::uuid`,
      );
      await recordOperation(
        tx,
        ctx,
        id,
        leatherOperationSchema.parse({
          date: input.date,
          requestKey: input.requestKey,
          key: input.operationKey,
          status: 'started',
          resourceId: r.id,
          batchId: input.batchId,
          note: input.reason,
        }),
      );
      return createRecord(
        tx,
        ctx,
        'work_session',
        {
          orderId: id,
          operationKey: input.operationKey,
          resourceId: r.id,
          batchId: input.batchId ?? null,
          startedAt: new Date().toISOString(),
          processingStartedAt,
          userId: ctx.userId,
        },
        'running',
      );
    }
    if (sessions.length !== 1 || sessions[0]!.created_by !== ctx.userId)
      throw fail('Kendi aktif operasyon oturumunuz gerekli');
    const session = sessions[0]!;
    const elapsed = Math.max(0, (Date.now() - Date.parse(session.config.startedAt)) / 60000);
    if (
      input.action === 'complete' &&
      input.batchId !== undefined &&
      input.batchId !== session.config.batchId
    )
      throw fail('Üretim partisi çalışma oturumuyla uyuşmuyor');
    await recordOperation(
      tx,
      ctx,
      id,
      leatherOperationSchema.parse({
        date: input.date,
        requestKey: input.requestKey,
        key: input.operationKey,
        status: input.action === 'pause' ? 'started' : 'completed',
        resourceId: session.config.resourceId,
        batchId: session.config.batchId ?? undefined,
        minutes: elapsed.toFixed(4),
        quantity: input.action === 'pause' ? '0' : input.quantity,
        goodQty: input.action === 'pause' ? '0' : input.goodQty,
        scrapQty: input.action === 'pause' ? '0' : input.scrapQty,
        reworkQty: input.action === 'pause' ? '0' : input.reworkQty,
        note: input.reason,
      }),
    );
    const record = await updateRecord(
      tx,
      session.id,
      input.action === 'pause' ? 'paused' : 'completed',
      {
        ...session.config,
        endedAt: new Date().toISOString(),
        minutes: elapsed.toFixed(4),
        quantity: input.quantity,
        goodQty: input.goodQty,
        scrapQty: input.scrapQty,
        reworkQty: input.reworkQty,
      },
    );
    if (input.action === 'pause')
      await tx.execute(
        sql`update leather_production_orders set config=config||${json({ executionPhase: 'paused' })} where id=${id}::uuid`,
      );
    return record;
  });
}
export async function createRework(tx: Tx, ctx: LeatherCtx, input: Row & { requestKey: string }) {
  return command(tx, ctx, 'rework', input, async () => {
    const order = await getProduction(tx, input.orderId),
      check = await one(
        tx,
        sql`select * from leather_quality_checks where id=${input.qualityCheckId}::uuid`,
        'Kalite kontrolü',
      );
    if (
      check.scope !== 'production' ||
      check.source_id !== order.id ||
      check.status !== 'approved' ||
      !order.operations.some((p: Row) => p.key === input.operationKey)
    )
      throw fail('Onaylı kaynak kalite kontrolü ve hedef operasyon gerekli');
    const booked = await one(
      tx,
      sql`select coalesce(sum((config->>'quantity')::numeric),0)::text as qty from manufacturing_records where kind='rework' and config->>'qualityCheckId'=${check.id}`,
    );
    if (
      dec(booked.qty)
        .plus(input.quantity)
        .gt(check.config.reworkQty ?? 0)
    )
      throw fail('Yeniden işleme miktarı kalite kontrolünde ayrılan miktarı aşamaz');
    return createRecord(
      tx,
      ctx,
      'rework',
      {
        ...input,
        batchId: check.config.batchId ?? null,
        sourceOperationKey: check.config.operationKey ?? input.operationKey,
      },
      'planned',
    );
  });
}
export async function reworkResult(
  tx: Tx,
  ctx: LeatherCtx,
  id: string,
  input: Row & { requestKey: string },
) {
  return command(tx, ctx, 'rework-result:' + id, input, async () => {
    await requireOpenPeriod(tx, input.date);
    const rework = await getRecord(tx, id, 'rework', true),
      order = await one(
        tx,
        sql`select * from leather_production_orders where id=${rework.order_id}::uuid for update`,
      );
    let retryRejected = false;
    if (rework.status === 'quality_waiting' && rework.config.recheckId) {
      const prior = await one(
        tx,
        sql`select status from leather_quality_checks where id=${rework.config.recheckId}::uuid`,
      );
      retryRejected = prior.status === 'rejected';
    }
    if (
      (rework.status !== 'planned' && !retryRejected) ||
      !['released', 'in_progress'].includes(order.status) ||
      ['on_hold', 'closed'].includes(order.config.executionPhase)
    )
      throw fail('Açık yeniden işleme ve üretim gerekli');
    const op = order.config.operations.find((o: Row) => o.key === rework.config.operationKey);
    const resource = await getRecord(tx, input.resourceId, 'resource');
    if (resource.status !== 'active') throw fail('Aktif yeniden işleme kaynağı gerekli');
    if (op.resources?.length && !op.resources.some((r: Row) => r.resourceId === input.resourceId))
      throw fail('Yeniden işleme kaynağı uygun değil');
    if (!dec(input.passedQty).plus(input.scrapQty).plus(input.secondQty).eq(rework.config.quantity))
      throw fail('Yeniden işleme sonuçları miktara eşit olmalı');
    const check = await createQuality(
      tx,
      ctx,
      leatherQualitySchema.parse({
        scope: 'production',
        sourceId: order.id,
        batchId: rework.config.batchId ?? undefined,
        stage: 'final',
        inspectedQty: rework.config.quantity,
        passedQty: input.passedQty,
        scrapQty: input.scrapQty,
        secondQty: input.secondQty,
        checks: [
          {
            label: 'Yeniden işleme son kontrolü',
            passed: dec(input.passedQty).eq(rework.config.quantity),
          },
        ],
        note: input.reason,
      }),
    );
    await tx.execute(
      sql`update leather_quality_checks set config=config||${json({ reworkId: id })} where id=${check.id}::uuid`,
    );
    await saveDocument(tx, ctx, {
      id: newId(),
      orderId: order.id,
      kind: 'operation',
      date: input.date,
      requestKey: input.requestKey,
      quantity: '0',
      config: {
        key: op.key,
        status: 'completed',
        resourceId: input.resourceId,
        minutes: input.minutes,
        goodQty: '0',
        rework: true,
        reworkId: id,
        batchId: rework.config.batchId ?? null,
        qualityCheckId: check.id,
        note: input.reason,
      },
    });
    if (rework.config.batchId) {
      const batch = await getRecord(tx, rework.config.batchId, 'batch', true);
      const operations = batch.config.operations ?? {};
      operations[op.key] = {
        ...(operations[op.key] ?? { goodQty: '0', reworkQty: '0', scrapQty: '0' }),
        minutes: dec(operations[op.key]?.minutes ?? 0)
          .plus(input.minutes)
          .toFixed(4),
        resourceId: input.resourceId,
      };
      await updateRecord(tx, batch.id, batch.status, { ...batch.config, operations });
    }
    op.actualMinutes = dec(op.actualMinutes ?? 0)
      .plus(input.minutes)
      .toFixed(4);
    await tx.execute(
      sql`update leather_production_orders set config=config||${json({ operations: order.config.operations, executionPhase: 'quality_waiting' })} where id=${order.id}::uuid`,
    );
    return updateRecord(tx, id, 'quality_waiting', {
      ...rework.config,
      ...input,
      recheckId: check.id,
    });
  });
}
