import { describe, expect, it } from 'vitest';
import { accountIds, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

/** Öneri 9: aylık kapanış kontrol listesi ve elle tamamlanan kapanış görevleri. */
describe('aylık kapanış kontrol listesi', async () => {
  const { app } = await makeApp();

  it('taslak ve bekleyen işler kaynağıyla listelenir; görevler kimin işaretlediğiyle tutulur; kapalı dönemde değişmez', async () => {
    const s = await registerUser(app, 'Kapanis');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const year = Number(day(3, 1).slice(0, 4));
    const periods = (await c.get(`/api/periods?year=${year}`)).json().periods as { id: string; month: number }[];
    const march = periods.find((p) => p.month === 3)!;
    const party = (await c.post('/api/parties', { name: 'Kapanış Müşterisi' })).json().party;
    const draft = await c.post('/api/invoices', { type: 'sales', partyId: party.id, invoiceDate: day(3, 10), lines: [{ description: 'Hizmet', accountId: ids['600'], quantity: '1', unitPrice: '100', vatCode: null }] });
    expect([200, 201], draft.body).toContain(draft.statusCode);
    const lines = [{ accountId: ids['100'], currency: 'TRY', debit: '50', credit: '0' }, { accountId: ids['600'], currency: 'TRY', debit: '0', credit: '50' }];
    const entry = (await c.post('/api/journal-entries', { entryDate: day(3, 12), description: 'Taslak fiş', lines })).json().entry as { id: string };

    const list = async () => {
      const r = await c.get(`/api/periods/${march.id}/checklist`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { checks: { key: string; severity: string; count?: number; link?: string }[]; tasks: { key: string; done: { by: string; note: string | null } | null }[]; blockers: number; openTasks: number };
    };
    let data = await list();
    const check = (key: string) => data.checks.find((x) => x.key === key)!;
    expect(check('draft_entries')).toMatchObject({ severity: 'blocker', count: 1, link: '/accounting/journal' });
    expect(check('draft_invoices')).toMatchObject({ severity: 'warning', count: 1 });
    expect(check('trial_balance').severity).toBe('ok');
    expect(data.blockers).toBe(1);
    expect(data.openTasks).toBe(6);

    const marked = await c.post(`/api/periods/${march.id}/tasks/depreciation`, { note: 'AM-2026-03 fişi' });
    expect(marked.statusCode, marked.body).toBe(200);
    data = marked.json();
    expect(data.tasks.find((t) => t.key === 'depreciation')!.done).toMatchObject({ note: 'AM-2026-03 fişi', by: expect.any(String) });
    expect((await c.post(`/api/periods/${march.id}/tasks/bilinmeyen`, {})).statusCode).toBe(400);
    expect((await c.delete(`/api/periods/${march.id}/tasks/depreciation`)).json().openTasks).toBe(6);
    await c.post(`/api/periods/${march.id}/tasks/vat_review`, {});

    // Taslak fiş kapatmayı engeller (mevcut kural); fiş silinince kapanır ve görevler kilitlenir
    expect((await c.post(`/api/periods/${march.id}/close`, {})).json().error.code).toBe('PERIOD_HAS_DRAFTS');
    expect((await c.delete(`/api/journal-entries/${entry.id}`)).statusCode).toBeLessThan(300);
    expect((await c.post(`/api/periods/${march.id}/close`, {})).statusCode).toBe(200);
    expect((await c.post(`/api/periods/${march.id}/tasks/accruals`, {})).json().error.code).toBe('PERIOD_CLOSED');
    await expect(execAsOwner(`delete from period_close_tasks where period_id = $1`, [march.id])).rejects.toThrow(/değiştirilemez/);
  });
});
