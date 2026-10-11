import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { todayIso } from '@erp/shared';
import { asOwner, client, createCompany, day, expectDbError, makeApp, registerUser } from './helpers';

/**
 * F9 ilk kapsamı: iş cephesi hazırlığı (84), ekip dengeleme (87), ölçüm/kabul farkı (88), değişiklik etki dosyası (16),
 * aşamalı teslim kontrolü (91) ve taksit yeniden yapılandırma (92).
 */
describe('inşaat ve gayrimenkul kararları (F9)', async () => {
  const { app } = await makeApp();

  async function world(name: string) {
    const owner = await registerUser(app, name);
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const project = (await c.post('/api/projects', { name, kind: 'own' })).json().project as { id: string };
    return { c, owner, project };
  }
  type C = ReturnType<typeof client>;
  async function create(c: C, projectId: string, kind: string, payload: unknown, extra: Record<string, unknown> = {}) {
    const r = await c.post('/api/construction/workflows', { projectId, kind, title: 'Test ' + kind, payload, ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item;
  }
  const decide = (c: C, item: any, action: string, extra: Record<string, unknown> = {}) =>
    c.post(`/api/construction/workflows/${item.id}/decision`, { version: item.version, action, note: 'Kontrol notu', ...extra });
  async function approve(c: C, item: any, extra: Record<string, unknown> = {}) {
    const submitted = await decide(c, item, 'submit');
    expect(submitted.statusCode, submitted.body).toBe(200);
    const r = await decide(c, submitted.json().item, 'approve', extra);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().item;
  }

  it('iş cephesi hazırlığı ve ekip dengeleme önerisi', async () => {
    const { c, owner, project } = await world('IsCephesi');
    const today = todayIso();
    const plus = (n: number) => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    await approve(c, await create(c, project.id, 'calendar', { weekdays: [0, 1, 2, 3, 4, 5, 6], holidays: [], crews: [{ name: 'Kalıpçı', size: 6 }] }));
    const activity = async (title: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
      (await c.post('/api/workspace/operations', { kind: 'schedule', title, projectId: project.id, ownerId: owner.userId, eventDate: start, dueDate: '2099-01-01', payload: { start, end, progress: 0, ...extra } })).json().item;
    const a = await activity('Temel', today, plus(9));
    const b = await activity('Kolon kalıbı', today, today, { crew: 'Kalıpçı', crewSize: 4 });
    const k = await activity('Perde kalıbı', today, today, { crew: 'Kalıpçı', crewSize: 4 });
    await approve(c, await create(c, project.id, 'readiness', { activityId: a.id, drawingReady: true, materialReady: false, crewReady: true, approvalReady: true, blocker: 'Demir sevkiyatı bekleniyor' }));
    await approve(c, await create(c, project.id, 'readiness', { activityId: b.id, drawingReady: true, materialReady: true, crewReady: true, approvalReady: true }));

    const la = (await c.get(`/api/construction/lookahead?projectId=${project.id}`)).json();
    const byId = (id: string) => la.activities.find((x: { activityId: string }) => x.activityId === id);
    expect(byId(a.id)).toMatchObject({ status: 'blocked', missing: ['material'], atRisk: true, critical: true, blocker: 'Demir sevkiyatı bekleniyor' });
    expect(byId(b.id)).toMatchObject({ status: 'ready', atRisk: false });
    expect(byId(k.id)).toMatchObject({ status: 'unknown', atRisk: true });
    expect(la.summary).toMatchObject({ total: 3, ready: 1, blocked: 1, unknown: 1, criticalAtRisk: 1 });

    const lv = (await c.get(`/api/construction/program/leveling?projectId=${project.id}`)).json();
    expect(lv.before[0].overloadDays).toEqual([{ day: today, demand: 8 }]);
    expect(lv.after[0].overloadDays).toEqual([]);
    expect(lv.shifts).toHaveLength(1);
    expect(lv.shifts[0]).toMatchObject({ crew: 'Kalıpçı', shiftDays: 1, from: today, to: plus(1) });

    const impact = (await c.get(`/api/construction/change-impact?projectId=${project.id}`)).json();
    expect(impact).toEqual({ items: [], totals: [] });
  });

  it('ölçüm ve kabul farkı: hakedişe kabul edilen miktar girer', async () => {
    const { c, project } = await world('OlcumKabul');
    const today = todayIso();
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '01', name: 'Beton' })).json().wbs[0];
    const party = (await c.post('/api/parties', { name: 'Taşeron', kind: 'supplier' })).json().party;
    const sc = (await c.post('/api/subcontracts', { projectId: project.id, partyId: party.id, title: 'Beton işleri', currencyCode: 'TRY' })).json();
    const revision = sc.revisions[0].id;
    await c.put(`/api/subcontract-revisions/${revision}/lines`, { lines: [{ itemNo: '01', description: 'Beton', unit: 'm3', quantity: '100', unitPrice: '2000', wbsId: wbs.id }] });
    await c.post(`/api/subcontract-revisions/${revision}/approve`, {});
    const boq = (await c.get(`/api/subcontract-revisions/${revision}`)).json().lines[0];
    const place = (await c.post('/api/construction/locations', { projectId: project.id, kind: 'building', name: 'A blok' })).json().item;
    const image = (await c.post('/api/construction/assets', { projectId: project.id, filename: 'p.png', mime: 'image/png', base64: (await readFile('test/fixtures/construction/invoice.png')).toString('base64') })).json().item;
    const photo = (await c.post('/api/construction/photos', { projectId: project.id, locationId: place.id, assetId: image.id, date: today, caption: 'Ölçüm', clientId: randomUUID() })).json().item;
    const prod = await create(c, project.id, 'production', { subcontractId: sc.subcontract.id, lineKey: boq.lineKey, quantity: 60, plannedQuantity: 60, unit: 'm3', crew: 'Ekip', date: today, photoIds: [photo.id] }, { locationId: place.id, wbsId: wbs.id });
    const submitted = (await decide(c, prod, 'submit')).json().item;
    expect((await decide(c, submitted, 'approve', { acceptedQuantity: 61 })).statusCode).toBe(400);
    const ok = await decide(c, submitted, 'approve', { acceptedQuantity: 50, note: 'Yeniden ölçümde 50 m3' });
    expect(ok.statusCode, ok.body).toBe(200);
    const approved = ok.json().item;
    expect(approved.computed).toMatchObject({ claimedQuantity: 60, acceptedQuantity: 50, measurementDiff: '10.0000', acceptanceNote: 'Yeniden ölçümde 50 m3' });

    const transfer = await c.post(`/api/construction/workflows/${prod.id}/transfer`, { version: approved.version });
    expect(transfer.statusCode, transfer.body).toBe(200);
    expect(Number((await c.get(`/api/progress-payments/${transfer.json().linkedId}`)).json().lines[0].thisQty)).toBe(50);
    expect((await c.post(`/api/construction/workflows/${prod.id}/transfer`, { version: transfer.json().item.version, quantity: 5 })).statusCode).toBe(409);

    const diffs = (await c.get(`/api/construction/measurement-diffs?projectId=${project.id}`)).json();
    expect(diffs.withDifference).toBe(1);
    expect(diffs.items[0]).toMatchObject({ claimed: '60.0000', accepted: '50.0000', difference: '10.0000', transferred: '50.0000', remaining: '0.0000', note: 'Yeniden ölçümde 50 m3' });
  });

  it('aşamalı teslim kontrolü tamamlanmadan teslim yapılmaz', async () => {
    const { c, project } = await world('TeslimKontrol');
    const today = todayIso();
    const buyer = (await c.post('/api/parties', { name: 'Alıcı', kind: 'customer' })).json().party;
    const unit = (await c.post('/api/real-estate/units', { projectId: project.id, block: 'A', unitNo: '1', floor: 1, grossM2: '100', listPrice: '1000', listCurrency: 'TRY' })).json().unit;
    const contract = (await c.post('/api/sales-contracts', { unitId: unit.id, partyId: buyer.id, currencyCode: 'TRY', contractDate: today, price: '1000', downPayment: '1000', installments: [{ kind: 'down_payment', dueDate: today, amount: '1000' }] })).json().contract;
    expect((await c.post(`/api/sales-contracts/${contract.id}/activate`, {})).statusCode).toBe(200);
    const check = (stage: string, ok = true) => create(c, project.id, 'handover_check', { unitId: unit.id, stage, items: [{ label: 'Boya', ok }, { label: 'Tesisat', ok: true }] });

    const failing = await check('pre_inspection', false);
    const sub = (await decide(c, failing, 'submit')).json().item;
    expect((await decide(c, sub, 'approve')).statusCode).toBe(400);
    expect((await decide(c, sub, 'reject')).statusCode).toBe(200);
    // Önceki aşama onaysız
    const early = await check('customer_walkthrough');
    const earlySub = (await decide(c, early, 'submit')).json().item;
    expect((await decide(c, earlySub, 'approve')).statusCode).toBe(400);
    // Açık kontrol varken teslim olmaz
    expect((await c.post(`/api/sales-contracts/${contract.id}/handover`, {})).json().error.code).toBe('HANDOVER_CHECK_OPEN');
    expect((await decide(c, earlySub, 'cancel')).statusCode).toBe(200);

    await approve(c, await check('pre_inspection'));
    expect((await c.post(`/api/sales-contracts/${contract.id}/handover`, {})).json().error.code).toBe('HANDOVER_CHECK_INCOMPLETE');
    await approve(c, await check('snag_fix'));
    await approve(c, await check('reinspection'));
    await approve(c, await check('customer_walkthrough'));
    const handed = await c.post(`/api/sales-contracts/${contract.id}/handover`, {});
    expect(handed.statusCode, handed.body).toBe(200);
  });
});

