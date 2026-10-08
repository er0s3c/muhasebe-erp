import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  asDb,
  client,
  createCompany,
  makeApp,
  registerUser,
  TODAY_LOCAL,
} from './helpers';
import type { LightMyRequestResponse } from 'fastify';

const body = (r: LightMyRequestResponse, status = 200) => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json();
};
const action = (extra: Record<string, unknown> = {}) => ({
  date: TODAY_LOCAL,
  requestKey: randomUUID(),
  note: 'Test',
  ...extra,
});
describe('deri üretim gerçek stok ve muhasebe', async () => {
  const { app, handle } = await makeApp();
  async function setup(name: string, outsourced = false) {
    const owner = await registerUser(app, name);
    const company = await createCompany(app, owner.token, { sector: 'LEATHER_FASHION' });
    const c = client(app, owner.token, company.id);
    const wh = body(await c.get('/api/warehouses')).warehouses[0].id;
    const supplier = body(
      await c.post('/api/parties', { name: 'Deri tabakhane', kind: 'supplier' }),
      201,
    ).party.id;
    const customer = body(
      await c.post('/api/parties', { name: 'Cüzdan müşterisi', kind: 'customer' }),
      201,
    ).party.id;
    const raw = body(
      await c.post('/api/items', {
        name: 'İtalyan kök dana deri',
        kind: 'goods',
        unit: 'm2',
        inventoryRole: 'raw_material',
      }),
      201,
    ).item.id;
    const fg = body(
      await c.post('/api/items', {
        name: 'Deri cüzdan',
        kind: 'goods',
        unit: 'adet',
        inventoryRole: 'finished_goods',
      }),
      201,
    ).item.id;
    const model = body(
      await c.post('/api/leather/catalog/models', {
        code: 'MODEL-1',
        name: 'Deri cüzdan',
        family: 'wallet',
      }),
      201,
    ).model;
    const revision = body(
      await c.post(`/api/leather/catalog/models/${model.id}/revisions`, {
        name: 'Onaylı reçete',
        materials: [{ itemId: raw, quantity: '0.5' }],
        operations: [{ key: 'stitching', name: 'Dikiş', outsourced }],
        sampleApproved: true,
      }),
      201,
    ).revision;
    body(await c.post(`/api/leather/catalog/revisions/${revision.id}/approve`));
    const variant = body(
      await c.post('/api/leather/catalog/variants', {
        modelId: model.id,
        revisionId: revision.id,
        itemId: fg,
        color: 'Taba',
        allowsPersonalization: true,
      }),
      201,
    ).variant;
    async function receipt(area = '10', cost = '100', code = 'HIDE-1') {
      const lot = body(
        await c.post('/api/leather/materials/receipts', {
          partyId: supplier,
          itemId: raw,
          warehouseId: wh,
          date: TODAY_LOCAL,
          externalNo: code,
          provisionalUnitCost: cost,
          pieces: [{ code, area, thicknessMin: '1.2', thicknessMax: '1.4' }],
        }),
        201,
      ).lot;
      const piece = body(await c.get('/api/leather/materials/pieces')).pieces.find(
        (p: { lotId: string }) => p.lotId === lot.id,
      );
      return { lot, piece };
    }
    async function accept(pieceId: string) {
      body(
        await c.post(`/api/leather/materials/pieces/${pieceId}/accept`, {
          decision: 'accept',
          note: 'Giriş kalite kabul',
        }),
      );
    }
    async function order(quantity = '16', extra: Record<string, unknown> = {}) {
      return body(
        await c.post('/api/leather/production/orders', {
          variantId: variant.id,
          revisionId: revision.id,
          warehouseId: wh,
          outputWarehouseId: wh,
          quantity,
          ...extra,
        }),
        201,
      ).order;
    }
    async function release(id: string) {
      return body(await c.post(`/api/leather/production/orders/${id}/release`, action())).order;
    }
    async function issue(id: string, pieceId: string, qty = '8') {
      return body(
        await c.post(
          `/api/leather/production/orders/${id}/issues`,
          action({ lines: [{ itemId: raw, quantity: qty, pieces: [{ pieceId, quantity: qty }] }] }),
        ),
      );
    }
    async function complete(id: string, qty = '10', final = false) {
      const check = body(
        await c.post('/api/leather/quality/checks', {
          scope: 'production',
          sourceId: id,
          stage: 'final',
          inspectedQty: qty,
          passedQty: qty,
          checks: [{ label: 'Dikiş ve finisaj', passed: true }],
        }),
        201,
      ).check;
      body(
        await c.post(`/api/leather/quality/checks/${check.id}/decision`, { decision: 'approve' }),
      );
      return body(
        await c.post(
          `/api/leather/production/orders/${id}/completions`,
          action({ quantity: qty, qualityCheckId: check.id, final }),
        ),
      );
    }
    async function sale(quantity = '5', extra: Record<string, unknown> = {}) {
      return body(
        await c.post('/api/invoices', {
          type: 'sales',
          partyId: customer,
          warehouseId: wh,
          invoiceDate: TODAY_LOCAL,
          post: true,
          lines: [{ itemId: fg, description: 'Deri cüzdan', quantity, unitPrice: '400', ...extra }],
        }),
        201,
      );
    }
    const stock = async (id: string) => body(await c.get(`/api/items/${id}`)).stock;
    const query = <T>(f: Parameters<typeof asDb<T>>[2]) =>
      asDb(handle, { userId: owner.userId, companyId: company.id }, f);
    return {
      c,
      owner,
      company,
      wh,
      supplier,
      customer,
      raw,
      fg,
      model,
      revision,
      variant,
      receipt,
      accept,
      order,
      release,
      issue,
      complete,
      sale,
      stock,
      query,
    };
  }
  it('faturasız kabul → sarf → kısmi mamul → satış → geç fatura 200/300/250/250 gerçek maliyet farkı', async () => {
    const s = await setup('LeatherLate');
    const { lot, piece } = await s.receipt();
    await s.accept(piece.id);
    const order = await s.order();
    await s.release(order.id);
    await s.issue(order.id, piece.id);
    await s.complete(order.id);
    await s.sale();
    expect(Number((await s.stock(s.raw)).value)).toBe(200);
    expect(Number((await s.stock(s.fg)).value)).toBe(250);
    const purchase = body(
      await s.c.post('/api/invoices', {
        type: 'purchase',
        partyId: s.supplier,
        warehouseId: s.wh,
        invoiceDate: TODAY_LOCAL,
        externalNo: 'LATE-1',
        post: true,
        lines: [
          {
            itemId: s.raw,
            description: 'İtalyan deri',
            quantity: '10',
            unitPrice: '200',
            deliveryLineId: lot.deliveryLineId,
          },
        ],
      }),
      201,
    );
    expect(Number((await s.stock(s.raw)).value)).toBe(400);
    expect(Number((await s.stock(s.fg)).value)).toBe(500);
    expect(
      Number(body(await s.c.get(`/api/leather/production/orders/${order.id}`)).order.wipValue),
    ).toBe(600);
    await s.query(async (q) => {
      const destinations = (
        await q('select config from leather_cost_corrections where source_key like $1', [
          `invoice:${purchase.invoice.id}:%`,
        ])
      ).rows.flatMap((r) => r.config.destinations);
      expect(
        destinations
          .map((r: { amount: string }) => Number(r.amount))
          .sort((a: number, b: number) => a - b),
      ).toEqual([200, 250, 250, 300]);
      const sums = (
        await q(
          "select m.key,sum(l.debit_base-l.credit_base)::text as balance from journal_lines l join journal_entries e on e.id=l.entry_id join account_mappings m on m.account_id=l.account_id where e.status='posted' and m.key in ('goods_receipt_accrual','produced_cogs') group by m.key",
        )
      ).rows;
      expect(Number(sums.find((r) => r.key === 'goods_receipt_accrual').balance)).toBe(0);
      expect(Number(sums.find((r) => r.key === 'produced_cogs').balance)).toBe(500);
    });
    const expense = body(
      await s.c.post('/api/invoices', {
        type: 'purchase',
        partyId: s.supplier,
        invoiceDate: TODAY_LOCAL,
        externalNo: 'LABOR-1',
        post: true,
        lines: [{ description: 'Atölye işçilik', quantity: '1', unitPrice: '400' }],
      }),
      201,
    );
    const source = await s.query(
      async (q) =>
        (
          await q(
            "select l.id from journal_lines l join accounts a on a.id=l.account_id where l.entry_id=$1 and l.debit_base>0 and (a.type='expense' or (a.type='cost' and a.code like '7%') or a.id in (select account_id from account_mappings where key='default_expense'))",
            [expense.invoice.journalEntryId],
          )
        ).rows[0].id,
    );
    const input = action({
      orderId: order.id,
      sourceJournalLineId: source,
      amount: '400',
      kind: 'labor',
    });
    body(await s.c.post('/api/leather/costs/allocations', input), 201);
    expect(
      Number(body(await s.c.get(`/api/leather/production/orders/${order.id}`)).order.wipValue),
    ).toBe(750);
    expect(Number((await s.stock(s.fg)).value)).toBe(625);
    expect(Number((await s.stock(s.raw)).value)).toBe(400);
    expect(
      (await s.c.post('/api/leather/costs/allocations', { ...input, requestKey: randomUUID() }))
        .statusCode,
    ).toBe(422);
    const report = body(
      await s.c.get('/api/manufacturing/production/orders/' + order.id + '/cost-close'),
    );
    expect(report.materialActualValue).toBe('1600.00');
    expect(report.actualValue).toBe('2000.00');
    expect(report.materialStandardValue).toBe('800.00');
    expect(report.materialVariance).toBe('800.00');
    expect(report.standardSource).toBe('order_creation_sku_average_material_only');
  });
  it('seçilen fiziksel parti maliyet havuzu değildir; kalite blokesi ve kesim alanı stokla korunur', async () => {
    const s = await setup('LeatherMix');
    const a = await s.receipt('10', '100', 'HIDE-A');
    const b = await s.receipt('10', '300', 'HIDE-B');
    const o = await s.order('8');
    expect(
      (await s.c.post(`/api/leather/production/orders/${o.id}/release`, action())).statusCode,
    ).toBe(422);
    await s.accept(a.piece.id);
    await s.accept(b.piece.id);
    await s.release(o.id);
    const key = () => ({ requestKey: randomUUID(), reason: 'Kesim kabul testi' });
    const pattern = body(
      await s.c.post('/api/leather/catalog/patterns', {
        ...key(),
        modelId: s.model.id,
        code: 'KLP-A',
        name: 'Cüzdan parçası',
        area: '0.5',
        direction: 'grain',
      }),
    ).record;
    const planInput = {
      ...key(),
      orderId: o.id,
      pieces: [a.piece.id],
      sets: 7,
      patterns: [{ patternId: pattern.id, perSet: 1 }],
    };
    expect((await s.c.post('/api/leather/materials/cutting/plans', planInput)).statusCode).toBe(
      422,
    );
    body(
      await s.c.post('/api/leather/materials/pieces/' + a.piece.id + '/geometry', {
        ...key(),
        grainAngle: 90,
        outline: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        defects: [
          {
            code: 'IZ',
            kind: 'scratch',
            points: [
              { x: 0.1, y: 0.1 },
              { x: 0.2, y: 0.1 },
              { x: 0.2, y: 0.2 },
            ],
          },
        ],
      }),
    );
    const plan = body(await s.c.post('/api/leather/materials/cutting/plans', planInput)).record;
    expect(plan.requiredArea).toBe('3.5000');
    expect(plan.pieceSnapshots[0].grainAngle).toBe(90);
    expect(plan.patternSnapshots[0].direction).toBe('grain');
    expect(
      (await s.c.post('/api/leather/materials/cutting/plans', { ...planInput, ...key() }))
        .statusCode,
    ).toBe(422);
    const input = action({
      orderId: o.id,
      pieceId: a.piece.id,
      planId: plan.id,
      setsProduced: 7,
      usedArea: '3.5',
      wasteArea: '0.5',
      remnants: [{ code: 'HIDE-A-R', area: '6' }],
    });
    body(await s.c.post('/api/leather/materials/cuts', input));
    body(await s.c.post('/api/leather/materials/cuts', input));
    expect(Number((await s.stock(s.raw)).qty)).toBe(16);
    expect(
      Number(body(await s.c.get(`/api/leather/production/orders/${o.id}`)).order.wipValue),
    ).toBe(800);
    body(await s.c.post('/api/leather/materials/pieces/' + b.piece.id + '/geometry', { ...key(), grainAngle: 90, outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }));
    const unused = body(
      await s.c.post('/api/leather/materials/cutting/plans', {
        ...key(),
        orderId: o.id,
        pieces: [b.piece.id],
        sets: 1,
        patterns: [{ patternId: pattern.id, perSet: 1 }],
      }),
    ).record;
    expect(
      (
        await s.c.post(
          '/api/leather/production/orders/' + o.id + '/issues',
          action({
            lines: [
              {
                itemId: s.raw,
                quantity: '0.5',
                pieces: [{ pieceId: b.piece.id, quantity: '0.5' }],
              },
            ],
          }),
        )
      ).statusCode,
    ).toBe(422);
    const cancel = key();
    body(await s.c.post('/api/leather/materials/cutting/plans/' + unused.id + '/cancel', cancel));
    body(await s.c.post('/api/leather/materials/cutting/plans/' + unused.id + '/cancel', cancel));
    expect(Number((await s.stock(s.raw)).qty)).toBe(16);

    const cutPlan = body(await s.c.get('/api/leather/materials/cutting/lookups')).plans.find(
      (p: { id: string }) => p.id === plan.id,
    );
    expect(cutPlan.status).toBe('completed');
    expect(cutPlan.results[0]).toMatchObject({
      setsProduced: 7,
      usedArea: '3.5',
      wasteArea: '0.5',
      remnantArea: '6.0000',
    });
    await s.query(async (q) => {
      const pieces = (
        await q('select coalesce(sum(remaining_area),0)::text as qty from leather_pieces')
      ).rows[0];
      expect(Number(pieces.qty)).toBe(16);
      const shares = (
        await q('select share::text from leather_cost_shares where target_key=$1 and share>0', [
          'wip:' + o.id,
        ])
      ).rows.map((r) => Number(r.share));
      expect(shares.filter((x) => x > 0.001).sort((a, b) => a - b)).toEqual([0.2, 0.2, 1, 1, 1]);
    });
    expect(
      (
        await s.c.put(`/api/leather/catalog/revisions/${s.revision.id}`, {
          name: 'Değişmiş',
          materials: [{ itemId: s.raw, quantity: '1' }],
          operations: [{ key: 'stitching', name: 'Dikiş' }],
        })
      ).statusCode,
    ).toBe(422);
  });
  it('fasona gerçek transfer, dış depoda sarf ve kullanılmayan malzemenin dönüşü', async () => {
    const s = await setup('LeatherFason', true);
    const { piece } = await s.receipt('4');
    await s.accept(piece.id);
    const o = await s.order('8');
    await s.release(o.id);
    const external = body(
      await s.c.post('/api/warehouses', { code: 'FASON', name: 'Fason işletme malzemesi' }),
      201,
    ).warehouse.id;
    const job = body(
      await s.c.post('/api/leather/subcontracting/jobs', {
        orderId: o.id,
        partyId: s.supplier,
        operationKey: 'stitching',
        quantity: '8',
        externalWarehouseId: external,
      }),
      201,
    ).job;
    body(
      await s.c.post(
        `/api/leather/subcontracting/jobs/${job.id}/actions`,
        action({
          action: 'dispatch',
          materials: [
            { itemId: s.raw, quantity: '4', pieces: [{ pieceId: piece.id, quantity: '4' }] },
          ],
        }),
      ),
    );
    await s.query(async (q) => {
      expect(
        (await q('select warehouse_id from leather_pieces where id=$1', [piece.id])).rows[0]
          .warehouse_id,
      ).toBe(external);
      expect(
        Number(
          (
            await q(
              'select sum(qty)::text as qty from stock_movements where warehouse_id=$1 and item_id=$2',
              [external, s.raw],
            )
          ).rows[0].qty,
        ),
      ).toBe(4);
    });
    body(
      await s.c.post(
        `/api/leather/subcontracting/jobs/${job.id}/actions`,
        action({
          action: 'consume',
          materials: [
            { itemId: s.raw, quantity: '3', pieces: [{ pieceId: piece.id, quantity: '3' }] },
          ],
        }),
      ),
    );
    body(
      await s.c.post(
        `/api/leather/subcontracting/jobs/${job.id}/actions`,
        action({
          action: 'return',
          quantity: '8',
          materials: [
            { itemId: s.raw, quantity: '1', pieces: [{ pieceId: piece.id, quantity: '1' }] },
          ],
        }),
      ),
    );
    expect(Number((await s.stock(s.raw)).qty)).toBe(1);
    expect(
      Number(body(await s.c.get(`/api/leather/production/orders/${o.id}`)).order.wipValue),
    ).toBe(300);
  });
  it('kalite fire onayı gerçek stok ve zarar kaydı üretir; iptal kabul fiziksel izini kapatır', async () => {
    const s = await setup('LeatherScrap');
    const { piece } = await s.receipt('2');
    const q = body(
      await s.c.post('/api/leather/quality/checks', {
        scope: 'material',
        sourceId: piece.id,
        stage: 'incoming',
        inspectedQty: '2',
        passedQty: '0',
        scrapQty: '2',
        checks: [{ label: 'Delik ve lif kusuru', passed: false }],
      }),
      201,
    ).check;
    body(await s.c.post(`/api/leather/quality/checks/${q.id}/decision`, { decision: 'approve' }));
    expect(Number((await s.stock(s.raw)).qty)).toBe(0);
    expect(Number((await s.stock(s.raw)).value)).toBe(0);
    const cancel = await s.receipt('1', '100', 'CANCEL-HIDE');
    body(
      await s.c.post(`/api/delivery-notes/${cancel.lot.deliveryNoteId}/cancel`, {
        date: TODAY_LOCAL,
        reason: 'İade kabul hatası',
      }),
    );
    const p = body(await s.c.get('/api/leather/materials/pieces')).pieces.find(
      (x: { id: string }) => x.id === cancel.piece.id,
    );
    expect(Number(p.remainingArea)).toBe(0);
    expect(p.status).toBe('consumed');
  });
  it('operatör yalnızca atanmış emri okur ve işler; maliyet ve kaynak paylarını göremez', async () => {
    const s = await setup('LeatherScope');
    const op = await addMember(app, s.c, s.company.id, 'operator', 'Atolye');
    body(
      await s.c.put(`/api/company/members/${op.userId}/module-access`, {
        levels: { 'leather.production': 'write', 'leather.materials': 'read' },
      }),
    );
    const { piece } = await s.receipt();
    await s.accept(piece.id);
    const mine = await s.order('8', { assignedUserId: op.userId });
    await s.release(mine.id);
    const theirs = await s.order('4');
    const listed = body(await op.client.get('/api/leather/production/orders')).orders;
    expect(listed.map((o: { id: string }) => o.id)).toEqual([mine.id]);
    expect(listed[0].wipValue).toBeNull();
    expect((await op.client.get(`/api/leather/production/orders/${theirs.id}`)).statusCode).toBe(
      403,
    );
    const issued = body(
      await op.client.post(
        `/api/leather/production/orders/${mine.id}/issues`,
        action({
          lines: [{ itemId: s.raw, quantity: '4', pieces: [{ pieceId: piece.id, quantity: '4' }] }],
        }),
      ),
    );
    expect(issued.document.value).toBeNull();
    expect(issued.document.config.trace).toBeUndefined();
    expect(
      body(await op.client.get('/api/leather/materials/lots')).lots[0].provisionalValue,
    ).toBeNull();
    expect((await op.client.get('/api/leather/lookups')).statusCode).toBe(200);
    expect((await op.client.get('/api/leather/costs/corrections')).statusCode).toBe(403);
  });
});
