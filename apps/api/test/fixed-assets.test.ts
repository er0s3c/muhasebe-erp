import { describe, it, expect } from 'vitest';
import { makeApp, TODAY_LOCAL, asOwner, expectDbError, addMember } from './helpers';
import { x2Kit } from './x2-helpers';
describe('demirbaş ve amortisman', async () => {
  const { app } = await makeApp(),
    kit = x2Kit(app);
  async function setup(name: string) {
    const w = await kit.setup(name, { sector: 'CONSTRUCTION' });
    const added = await w.c.post('/api/accounts', { code: '257', name: 'Birikmiş amortismanlar' });
    expect([201, 409]).toContain(added.statusCode);
    const accounts = (await w.c.get('/api/accounts')).json().accounts,
      accumulated = accounts.find((a: any) => a.code === '257');
    const month = TODAY_LOCAL.slice(0, 7),
      date = month + '-01';
    const config = {
      code: 'EK-1',
      name: 'Ekskavatör',
      category: 'equipment',
      cost: '1000',
      salvage: '100',
      startMonth: month,
      acquisitionDate: date,
      usefulMonths: 3,
      expenseAccountId: w.ids['632'],
      accumulatedAccountId: accumulated.id,
      department: 'Şantiye',
      location: 'A Blok',
    };
    const response = await w.c.post('/api/fixed-assets', config);
    expect(response.statusCode, response.body).toBe(201);
    const asset = response.json().asset;
    return { ...w, config, asset, month };
  }
  it('aynı ay yalnızca bir taslak, deftere kayıtta maliyet ve ters kayıtta geri alma; değişmez mali geçmiş', async () => {
    const w = await setup('Amortisman');
    const replies = await Promise.all([
      w.c.post(`/api/fixed-assets/${w.asset.id}/depreciation`, { month: w.month, version: 1 }),
      w.c.post(`/api/fixed-assets/${w.asset.id}/depreciation`, { month: w.month, version: 1 }),
    ]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const entry = replies.find((r) => r.statusCode === 201)!.json().entry;
    expect(entry).toMatchObject({
      amount: '300.00',
      month: w.month,
      entryStatus: 'draft',
      cancelledAt: null,
    });
    expect((await w.c.get(`/api/fixed-assets/${w.asset.id}`)).json().asset).toMatchObject({
      draftAmount: '300.00',
      postedAmount: '0',
      bookValue: '1000.00',
    });
    expect(
      (
        await w.c.put(`/api/fixed-assets/${w.asset.id}`, {
          config: { ...w.config, cost: '2000' },
          version: 1,
        })
      ).statusCode,
    ).toBe(409);
    const journal = await kit.journalOf(w.c, entry.journalEntryId);
    expect(journal.byCode('632')).toEqual([['632', 300, 0]]);
    expect(journal.byCode('257')).toEqual([['257', 0, 300]]);
    await asOwner(async (q) => {
      expect(
        (
          await expectDbError(
            q,
            'update journal_lines set debit=1,debit_base=1 where entry_id=$1 and debit>0',
            [entry.journalEntryId],
          )
        ).code,
      ).toBe('ERP19');
      expect(
        (
          await expectDbError(
            q,
            'update journal_entries set source_type=null,source_id=null where id=$1',
            [entry.journalEntryId],
          )
        ).code,
      ).toBe('ERP19');
      expect(
        (
          await expectDbError(
            q,
            "update fixed_assets set config=jsonb_set(config,'{cost}','\"9999\"') where id=$1",
            [w.asset.id],
          )
        ).code,
      ).toBe('ERP19');
    });
    const posted = await w.c.post(`/api/journal-entries/${entry.journalEntryId}/post`, {});
    expect(posted.statusCode, posted.body).toBe(200);
    expect((await w.c.get(`/api/fixed-assets/${w.asset.id}`)).json().asset).toMatchObject({
      postedAmount: '300.00',
      draftAmount: '0',
      bookValue: '700.00',
    });
    const lastDay = posted.json().entry.entryDate;
    // Reporting-only backfill stays available; carrying amounts and source never change.
    await asOwner(async (q) => {
      await q(
        'update journal_lines set debit_reporting=debit_base,credit_reporting=credit_base where entry_id=$1',
        [entry.journalEntryId],
      );
      expect(
        (
          await expectDbError(
            q,
            'update journal_lines set debit_reporting=debit_base+1 where entry_id=$1',
            [entry.journalEntryId],
          )
        ).code,
      ).toBeDefined();
    });
    const cancelled = await w.c.post(
      `/api/fixed-assets/${w.asset.id}/depreciation/${entry.id}/cancel`,
      { reason: 'Hatalı dönem kaydı', date: lastDay },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().asset).toMatchObject({ postedAmount: '0', bookValue: '1000.00' });
    expect(cancelled.json().history[0].reversalEntryId).toBeTruthy();
    const recreated = await w.c.post(`/api/fixed-assets/${w.asset.id}/depreciation`, {
      month: w.month,
      version: 1,
    });
    expect(recreated.statusCode, recreated.body).toBe(201);
    const newPeriod = recreated.json().entry;
    const discard = await w.c.post(
      `/api/fixed-assets/${w.asset.id}/depreciation/${newPeriod.id}/cancel`,
      { reason: 'Taslak iptali' },
    );
    expect(discard.statusCode, discard.body).toBe(200);
    expect(
      (await w.c.post(`/api/journal-entries/${newPeriod.journalEntryId}/post`, {})).statusCode,
    ).toBe(422);
  });
  it('şirket, rol, kart sürümü, ay kapsamı ve hesap uyumu denetlenir', async () => {
    const w = await setup('DemirbasYetki'),
      other = await setup('DemirbasDiger');
    expect((await other.c.get(`/api/fixed-assets/${w.asset.id}`)).statusCode).toBe(404);
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect((await viewer.client.post('/api/fixed-assets', w.config)).statusCode).toBe(403);
    expect(
      (await w.c.put(`/api/fixed-assets/${w.asset.id}`, { config: w.config, version: 2 }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await w.c.post(`/api/fixed-assets/${w.asset.id}/depreciation`, {
          month: '2099-01',
          version: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await w.c.post('/api/fixed-assets', {
          ...w.config,
          code: 'BAD',
          accumulatedAccountId: w.ids['320'],
        })
      ).statusCode,
    ).toBe(400);
    const toggled = await w.c.patch(`/api/fixed-assets/${w.asset.id}/active`, {
      active: false,
      version: 1,
    });
    expect(toggled.statusCode).toBe(200);
    expect(
      (
        await w.c.post(`/api/fixed-assets/${w.asset.id}/depreciation`, {
          month: w.month,
          version: 2,
        })
      ).statusCode,
    ).toBe(409);
  });
});
