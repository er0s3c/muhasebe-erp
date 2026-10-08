import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeApp, registerUser, createCompany, client, addMember, asOwner, expectDbError, TODAY_LOCAL } from './helpers';

describe('üretim taahhüdü ve yürütme ekleri', async () => {
  const { app } = await makeApp(),
    owner = await registerUser(app, 'Execution');
  const company = await createCompany(app, owner.token, { sector: 'MANUFACTURING_WHOLESALE' }),
    c = client(app, owner.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const warehouse = (await ok(c.get('/api/warehouses'))).warehouses[0].id;
  const fg = (
    await ok(
      c.post('/api/items', {
        code: 'EX-FG',
        name: 'Taahhüt mamulü',
        unit: 'adet',
        inventoryRole: 'finished_goods',
      }),
      201,
    )
  ).item.id;
  const raw = (
    await ok(
      c.post('/api/items', {
        code: 'EX-RAW',
        name: 'Hammadde',
        unit: 'adet',
        inventoryRole: 'raw_material',
      }),
      201,
    )
  ).item.id;
  const receipt = (
    await ok(
      c.post('/api/stock-documents', {
        type: 'opening',
        docDate: TODAY_LOCAL,
        warehouseId: warehouse,
        lines: [
          { itemId: fg, quantity: '500', unitCost: '10' },
          { itemId: raw, quantity: '1000', unitCost: '1' },
        ],
      }),
      201,
    )
  ).document.id;
  const party = (
    await ok(
      c.post('/api/parties', { code: 'EX-CUSTOMER', name: 'Müşteri', kind: 'customer' }),
      201,
    )
  ).party.id;
  const sale = async (quantity: string) => {
    const doc = (
      await ok(
        c.post('/api/sales-docs', {
          kind: 'order',
          partyId: party,
          warehouseId: warehouse,
          docDate: TODAY_LOCAL,
          currency: 'TRY',
          lines: [{ itemId: fg, quantity, unitPrice: '20' }],
        }),
        201,
      )
    ).doc;
    await ok(c.post(`/api/sales-docs/${doc.id}/confirm`, {}));
    const detail = await ok(c.get(`/api/sales-docs/${doc.id}`));
    return { id: doc.id, lineId: detail.lines[0].id };
  };
  const a = await sale('600'),
    b = await sale('200'),
    d = await sale('200');
  const key = () => ({ requestKey: randomUUID(), reason: 'Kabul testi' });
  const anchor = TODAY_LOCAL + 'T08:00:00Z';
  const resource = (
    await ok(
      c.post('/api/manufacturing/resources', {
        code: 'EX-MACHINE',
        name: 'Dikim',
        type: 'machine',
      }),
    )
  ).record.id;
  await ok(
    c.post('/api/manufacturing/calendars', {
      resourceId: resource,
      start: anchor,
      end: TODAY_LOCAL + 'T18:00:00Z',
      available: true,
      reason: 'shift',
    }),
  );
  const model = (
    await ok(
      c.post('/api/manufacturing/catalog/models', {
        code: 'EX-MODEL',
        name: 'Model',
        family: 'Genel',
      }),
      201,
    )
  ).model.id;
  const revision = (
    await ok(
      c.post(`/api/manufacturing/catalog/models/${model}/revisions`, {
        name: 'Onaylı rota',
        sampleApproved: true,
        materials: [{ itemId: raw, quantity: '1' }],
        operations: [
          {
            key: 'sew',
            name: 'Dikim',
            plannedMinutes: '2',
            resources: [{ resourceId: resource, minutesPerUnit: '1' }],
          },
        ],
      }),
      201,
    )
  ).revision.id;
  await ok(c.post(`/api/manufacturing/catalog/revisions/${revision}/approve`, {}));
  const variant = (
    await ok(
      c.post('/api/manufacturing/catalog/variants', {
        modelId: model,
        revisionId: revision,
        itemId: fg,
        color: 'Standart',
      }),
      201,
    )
  ).variant.id;
  it('500−300−50=150 ATP; tahsis ve eşzamanlı talepler aynı stoğu kullanamaz', async () => {
    const lot = (
      await ok(
        c.post('/api/wms/lots', {
          code: 'EX-HOLD',
          itemId: fg,
          warehouseId: warehouse,
          sourceDocumentId: receipt,
          quantity: '50',
        }),
      )
    ).record.id;
    const input = {
      ...key(),
      salesOrderLineId: a.lineId,
      warehouseId: warehouse,
      quantity: '300',
      priority: 90,
    };
    const first = await ok(c.post('/api/manufacturing/allocations', input));
    expect((await ok(c.post('/api/manufacturing/allocations', input))).record.id).toBe(
      first.record.id,
    );
    expect(
      (await c.post('/api/manufacturing/allocations', { ...input, quantity: '301' })).statusCode,
    ).toBe(422);
    const atp = await ok(
      c.post('/api/manufacturing/promise', { salesOrderId: b.id, warehouseId: warehouse, anchor }),
    );
    expect(atp.lines[0]).toMatchObject({ atp: '150.0000', productionQty: '50.0000' });
    expect(atp.lines[0].stock).toMatchObject({
      physical: '500.0000',
      qualityHold: '50.0000',
      salesAllocated: '300.0000',
    });
    const results = await Promise.all(
      [b, d].map((s) =>
        c.post('/api/manufacturing/allocations', {
          ...key(),
          salesOrderLineId: s.lineId,
          warehouseId: warehouse,
          quantity: '100',
          priority: 50,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    await ok(
      c.post(`/api/wms/lots/${lot}/quality-quantity`, {
        ...key(),
        releasedQty: '20',
        damagedQty: '5',
      }),
    );
    const available = await ok(
      c.get(`/api/manufacturing/stock-availability?itemId=${fg}&warehouseId=${warehouse}`),
    );
    expect(available.qualityHold).toBe('30.0000');
  });
  it('CTP uygun alternatif kaynakta gerçek vardiya kullanır; simülasyon gerçek takvimi değiştirmez', async () => {
    const promise = await ok(
      c.post('/api/manufacturing/promise', { salesOrderId: b.id, warehouseId: warehouse, anchor }),
    );
    expect(promise.lines[0].expectedAt).toBeTruthy();
    expect(promise.lines[0].reasons).toEqual([]);
    expect(promise.lines[0].operations[0].resourceId).toBe(resource);
    const order = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '10',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
        }),
        201,
      )
    ).order.id;
    const plan = (
      await ok(
        c.post('/api/manufacturing/planning/schedules', {
          anchor,
          direction: 'forward',
          jobs: [{ orderId: order, operationKey: 'sew', resourceId: resource, minutes: 20 }],
        }),
      )
    ).record;
    const before = (await ok(c.get('/api/manufacturing/calendars'))).records.length;
    const simulated = (
      await ok(
        c.post('/api/manufacturing/planning/scenarios', {
          ...key(),
          parentId: plan.id,
          calendarOverrides: [
            {
              resourceId: resource,
              start: anchor,
              end: TODAY_LOCAL + 'T08:10:00Z',
              available: false,
            },
          ],
        }),
      )
    ).record;
    expect(simulated.version).toBe(2);
    expect(simulated.parentId).toBe(plan.id);
    expect(simulated.operations[0].start).toBe(TODAY_LOCAL + 'T08:10:00.000Z');
    expect((await ok(c.get('/api/manufacturing/calendars'))).records).toHaveLength(before);
    expect(
      (await c.post(`/api/manufacturing/planning/schedules/${simulated.id}/publish`, {}))
        .statusCode,
    ).toBe(422);
  });
  it('atanmış operatör, batch sınırı, başlat/duraklat/tamamla ve tekrar komutu', async () => {
    await ok(
      c.post('/api/manufacturing/calendars', {
        resourceId: resource,
        start: new Date(Date.now() - 3600000).toISOString(),
        end: new Date(Date.now() + 3600000).toISOString(),
        available: true,
        reason: 'shift',
      }),
    );
    const worker = await addMember(app, c, company.id, 'operator', 'ExecutionWorker');
    await ok(
      c.put(`/api/company/members/${worker.userId}/module-access`, {
        levels: { 'manufacturing.production': 'write' },
      }),
    );
    const order = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '10',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
          assignedUserId: worker.userId,
        }),
        201,
      )
    ).order.id;
    await ok(
      c.post(`/api/manufacturing/production/orders/${order}/release`, {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
      }),
    );
    const batch = (
      await ok(c.post('/api/manufacturing/batches', { ...key(), orderId: order, quantity: '5' }))
    ).record.id;
    expect(
      (await c.post('/api/manufacturing/batches', { ...key(), orderId: order, quantity: '6' }))
        .statusCode,
    ).toBe(422);
    const input = {
      ...key(),
      action: 'start',
      operationKey: 'sew',
      resourceId: resource,
      batchId: batch,
      date: TODAY_LOCAL,
    };
    const started = await ok(
      worker.client.post(`/api/manufacturing/production/orders/${order}/work`, input),
    );
    expect(
      (await ok(worker.client.post(`/api/manufacturing/production/orders/${order}/work`, input)))
        .record.id,
    ).toBe(started.record.id);
    await ok(
      worker.client.post(`/api/manufacturing/production/orders/${order}/work`, {
        ...key(),
        action: 'pause',
        operationKey: 'sew',
        date: TODAY_LOCAL,
      }),
    );
    await ok(
      worker.client.post(`/api/manufacturing/production/orders/${order}/work`, {
        ...input,
        ...key(),
      }),
    );
    await ok(
      worker.client.post(`/api/manufacturing/production/orders/${order}/work`, {
        ...key(),
        action: 'complete',
        operationKey: 'sew',
        batchId: batch,
        date: TODAY_LOCAL,
        quantity: '5',
        goodQty: '5',
      }),
    );
    const detail = await ok(
      worker.client.get(`/api/manufacturing/production/orders/${order}/execution`),
    );
    expect(detail.order.operations[0].goodQty).toBe('5.0000');
    expect(detail.sessions).toHaveLength(2);
    expect(detail.sessions.every((s: { processingStartedAt: string }) => s.processingStartedAt === started.record.processingStartedAt)).toBe(true);
    expect(detail.order.wipValue).toBeNull();
    const outsider = await addMember(app, c, company.id, 'operator', 'ExecutionOther');
    await ok(
      c.put(`/api/company/members/${outsider.userId}/module-access`, {
        levels: { 'manufacturing.production': 'write' },
      }),
    );
    expect(
      (await outsider.client.get(`/api/manufacturing/production/orders/${order}/execution`))
        .statusCode,
    ).toBe(404);
  });
  it('batch sarfı, kısmi kalite kabulü ve mamul partisi aynı kaynağı korur', async () => {
    const order = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '10',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
        }),
        201,
      )
    ).order.id;
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/release', {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
      }),
    );
    const batch = (
      await ok(c.post('/api/manufacturing/batches', { ...key(), orderId: order, quantity: '5' }))
    ).record.id;
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/issues', {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
        batchId: batch,
        lines: [{ itemId: raw, quantity: '10' }],
      }),
    );
    const qc = (
      await ok(
        c.post('/api/manufacturing/quality/checks', {
          scope: 'production',
          sourceId: order,
          batchId: batch,
          stage: 'final',
          inspectedQty: '5',
          passedQty: '5',
          checks: [{ label: 'Batch son kontrol', passed: true }],
        }),
        201,
      )
    ).check.id;
    await ok(
      c.post('/api/manufacturing/quality/checks/' + qc + '/decision', { decision: 'approve' }),
    );
    expect(
      (
        await c.post('/api/manufacturing/production/orders/' + order + '/completions', {
          date: TODAY_LOCAL,
          requestKey: randomUUID(),
          quantity: '2',
          qualityCheckId: qc,
        })
      ).statusCode,
    ).toBe(422);
    const accept = {
      date: TODAY_LOCAL,
      requestKey: randomUUID(),
      batchId: batch,
      quantity: '2',
      qualityCheckId: qc,
    };
    const first = (
      await ok(c.post('/api/manufacturing/production/orders/' + order + '/completions', accept))
    ).document;
    expect(
      (await ok(c.post('/api/manufacturing/production/orders/' + order + '/completions', accept)))
        .document.id,
    ).toBe(first.id);
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/completions', {
        ...accept,
        requestKey: randomUUID(),
        quantity: '3',
      }),
    );
    const detail = await ok(c.get('/api/manufacturing/production/orders/' + order + '/execution'));
    expect(detail.batches[0]).toMatchObject({ completedQty: '5.0000', status: 'completed' });
    const lots = (await ok(c.get('/api/wms/lots'))).records.filter(
      (l: { orderId: string }) => l.orderId === order,
    );
    expect(lots).toHaveLength(2);
    expect(lots.every((l: { batchId: string }) => l.batchId === batch)).toBe(true);
  });
  it('yeniden işleme reddedilirse tekrar yapılır; iyi adet yalnız kalite onayında artar', async () => {
    const source = await sale('1000');
    const order = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '10',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
          salesOrderLineId: source.lineId,
        }),
        201,
      )
    ).order.id;
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/release', {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
      }),
    );
    const batch = (
      await ok(c.post('/api/manufacturing/batches', { ...key(), orderId: order, quantity: '10' }))
    ).record.id;
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/operations', {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
        batchId: batch,
        key: 'sew',
        status: 'completed',
        resourceId: resource,
        minutes: '20',
        quantity: '10',
        goodQty: '8',
        reworkQty: '2',
      }),
    );
    const qc = (await ok(c.get('/api/manufacturing/quality/checks'))).checks.find(
      (q: { sourceId: string }) => q.sourceId === order,
    );
    await ok(
      c.post('/api/manufacturing/quality/checks/' + qc.id + '/decision', { decision: 'approve' }),
    );
    expect(qc.batchId).toBe(batch);
    const rework = (
      await ok(
        c.post('/api/manufacturing/rework', {
          ...key(),
          orderId: order,
          qualityCheckId: qc.id,
          operationKey: 'sew',
          quantity: '2',
          defectCode: 'DIKIS',
        }),
      )
    ).record.id;
    const pendingPromise = (await ok(c.post('/api/manufacturing/promise', {
      salesOrderId: source.id, warehouseId: warehouse, anchor,
    }))).lines[0];
    expect(pendingPromise.expectedAt).toBeNull();
    expect(pendingPromise.reasons.join(' ')).toContain('yeniden işleme açık');
    const result = {
      ...key(),
      date: TODAY_LOCAL,
      resourceId: resource,
      minutes: '10',
      passedQty: '2',
    };
    const rejected = (await ok(c.post('/api/manufacturing/rework/' + rework + '/result', result)))
      .record;
    await ok(
      c.post('/api/manufacturing/quality/checks/' + rejected.recheckId + '/decision', {
        decision: 'reject',
      }),
    );
    expect(
      (await ok(c.get('/api/manufacturing/production/orders/' + order))).order.operations[0]
        .goodQty,
    ).toBe('8.0000');
    const redo = { ...result, ...key(), minutes: '5' };
    const passed = (await ok(c.post('/api/manufacturing/rework/' + rework + '/result', redo)))
      .record;
    await ok(
      c.post('/api/manufacturing/quality/checks/' + passed.recheckId + '/decision', {
        decision: 'approve',
      }),
    );
    await ok(c.post('/api/manufacturing/rework/' + rework + '/result', redo));
    const completedPromise = (await ok(c.post('/api/manufacturing/promise', {
      salesOrderId: source.id, warehouseId: warehouse, anchor,
    }))).lines[0];
    expect(completedPromise.reasons.join(' ')).not.toContain('yeniden işleme açık');
    const batchResult = (await ok(c.get('/api/manufacturing/production/batches'))).records.find(
      (r: { id: string }) => r.id === batch,
    );
    expect(batchResult.operations.sew).toMatchObject({
      goodQty: '10.0000',
      reworkQty: '0.0000',
      minutes: '35.0000',
    });
    const updated = (await ok(c.get('/api/manufacturing/production/orders/' + order))).order;
    expect(updated.operations[0]).toMatchObject({
      goodQty: '10.0000',
      reworkQty: '0.0000',
      actualMinutes: '35.0000',
    });
    expect(
      (await c.post('/api/manufacturing/rework/' + rework + '/result', { ...redo, ...key() }))
        .statusCode,
    ).toBe(422);
  });
  it('üretim komut olayları tablo sahibi için de değiştirilemez ve silinemez', async () => {
    await asOwner(async q => {
      const event = (await q("select id from manufacturing_records where company_id=$1 and kind='command_event' limit 1", [company.id])).rows[0];
      expect(event).toBeTruthy();
      expect((await expectDbError(q, "update manufacturing_records set status='changed' where id=$1", [event.id])).message).toContain('değiştirilemez');
      expect((await expectDbError(q, 'delete from manufacturing_records where id=$1', [event.id])).message).toContain('değiştirilemez');
    });
  });
  it('kalite profili yeniden işleme izini üretim yetkisi olmadan okur; sonuç yazma ve üretim API kapıları kapalıdır', async () => {
    const member = await addMember(app, c, company.id, 'operations_manager', 'ExecutionQuality');
    await ok(c.put(`/api/company/members/${member.userId}/module-access`, {
      levels: { 'manufacturing.production': 'none', 'manufacturing.quality': 'write' },
    }));
    expect((await member.client.get('/api/manufacturing/quality/rework')).statusCode).toBe(200);
    expect((await member.client.get('/api/manufacturing/rework')).statusCode).toBe(403);
    expect((await member.client.post('/api/manufacturing/rework/' + randomUUID() + '/result', {})).statusCode).toBe(403);
  });
  it('ham madde kabulünde aynı SKU satırları karantinaya girer; parçalı kalite toplamı korunur', async () => {
    const receipt = (
      await ok(
        c.post('/api/stock-documents', {
          type: 'receipt',
          docDate: TODAY_LOCAL,
          warehouseId: warehouse,
          lines: [
            { itemId: raw, quantity: '3', unitCost: '1' },
            { itemId: raw, quantity: '7', unitCost: '1' },
          ],
        }),
        201,
      )
    ).document.id;
    const lots = (await ok(c.get('/api/wms/lots'))).records.filter(
      (l: { sourceDocumentId: string }) => l.sourceDocumentId === receipt,
    );
    expect(lots).toHaveLength(2);
    expect(
      lots
        .map((l: { quantity: string }) => Number(l.quantity))
        .sort((a: number, b: number) => a - b),
    ).toEqual([3, 7]);
    expect(lots.every((l: { status: string }) => l.status === 'quarantine')).toBe(true);
    expect(
      (
        await c.post('/api/wms/lots/' + lots[0].id + '/quality-quantity', {
          ...key(),
          releasedQty: '10',
        })
      ).statusCode,
    ).toBe(422);
  });
  it('tedarikçi MOQ/paket ve minimum stok önerisi kaynak servise bağlanır', async () => {
    const supplier = (
      await ok(c.post('/api/parties', { code: 'EX-SUP', name: 'Tedarikçi', kind: 'supplier' }), 201)
    ).party.id;
    await ok(
      c.post('/api/manufacturing/supplier-profiles', {
        ...key(),
        itemId: raw,
        partyId: supplier,
        leadDays: 5,
        minOrderQty: '100',
        packQty: '25',
        unitPrice: '3',
        currency: 'TRY',
        supplierCode: 'TED-RAW',
      }),
    );
    const result = await ok(
      c.post('/api/manufacturing/mrp/proposals', {
        anchor,
        needs: [{ itemId: raw, net: '51', action: 'purchase', name: 'Hammadde' }],
      }),
    );
    expect(result.proposals[0].suppliers[0]).toMatchObject({
      quantity: '100.0000',
      leadDays: 5,
      supplierCode: 'TED-RAW',
    });
    await ok(
      c.post('/api/manufacturing/demand-policies', {
        ...key(),
        itemId: raw,
        warehouseId: warehouse,
        minimum: '2000',
        target: '2500',
      }),
    );
    expect((await ok(c.get('/api/manufacturing/replenishment'))).recommendations).toHaveLength(1);
  });
  it('siparişe bağlı açık üretim tekrar üretim önerisine dönüşmez; plansız işte termin uydurulmaz', async () => {
    const source = await sale('1000');
    const created = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '20',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
          salesOrderLineId: source.lineId,
        }),
        201,
      )
    ).order;
    const result = (
      await ok(
        c.post('/api/manufacturing/promise', {
          salesOrderId: source.id,
          warehouseId: warehouse,
          anchor,
        }),
      )
    ).lines[0];
    expect(result.openProductionQty).toBe('20.0000');
    expect(Number(result.newProductionQty)).toBe(Number(result.productionQty) - 20);
    expect(result.existingOrders[0].id).toBe(created.id);
    expect(result.expectedAt).toBeNull();
    expect(result.reasons.join(' ')).toContain('yayımlanmış gelecek plan yok');
  });
  it('atölye teslimi değer yaratmaz; gerçek sarf teslimi tüketir ve kullanılmayan miktar izli iade edilir', async () => {
    const order = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant,
          revisionId: revision,
          quantity: '10',
          warehouseId: warehouse,
          outputWarehouseId: warehouse,
        }),
        201,
      )
    ).order.id;
    await ok(
      c.post('/api/manufacturing/production/orders/' + order + '/release', {
        date: TODAY_LOCAL,
        requestKey: randomUUID(),
      }),
    );
    const path = '/api/manufacturing/production/orders/' + order;
    const before = await ok(
      c.get('/api/manufacturing/stock-availability?itemId=' + raw + '&warehouseId=' + warehouse),
    );
    const input = { ...key(), action: 'deliver', date: TODAY_LOCAL, itemId: raw, quantity: '5' };
    const handoff = (await ok(c.post(path + '/material-handoff', input))).record;
    expect((await ok(c.post(path + '/material-handoff', input))).record.id).toBe(handoff.id);
    expect(
      (
        await ok(
          c.get(
            '/api/manufacturing/stock-availability?itemId=' + raw + '&warehouseId=' + warehouse,
          ),
        )
      ).physical,
    ).toBe(before.physical);
    expect(Number((await ok(c.get(path))).order.wipValue)).toBe(0);
    await ok(
      c.post(path + '/material-handoff', {
        ...key(),
        action: 'return',
        date: TODAY_LOCAL,
        itemId: raw,
        handoffId: handoff.id,
        quantity: '1',
      }),
    );
    const issue = {
      date: TODAY_LOCAL,
      requestKey: randomUUID(),
      lines: [{ itemId: raw, quantity: '3' }],
    };
    const posted = (await ok(c.post(path + '/issues', issue))).document;
    await ok(c.post(path + '/issues', issue));
    expect(posted.config.handoffs).toEqual([
      { handoffId: handoff.id, lineNo: 1, quantity: '3.0000' },
    ]);
    expect(
      (
        await c.post(path + '/material-handoff', {
          ...key(),
          action: 'return',
          date: TODAY_LOCAL,
          itemId: raw,
          handoffId: handoff.id,
          quantity: '2',
        })
      ).statusCode,
    ).toBe(422);
    await ok(
      c.post(path + '/material-handoff', {
        ...key(),
        action: 'return',
        date: TODAY_LOCAL,
        itemId: raw,
        handoffId: handoff.id,
        quantity: '1',
      }),
    );
    const summary = await ok(c.get(path + '/execution'));
    expect(summary.materials.find((m: { itemId: string }) => m.itemId === raw)).toMatchObject({
      handed: '5.0000',
      unusedReturned: '2.0000',
      issued: '3.0000',
      net: '3.0000',
      stagedBalance: '0.0000',
    });
    expect(
      Number(
        (
          await ok(
            c.get(
              '/api/manufacturing/stock-availability?itemId=' + raw + '&warehouseId=' + warehouse,
            ),
          )
        ).physical,
      ),
    ).toBe(Number(before.physical) - 3);
  });
});
