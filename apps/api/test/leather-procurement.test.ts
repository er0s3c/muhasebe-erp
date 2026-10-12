import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, makeApp, orgOf, registerUser, TODAY_LOCAL } from './helpers';

const { app, handle } = await makeApp();

async function world(name: string) {
  const owner = await registerUser(app, name);
  const company = await createCompany(app, owner.token, { name: 'Deri Aksesuar Ltd.', sector: 'LEATHER_FASHION', jurisdiction: 'KKTC' });
  const c = client(app, owner.token, company.id);
  const supplier = (await c.post('/api/parties', { name: 'Tabakhane Tedarik', kind: 'supplier' })).json().party;
  const item = (await c.post('/api/items', { name: 'Tabaklanmış dana derisi', unit: 'm2' })).json().item;
  const requestBody = { title: 'Aksesuar koleksiyonu deri alımı', lines: [{ itemId: item.id, description: 'Dana derisi', unit: 'm2', quantity: '10', estUnitPrice: '200' }] };
  return { owner, company, c, supplier, item, requestBody };
}

describe('deri sektöründe ortak satın alma', () => {
  it('projesiz talep → onay → RFQ → sipariş → kısmi mal kabul ve eşleştirme çalışır', async () => {
    const w = await world('DeriTedarik');
    const manager = await addMember(app, w.c, w.company.id, 'operations_manager');
    const created = await manager.client.post('/api/purchase-requests', w.requestBody);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().request).toMatchObject({ projectId: null, estimatedTotal: '2000.00' });
    const id = created.json().request.id;
    const submit = await manager.client.post(`/api/purchase-requests/${id}/submit`, {});
    expect(submit.statusCode, submit.body).toBe(200);
    const approvalId = submit.json().approvals[0].id;
    expect((await manager.client.get('/api/procurement/approvals/inbox')).json().requests.some((r: { id: string }) => r.id === approvalId)).toBe(true);
    const approve = await manager.client.post(`/api/procurement/approvals/${approvalId}/decide`, { decision: 'approve' });
    expect(approve.statusCode, approve.body).toBe(200);
    const rq = await manager.client.post('/api/rfqs', { requestId: id });
    expect(rq.statusCode, rq.body).toBe(201);
    const rfqId = rq.json().rfq.id;
    const lineId = rq.json().lines[0].id;
    const offer = await manager.client.put(`/api/rfqs/${rfqId}/offers`, { partyId: w.supplier.id, currencyCode: 'TRY', lines: [{ requestLineId: lineId, unitPrice: '210' }] });
    expect(offer.statusCode, offer.body).toBe(200);
    const award = await manager.client.post(`/api/rfqs/${rfqId}/award`, { offerId: offer.json().offers[0].id });
    expect(award.statusCode, award.body).toBe(201);
    const orderId = award.json().order.order.id;
    const issue = await manager.client.post(`/api/purchase-orders/${orderId}/issue`, {});
    expect(issue.statusCode, issue.body).toBe(200);
    expect(issue.json().order.projectId).toBeNull();
    const orderLineId = issue.json().lines[0].id;
    const receipt = await manager.client.post(`/api/purchase-orders/${orderId}/receipts`, { receiptDate: TODAY_LOCAL, externalNo: 'DERI-KABUL-01', lines: [{ orderLineId, quantity: '4' }] });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receipt.json().order.receiptState).toBe('partial');
    expect(receipt.json().lines[0]).toMatchObject({ receivedQty: '4.0000', remainingQty: '6.0000' });
    expect((await manager.client.get('/api/purchase-orders')).json().orders.some((o: { id: string }) => o.id === orderId)).toBe(true);
    expect((await manager.client.get('/api/rfqs')).json().rfqs.some((r: { id: string }) => r.id === rfqId)).toBe(true);
    expect((await manager.client.get('/api/procurement/matching')).json().orders.some((o: { id: string }) => o.id === orderId)).toBe(true);
    const over = await manager.client.post(`/api/purchase-orders/${orderId}/receipts`, { receiptDate: TODAY_LOCAL, externalNo: 'DERI-KABUL-02', lines: [{ orderLineId, quantity: '7' }] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('RECEIPT_OVER_ORDER');
  });

  it('operatör write istisnası talep açar ama sipariş veremez ve onaylayamaz', async () => {
    const w = await world('DeriYetki');
    const operator = await addMember(app, w.c, w.company.id, 'operator');
    const levels = await w.c.put(`/api/company/members/${operator.userId}/module-access`, { levels: { 'core.procurement': 'write' } });
    expect(levels.statusCode, levels.body).toBe(200);
    const created = await operator.client.post('/api/purchase-requests', w.requestBody);
    expect(created.statusCode, created.body).toBe(201);
    const submit = await operator.client.post(`/api/purchase-requests/${created.json().request.id}/submit`, {});
    expect(submit.statusCode, submit.body).toBe(200);
    const approvalId = submit.json().approvals[0].id;
    expect((await operator.client.post(`/api/procurement/approvals/${approvalId}/decide`, { decision: 'approve' })).statusCode).toBe(403);
    await w.c.put(`/api/company/members/${operator.userId}/module-access`, { levels: { 'core.procurement': 'read' } });
    expect((await operator.client.get('/api/purchase-requests')).statusCode).toBe(200);
    expect((await operator.client.post('/api/purchase-requests', w.requestBody)).statusCode).toBe(403);
    await w.c.put(`/api/company/members/${operator.userId}/module-access`, { levels: { 'core.procurement': 'none' } });
    expect((await operator.client.get('/api/purchase-requests')).json().error.code).toBe('MODULE_ACCESS_DENIED');
  });

  it('şirket modülü kapalıyken ortak satın alma ve onay API kapanır', async () => {
    const w = await world('DeriModul');
    expect((await w.c.put('/api/company/modules/core.procurement', { enabled: false })).statusCode).toBe(200);
    expect((await w.c.get('/api/purchase-requests')).json().error.code).toBe('MODULE_DISABLED');
    expect((await w.c.get('/api/procurement/approvals/inbox')).json().error.code).toBe('MODULE_DISABLED');
    const groups = (await w.c.get('/api/navigation')).json().groups;
    expect(groups.some((g: { key: string }) => g.key === 'procurement')).toBe(false);
  });

  it('deri satın almaya proje/iş kalemi gönderilemez; şantiyede proje zorunluluğu korunur', async () => {
    const w = await world('DeriBaglam');
    const fakeId = '018f0000-0000-7000-8000-000000000001';
    const withProject = await w.c.post('/api/purchase-requests', { ...w.requestBody, projectId: fakeId });
    expect(withProject.json().error.code).toBe('PROCUREMENT_PROJECT_NOT_ALLOWED');
    const withWbs = await w.c.post('/api/purchase-requests', { ...w.requestBody, lines: w.requestBody.lines.map((l) => ({ ...l, wbsId: fakeId })) });
    expect(withWbs.json().error.code).toBe('WBS_WITHOUT_PROJECT');
    const construction = await createCompany(app, w.owner.token, { sector: 'CONSTRUCTION' });
    const cc = client(app, w.owner.token, construction.id);
    const missingProject = await cc.post('/api/purchase-requests', { title: 'Şantiye talebi', lines: [{ description: 'Malzeme', unit: 'adet', quantity: '1' }] });
    expect(missingProject.json().error.code).toBe('PROJECT_REQUIRED');
    const access = await addMember(app, cc, construction.id, 'operator', 'constructionoperator');
    const areas = await cc.get(`/api/company/members/${access.userId}/module-access`);
    expect(areas.json().areas.some((a: { key: string }) => a.key === 'core.procurement')).toBe(true);
  });

  it('projesiz üst belgeye satır FK şirketi korur; başka şirketin talebi okunamaz', async () => {
    const w = await world('DeriIzolasyon');
    const created = await w.c.post('/api/purchase-requests', w.requestBody);
    const requestId = created.json().request.id;
    const other = await createCompany(app, w.owner.token, { sector: 'LEATHER_FASHION' });
    const cc = client(app, w.owner.token, other.id);
    expect((await cc.get(`/api/purchase-requests/${requestId}`)).statusCode).toBe(404);
    const orgId = await orgOf(app, w.owner.token);
    await expect(asDb(handle, { companyId: other.id, orgId, userId: w.owner.userId }, (q) => q('insert into purchase_request_lines(company_id,request_id,project_id,line_no,description,unit,quantity) values($1,$2,null,1,$3,$4,1)', [other.id, requestId, 'Yabancı belge satırı', 'adet']))).rejects.toThrow();
  });
});