describe('taksit yeniden yapılandırma (F9: öneri 92)', async () => {
  const { app } = await makeApp();

  it('kalan yeni vadelere aynı toplamla devredilir; tahsilat ve eski satırlar korunur', async () => {
    const owner = await registerUser(app, 'Yapilandirma');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const project = (await c.post('/api/projects', { name: 'Site', kind: 'own' })).json().project;
    const buyer = (await c.post('/api/parties', { name: 'Taksitli Alıcı', kind: 'customer' })).json().party;
    await c.put('/api/exchange-rates', { rateDate: day(3, 1), currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    const unit = (await c.post('/api/real-estate/units', { projectId: project.id, block: 'A', unitNo: '7', floor: 1, grossM2: '120', listPrice: '120000', listCurrency: 'GBP' })).json().unit;
    const draft = (
      await c.post('/api/sales-contracts', {
        unitId: unit.id,
        partyId: buyer.id,
        currencyCode: 'GBP',
        contractDate: day(3, 1),
        price: '120000',
        downPayment: '30000',
        installments: [
          { kind: 'down_payment', dueDate: day(3, 1), amount: '30000' },
          { kind: 'installment', dueDate: day(6, 1), amount: '45000' },
          { kind: 'installment', dueDate: day(9, 1), amount: '45000' },
        ],
      })
    ).json();
    expect((await c.post(`/api/sales-contracts/${draft.contract.id}/activate`, {})).statusCode).toBe(200);
    const bank = (await c.post('/api/treasury/accounts', { kind: 'bank', name: 'GBP banka', currency: 'GBP' })).json().account;
    const lines = (await c.get(`/api/sales-contracts/${draft.contract.id}`)).json().installments.map((i: { journalLineId: string }) => i.journalLineId);
    const pay = (line: string, amount: string, date: string) =>
      c.post('/api/treasury/transactions', { type: 'receipt', date, accountId: bank.id, amount, fxRate: '50', partyId: buyer.id, items: [{ lineId: line, amount, settleAmount: amount }] });
    expect((await pay(lines[0], '30000', day(3, 2))).statusCode).toBe(201);
    expect((await pay(lines[1], '10000', day(3, 3))).statusCode).toBe(201);

    const url = `/api/sales-contracts/${draft.contract.id}/restructure`;
    const plan = [{ dueDate: day(7, 1), amount: '40000' }, { dueDate: day(10, 1), amount: '40000' }];
    const mismatch = await c.post(url, { date: day(4, 1), reason: 'Alıcının talebi', installments: [{ dueDate: day(7, 1), amount: '79999' }] });
    expect(mismatch.json().error).toMatchObject({ code: 'RESTRUCTURE_TOTAL_MISMATCH', details: { remaining: '80000.00' } });
    expect((await c.post(url, { date: day(8, 1), reason: 'Geç vade', installments: plan })).json().error.code).toBe('RESTRUCTURE_DUE_BEFORE_DATE');
    const res = await c.post(url, { date: day(4, 1), reason: 'Alıcının talebi', installments: plan });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json();
    expect(after.contract).toMatchObject({ paid: '40000.00', remaining: '80000.00' });
    expect(after.installments.map((i: any) => [i.seq, i.amount, i.paid, i.remaining, i.restructuredAmount, !!i.restructuredIn, !!i.restructureId])).toEqual([
      [1, '30000.00', '30000.00', '0.00', '0.00', false, false],
      [2, '45000.00', '10000.00', '0.00', '35000.00', true, false],
      [3, '45000.00', '0.00', '0.00', '45000.00', true, false],
      [4, '40000.00', '0.00', '40000.00', '0.00', false, true],
      [5, '40000.00', '0.00', '40000.00', '0.00', false, true],
    ]);
    const history = (await c.get(`/api/sales-contracts/${draft.contract.id}/restructures`)).json().restructures;
    expect(history).toEqual([expect.objectContaining({ reason: 'Alıcının talebi', amount: '80000.00' })]);
    expect(history[0].oldPlan).toEqual([
      expect.objectContaining({ seq: 2, remaining: '35000.00' }),
      expect.objectContaining({ seq: 3, remaining: '45000.00' }),
    ]);

    // Yeni taksit tahsil edilir
    expect((await pay(after.installments[3].journalLineId, '40000', day(7, 1))).statusCode).toBe(201);
    const final = (await c.get(`/api/sales-contracts/${draft.contract.id}`)).json();
    expect(final.contract).toMatchObject({ paid: '80000.00', remaining: '40000.00' });
    // Taksit satırları doğrudan değiştirilemez; yapılandırma kaydı silinemez
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update sales_installments set amount = 1 where contract_id = $1`, [draft.contract.id])).code).toBe('ERP12');
      expect((await expectDbError(q, `delete from sales_restructures where contract_id = $1`, [draft.contract.id])).code).toBe('ERP12');
    });
  });
});
