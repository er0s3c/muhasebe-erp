import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, registerUser, createCompany, client, addMember } from './helpers';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { todayIso } from '@erp/shared';
import { sql } from 'drizzle-orm';
import { withContext } from '../src/db/client';
import { processConstructionMaintenance } from '../src/modules/construction-control/jobs';
let app: FastifyInstance;
beforeAll(async () => {
  app = (await makeApp()).app;
});
describe('İnşaat süreçleri', () => {
  async function world(name: string) {
    const owner = await registerUser(app, name),
      company = await createCompany(app, owner.token),
      c = client(app, owner.token, company.id);
    const project = (await c.post('/api/projects', { name, kind: 'own' })).json().project;
    return { c, project, owner, company };
  }
  async function create(
    c: ReturnType<typeof client>,
    projectId: string,
    kind: string,
    payload: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const r = await c.post('/api/construction/workflows', {
      projectId,
      kind,
      title: 'Test ' + kind,
      payload,
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item;
  }
  async function decide(
    c: ReturnType<typeof client>,
    item: any,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    const r = await c.post(`/api/construction/workflows/${item.id}/decision`, {
      version: item.version,
      action,
      note: 'Kabul testi kontrolü',
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().item;
  }
  async function approve(c: ReturnType<typeof client>, item: any) {
    return decide(c, await decide(c, item, 'submit'), 'approve');
  }
  it('bakım saatleri güncellenir, arıza rezervasyonu engeller ve geciken numune tek kalite aksiyonu açar', async () => {
    const { c, project, owner, company } = await world('BakimNumune');
    const equipment = (
      await c.post('/api/workspace/operations', {
        kind: 'equipment',
        title: 'Ortak vinç',
        projectId: project.id,
        ownerId: owner.userId,
        eventDate: todayIso(),
        dueDate: '2099-01-01',
        payload: { code: 'VINC', category: 'machine' },
      })
    ).json().item;
    const maintenance = await approve(
      c,
      await create(c, project.id, 'maintenance', {
        equipmentId: equipment.id,
        dueDate: '2099-01-01',
        dueHours: 5,
        work: 'Saat esaslı bakım',
        parts: '',
        outageStart: todayIso(),
        outageEnd: '2099-01-01',
      }),
    );
    expect(maintenance.computed.hoursDue).toBeNull();
    const log = await c.post('/api/workspace/operations', {
      kind: 'equipment_log',
      title: 'Vinç çalışma saati',
      projectId: project.id,
      ownerId: owner.userId,
      eventDate: todayIso(),
      dueDate: todayIso(),
      payload: {
        equipmentId: equipment.id,
        hours: 8,
        fuelLiters: '0',
        cost: '0',
        currency: 'TRY',
        expenseType: 'other',
      },
    });
    expect(log.statusCode, log.body).toBe(201);
    const refreshed = (await c.get(`/api/construction/workflows?projectId=${project.id}`))
      .json()
      .items.find((r: any) => r.id === maintenance.id);
    expect(refreshed.computed.hoursDue).toBe(true);
    const reservation = await decide(
      c,
      await create(c, project.id, 'reservation', {
        equipmentId: equipment.id,
        start: todayIso(),
        end: todayIso(),
        purpose: 'Arızalı vinci kullanma',
      }),
      'submit',
    );
    expect(
      (
        await c.post(`/api/construction/workflows/${reservation.id}/decision`, {
          version: reservation.version,
          action: 'approve',
          note: 'Kontrol',
        })
      ).statusCode,
    ).toBe(409);
    const party = (await c.post('/api/parties', { name: 'Beton firması', kind: 'supplier' })).json()
      .party;
    const location = (
      await c.post('/api/construction/locations', {
        projectId: project.id,
        kind: 'building',
        name: 'A Blok',
      })
    ).json().item;
    const concrete = await create(
      c,
      project.id,
      'concrete',
      {
        supplierId: party.id,
        batchNo: 'LATE',
        quantity: 5,
        date: '2020-01-01',
        samples: [{ name: 'N1', testDate: '2020-01-02', strength: null, minimum: 25 }],
      },
      { locationId: location.id },
    );
    // Önceki gün onaylanmış, artık sonuç termini geçmiş bir dosyayı temsil eder.
    await withContext(app.db, { companyId: company.id, userId: owner.userId }, (tx) =>
      tx.execute(
        sql`update construction_workflows set status='approved' where id=${concrete.id}::uuid`,
      ),
    );
    await processConstructionMaintenance(app);
    await processConstructionMaintenance(app);
    const after = (await c.get(`/api/construction/workflows?projectId=${project.id}`))
      .json()
      .items.find((r: any) => r.id === concrete.id);
    expect(after.linkedKind).toBe('quality_check');
    expect(
      (await c.get(`/api/construction/workflows/${concrete.id}/events`))
        .json()
        .items.filter((e: any) => e.action === 'quality_action'),
    ).toHaveLength(1);
    const labs = await c.post(`/api/construction/workflows/${concrete.id}/concrete-results`, {
      version: after.version,
      samples: [{ name: 'N1', testDate: '2020-01-02', strength: 30, minimum: 25 }],
      note: 'Laboratuvar sonucu geldi',
      assetIds: [],
    });
    expect(labs.statusCode, labs.body).toBe(200);
    const answer = (
      await c.post('/api/construction/assistant', {
        projectId: project.id,
        question: 'Test concrete',
      })
    ).json();
    expect(answer.sources.find((s: any) => s.id === concrete.id).text).toContain(
      'Geciken sonuç: 0',
    );
    await decide(c, labs.json().item, 'close');
  });
  it('CRM rezervasyonundan sözleşme taslağının iptali daireyi ve aday geçmişini serbest bırakır', async () => {
    const { c, project } = await world('CrmIptal');
    const party = (await c.post('/api/parties', { name: 'Alıcı', kind: 'customer' })).json().party;
    const unit = (
      await c.post('/api/real-estate/units', {
        projectId: project.id,
        block: 'B',
        floor: 1,
        unitNo: '02',
        grossM2: '100',
        listPrice: '1000',
        listCurrency: 'TRY',
      })
    ).json().unit;
    let lead = await create(c, project.id, 'lead', {
      name: 'Alıcı',
      source: 'Ofis',
      unitId: unit.id,
      partyId: party.id,
      reservationUntil: '2099-01-01',
      offerAmount: '1000',
      currency: 'TRY',
    });
    for (const action of ['contacted', 'visited', 'offered', 'reserved'])
      lead = await decide(c, lead, action);
    const contract = await c.post('/api/sales-contracts', {
      unitId: unit.id,
      partyId: party.id,
      reservationLeadId: lead.id,
      currencyCode: 'TRY',
      contractDate: todayIso(),
      price: '1000',
      downPayment: '0',
      installments: [{ kind: 'installment', dueDate: todayIso(), amount: '1000' }],
    });
    expect(contract.statusCode, contract.body).toBe(201);
    const cancelled = await c.post(`/api/sales-contracts/${contract.json().contract.id}/cancel`, {
      reason: 'Alıcı vazgeçti',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const refreshed = (await c.get(`/api/construction/workflows?projectId=${project.id}`))
      .json()
      .items.find((r: any) => r.id === lead.id);
    expect(refreshed.status).toBe('lost');
    expect(
      (await c.get(`/api/construction/workflows/${lead.id}/events`))
        .json()
        .items.some((e: any) => e.action === 'contract_cancelled'),
    ).toBe(true);
    let second = await create(c, project.id, 'lead', {
      name: 'Yeni alıcı',
      source: 'Ofis',
      unitId: unit.id,
      reservationUntil: '2099-01-01',
      offerAmount: '1000',
      currency: 'TRY',
    });
    for (const action of ['contacted', 'visited', 'offered', 'reserved'])
      second = await decide(c, second, action);
  });
  it('tipli süreç, hesap, onay, mühürleme, eşzamanlı değişiklik ve şirket izolasyonu', async () => {
    const owner = await registerUser(app, 'Workflow'),
      company = await createCompany(app, owner.token),
      c = client(app, owner.token, company.id);
    const project = (
      await c.post('/api/projects', { code: 'FLOW', name: 'Süreç projesi', kind: 'own' })
    ).json().project;
    const input = {
      projectId: project.id,
      kind: 'rate_analysis',
      title: 'Beton analizi',
      payload: {
        unit: 'm³',
        currency: 'TRY',
        validFrom: '2026-10-06',
        components: [
          {
            name: 'Hazır beton',
            kind: 'material',
            quantity: 1,
            unitPrice: '2500',
            source: 'Tedarikçi teklifi',
          },
          {
            name: 'İşçilik',
            kind: 'labor',
            quantity: 2,
            unitPrice: '300',
            source: 'Firma varsayımı',
          },
        ],
      },
    };
    const r = await c.post('/api/construction/workflows', input);
    expect(r.statusCode, r.body).toBe(201);
    let item = r.json().item;
    expect(item.computed.unitPrice).toBe('3100.0000');
    const site = await addMember(app, c, company.id, 'site_manager');
    item = (
      await c.post(`/api/construction/workflows/${item.id}/decision`, {
        action: 'submit',
        version: item.version,
        note: 'İncelemeye sunuldu',
      })
    ).json().item;
    expect(
      (
        await site.client.post(`/api/construction/workflows/${item.id}/decision`, {
          action: 'approve',
          version: item.version,
          note: 'Onaylandı',
        })
      ).statusCode,
    ).toBe(403);
    const approved = await c.post(`/api/construction/workflows/${item.id}/decision`, {
      action: 'approve',
      version: item.version,
      note: 'Kaynağı ile kontrol edildi',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    item = approved.json().item;
    expect(
      (await c.put(`/api/construction/workflows/${item.id}`, { ...input, version: item.version }))
        .statusCode,
    ).toBe(400);
    expect(
      (await c.get(`/api/construction/workflows/${item.id}/events`)).json().items.length,
    ).toBeGreaterThanOrEqual(3);
    const other = await createCompany(app, owner.token);
    expect(
      (
        await client(app, owner.token, other.id).get(
          `/api/construction/workflows/${item.id}/events`,
        )
      ).statusCode,
    ).toBe(404);
    const feasibility = await c.post('/api/construction/workflows', {
      projectId: project.id,
      kind: 'feasibility',
      title: 'Arsa A',
      payload: {
        currency: 'TRY',
        landCost: '1000',
        ownerSharePct: 20,
        sellableArea: 100,
        salePerM2: '100',
        costPerM2: '50',
        otherCosts: '500',
        stages: [
          { name: 'Kaba yapı', date: '2026-10-06', salePct: 0, costPct: 50 },
          { name: 'Teslim', date: '2027-10-06', salePct: 100, costPct: 50 },
        ],
      },
    });
    expect(feasibility.statusCode, feasibility.body).toBe(201);
    expect(feasibility.json().item.computed).toMatchObject({
      revenue: '8000.00',
      totalCost: '6500.00',
      profit: '1500.00',
      fundingNeed: '3750.00',
    });
    const f = feasibility.json().item;
    expect(
      (
        await c.put(`/api/construction/workflows/${f.id}`, {
          projectId: project.id,
          kind: 'feasibility',
          title: 'Yeni',
          payload: f.payload,
          version: 99,
        })
      ).statusCode,
    ).toBe(409);
    const opts = await c.get(`/api/construction/options?projectId=${project.id}`);
    expect(opts.statusCode, opts.body).toBe(200);
    const p = await c.get(`/api/construction/program?projectId=${project.id}`);
    expect(p.statusCode, p.body).toBe(200);
    const scores = await c.get(`/api/construction/scorecards?projectId=${project.id}`);
    expect(scores.statusCode, scores.body).toBe(200);
    const productivity = await c.get(
      `/api/construction/productivity?projectId=${project.id}&from=2026-10-01&to=2026-10-31`,
    );
    expect(productivity.statusCode, productivity.body).toBe(200);
  });
  it('ekipman çakışması, izin listesi, başlangıç planı, PDF metraj ve gerçek satın alma taslağı', async () => {
    const { c, project, owner } = await world('SahaKontrol');
    const today = todayIso();
    const equipment = (
      await c.post('/api/workspace/operations', {
        kind: 'equipment',
        title: 'Vinç 01',
        projectId: project.id,
        ownerId: owner.userId,
        eventDate: today,
        dueDate: '2099-01-01',
        payload: { code: 'VIN01', category: 'machine' },
      })
    ).json().item;
    await approve(
      c,
      await create(c, project.id, 'reservation', {
        equipmentId: equipment.id,
        start: today,
        end: '2099-01-01',
        purpose: 'Kaba yapı',
      }),
    );
    const overlap = await decide(
      c,
      await create(c, project.id, 'reservation', {
        equipmentId: equipment.id,
        start: today,
        end: today,
        purpose: 'Çakışan iş',
      }),
      'submit',
    );
    const blocked = await c.post(`/api/construction/workflows/${overlap.id}/decision`, {
      version: overlap.version,
      action: 'approve',
      note: 'Çakışma kontrolü',
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const permit = await decide(
      c,
      await create(c, project.id, 'permit', {
        type: 'height',
        start: today,
        end: '2099-01-01',
        checklist: [{ label: 'Ankraj kontrolü', checked: false }],
        procedure: 'Yüksekte çalışma yöntemi',
      }),
      'submit',
    );
    expect(
      (
        await c.post(`/api/construction/workflows/${permit.id}/decision`, {
          version: permit.version,
          action: 'approve',
          note: 'Kontrol eksik',
        })
      ).statusCode,
    ).toBe(400);
    const activity = (
      await c.post('/api/workspace/operations', {
        kind: 'schedule',
        title: 'Kalıp',
        projectId: project.id,
        ownerId: owner.userId,
        eventDate: today,
        dueDate: '2099-01-01',
        payload: { start: today, end: today, progress: 0 },
      })
    ).json().item;
    const baseline = await approve(
      c,
      await create(c, project.id, 'baseline', { note: 'İlk plan' }),
    );
    expect(baseline.payload.snapshot[0].id).toBe(activity.id);
    const plan = (await c.get(`/api/construction/program?projectId=${project.id}`)).json();
    expect(plan.baselines[0].payload.snapshot[0].payload.start).toBe(today);
    const pdf = (
      await c.post('/api/construction/assets', {
        projectId: project.id,
        filename: 'plan.pdf',
        mime: 'application/pdf',
        base64: (await readFile('test/fixtures/construction/plan.pdf')).toString('base64'),
      })
    ).json().item;
    const drawing = (
      await c.post('/api/construction/drawings', {
        projectId: project.id,
        assetId: pdf.id,
        code: 'P-01',
        title: 'Metraj planı',
        discipline: 'architecture',
        revision: '01',
      })
    ).json().item;
    await c.post(`/api/construction/drawings/${drawing.id}/decision`, {
      version: 1,
      status: 'approved',
      note: 'Çizim onaylandı',
    });
    const takeoff = await approve(
      c,
      await create(c, project.id, 'takeoff', {
        drawingId: drawing.id,
        page: 1,
        kind: 'area',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        pageWidth: 600,
        pageHeight: 500,
        unitsPerPixel: 0.01,
        unit: 'm2',
      }),
    );
    expect(takeoff.computed.quantity).toBe(30);
    const excel = await c.get(`/api/construction/takeoff-export?projectId=${project.id}`);
    expect(excel.statusCode, excel.body).toBe(200);
    expect(excel.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const item = (await c.post('/api/items', { name: 'Çimento', unit: 'adet' })).json().item;
    let need = await approve(
      c,
      await create(c, project.id, 'material_need', {
        itemId: item.id,
        activityId: activity.id,
        quantity: 10,
        needDate: today,
        leadDays: 7,
        unit: 'adet',
        reserveQuantity: 0,
      }),
    );
    expect(need.computed.shortage).toBe('10.0000');
    const transfer = await c.post(`/api/construction/workflows/${need.id}/transfer`, {
      version: need.version,
    });
    expect(transfer.statusCode, transfer.body).toBe(200);
    need = transfer.json().item;
    expect(transfer.json().linkedKind).toBe('purchase_request');
    const draft = await c.get(`/api/purchase-requests/${need.linkedId}`);
    expect(draft.json().request.status).toBe('draft');
    expect(
      (await c.post(`/api/construction/workflows/${need.id}/transfer`, { version: need.version }))
        .statusCode,
    ).toBe(409);
    const supplier = (
      await c.post('/api/parties', { name: 'Numune tedarikçisi', kind: 'supplier' })
    ).json().party;
    const order = await c.post('/api/purchase-orders', {
      projectId: project.id,
      partyId: supplier.id,
      currencyCode: 'TRY',
      paymentDays: 30,
      lines: [{ description: 'Çimento', unit: 'adet', quantity: '10', unitPrice: '100' }],
    });
    expect(order.statusCode, order.body).toBe(201);
    const submittal = await approve(
      c,
      await create(c, project.id, 'submittal', {
        supplierId: supplier.id,
        brand: 'Test marka',
        revision: '01',
        assetIds: [pdf.id],
        orderId: order.json().order.id,
      }),
    );
    const linked = await c.get(
      `/api/construction/order-submittals?orderId=${order.json().order.id}`,
    );
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().items[0]).toMatchObject({
      id: submittal.id,
      status: 'approved',
      brand: 'Test marka',
    });
  });
  it('fotoğraflı üretimden kısmi hakediş, tekrar aktarım ve numune kalite aksiyonu', async () => {
    const { c, project, owner } = await world('UretimZinciri'),
      today = todayIso();
    const wbs = (
      await c.post(`/api/projects/${project.id}/wbs`, { code: '01', name: 'Beton' })
    ).json().wbs[0];
    const party = (await c.post('/api/parties', { name: 'Taşeron A', kind: 'supplier' })).json()
      .party;
    const sc = (
      await c.post('/api/subcontracts', {
        projectId: project.id,
        partyId: party.id,
        title: 'Beton işleri',
        currencyCode: 'TRY',
      })
    ).json();
    const revision = sc.revisions[0].id;
    const put = await c.put(`/api/subcontract-revisions/${revision}/lines`, {
      lines: [
        {
          itemNo: '01',
          description: 'Beton',
          unit: 'm3',
          quantity: '100',
          unitPrice: '2000',
          wbsId: wbs.id,
        },
      ],
    });
    expect(put.statusCode, put.body).toBe(200);
    await c.post(`/api/subcontract-revisions/${revision}/approve`, {});
    const boq = (await c.get(`/api/subcontract-revisions/${revision}`)).json().lines[0];
    const place = (
      await c.post('/api/construction/locations', {
        projectId: project.id,
        kind: 'building',
        name: 'A blok',
      })
    ).json().item;
    const image = (
      await c.post('/api/construction/assets', {
        projectId: project.id,
        filename: 'production.png',
        mime: 'image/png',
        base64: (await readFile('test/fixtures/construction/invoice.png')).toString('base64'),
      })
    ).json().item;
    const photo = (
      await c.post('/api/construction/photos', {
        projectId: project.id,
        locationId: place.id,
        assetId: image.id,
        date: today,
        caption: 'Üretim kanıtı',
        clientId: randomUUID(),
      })
    ).json().item;
    const prod = await approve(
      c,
      await create(
        c,
        project.id,
        'production',
        {
          subcontractId: sc.subcontract.id,
          lineKey: boq.lineKey,
          quantity: 60,
          plannedQuantity: 55,
          unit: 'm3',
          crew: 'Ekip A',
          date: today,
          photoIds: [photo.id],
        },
        { locationId: place.id, wbsId: wbs.id },
      ),
    );
    const transfer = await c.post(`/api/construction/workflows/${prod.id}/transfer`, {
      version: prod.version,
      quantity: 20,
    });
    expect(transfer.statusCode, transfer.body).toBe(200);
    const payment = await c.get(`/api/progress-payments/${transfer.json().linkedId}`);
    expect(payment.statusCode, payment.body).toBe(200);
    expect(Number(payment.json().lines[0].thisQty)).toBe(20);
    expect(payment.json().payment.status).toBe('draft');
    expect(
      (
        await c.post(`/api/construction/workflows/${prod.id}/transfer`, {
          version: transfer.json().item.version,
          quantity: 50,
        })
      ).statusCode,
    ).toBe(409);
    const concrete = await approve(
      c,
      await create(
        c,
        project.id,
        'concrete',
        {
          supplierId: party.id,
          batchNo: 'B-01',
          quantity: 10,
          date: today,
          samples: [{ name: 'Numune 01', testDate: today, strength: 10, minimum: 25 }],
        },
        { locationId: place.id },
      ),
    );
    expect(concrete.linkedKind).toBe('quality_check');
    const checks = await c.get(
      `/api/workspace/operations?kind=quality_check&projectId=${project.id}`,
    );
    expect(checks.json().items.some((i: any) => i.id === concrete.linkedId)).toBe(true);
    expect((await c.get(`/api/construction/options?projectId=${project.id}`)).statusCode).toBe(200);
    expect(
      (
        await c.get(
          `/api/construction/productivity?projectId=${project.id}&from=${today}&to=${today}`,
        )
      ).json().items[0].perHour,
    ).toBeNull();
    expect(owner.userId).toBeTruthy();
  });
  it('CRM çifte rezervasyonu engeller, sözleşme bağlantısı ve müşteri servis teyidi', async () => {
    const { c, project } = await world('MusteriZinciri'),
      today = todayIso();
    const party = (await c.post('/api/parties', { name: 'Alıcı A', kind: 'customer' })).json()
      .party;
    const unit = (
      await c.post('/api/real-estate/units', {
        projectId: project.id,
        block: 'A',
        floor: 1,
        unitNo: '01',
        grossM2: '100',
        listPrice: '1000',
        listCurrency: 'TRY',
      })
    ).json().unit;
    const leadPayload = {
      name: 'Alıcı A',
      source: 'Tanıtım ofisi',
      unitId: unit.id,
      partyId: party.id,
      reservationUntil: '2099-01-01',
      offerAmount: '1000',
      currency: 'TRY',
    };
    let lead = await create(c, project.id, 'lead', leadPayload);
    for (const action of ['contacted', 'visited', 'offered', 'reserved'])
      lead = await decide(c, lead, action);
    let second = await create(c, project.id, 'lead', { ...leadPayload, name: 'Alıcı B' });
    for (const action of ['contacted', 'visited', 'offered'])
      second = await decide(c, second, action);
    expect(
      (
        await c.post(`/api/construction/workflows/${second.id}/decision`, {
          version: second.version,
          action: 'reserved',
          note: 'Çifte rezervasyon',
        })
      ).statusCode,
    ).toBe(409);
    const body = {
      unitId: unit.id,
      partyId: party.id,
      currencyCode: 'TRY',
      contractDate: today,
      price: '1000',
      downPayment: '0',
      installments: [{ kind: 'installment', dueDate: today, amount: '1000' }],
    };
    expect((await c.post('/api/sales-contracts', body)).json().error.code).toBe(
      'UNIT_CRM_RESERVED',
    );
    const contract = await c.post('/api/sales-contracts', { ...body, reservationLeadId: lead.id });
    expect(contract.statusCode, contract.body).toBe(201);
    const id = contract.json().contract.id;
    expect((await c.post(`/api/sales-contracts/${id}/activate`, {})).statusCode).toBe(200);
    lead = await decide(c, lead, 'contracted', { contractId: id });
    expect(lead.linkedId).toBe(id);
    expect((await c.post(`/api/sales-contracts/${id}/handover`, { date: today })).statusCode).toBe(
      200,
    );
    const link = await c.post('/api/workspace/portal-links', {
      partyId: party.id,
      label: 'Alıcı portalı',
      password: 'Portal-Test-12345',
      days: 7,
    });
    const credentials = { token: link.json().token, password: 'Portal-Test-12345' },
      clientId = randomUUID();
    const request = await app.inject({
      method: 'POST',
      url: '/api/portal/view',
      payload: {
        ...credentials,
        action: 'request_service',
        contractId: id,
        clientId,
        description: 'Mutfak bataryası sızdırıyor',
      },
    });
    expect(request.statusCode, request.body).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/portal/view',
          payload: {
            ...credentials,
            action: 'request_service',
            contractId: id,
            clientId,
            description: 'Mutfak bataryası sızdırıyor',
          },
        })
      ).json().serviceId,
    ).toBe(clientId);
    let warranty = (
      await c.get(`/api/construction/workflows?projectId=${project.id}&kind=warranty`)
    ).json().items[0];
    warranty = await decide(c, warranty, 'approve');
    expect(
      (
        await c.post(`/api/construction/workflows/${warranty.id}/decision`, {
          version: warranty.version,
          action: 'close',
          note: 'Çözüm bekleniyor',
        })
      ).statusCode,
    ).toBe(400);
    const service = await c.post(`/api/construction/workflows/${warranty.id}/service`, {
      version: warranty.version,
      coverage: 'covered',
      appointment: today,
      contractorId: party.id,
      resolution: 'Batarya contası yenilendi.',
    });
    expect(service.statusCode, service.body).toBe(200);
    warranty = service.json().item;
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/portal/view',
      payload: { ...credentials, action: 'confirm_service', serviceId: warranty.id },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    warranty = (
      await c.get(`/api/construction/workflows?projectId=${project.id}&kind=warranty`)
    ).json().items[0];
    expect(warranty.payload.customerConfirmation).toBe('Portal müşteri teyidi');
    warranty = await decide(c, warranty, 'close');
    expect(warranty.status).toBe('closed');
  });
});
