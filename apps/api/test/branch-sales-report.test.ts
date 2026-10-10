import { describe, expect, it } from 'vitest';
import { addMember, client, day, makeApp, registerUser } from './helpers';
import { createLegacyCompany } from './legacy-company';

const { app } = await makeApp();
const ok = (response: { statusCode: number; body: string; json(): any }, status = 201) => {
  expect(response.statusCode, response.body).toBe(status); return response.json();
};
async function setup() {
  const owner = await registerUser(app, 'BranchSales');
  const company = await createLegacyCompany(app, owner.token, { sector: 'COMMERCE' });
  const c = client(app, owner.token, company.id);
  const a = ok(await c.post('/api/company/branches', { code: 'A', name: 'Birinci şube' })).branch;
  const b = ok(await c.post('/api/company/branches', { code: 'B', name: 'İkinci şube' })).branch;
  const preparer = await addMember(app, c, company.id, 'admin', 'SalesPreparer');
  const party = ok(await c.post('/api/parties', { kind: 'customer', name: 'Şube müşterisi' })).party;
  const call = (method: 'GET' | 'POST', url: string, branch: string, payload?: object, token = owner.token) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, 'x-company-id': company.id, 'x-branch-id': branch } });
  const invoice = (amount: string, branch: string, token = owner.token, extra: object = {}) => call('POST', '/api/invoices', branch, { type: 'sales', partyId: party.id, invoiceDate: day(9, 1), post: true, lines: [{ description: 'Şube hizmeti', quantity: '10', unitPrice: amount, vatCode: 'KDV-16' }], ...extra }, token);
  return { owner, company, c, a, b, preparer, call, invoice };
}
describe('Şube ve kayıt kullanıcısı raporları', () => {
  it('eski şubesiz kayıt korunur; iade özgün kullanıcıya, iptal kendi dönemine yazılır; CSV aynı toplamı taşır', async () => {
    const w = await setup();
    const first = ok(await w.invoice('10', w.a.id, w.preparer.token));
    const second = ok(await w.invoice('30', w.b.id));
    ok(await w.invoice('5', 'unassigned'));
    ok(await w.invoice('30', w.b.id, w.preparer.token, { type: 'sales_return', returnOfId: second.invoice.id, invoiceDate: day(9, 15), lines: [{ description: 'Kısmi iade', quantity: '1', unitPrice: '30', vatCode: 'KDV-16', sourceLineId: second.lines[0].id }] }));
    const september = `from=${day(9, 1)}&to=${day(9, 30)}`;
    const branches = ok(await w.c.get(`/api/reports/sales-report?${september}&groupBy=branch`), 200);
    expect(branches.rows).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Birinci şube', net: '100.0000' }), expect.objectContaining({ label: 'İkinci şube', net: '270.0000' }), expect.objectContaining({ key: '-', label: 'Şubeye atanmamış', net: '50.0000' })]));
    const users = ok(await w.c.get(`/api/reports/sales-report?${september}&groupBy=creator`), 200);
    expect(users.rows.find((r: { key: string }) => r.key === w.preparer.userId).net).toBe('100.0000');
    expect(users.rows.find((r: { key: string }) => r.key === w.owner.userId).net).toBe('320.0000');
    expect(users.totals.net).toBe(branches.totals.net);
    const cancelled = await w.c.post(`/api/invoices/${first.invoice.id}/cancel`, { reason: 'Dönemli iptal testi', date: day(10, 1) }); expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(ok(await w.c.get(`/api/reports/sales-report?${september}&groupBy=branch`), 200).totals.net).toBe('420.0000');
    const year = `from=${day(1, 1)}&to=${day(12, 31)}`;
    const after = ok(await w.c.get(`/api/reports/sales-report?${year}&groupBy=creator`), 200); expect(after.totals.net).toBe('320.0000');
    const csv = await w.c.get(`/api/exports/sales-report?${year}&groupBy=branch&format=csv`); expect(csv.statusCode, csv.body).toBe(200); expect(csv.body).toContain('Şubeye atanmamış'); expect(csv.body).toContain('270');
  });
  it('güncel şube kapsamı hem kullanıcı kırılımını hem dosya çıktısını sınırlar; dışa aktarma engeli ayrıca uygulanır', async () => {
    const w = await setup(); ok(await w.invoice('10', w.a.id)); ok(await w.invoice('30', w.b.id)); ok(await w.invoice('5', 'unassigned'));
    expect((await w.c.put(`/api/company/members/${w.preparer.userId}/branches`, { mode: 'restricted', branchIds: [w.a.id], allowUnassigned: false })).statusCode).toBe(200);
    const range = `from=${day(1, 1)}&to=${day(12, 31)}`;
    for (const groupBy of ['branch', 'creator']) {
      const report = ok(await w.call('GET', `/api/reports/sales-report?${range}&groupBy=${groupBy}`, 'all', undefined, w.preparer.token), 200); expect(report.totals.net).toBe('100.0000'); expect(report.rows).toHaveLength(1);
    }
    const csv = await w.call('GET', `/api/exports/sales-report?${range}&groupBy=branch&format=csv`, 'all', undefined, w.preparer.token); expect(csv.statusCode, csv.body).toBe(200); expect(csv.body).not.toContain('İkinci şube'); expect(csv.body).not.toContain('Şubeye atanmamış');
    expect((await w.c.put(`/api/company/members/${w.preparer.userId}/module-access`, { operations: { 'operation.core.invoices.export': 'deny' } })).statusCode).toBe(200);
    expect((await w.preparer.client.get(`/api/reports/sales-report?${range}&groupBy=branch`)).statusCode).toBe(200);
    expect((await w.preparer.client.get(`/api/exports/sales-report?${range}&groupBy=branch&format=csv`)).statusCode).toBe(403);
  });
});
