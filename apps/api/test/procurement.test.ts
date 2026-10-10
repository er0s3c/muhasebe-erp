import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('satın alma zinciri: talep → onay → RFQ → sipariş → mal kabul → taahhüt', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const project = (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '03', name: 'Betonarme' })).json().wbs[0] as { id: string };
    const supA = (await c.post('/api/parties', { name: 'A Beton Ltd.', kind: 'supplier' })).json().party as { id: string };
    const supB = (await c.post('/api/parties', { name: 'B Yapı Malz.', kind: 'supplier' })).json().party as { id: string };
    const item = (await c.post('/api/items', { name: 'Çimento 50 kg', vatCode: 'KDV-16' })).json().item as { id: string };
    const reqBody = (extra: Record<string, unknown> = {}) => ({
      projectId: project.id,
      title: 'Blok B temel betonu',
      needDate: day(10, 15),
      lines: [
        { itemId: item.id, description: 'Çimento 50 kg', unit: 'cuval', quantity: '500', estUnitPrice: '50', wbsId: wbs.id },
        { description: 'Beton pompası kiralama', unit: 'gün', quantity: '2', estUnitPrice: '4000', wbsId: wbs.id },
      ],
      ...extra,
    });
    /** Talep → gönder → (varsayılan adım) onayla. */
    const approvedRequest = async (cc: typeof c = c) => {
      const created = await cc.post('/api/purchase-requests', reqBody());
      if (created.statusCode !== 201) throw new Error(created.body);
      const id = created.json().request.id as string;
      const sub = await cc.post(`/api/purchase-requests/${id}/submit`, {});
      if (sub.statusCode !== 200) throw new Error(sub.body);
      const dec = await c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
      if (dec.statusCode !== 200) throw new Error(dec.body);
      return (await c.get(`/api/purchase-requests/${id}`)).json();
    };
    return { s, company, c, orgId, project, wbs, supA, supB, item, reqBody, approvedRequest };
  }

  it('talep: tahmini toplam onay tutarıdır; kademeli kural; ret düzenlenip yeniden gönderilir', async () => {
    const w = await world('TalepOnay');
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    const created = await sm.client.post('/api/purchase-requests', w.reqBody());
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().request).toMatchObject({ code: 'SAT-0001', status: 'draft', estimatedTotal: '33000.00' }); // 500×50 + 2×4000
    const id = created.json().request.id as string;
    // Kural: 0–10.000 şantiye sorumlusu... ≥10.000 muhasebeci (gönderen şantiye sorumlusu kendi talebini onaylayamaz)
    await w.c.post('/api/approval-rules', { docType: 'purchase_request', minAmount: '10000', steps: [{ role: 'accountant', label: 'Satın alma müdürü' }], separateRequester: true });
    const sub = await sm.client.post(`/api/purchase-requests/${id}/submit`, {});
    expect(sub.json().request.status).toBe('submitted');
    expect(sub.json().approvals[0]).toMatchObject({ docType: 'purchase_request', amount: '33000.0000' });
    // Gönderilen talep düzenlenemez
    expect((await sm.client.put(`/api/purchase-requests/${id}`, { title: 'Yeni başlık', lines: w.reqBody().lines })).json().error.code).toBe('REQUEST_NOT_DRAFT');
    // Ret → reddedildi; düzenlenince taslağa döner
    const rej = await acc.client.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'reject', note: 'Miktar fazla' });
    expect(rej.json().request.status).toBe('rejected');
    const back = (await sm.client.get(`/api/purchase-requests/${id}`)).json();
    expect(back.request).toMatchObject({ status: 'rejected', rejectionNote: 'Miktar fazla' });
    const upd = await sm.client.put(`/api/purchase-requests/${id}`, { title: 'Blok B temel betonu (revize)', lines: [{ ...w.reqBody().lines[0], quantity: '300' }] });
    expect(upd.json().request).toMatchObject({ status: 'draft', estimatedTotal: '15000.00' });
    const again = await sm.client.post(`/api/purchase-requests/${id}/submit`, {});
    const ok = await acc.client.post(`/api/approvals/${again.json().approvals.find((a: { status: string }) => a.status === 'pending').id}/decide`, { decision: 'approve' });
    expect(ok.json().request.status).toBe('approved');
    expect((await sm.client.get(`/api/purchase-requests/${id}`)).json().request.status).toBe('approved');
    // Şantiye sorumlusu onaylayıcı değildir: RFQ'dan teklif seçimi (approve) yapamaz; talep geri çekme/iptal manage ile
    expect((await sm.client.post('/api/rfqs', { requestId: id })).statusCode).toBe(201);
  });

  it('RFQ: teklif karşılaştırma (fiyat, teslim, vade), eksik teklif seçilemez; kazanan sipariş taslağı açar', async () => {
    const w = await world('RfqKarsilastir');
    const r = await w.approvedRequest();
    const reqId = r.request.id as string;
    const lines = r.lines as { id: string }[];
    const rfq = await w.c.post('/api/rfqs', { requestId: reqId, dueDate: day(10, 1) });
    expect(rfq.statusCode, rfq.body).toBe(201);
    const rfqId = rfq.json().rfq.id as string;
    expect((await w.c.post('/api/rfqs', { requestId: reqId })).json().error.code).toBe('RFQ_EXISTS');

    // A: ucuz ama yalnızca çimento; B: eksiksiz, TL; C: GBP (kur yok → karşılaştırma dışı)
    await w.c.put(`/api/rfqs/${rfqId}/offers`, { partyId: w.supA.id, currencyCode: 'TRY', deliveryDays: 3, paymentDays: 30, lines: [{ requestLineId: lines[0]!.id, unitPrice: '45' }] });
    await w.c.put(`/api/rfqs/${rfqId}/offers`, { partyId: w.supB.id, currencyCode: 'TRY', deliveryDays: 7, paymentDays: 0, lines: [{ requestLineId: lines[0]!.id, unitPrice: '48' }, { requestLineId: lines[1]!.id, unitPrice: '3800' }] });
    const cmp = (await w.c.get(`/api/rfqs/${rfqId}`)).json();
    const byParty = Object.fromEntries((cmp.offers as { partyName: string; id: string }[]).map((o) => [o.partyName, o]));
    expect(byParty['A Beton Ltd.']).toMatchObject({ complete: false, total: '22500.00', deliveryDays: 3, paymentDays: 30 });
    expect(byParty['B Yapı Malz.']).toMatchObject({ complete: true, total: '31600.00', totalBase: '31600.00', deliveryDays: 7, paymentDays: 0 });
    expect(cmp.cheapestOfferId).toBe(byParty['B Yapı Malz.'].id); // yalnızca eksiksiz teklifler "en ucuz" olabilir
    expect(cmp.fastestOfferId).toBe(byParty['A Beton Ltd.'].id);
    // Teklif güncellenir (aynı tedarikçi tek teklif)
    await w.c.put(`/api/rfqs/${rfqId}/offers`, { partyId: w.supB.id, currencyCode: 'TRY', deliveryDays: 5, paymentDays: 0, lines: [{ requestLineId: lines[0]!.id, unitPrice: '47' }, { requestLineId: lines[1]!.id, unitPrice: '3800' }] });
    expect((await w.c.get(`/api/rfqs/${rfqId}`)).json().offers).toHaveLength(2);

    expect((await w.c.post(`/api/rfqs/${rfqId}/award`, { offerId: byParty['A Beton Ltd.'].id })).json().error.code).toBe('OFFER_INCOMPLETE');
    const award = await w.c.post(`/api/rfqs/${rfqId}/award`, { offerId: byParty['B Yapı Malz.'].id });
    expect(award.statusCode, award.body).toBe(201);
    const order = award.json().order.order;
    expect(order).toMatchObject({ code: 'SIP-0001', status: 'draft', currencyCode: 'TRY', paymentDays: 0, net: '31100.00' }); // 500×47 + 2×3800
    expect(award.json().rfq.rfq.status).toBe('awarded');
    expect((await w.c.get(`/api/purchase-requests/${reqId}`)).json().request.status).toBe('ordered');
    // Sonuçlanmış RFQ'ya teklif girilemez
    expect((await w.c.put(`/api/rfqs/${rfqId}/offers`, { partyId: w.supA.id, currencyCode: 'TRY', lines: [{ requestLineId: lines[0]!.id, unitPrice: '1' }] })).json().error.code).toBe('RFQ_NOT_OPEN');
  });

  it('sipariş: verince taahhüt oluşur; mal kabul (stoklu satır alış irsaliyesi üretir) taahhüdü düşürür; kapatma kalanı serbest bırakır', async () => {
    const w = await world('SiparisTaahhut');
    const r = await w.approvedRequest();
    const created = await w.c.post('/api/purchase-orders', {
      projectId: w.project.id,
      requestId: r.request.id,
      partyId: w.supA.id,
      currencyCode: 'TRY',
      vatCode: 'KDV-16',
      paymentDays: 30,
      deliveryLocation: 'Girne şantiyesi, ana depo',
      lines: [
        { itemId: w.item.id, description: 'Çimento 50 kg', unit: 'cuval', quantity: '500', unitPrice: '50', wbsId: w.wbs.id },
        { description: 'Beton pompası kiralama', unit: 'gün', quantity: '2', unitPrice: '4000', wbsId: w.wbs.id },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().order.id as string;
    expect(created.json().order).toMatchObject({ status: 'draft', net: '33000.00', vat: '0.00' });

    const report = async () => (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(12, 31)}`)).json();
    // Taslak sipariş taahhüt yaratmaz
    expect((await report()).totals.committed).toBe('0.00');

    const issued = await w.c.post(`/api/purchase-orders/${id}/issue`, {});
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().order).toMatchObject({ status: 'issued', vatRate: '16.0000', vat: '5280.00', gross: '38280.00' });
    let rep = await report();
    expect(rep.totals).toMatchObject({ committed: '33000.00', actual: '0.00' });
    expect(rep.commitments).toMatchObject({ orders: 1 });

    // Verilmiş sipariş değişmez
    expect((await w.c.put(`/api/purchase-orders/${id}`, { partyId: w.supA.id, currencyCode: 'TRY', paymentDays: 30, lines: [{ description: 'x', unit: 'adet', quantity: '1', unitPrice: '1', wbsId: w.wbs.id }] })).json().error.code).toBe('ORDER_NOT_DRAFT');

    const lines = issued.json().lines as { id: string; remainingQty: string }[];
    // Fazla kabul reddedilir; stoklu satır için irsaliye numarası zorunlu
    expect((await w.c.post(`/api/purchase-orders/${id}/receipts`, { receiptDate: day(3, 10), externalNo: 'IRS-1', lines: [{ orderLineId: lines[0]!.id, quantity: '501' }] })).json().error.code).toBe('RECEIPT_OVER_ORDER');
    expect((await w.c.post(`/api/purchase-orders/${id}/receipts`, { receiptDate: day(3, 10), lines: [{ orderLineId: lines[0]!.id, quantity: '300' }] })).json().error.code).toBe('RECEIPT_EXTERNAL_NO_REQUIRED');

    // 300 çuval kabul: alış irsaliyesi + stok girişi; taahhüt 33.000 → 18.000
    const rc = await w.c.post(`/api/purchase-orders/${id}/receipts`, { receiptDate: day(3, 10), externalNo: 'IRS-1', lines: [{ orderLineId: lines[0]!.id, quantity: '300' }] });
    expect(rc.statusCode, rc.body).toBe(201);
    expect(rc.json().order.receiptState).toBe('partial');
    const rcpt = rc.json().receipts[0];
    expect(rcpt.receiptNo).toMatch(/^MK-\d{4}-000001$/);
    expect(rcpt.deliveryNoteId).toBeTruthy();
    const stock = (await w.c.get(`/api/reports/stock-status?asOf=${day(12, 31)}`)).json();
    expect(JSON.stringify(stock)).toContain('300');
    const note = (await w.c.get(`/api/delivery-notes/${rcpt.deliveryNoteId}`)).json();
    expect(note.note).toMatchObject({ type: 'purchase', status: 'posted', externalNo: 'IRS-1' });
    rep = await report();
    expect(rep.totals.committed).toBe('18000.00'); // 200×50 + 2×4000

    // Stoksuz satır (hizmet) kabulü yalnızca miktar: irsaliye üretmez
    const rc2 = await w.c.post(`/api/purchase-orders/${id}/receipts`, { receiptDate: day(3, 12), lines: [{ orderLineId: lines[1]!.id, quantity: '2' }] });
    expect(rc2.statusCode, rc2.body).toBe(201);
    expect(rc2.json().receipts[0].deliveryNoteId).toBeNull();
    expect((await report()).totals.committed).toBe('10000.00'); // kalan 200 çuval

    // Mal kabul iptali irsaliyeyi de iptal eder ve taahhüdü geri yükler
    const cancel = await w.c.post(`/api/po-receipts/${rcpt.id}/cancel`, { reason: 'Hasarlı teslimat', date: day(3, 13) });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await w.c.get(`/api/delivery-notes/${rcpt.deliveryNoteId}`)).json().note.status).toBe('cancelled');
    expect((await report()).totals.committed).toBe('25000.00'); // 500 çuval kalan = 25.000; hizmet teslim alındı

    // Kalanı kapat → taahhüt düşer; kapalı siparişe kabul girilmez
    const closed = await w.c.post(`/api/purchase-orders/${id}/close`, {});
    expect(closed.json().order.status).toBe('closed');
    expect((await report()).totals.committed).toBe('0.00');
    expect((await w.c.post(`/api/purchase-orders/${id}/receipts`, { receiptDate: day(3, 14), externalNo: 'IRS-2', lines: [{ orderLineId: lines[0]!.id, quantity: '1' }] })).json().error.code).toBe('ORDER_NOT_ISSUED');
  });

  it('kurallar: iş kalemsiz sipariş verilemez, mal kabullü sipariş iptal edilemez, yetki, modül ve DB korumaları', async () => {
    const w = await world('SatinAlmaKural');
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    const body = (extra: Record<string, unknown> = {}) => ({
      projectId: w.project.id,
      partyId: w.supA.id,
      currencyCode: 'TRY',
      paymentDays: 30,
      lines: [{ description: 'Nakliye', unit: 'sefer', quantity: '4', unitPrice: '500', wbsId: w.wbs.id }],
      ...extra,
    });
    // Onaysız talepten sipariş açılamaz; müşteri carisine sipariş verilemez
    const draftReq = (await w.c.post('/api/purchase-requests', w.reqBody())).json().request.id as string;
    expect((await w.c.post('/api/purchase-orders', body({ requestId: draftReq }))).json().error.code).toBe('REQUEST_NOT_APPROVED');
    const customer = (await w.c.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).json().party as { id: string };
    expect((await w.c.post('/api/purchase-orders', body({ partyId: customer.id }))).json().error.code).toBe('PARTY_KIND_MISMATCH');

    // İş kalemsiz sipariş taslak olur ama verilemez
    const noWbs = await w.c.post('/api/purchase-orders', body({ lines: [{ description: 'Nakliye', unit: 'sefer', quantity: '4', unitPrice: '500' }] }));
    expect(noWbs.statusCode).toBe(201);
    expect((await w.c.post(`/api/purchase-orders/${noWbs.json().order.id}/issue`, {})).json().error.code).toBe('ORDER_WBS_REQUIRED');

    // Yetki: şantiye sorumlusu sipariş taslağı hazırlar ve mal kabul girer, ama sipariş veremez/iptal edemez
    const mine = await sm.client.post('/api/purchase-orders', body());
    expect(mine.statusCode).toBe(201);
    expect((await sm.client.post(`/api/purchase-orders/${mine.json().order.id}/issue`, {})).statusCode).toBe(403);
    expect((await viewer.client.get('/api/purchase-orders')).statusCode).toBe(200);
    expect((await viewer.client.post('/api/purchase-orders', body())).statusCode).toBe(403);
    const issued = await w.c.post(`/api/purchase-orders/${mine.json().order.id}/issue`, {});
    const lineId = issued.json().lines[0].id as string;
    expect((await sm.client.post(`/api/purchase-orders/${mine.json().order.id}/receipts`, { receiptDate: day(3, 1), lines: [{ orderLineId: lineId, quantity: '1' }] })).statusCode).toBe(201);
    expect((await sm.client.post(`/api/purchase-orders/${mine.json().order.id}/cancel`, { reason: 'Vazgeçildi' })).statusCode).toBe(403);
    expect((await w.c.post(`/api/purchase-orders/${mine.json().order.id}/cancel`, { reason: 'Vazgeçildi' })).statusCode).toBe(422); // mal kabulü var

    // Market şirketinde satın alma açık; şirket ayarıyla kapatılınca erişim yine engellenir.
    const market = await registerUser(app, 'SatinAlmaMarket');
    const mc = await createCompany(app, market.token, { sector: 'RETAIL_MARKET' });
    const marketClient = client(app, market.token, mc.id);
    expect((await marketClient.get('/api/purchase-orders')).statusCode).toBe(200);
    const disabled = await marketClient.put('/api/company/modules/core.procurement', { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const blocked = await marketClient.get('/api/purchase-orders');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MODULE_DISABLED');

    // DB: verilmiş siparişin satırı ve mal kabul kaydı değişmez (sahip rolüyle bile)
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      let e = await expectDbError(q, `update purchase_order_lines set quantity = 99 where order_id = $1`, [mine.json().order.id]);
      expect(e.code).toBe('ERP11');
      e = await expectDbError(q, `delete from po_receipt_lines`, []);
      expect(e.code).toBe('42501'); // uygulama rolünün silme yetkisi yok
      e = await expectDbError(q, `update purchase_orders set status = 'draft' where id = $1`, [mine.json().order.id]);
      expect(e.code).toBe('ERP11');
      e = await expectDbError(q, `update purchase_requests set status = 'approved' where id = $1`, [draftReq]);
      expect(e.code).toBe('ERP11');
    });
    await expect(execAsOwner(`update po_receipts set note = 'x' where order_id = $1`, [mine.json().order.id])).rejects.toThrow();
  });
});
