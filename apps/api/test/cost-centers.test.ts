import { describe, expect, it } from 'vitest';
import { accountIds, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

/** Öneri 11: departman / maliyet merkezi alanı. İsteğe bağlı; yalnız sonuç hesaplarında; faturadan yevmiyeye taşınır. */
describe('maliyet merkezi', async () => {
  const { app } = await makeApp();

  it('tanım, yevmiye ve fatura satırında kullanım; bilanço hesabı, pasif ve yabancı merkez reddedilir', async () => {
    const s = await registerUser(app, 'Departman');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const created = await c.post('/api/cost-centers', { code: 'sat', name: 'Satış departmanı' });
    expect(created.statusCode, created.body).toBe(201);
    const sales = created.json().costCenter;
    expect(sales.code).toBe('SAT');
    expect((await c.post('/api/cost-centers', { code: 'SAT', name: 'Tekrar' })).statusCode).toBe(409);

    const entry = (lines: unknown[]) => c.post('/api/journal-entries', { entryDate: day(3, 5), description: 'Departman gideri', post: true, lines });
    const ok = await entry([{ accountId: ids['770'], currency: 'TRY', debit: '40', credit: '0', costCenterId: sales.id }, { accountId: ids['100'], currency: 'TRY', debit: '0', credit: '40' }]);
    expect([200, 201], ok.body).toContain(ok.statusCode);
    expect((await entry([{ accountId: ids['770'], currency: 'TRY', debit: '40', credit: '0' }, { accountId: ids['100'], currency: 'TRY', debit: '0', credit: '40', costCenterId: sales.id }])).json().error.code).toBe('COST_CENTER_ACCOUNT');

    const party = (await c.post('/api/parties', { name: 'Departman Müşterisi' })).json().party;
    const inv = await c.post('/api/invoices', { post: true, type: 'sales', partyId: party.id, invoiceDate: day(3, 6), lines: [{ description: 'Hizmet', accountId: ids['600'], quantity: '1', unitPrice: '100', vatCode: null, costCenterId: sales.id }] });
    expect([200, 201], inv.body).toContain(inv.statusCode);
    expect(inv.json().lines[0]).toMatchObject({ costCenterId: sales.id, costCenterCode: 'SAT' });
    const rows = (await execAsOwner(`select a.code, l.cost_center_id from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no`, [inv.json().invoice.journalEntryId])).rows;
    expect(rows.find((r) => r.code === '600')!.cost_center_id).toBe(sales.id);
    expect(rows.filter((r) => r.code !== '600').every((r) => r.cost_center_id === null)).toBe(true);

    expect((await c.patch(`/api/cost-centers/${sales.id}`, { isActive: false })).json().costCenter.isActive).toBe(false);
    expect((await entry([{ accountId: ids['770'], currency: 'TRY', debit: '1', credit: '0', costCenterId: sales.id }, { accountId: ids['100'], currency: 'TRY', debit: '0', credit: '1' }])).json().error.code).toBe('COST_CENTER_INACTIVE');
    await expect(execAsOwner(`update cost_centers set code = 'X' where id = $1`, [sales.id])).rejects.toThrow(/değiştirilemez/);

    const s2 = await registerUser(app, 'DepartmanYabanci');
    const c2company = await createCompany(app, s2.token);
    const c2 = client(app, s2.token, c2company.id);
    const ids2 = await accountIds(app, s2.token, c2company.id);
    const foreign = await c2.post('/api/journal-entries', { entryDate: day(3, 5), description: 'Yabancı', post: true, lines: [{ accountId: ids2['770'], currency: 'TRY', debit: '1', credit: '0', costCenterId: sales.id }, { accountId: ids2['100'], currency: 'TRY', debit: '0', credit: '1' }] });
    expect(foreign.json().error.code).toBe('COST_CENTER_NOT_FOUND');
  });
});
