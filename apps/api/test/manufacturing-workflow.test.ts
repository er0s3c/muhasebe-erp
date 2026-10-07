import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeApp, registerUser, createCompany, client, addMember, TODAY_LOCAL } from './helpers';

describe('üretim kabulü, depo ve kapasite', async () => {
  const { app } = await makeApp(),
    user = await registerUser(app, 'MfgWorkflow');
  const company = await createCompany(app, user.token, { sector: 'MANUFACTURING_WHOLESALE' }),
    c = client(app, user.token, company.id);
  const ok = async (p: ReturnType<typeof c.get>, status = 200) => {
    const r = await p;
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const wh = (await ok(c.get('/api/warehouses'))).warehouses[0].id;
  const item = async (code: string, role: string) =>
    (await ok(c.post('/api/items', { code, name: code, unit: 'adet', inventoryRole: role }), 201))
      .item.id;
  const raw = await item('W-RAW', 'raw_material'),
    fg = await item('W-FG', 'finished_goods'),
    by = await item('W-BY', 'finished_goods'),
    spare = await item('W-SPARE', 'raw_material');
  const opening = (
    await ok(
      c.post('/api/stock-documents', {
        type: 'opening',
        docDate: TODAY_LOCAL,
        warehouseId: wh,
        lines: [
          { itemId: raw, quantity: '100', unitCost: '10' },
          { itemId: spare, quantity: '10', unitCost: '5' },
        ],
      }),
      201,
    )
  ).document.id;
  const m = (
    await ok(
      c.post('/api/manufacturing/catalog/models', {
        code: 'W-MODEL',
        name: 'Ortak üretim',
        family: 'Metal işleme',
      }),
      201,
    )
  ).model.id;
  const rev = (
    await ok(
      c.post(`/api/manufacturing/catalog/models/${m}/revisions`, {
        name: 'Yan ürün reçetesi',
        sampleApproved: true,
        materials: [{ itemId: raw, quantity: '2' }],
        byproducts: [{ itemId: by, quantity: '1', costShare: '0.2' }],
        operations: [
          { key: 'first', name: 'Kesim', plannedMinutes: '3' },
          { key: 'second', name: 'Montaj' },
        ],
      }),
      201,
    )
  ).revision.id;
  await ok(c.post(`/api/manufacturing/catalog/revisions/${rev}/approve`, {}));
  const v = (
    await ok(
      c.post('/api/manufacturing/catalog/variants', {
        modelId: m,
        revisionId: rev,
        itemId: fg,
        color: 'Standart',
      }),
      201,
    )
  ).variant.id;
  const order = (
    await ok(
      c.post('/api/manufacturing/production/orders', {
        variantId: v,
        revisionId: rev,
        quantity: '10',
        warehouseId: wh,
        outputWarehouseId: wh,
      }),
      201,
    )
  ).order.id;
  const action = () => ({ date: TODAY_LOCAL, requestKey: randomUUID() });
  let lot: string, issue: string;
  it('kaynak kabul miktarı, kalite blokesi ve doğrudan serbest bırakma yetkisini denetler', async () => {
    lot = (
      await ok(
        c.post('/api/wms/lots', {
          code: 'W-LOT',
          itemId: raw,
          warehouseId: wh,
          sourceDocumentId: opening,
          quantity: '100',
        }),
      )
    ).record.id;
    expect(
      (await c.post(`/api/manufacturing/production/orders/${order}/release`, action())).statusCode,
    ).toBe(422);
    expect(
      (
        await c.post('/api/wms/lots', {
          code: 'W-OVER',
          itemId: raw,
          warehouseId: wh,
          sourceDocumentId: opening,
          quantity: '1',
        })
      ).statusCode,
    ).toBe(422);
    const depot = await addMember(app, c, company.id, 'operator', 'MfgDepot');
    await ok(
      c.put(`/api/company/members/${depot.userId}/module-access`, {
        levels: { 'inventory.wms': 'write' },
      }),
    );
    expect(
      (
        await depot.client.post('/api/wms/lots', {
          code: 'W-BYPASS',
          itemId: spare,
          warehouseId: wh,
          sourceDocumentId: opening,
          quantity: '1',
          status: 'available',
        })
      ).statusCode,
    ).toBe(403);
    await ok(
      c.post(`/api/wms/lots/${lot}/actions`, { action: 'release', requestKey: randomUUID() }),
    );
    await ok(c.post(`/api/manufacturing/production/orders/${order}/release`, action()));
    await ok(c.post(`/api/wms/lots/${lot}/actions`, { action: 'block', requestKey: randomUUID() }));
    expect(
      (
        await c.post(`/api/manufacturing/production/orders/${order}/issues`, {
          ...action(),
          lines: [{ itemId: raw, quantity: '20' }],
        })
      ).statusCode,
    ).toBe(422);
    await ok(
      c.post(`/api/wms/lots/${lot}/actions`, { action: 'release', requestKey: randomUUID() }),
    );
  });
  it('parti sarfı ve kaynak iadesi miktar ile maliyeti birlikte geri taşır', async () => {
    const body = {
      ...action(),
      lines: [{ itemId: raw, quantity: '20', lotAllocations: [{ lotId: lot, quantity: '20' }] }],
    };
    issue = (await ok(c.post(`/api/manufacturing/production/orders/${order}/issues`, body)))
      .document.id;
    await ok(c.post(`/api/manufacturing/production/orders/${order}/issues`, body));
    expect(
      (await ok(c.get('/api/wms/lots'))).records.find((r: { id: string }) => r.id === lot)
        .remainingQty,
    ).toBe('80.0000');
    await ok(
      c.post(`/api/manufacturing/production/orders/${order}/returns`, {
        ...action(),
        issueId: issue,
        lines: [{ lineNo: 1, quantity: '4' }],
      }),
    );
    expect(
      (await ok(c.get('/api/wms/lots'))).records.find((r: { id: string }) => r.id === lot)
        .remainingQty,
    ).toBe('84.0000');
    expect((await ok(c.get(`/api/manufacturing/production/orders/${order}`))).order.wipValue).toBe(
      '160.0000',
    );
  });
  it('operasyon transferinde kısmi kabul ve tekrar isteği aynı sonucu verir', async () => {
    await ok(
      c.post(`/api/manufacturing/production/orders/${order}/operations`, {
        ...action(),
        key: 'first',
        status: 'completed',
        quantity: '10',
        goodQty: '10',
        minutes: '30',
      }),
    );
    const transfer = (
      await ok(
        c.post('/api/manufacturing/transfers', {
          orderId: order,
          fromOperation: 'first',
          toOperation: 'second',
          quantity: '10',
        }),
      )
    ).record.id;
    for (const a of ['approve', 'dispatch'])
      await ok(
        c.post(`/api/manufacturing/transfers/${transfer}/actions`, {
          action: a,
          requestKey: randomUUID(),
        }),
      );
    const accept = { action: 'receive', quantity: '3', requestKey: randomUUID() };
    await ok(c.post(`/api/manufacturing/transfers/${transfer}/actions`, accept));
    const again = (await ok(c.post(`/api/manufacturing/transfers/${transfer}/actions`, accept)))
      .record;
    expect(again.status).toBe('part_received');
    expect(again.receivedQty).toBe('3.0000');
  });
  it('bakım plan yayımlama kontrolünü değiştirir ve yedek parça bir kez sarf edilir', async () => {
    const resource = (
      await ok(
        c.post('/api/manufacturing/resources', {
          code: 'W-MACHINE',
          name: 'Test makinesi',
          type: 'machine',
        }),
      )
    ).record.id;
    const start = TODAY_LOCAL + 'T08:00:00Z';
    await ok(
      c.post('/api/manufacturing/calendars', {
        resourceId: resource,
        start,
        end: TODAY_LOCAL + 'T17:00:00Z',
        available: true,
        reason: 'shift',
      }),
    );
    const payload = {
      anchor: start,
      jobs: [{ orderId: order, operationKey: 'second', resourceId: resource, minutes: 120 }],
    };
    const scenario = (await ok(c.post('/api/manufacturing/planning/schedules', payload))).record.id;
    const maintenance = (
      await ok(
        c.post('/api/manufacturing/maintenance', {
          resourceId: resource,
          start,
          end: TODAY_LOCAL + 'T09:00:00Z',
          kind: 'breakdown',
          description: 'Arıza',
          warehouseId: wh,
          spareParts: [{ itemId: spare, quantity: '2' }],
        }),
      )
    ).record.id;
    expect(
      (await c.post(`/api/manufacturing/planning/schedules/${scenario}/publish`, {})).statusCode,
    ).toBe(422);
    await ok(c.put(`/api/manufacturing/planning/schedules/${scenario}`, payload));
    await ok(c.post(`/api/manufacturing/planning/schedules/${scenario}/publish`, {}));
    const command = { action: 'complete', ...action() };
    const first = (
      await ok(c.post(`/api/manufacturing/maintenance/${maintenance}/complete`, command))
    ).record;
    const repeated = (
      await ok(c.post(`/api/manufacturing/maintenance/${maintenance}/complete`, command))
    ).record;
    expect(repeated.stockDocumentId).toBe(first.stockDocumentId);
    const metrics = await ok(
      c.get(`/api/manufacturing/maintenance/metrics?from=${TODAY_LOCAL}&to=${TODAY_LOCAL}`),
    );
    expect(metrics.metrics[0].mttrMinutes).toBe(60);
    expect(metrics.metrics[0].oee).toBeNull();
  });
  it('yan ürün değeri ikinci kez yaratılmaz; 160 TL 128/32 bölünür', async () => {
    const quality = (
      await ok(
        c.post('/api/manufacturing/quality/checks', {
          scope: 'production',
          sourceId: order,
          stage: 'final',
          inspectedQty: '10',
          passedQty: '10',
          checks: [{ label: 'Son kontrol', passed: true }],
        }),
        201,
      )
    ).check.id;
    await ok(
      c.post(`/api/manufacturing/quality/checks/${quality}/decision`, { decision: 'approve' }),
    );
    const accepted = (
      await ok(
        c.post(`/api/manufacturing/production/orders/${order}/completions`, {
          ...action(),
          quantity: '10',
          qualityCheckId: quality,
          final: true,
        }),
      )
    ).document;
    const stock = await ok(c.get(`/api/stock-documents/${accepted.stockDocumentId}`));
    expect(stock.lines.map((r: { value: string }) => Number(r.value))).toEqual([128, 32]);
    expect((await ok(c.get(`/api/manufacturing/production/orders/${order}`))).order.wipValue).toBe(
      '0.0000',
    );
  });
  it('PDKS ve özel alanlar kaynak kapasitesine, gerçek parça başı prim mevcut bordroya bağlanır', async () => {
    const employee = (
      await ok(
        c.post('/api/employees', { fullName: 'Üretim personeli', hireDate: TODAY_LOCAL }),
        201,
      )
    ).employee.id;
    const resource = (
      await ok(
        c.post('/api/manufacturing/resources', {
          code: 'W-PERSON',
          name: 'Üretim personeli',
          type: 'person',
          employeeId: employee,
        }),
      )
    ).record.id;
    await ok(
      c.post('/api/manufacturing/custom-fields', {
        code: 'skill',
        name: 'Yetkinlik',
        entity: 'resource',
        type: 'choice',
        required: true,
        choices: ['Montaj', 'Paketleme'],
      }),
    );
    expect(
      (
        await c.put(`/api/manufacturing/custom-values/resource/${resource}`, {
          values: { skill: 'Yanlış' },
        })
      ).statusCode,
    ).toBe(422);
    await ok(
      c.put(`/api/manufacturing/custom-values/resource/${resource}`, {
        values: { skill: 'Montaj' },
      }),
    );
    expect(
      (await ok(c.get(`/api/manufacturing/custom-values/resource/${resource}`))).values.skill,
    ).toBe('Montaj');
    const connection = (
      await ok(c.post('/api/integrations/connections', { name: 'Dosya PDKS', provider: 'pdks' }))
    ).record.id;
    const absence = {
      requestKey: randomUUID(),
      attendance: { entries: [{ employeeId: employee, workDate: TODAY_LOCAL, dayType: 'absent' }] },
    };
    const first = (
      await ok(c.post(`/api/integrations/connections/${connection}/attendance-file`, absence))
    ).record;
    expect(
      (await ok(c.post(`/api/integrations/connections/${connection}/attendance-file`, absence)))
        .record.id,
    ).toBe(first.id);
    expect(
      (await ok(c.get('/api/manufacturing/calendars'))).records.some(
        (r: { resourceId: string; status: string }) =>
          r.resourceId === resource && r.status === 'active',
      ),
    ).toBe(true);
    await ok(
      c.post(`/api/integrations/connections/${connection}/attendance-file`, {
        requestKey: randomUUID(),
        attendance: { clear: [{ employeeId: employee, workDate: TODAY_LOCAL }] },
      }),
    );
    expect(
      (await ok(c.get('/api/manufacturing/calendars'))).records.some(
        (r: { resourceId: string; status: string }) =>
          r.resourceId === resource && r.status === 'active',
      ),
    ).toBe(false);
    const variant = (await ok(c.get('/api/manufacturing/catalog/variants'))).variants[0];
    const work = (
      await ok(
        c.post('/api/manufacturing/production/orders', {
          variantId: variant.id,
          revisionId: variant.revisionId,
          quantity: '2',
          warehouseId: wh,
          outputWarehouseId: wh,
        }),
        201,
      )
    ).order.id;
    await ok(c.post(`/api/manufacturing/production/orders/${work}/release`, action()));
    await ok(
      c.post(`/api/manufacturing/production/orders/${work}/operations`, {
        ...action(),
        key: 'first',
        quantity: '2',
        goodQty: '2',
        minutes: '6',
        resourceId: resource,
        status: 'completed',
      }),
    );
    expect(
      (
        await c.post(`/api/manufacturing/production/orders/${work}/operations`, {
          ...action(),
          key: 'first',
          quantity: '1',
          goodQty: '1',
          minutes: '3',
          resourceId: resource,
          status: 'completed',
        })
      ).statusCode,
    ).toBe(422);
    const run = (await ok(c.post('/api/payroll/runs', { month: TODAY_LOCAL.slice(0, 7) }), 201)).run
      .id;
    const item = (
      await ok(
        c.post('/api/payroll/items', { code: 'PIECE', name: 'Parça başı prim', kind: 'earning' }),
        201,
      )
    ).item.id;
    const command = {
      payrollRunId: run,
      payrollItemId: item,
      resourceId: resource,
      operationKey: 'first',
      mode: 'piece',
      unitRate: '25',
      requestKey: randomUUID(),
    };
    const rate = (await ok(c.post('/api/manufacturing/piece-rates', command))).record;
    expect(rate.amount).toBe('50.00');
    expect((await ok(c.post('/api/manufacturing/piece-rates', command))).record.id).toBe(rate.id);
    expect(Number((await ok(c.get(`/api/payroll/runs/${run}`))).adjustments[0].amount)).toBe(50);
  });
  it('mamul partisi raf toplama, satış ve kaynak iadeyle izlenir; ikinci değer yaratmaz', async () => {
    const lots = (await ok(c.get('/api/wms/lots'))).records;
    const finished = lots.find((r: { itemId: string }) => r.itemId === fg);
    expect(finished.quantity).toBe('10');
    const bin = (
      await ok(
        c.post('/api/wms/bins', {
          code: 'W-FG-BIN',
          name: 'Mamul rafı',
          warehouseId: wh,
          capacity: '10',
        }),
      )
    ).record.id;
    await ok(
      c.post('/api/wms/placements', {
        lotId: finished.id,
        binId: bin,
        quantity: '10',
        requestKey: randomUUID(),
      }),
    );
    const party = (
      await ok(c.post('/api/parties', { name: 'Partili satış müşterisi', kind: 'customer' }), 201)
    ).party.id;
    const sale = await ok(
      c.post('/api/invoices', {
        post: true,
        type: 'sales',
        partyId: party,
        warehouseId: wh,
        invoiceDate: TODAY_LOCAL,
        lines: [{ itemId: fg, description: 'Partili mamul', quantity: '3', unitPrice: '100' }],
      }),
      201,
    );
    expect(
      (await ok(c.get('/api/wms/lots'))).records.find((r: { id: string }) => r.id === finished.id)
        .remainingQty,
    ).toBe('7.0000');
    expect(
      (await ok(c.get('/api/wms/placements'))).records.find(
        (r: { lotId: string }) => r.lotId === finished.id,
      ).remainingQty,
    ).toBe('7.0000');
    await ok(
      c.post('/api/invoices', {
        post: true,
        type: 'sales_return',
        partyId: party,
        warehouseId: wh,
        invoiceDate: TODAY_LOCAL,
        returnOfId: sale.invoice.id,
        lines: [
          {
            itemId: fg,
            description: 'Kaynak iade',
            quantity: '1',
            unitPrice: '100',
            sourceLineId: sale.lines[0].id,
          },
        ],
      }),
      201,
    );
    expect(
      (await ok(c.get('/api/wms/lots'))).records.find((r: { id: string }) => r.id === finished.id)
        .remainingQty,
    ).toBe('8.0000');
  });
  it('depo transferi ve geri alma parti izini korur, toplam miktar veya değer çoğaltmaz', async () => {
    const root = (await ok(c.get('/api/wms/lots'))).records.find(
      (r: { itemId: string; warehouseId: string }) => r.itemId === fg && r.warehouseId === wh,
    );
    const destination = (
      await ok(c.post('/api/warehouses', { name: 'Parti transfer deposu' }), 201)
    ).warehouse.id;
    const transfer = await ok(
      c.post('/api/stock-documents', {
        type: 'transfer',
        docDate: TODAY_LOCAL,
        warehouseId: wh,
        toWarehouseId: destination,
        lines: [{ itemId: fg, quantity: '2' }],
      }),
      201,
    );
    let lots = (await ok(c.get('/api/wms/lots'))).records;
    expect(lots.find((r: { id: string }) => r.id === root.id).remainingQty).toBe('6.0000');
    const child = lots.find(
      (r: { parentLotId: string; warehouseId: string }) =>
        r.parentLotId === root.id && r.warehouseId === destination,
    );
    expect(child.remainingQty).toBe('2.0000');
    await ok(
      c.post(`/api/stock-documents/${transfer.document.id}/reverse`, { docDate: TODAY_LOCAL }),
    );
    lots = (await ok(c.get('/api/wms/lots'))).records;
    expect(lots.find((r: { id: string }) => r.id === root.id).remainingQty).toBe('8.0000');
    expect(lots.find((r: { id: string }) => r.id === child.id).remainingQty).toBe('0.0000');
    expect(lots.filter((r: { itemId: string }) => r.itemId === fg)).toHaveLength(2);
  });
});
