import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { addMember, asDb, asOwner, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser } from './helpers';

type Line = { lineKey: string; itemNo: string; description: string; unit: string; quantity: string; unitPrice: string; wbsId: string; costCodeId: string | null };

describe('değişiklik emri (taşeron ve işveren, süre uzatımı)', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string, direction: 'payable' | 'receivable' = 'payable') {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const party =
      direction === 'payable'
        ? ((await c.post('/api/parties', { name: 'XYZ Elektrik Ltd', kind: 'supplier' })).json().party as { id: string })
        : ((await c.post('/api/parties', { name: 'Deniz Yatırım Ltd.', kind: 'customer' })).json().party as { id: string });
    const project = (
      await c.post('/api/projects', direction === 'payable' ? { name: 'Güneş Sitesi', kind: 'own' } : { name: 'Kuzey Villa', kind: 'contract', clientPartyId: party.id })
    ).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '05', name: 'Elektrik' })).json().wbs[0] as { id: string };
    const created = await c.post('/api/subcontracts', {
      direction,
      projectId: project.id,
      partyId: party.id,
      title: 'Elektrik tesisatı',
      currencyCode: 'TRY',
      paymentDays: 30,
      retentionPct: '0',
      advanceRecoupPct: '0',
      startDate: day(1, 1),
      endDate: day(6, 30),
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    const sc = created.json().subcontract as { id: string };
    const rev = created.json().revisions[0].id as string;
    // BOQ: kablo 15.000 m × 3 = 45.000; pano 30 adet × 500 = 15.000; toplam 60.000
    const put = await c.put(`/api/subcontract-revisions/${rev}/lines`, {
      lines: [
        { itemNo: '1', description: 'Kablo çekimi', unit: 'm', quantity: '15000', unitPrice: '3', wbsId: wbs.id },
        { itemNo: '2', description: 'Pano kurulumu', unit: 'adet', quantity: '30', unitPrice: '500', wbsId: wbs.id },
      ],
    });
    await c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const keys = Object.fromEntries((put.json().lines as Line[]).map((l) => [l.itemNo, l.lineKey]));

    const openVo = async (body: Record<string, unknown> = {}) => {
      const r = await c.post(`/api/subcontracts/${sc.id}/variations`, { title: 'Ek pano', reason: 'client_request', ...body });
      if (r.statusCode !== 201) throw new Error(r.body);
      return r.json().variation as { id: string; code: string; revisionId: string; status: string };
    };
    const linesOf = async (revisionId: string) => (await c.get(`/api/subcontract-revisions/${revisionId}`)).json().lines as Line[];
    const putLines = (revisionId: string, lines: Partial<Line>[]) =>
      c.put(`/api/subcontract-revisions/${revisionId}/lines`, {
        lines: lines.map((l) => ({ itemNo: l.itemNo, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, wbsId: l.wbsId ?? wbs.id, ...(l.lineKey ? { lineKey: l.lineKey } : {}) })),
      });
    /** Pano 30 → 40 ve yeni kalem (aydınlatma 10 × 1.000): +5.000 + 10.000 = +15.000 */
    const addWork = async (revisionId: string) => {
      const cur = await linesOf(revisionId);
      return putLines(revisionId, [
        ...cur.map((l) => (l.itemNo === '2' ? { ...l, quantity: '40' } : l)),
        { itemNo: '3', description: 'Aydınlatma', unit: 'adet', quantity: '10', unitPrice: '1000' },
      ]);
    };
    const approveVo = async (id: string) => {
      const sub = await c.post(`/api/variation-orders/${id}/submit`, {});
      if (sub.statusCode !== 200) throw new Error(`submit failed: ${sub.body}`);
      const dec = await c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
      if (dec.statusCode !== 200) throw new Error(`decide failed: ${dec.body}`);
      return (await c.get(`/api/variation-orders/${id}`)).json();
    };
    const contract = async () => (await c.get(`/api/subcontracts/${sc.id}`)).json();
    return { s, company, c, orgId, party, project, wbs, sc, keys, openVo, linesOf, putLines, addWork, approveVo, contract };
  }

  it('taşeron DE: ek iş + süre uzatımı → onay → yürürlükte; taahhüt, bedel ve bitiş tarihi güncellenir; bekleyen DE tahmine girmez', async () => {
    const w = await world('DeTaseron');
    const vo = await w.openVo({ timeExtensionDays: 15, description: 'İşveren talebiyle ek aydınlatma' });
    expect(vo).toMatchObject({ status: 'draft' });
    expect(vo.code).toMatch(/^DE-\d{4}$/);
    expect((await w.addWork(vo.revisionId)).statusCode).toBe(200);

    const draft = (await w.c.get(`/api/variation-orders/${vo.id}`)).json();
    expect(draft.variation).toMatchObject({ amountBefore: '60000.00', amountAfter: '75000.00', amountDelta: '15000.00', projectedEndDate: day(7, 15) });
    const change = Object.fromEntries((draft.lines as { itemNo: string; change: string; delta: string }[]).map((l) => [l.itemNo, l]));
    expect(change['1']).toMatchObject({ change: 'same', delta: '0.00' });
    expect(change['2']).toMatchObject({ change: 'changed', delta: '5000.00' });
    expect(change['3']).toMatchObject({ change: 'added', delta: '10000.00' });

    const report = async () => (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(12, 31)}`)).json();
    const sub = await w.c.post(`/api/variation-orders/${vo.id}/submit`, {});
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json().approvals[0]).toMatchObject({ docType: 'variation_order', status: 'pending' });
    // Onaydayken: bekleyen DE ayrı; taahhüt ve sözleşme bedeli değişmez; DE düzenlenemez
    let r = await report();
    expect(r.totals.committed).toBe('60000.00');
    expect(r.pendingVariations).toMatchObject({ cost: '15000.00', revenue: '0.00', count: 1 });
    expect((await w.contract()).subcontract).toMatchObject({ contractAmount: '60000.00', pendingVariations: '15000.00', pendingCount: 1, appliedVariations: '0.00' });
    expect((await w.c.put(`/api/variation-orders/${vo.id}`, { title: 'Yeni başlık' })).json().error.code).toBe('VARIATION_NOT_EDITABLE');
    expect((await w.putLines(vo.revisionId, await w.linesOf(vo.revisionId))).json().error.code).toBe('VARIATION_NOT_EDITABLE');

    const dec = await w.c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
    expect(dec.statusCode, dec.body).toBe(200);
    const done = (await w.c.get(`/api/variation-orders/${vo.id}`)).json().variation;
    expect(done).toMatchObject({ status: 'applied', amountDelta: '15000.0000', previousEndDate: day(6, 30), newEndDate: day(7, 15), projectedEndDate: null });

    const after = await w.contract();
    expect(after.subcontract).toMatchObject({ contractAmount: '75000.00', originalAmount: '60000.00', appliedVariations: '15000.00', pendingVariations: '0.00', extensionDays: 15, endDate: day(7, 15) });
    const cur = (after.revisions as { isCurrent: boolean; variationCode: string | null; status: string }[]).find((x) => x.isCurrent)!;
    expect(cur).toMatchObject({ variationCode: vo.code, status: 'approved' });
    r = await report();
    expect(r.totals.committed).toBe('75000.00');
    expect(r.pendingVariations.count).toBe(0);
    // Uygulanmış DE iptal edilemez
    expect((await w.c.delete(`/api/variation-orders/${vo.id}`)).json().error.code).toBe('VARIATION_NOT_CANCELLABLE');
    // Listeler
    expect((await w.c.get(`/api/variation-orders?projectId=${w.project.id}&status=applied`)).json().variations).toHaveLength(1);
    expect((await w.c.get(`/api/subcontracts/${w.sc.id}/variations`)).json().variations[0]).toMatchObject({ code: vo.code, amountDelta: '15000.0000' });
    // Excel: kayıt defteri ve tek DE karşılaştırması
    const reg = readXlsx(new Uint8Array((await w.c.get(`/api/exports/variation-orders?format=xlsx&projectId=${w.project.id}`)).rawPayload))[0]!.rows;
    expect(reg.flat()).toEqual(expect.arrayContaining([vo.code, 'Uygulandı', '15000', '15']));
    const one = await w.c.get(`/api/exports/variation-order?format=xlsx&id=${vo.id}`);
    expect(one.statusCode).toBe(200);
    expect(readXlsx(new Uint8Array(one.rawPayload))[0]!.rows.flat()).toEqual(expect.arrayContaining(['Aydınlatma', 'Eklendi']));
  });

  it('yürürlükteki sözleşmede düz revizyon yok; DE revizyonu doğrudan onaylanmaz ve silinmez; boş DE gönderilmez', async () => {
    const w = await world('DeKural');
    expect((await w.c.post(`/api/subcontracts/${w.sc.id}/revisions`, { copyFromCurrent: true })).json().error.code).toBe('USE_VARIATION_ORDER');
    const vo = await w.openVo();
    expect((await w.c.post(`/api/subcontract-revisions/${vo.revisionId}/approve`, {})).json().error.code).toBe('USE_VARIATION_ORDER');
    expect((await w.c.delete(`/api/subcontract-revisions/${vo.revisionId}`)).json().error.code).toBe('REVISION_IN_VARIATION');
    // Hiçbir değişiklik yok (BOQ aynı, süre 0)
    expect((await w.c.post(`/api/variation-orders/${vo.id}/submit`, {})).json().error.code).toBe('VARIATION_EMPTY');
    // Yalnızca süre uzatımı geçerli bir DE'dir
    await w.c.put(`/api/variation-orders/${vo.id}`, { timeExtensionDays: 30, reason: 'site_condition' });
    const applied = await w.approveVo(vo.id);
    expect(applied.variation).toMatchObject({ status: 'applied', amountDelta: '0.0000', newEndDate: day(7, 30) });
    expect((await w.contract()).subcontract).toMatchObject({ contractAmount: '60000.00', endDate: day(7, 30), extensionDays: 30 });
  });

  it('eksilen miktar hakedişteki kümülatifin altına inemez; kümülatifi olan satır kaldırılamaz', async () => {
    const w = await world('DeKumulatif');
    const p = await w.c.post('/api/progress-payments', {
      subcontractId: w.sc.id,
      periodEnd: day(3, 31),
      lines: [
        { lineKey: w.keys['1']!, cumulativeQty: '10000' },
        { lineKey: w.keys['2']!, cumulativeQty: '0' },
      ],
    });
    expect(p.statusCode, p.body).toBe(201);
    const sub = await w.c.post(`/api/progress-payments/${p.json().payment.id}/submit`, {});
    await w.c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });

    const vo = await w.openVo({ title: 'Eksilen kablo', reason: 'design_change' });
    const cur = await w.linesOf(vo.revisionId);
    await w.putLines(vo.revisionId, cur.map((l) => (l.itemNo === '1' ? { ...l, quantity: '9000' } : l)));
    const below = await w.c.post(`/api/variation-orders/${vo.id}/submit`, {});
    expect(below.statusCode).toBe(422);
    expect(below.json().error.code).toBe('VARIATION_BELOW_CERTIFIED');
    await w.putLines(vo.revisionId, cur.filter((l) => l.itemNo !== '1'));
    expect((await w.c.post(`/api/variation-orders/${vo.id}/submit`, {})).json().error.code).toBe('VARIATION_BELOW_CERTIFIED');
    // Kümülatife eşit miktar ve kümülatifi olmayan satırın kaldırılması geçerli (eksilen iş)
    await w.putLines(vo.revisionId, cur.filter((l) => l.itemNo !== '2').map((l) => ({ ...l, quantity: '10000' })));
    const ok = await w.approveVo(vo.id);
    expect(ok.variation).toMatchObject({ status: 'applied', amountDelta: '-30000.0000' }); // 60.000 → 30.000
    expect((ok.lines as { itemNo: string; change: string }[]).find((l) => l.itemNo === '2')!.change).toBe('removed');
  });

  it('iç onayda ret → düzenlenip yeniden gönderilir; iptal taslak revizyonu siler ve yeni DE açılabilir', async () => {
    const w = await world('DeRet');
    const vo = await w.openVo();
    await w.addWork(vo.revisionId);
    const sub = await w.c.post(`/api/variation-orders/${vo.id}/submit`, {});
    await w.c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'reject', note: 'fiyat yüksek' });
    const rejected = (await w.c.get(`/api/variation-orders/${vo.id}`)).json().variation;
    expect(rejected).toMatchObject({ status: 'rejected', rejectionNote: 'fiyat yüksek' });
    // Reddedilen DE'nin revizyonu durur, düzenlenebilir
    const cur = await w.linesOf(vo.revisionId);
    await w.putLines(vo.revisionId, cur.map((l) => (l.itemNo === '3' ? { ...l, unitPrice: '800' } : l)));
    const again = await w.approveVo(vo.id);
    expect(again.variation).toMatchObject({ status: 'applied', amountDelta: '13000.0000' });

    const second = await w.openVo({ title: 'Vazgeçilen' });
    await w.addWork(second.revisionId);
    await w.c.post(`/api/variation-orders/${second.id}/submit`, {});
    const cancelled = await w.c.delete(`/api/variation-orders/${second.id}`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().variation).toMatchObject({ status: 'cancelled', revisionId: null });
    expect(cancelled.json().approvals[0].status).toBe('cancelled');
    expect((await w.c.get(`/api/subcontract-revisions/${second.revisionId}`)).statusCode).toBe(404);
    expect((await w.contract()).subcontract.contractAmount).toBe('73000.00');
    // Tek taslak kuralı serbest kaldı
    expect((await w.c.post(`/api/subcontracts/${w.sc.id}/variations`, { title: 'Üçüncü', reason: 'other' })).statusCode).toBe(201);
  });

  it('işveren DE: iç onay → işveren kabulü beklenir (gelir değişmez, bekleyen sütunda) → kabul → sözleşmeli gelir artar; işveren reddi', async () => {
    const w = await world('DeIsveren', 'receivable');
    const profit = async () => ((await w.c.get('/api/projects/profitability')).json().rows as { id: string; contractedRevenue: string; pendingVariationRevenue: string }[]).find((r) => r.id === w.project.id)!;
    expect((await profit()).contractedRevenue).toBe('60000.00');

    const vo = await w.openVo({ timeExtensionDays: 10 });
    await w.addWork(vo.revisionId);
    // İç onay öncesi kabul girilemez
    expect((await w.c.post(`/api/variation-orders/${vo.id}/client-accept`, { acceptedAt: day(4, 1), reference: 'YAZI-1' })).json().error.code).toBe('VARIATION_NOT_AWAITING_CLIENT');
    const approved = await w.approveVo(vo.id);
    expect(approved.variation).toMatchObject({ status: 'awaiting_client' });
    expect(await profit()).toMatchObject({ contractedRevenue: '60000.00', pendingVariationRevenue: '15000.00' });
    expect((await w.contract()).subcontract).toMatchObject({ contractAmount: '60000.00', pendingVariations: '15000.00' });

    const acc = await w.c.post(`/api/variation-orders/${vo.id}/client-accept`, { acceptedAt: day(4, 2), reference: 'DY/2026-14' });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(acc.json().variation).toMatchObject({ status: 'applied', clientAcceptedAt: day(4, 2), clientReference: 'DY/2026-14', newEndDate: day(7, 10) });
    expect(await profit()).toMatchObject({ contractedRevenue: '75000.00', pendingVariationRevenue: '0.00' });

    const second = await w.openVo({ title: 'Reddedilecek' });
    await w.addWork(second.revisionId);
    await w.approveVo(second.id);
    const rej = await w.c.post(`/api/variation-orders/${second.id}/client-reject`, { note: 'bütçe yok' });
    expect(rej.json().variation).toMatchObject({ status: 'rejected', revisionId: null, rejectionNote: 'İşveren reddi: bütçe yok' });
    expect((await w.contract()).subcontract).toMatchObject({ contractAmount: '75000.00', pendingVariations: '0.00' });
    // İşveren reddedilen DE'nin revizyonu yok: yeniden gönderilemez
    expect((await w.c.post(`/api/variation-orders/${second.id}/submit`, {})).json().error.code).toBe('VARIATION_NO_REVISION');
  });

  it('yetki: şantiye sorumlusu DE hazırlar ve gönderir, onaylayamaz; görüntüleyici hazırlayamaz', async () => {
    const w = await world('DeYetki');
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect((await viewer.client.post(`/api/subcontracts/${w.sc.id}/variations`, { title: 'X', reason: 'other' })).statusCode).toBe(403);
    const vo = (await sm.client.post(`/api/subcontracts/${w.sc.id}/variations`, { title: 'Saha', reason: 'site_condition', timeExtensionDays: 5 })).json().variation;
    const sub = await sm.client.post(`/api/variation-orders/${vo.id}/submit`, {});
    expect(sub.statusCode, sub.body).toBe(200);
    expect((await sm.client.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    expect((await w.c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' })).statusCode).toBe(200);
    expect((await viewer.client.get(`/api/variation-orders/${vo.id}`)).json().variation.status).toBe('applied');
  });

  it('veritabanı: DE silinmez, uygulanmış DE değişmez, işveren DE kabulsüz uygulanamaz, DE dışı revizyon onayı reddedilir', async () => {
    const w = await world('DeDb', 'receivable');
    const vo = await w.openVo();
    await w.addWork(vo.revisionId);
    await w.approveVo(vo.id);
    const other = await w.openVo({ title: 'Ham' }).catch(() => null);
    expect(other).toBeNull(); // tek açık revizyon

    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      // erp_app'in silme yetkisi yok; sahip rolüyle de tetikleyici engeller (aşağıda)
      let e = await expectDbError(q, `delete from variation_orders where id = $1`, [vo.id]);
      expect(e.code).toBe('42501');
      e = await expectDbError(q, `update variation_orders set status = 'applied' where id = $1`, [vo.id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update variation_orders set code = 'DE-9999' where id = $1`, [vo.id]);
      expect(e.code).toBe('ERP10');
      // DE akışı dışında yürürlükteki sözleşmenin taslak revizyonu onaylanamaz
      e = await expectDbError(q, `update subcontract_revisions set status = 'approved', approved_at = now(), approved_by = created_by where id = $1`, [vo.revisionId]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update variation_orders set status = 'draft' where id = $1`, [vo.id]);
      expect(e.code).toBe('ERP10');
    });
    await w.c.post(`/api/variation-orders/${vo.id}/client-accept`, { acceptedAt: day(4, 2), reference: 'R-1' });
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const e = await expectDbError(q, `update variation_orders set title = 'x' where id = $1`, [vo.id]);
      expect(e.code).toBe('ERP10');
    });
    await asOwner(async (q) => {
      const e = await expectDbError(q, `delete from variation_orders where id = $1`, [vo.id]);
      expect(e.code).toBe('ERP10');
    });
  });
});
