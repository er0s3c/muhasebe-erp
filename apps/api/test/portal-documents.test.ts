import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPTY_PORTAL_SCOPES, type PortalDocumentKind } from '@erp/shared';
import { addMember, asDb, client, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';
import { createLegacyCompany } from './legacy-company';

const { app, handle } = await makeApp();
const password = 'Portal-Parolasi-12345';
const allScopes = { invoices: true, quotes: true, orders: true };
async function setup(name: string) {
  const owner = await registerUser(app, name);
  const company = await createLegacyCompany(app, owner.token, { sector: 'COMMERCE' });
  const c = client(app, owner.token, company.id);
  const partyResponse = await c.post('/api/parties', { name: 'Portal müşterisi', kind: 'customer', taxNumber: 'GIZLI-VERGI-NO' });
  expect(partyResponse.statusCode, partyResponse.body).toBe(201);
  const party = partyResponse.json().party;
  const createLink = async (body: object = {}, issuer = c) => {
    const response = await issuer.post('/api/workspace/portal-links', { partyId: party.id, label: 'Müşteri belgeleri', password, days: 7, ...body });
    expect(response.statusCode, response.body).toBe(201);
    const { token, id } = response.json();
    const view = (extra: object = {}) => app.inject({ method: 'POST', url: '/api/portal/view', payload: { token, password, ...extra } });
    return { id, token, view };
  };
  const invoice = async (partyId = party.id, extra: object = {}) => {
    const response = await c.post('/api/invoices', { type: 'sales', partyId, invoiceDate: '2026-06-15', currency: 'TRY', post: true, lines: [{ description: 'Müşteriye sunulan hizmet', quantity: '1', unitPrice: '100', vatCode: 'KDV-16' }], ...extra });
    expect(response.statusCode, response.body).toBe(201); return response.json().invoice;
  };
  const salesDoc = async (kind: 'quote' | 'order', actions: string[], partyId = party.id) => {
    const response = await c.post('/api/sales-docs', { kind, partyId, docDate: '2026-06-15', notes: 'GIZLI-IC-NOT', lines: [{ description: 'Müşteri kalemi', quantity: '2', unitPrice: '50', vatCode: 'KDV-16' }] });
    expect(response.statusCode, response.body).toBe(201); const id = response.json().doc.id;
    for (const action of actions) { const result = await c.post(`/api/sales-docs/${id}/${action}`, { reason: 'Test durumu' }); expect([200, 201], result.body).toContain(result.statusCode); }
    return id;
  };
  return { owner, company, c, party, createLink, invoice, salesDoc };
}
type PortalView = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['createLink']>>['view'];
const list = (view: PortalView, kind: PortalDocumentKind, extra: object = {}) => view({ action: 'list_documents', recordKind: kind, ...extra });
const detail = (view: PortalView, kind: PortalDocumentKind, id: string) => view({ action: 'document_detail', recordKind: kind, recordId: id });

describe('Müşteri portalının satış belgesi kapsamları', () => {
  it('eski bağlantıda kapsam kapalıdır; açıkça seçme ve daraltma hemen uygulanır', async () => {
    const w = await setup('PortalKapsam'); const inv = await w.invoice(); const link = await w.createLink();
    const base = await link.view(); expect(base.statusCode, base.body).toBe(200); expect(base.json().documentScopes).toEqual(EMPTY_PORTAL_SCOPES); expect(base.headers['cache-control']).toBe('no-store');
    expect((await list(link.view, 'invoice')).statusCode).toBe(404);
    expect((await detail(link.view, 'invoice', inv.id)).statusCode).toBe(404);
    expect((await w.c.patch(`/api/workspace/portal-links/${link.id}`, { scopes: { invoices: true, quotes: false, orders: false } })).statusCode).toBe(200);
    expect((await list(link.view, 'invoice')).json().items).toHaveLength(1);
    expect((await w.c.patch(`/api/workspace/portal-links/${link.id}`, { scopes: EMPTY_PORTAL_SCOPES })).statusCode).toBe(200);
    expect((await detail(link.view, 'invoice', inv.id)).statusCode).toBe(404);
    const links = await w.c.get('/api/workspace/portal-links'); expect(links.body).not.toMatch(/token_hash|password_hash|Portal-Parolasi/); expect(links.json().items[0].scopes).toEqual(EMPTY_PORTAL_SCOPES);
  });
  it('cari ve durum filtreleri, sayfalama ve alan allowlist iç maliyet/personel/vergi bilgilerini açıklamaz', async () => {
    const w = await setup('PortalIzolasyon');
    const other = (await w.c.post('/api/parties', { name: 'Diger gizli müşteri', kind: 'customer' })).json().party;
    const supplier = (await w.c.post('/api/parties', { name: 'Gizli tedarikçi', kind: 'supplier' })).json().party;
    const visible = await w.invoice(), second = await w.invoice(), hiddenOther = await w.invoice(other.id), draft = await w.invoice(w.party.id, { post: false }), cancelled = await w.invoice();
    expect((await w.c.post(`/api/invoices/${cancelled.id}/cancel`, { reason: 'Paylaşılamaz iptal faturası' })).statusCode).toBe(200);
    const purchase = await w.invoice(supplier.id, { type: 'purchase', externalNo: 'SUP-001' });
    const sent = await w.salesDoc('quote', ['send']), accepted = await w.salesDoc('quote', ['send', 'accept']), converted = await w.salesDoc('quote', ['send', 'accept', 'convert']);
    const hiddenQuotes = [await w.salesDoc('quote', []), await w.salesDoc('quote', ['send', 'reject']), await w.salesDoc('quote', ['send', 'cancel']), await w.salesDoc('quote', ['send'], other.id)];
    const confirmed = await w.salesDoc('order', ['confirm']);
    const hiddenOrders = [await w.salesDoc('order', []), await w.salesDoc('order', ['confirm', 'cancel']), await w.salesDoc('order', ['confirm'], other.id)];
    const link = await w.createLink({ scopes: allScopes });
    const firstPage = await list(link.view, 'invoice', { limit: 1 }); expect(firstPage.json()).toMatchObject({ total: 2, offset: 0, limit: 1 }); expect(firstPage.json().items).toHaveLength(1);
    const nextPage = await list(link.view, 'invoice', { offset: 1, limit: 1 }); expect(nextPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
    expect(new Set((await list(link.view, 'invoice')).json().items.map((v: { id: string }) => v.id))).toEqual(new Set([visible.id, second.id]));
    expect(new Set((await list(link.view, 'quote')).json().items.map((v: { id: string }) => v.id))).toEqual(new Set([sent, accepted, converted]));
    expect((await list(link.view, 'order')).json().items.map((v: { id: string }) => v.id)).toEqual([confirmed]);
    for (const id of [hiddenOther.id, draft.id, cancelled.id, purchase.id, randomUUID()]) expect((await detail(link.view, 'invoice', id)).statusCode).toBe(404);
    for (const id of hiddenQuotes) expect((await detail(link.view, 'quote', id)).statusCode).toBe(404);
    for (const id of hiddenOrders) expect((await detail(link.view, 'order', id)).statusCode).toBe(404);
    for (const [kind, id] of [['invoice', visible.id], ['quote', sent], ['order', confirmed]] as const) {
      const response = await detail(link.view, kind, id); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().document.lines[0]).toMatchObject({ description: expect.any(String), unitPrice: expect.any(String), gross: expect.any(String) });
      expect(response.body).not.toMatch(/costValue|cost_value|accountId|projectId|createdBy|legalProfile|documentMetadata|taxNumber|GIZLI|journalEntry|itemId/);
    }
  });
  it('bağlantı/parola yenileme, süre ve iptal eski erişimi kapatır; şirket RLS yönetimi korur', async () => {
    const w = await setup('PortalYenile'); const link = await w.createLink({ scopes: allScopes });
    const foreign = await createLegacyCompany(app, w.owner.token, { sector: 'COMMERCE' }); const other = client(app, w.owner.token, foreign.id);
    expect((await other.patch(`/api/workspace/portal-links/${link.id}`, { scopes: allScopes })).statusCode).toBe(404);
    expect((await other.post(`/api/workspace/portal-links/${link.id}/rotate`, { password, days: 7 })).statusCode).toBe(404);
    expect((await other.post(`/api/workspace/portal-links/${link.id}/revoke`)).statusCode).toBe(404);
    const newPassword = 'Yeni-Portal-Parolasi-12345'; const renewed = await w.c.post(`/api/workspace/portal-links/${link.id}/rotate`, { password: newPassword, days: 3 }); expect(renewed.statusCode, renewed.body).toBe(200);
    expect((await link.view()).statusCode).toBe(401);
    const nextView = (extra: object = {}) => app.inject({ method: 'POST', url: '/api/portal/view', payload: { token: renewed.json().token, password: newPassword, ...extra } });
    expect((await nextView({ password })).statusCode).toBe(401); expect((await nextView()).statusCode).toBe(200);
    await execAsOwner('update portal_links set expires_at=now()-interval \'1 second\' where id=$1', [link.id]); expect((await nextView()).statusCode).toBe(401);
    const refreshed = await w.c.post(`/api/workspace/portal-links/${link.id}/rotate`, { password: newPassword, days: 2 }); expect(refreshed.statusCode).toBe(200);
    expect((await w.c.post(`/api/workspace/portal-links/${link.id}/revoke`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/portal/view', payload: { token: refreshed.json().token, password: newPassword } })).statusCode).toBe(401);
    expect((await w.c.post(`/api/workspace/portal-links/${link.id}/rotate`, { password, days: 7 })).statusCode).toBe(404);
  });
  it('paylaşan yöneticinin canlı okuma/dışa aktarma/modül ve üyelik hakları her görünümde denetlenir', async () => {
    const w = await setup('PortalCanliYetki'); const admin = await addMember(app, w.c, w.company.id, 'admin'); const inv = await w.invoice(); const link = await w.createLink({ scopes: allScopes }, admin.client);
    expect((await detail(link.view, 'invoice', inv.id)).statusCode).toBe(200);
    const accessPath = `/api/company/members/${admin.userId}/module-access`;
    expect((await w.c.put(accessPath, { permissions: { 'invoices.read': 'deny' } })).statusCode).toBe(200);
    expect((await link.view()).json().documentScopes).toEqual(EMPTY_PORTAL_SCOPES); expect((await detail(link.view, 'invoice', inv.id)).statusCode).toBe(404);
    expect((await w.c.put(accessPath, { permissions: { 'invoices.read': 'default' }, operations: { 'operation.core.invoices.export': 'deny' } })).statusCode).toBe(200);
    expect((await list(link.view, 'invoice')).statusCode).toBe(404);
    expect((await admin.client.post('/api/workspace/portal-links', { partyId: w.party.id, label: 'Yasak kapsam', password, days: 7, scopes: allScopes })).statusCode).toBe(403);
    expect((await w.c.put(accessPath, { operations: { 'operation.core.invoices.export': 'default' } })).statusCode).toBe(200);
    expect((await w.c.put('/api/company/modules/invoices.orders', { enabled: false })).statusCode).toBe(200);
    expect((await link.view()).json().documentScopes).toEqual({ invoices: true, quotes: false, orders: false }); expect((await list(link.view, 'quote')).statusCode).toBe(404);
    expect((await w.c.put(accessPath, { operations: { 'operation.core.parties.export': 'deny' } })).statusCode).toBe(200); expect((await link.view()).statusCode).toBe(401);
    expect((await w.c.put(accessPath, { operations: { 'operation.core.parties.export': 'default' } })).statusCode).toBe(200);
    expect((await w.c.patch(`/api/company/members/${admin.userId}`, { role: 'viewer' })).statusCode).toBe(200); expect((await link.view()).statusCode).toBe(401);
  });
  it('şube kısıtı tam cari toplamlarını paylaşmayı engeller ve mevcut bağlantıyı kapatır', async () => {
    const w = await setup('PortalSube'); const admin = await addMember(app, w.c, w.company.id, 'admin'); const link = await w.createLink({ scopes: allScopes }, admin.client);
    const branch = (await w.c.post('/api/company/branches', { code: 'MAGAZA', name: 'Mağaza' })).json().branch;
    expect((await w.c.put(`/api/company/members/${admin.userId}/branches`, { mode: 'restricted', branchIds: [branch.id], allowUnassigned: false })).statusCode).toBe(200);
    expect((await link.view()).statusCode).toBe(401);
    const attempted = await admin.client.post('/api/workspace/portal-links', { partyId: w.party.id, label: 'Eksik kapsam', password, days: 7, scopes: allScopes }); expect(attempted.statusCode).toBe(403); expect(attempted.json().error.code).toBe('PORTAL_BRANCH_SCOPE_REQUIRED');
    expect((await admin.client.post(`/api/workspace/portal-links/${link.id}/rotate`, { password, days: 7 })).statusCode).toBe(403);
    expect((await w.c.put(`/api/company/members/${admin.userId}/branches`, { mode: 'all', branchIds: [], allowUnassigned: true })).statusCode).toBe(200);
    expect((await link.view()).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/portal/view', headers: { 'x-branch-id': branch.id }, payload: { token: link.token, password } })).statusCode).toBe(200);
  });
  it('scope şeması API ve SQL seviyesinde bilinmeyen alan ve boolean olmayan değerleri reddeder', async () => {
    const w = await setup('PortalScopeDogrula'); const link = await w.createLink();
    for (const scopes of [{ ...allScopes, payroll: true }, { invoices: 'true' }, { invoices: null }]) expect((await w.c.patch(`/api/workspace/portal-links/${link.id}`, { scopes })).statusCode).toBe(400);
    await asDb(handle, { companyId: w.company.id, userId: w.owner.userId, orgId: await orgOf(app, w.owner.token) }, async query => {
      for (const scopes of ['{"invoices":true}', '{"invoices":true,"quotes":false,"orders":false,"payroll":true}', '{"invoices":"true","quotes":false,"orders":false}']) expect((await expectDbError(query, 'update portal_links set scopes=$1::jsonb where id=$2', [scopes, link.id])).code).toBe('23514');
    });
    expect((await list(link.view, 'invoice', { offset: -1 })).statusCode).toBe(401);
    expect((await link.view({ action: 'document_detail', recordKind: 'payroll', recordId: randomUUID() })).statusCode).toBe(401);
  });
});
