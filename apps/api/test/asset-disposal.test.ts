import { describe, it, expect } from 'vitest';
import { makeApp, TODAY_LOCAL, asOwner, expectDbError } from './helpers';
import { x2Kit } from './x2-helpers';

/** Demirbaş elden çıkarma (öneri 60): satış kârı, hurda zararı, eksik amortisman engeli ve değişmez kayıt. */
describe('demirbaş elden çıkarma', async () => {
  const { app } = await makeApp(),
    kit = x2Kit(app);
  const month = TODAY_LOCAL.slice(0, 7);
  const prevMonth = (() => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  })();

  it('satış kârı ve hurda zararı yevmiyeyle kapanır, iptal ters kayıtla kartı geri açar', async () => {
    const w = await kit.setup('Elden', { sector: 'CONSTRUCTION' });
    for (const [code, name] of [
      ['253', 'Tesis makine ve cihazlar'],
      ['257', 'Birikmiş amortismanlar'],
      ['679', 'Diğer olağandışı gelir ve kârlar'],
      ['689', 'Diğer olağandışı gider ve zararlar'],
    ])
      expect([201, 409]).toContain((await w.c.post('/api/accounts', { code, name })).statusCode);
    const ids = Object.fromEntries(((await w.c.get('/api/accounts')).json().accounts as { code: string; id: string }[]).map((a) => [a.code, a.id]));
    const created = await w.c.post('/api/fixed-assets', {
      code: 'KAM-1',
      name: 'Kamyon',
      category: 'vehicle',
      cost: '1000',
      salvage: '100',
      startMonth: month,
      acquisitionDate: `${month}-01`,
      usefulMonths: 3,
      expenseAccountId: ids['632'],
      accumulatedAccountId: ids['257'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const asset = created.json().asset;
    const dep = await w.c.post(`/api/fixed-assets/${asset.id}/depreciation`, { month, version: 1 });
    expect(dep.statusCode, dep.body).toBe(201);
    // Taslak amortisman varken elden çıkarılamaz
    const sale = { date: TODAY_LOCAL, method: 'sale', proceeds: '800', assetAccountId: ids['253'], proceedsAccountId: ids['100'], gainAccountId: ids['679'], version: 1 };
    const draftBlocked = await w.c.post(`/api/fixed-assets/${asset.id}/dispose`, sale);
    expect(draftBlocked.statusCode, draftBlocked.body).toBe(422);
    expect(draftBlocked.json().error.code).toBe('ASSET_DRAFT_DEPRECIATION');
    expect((await w.c.post(`/api/journal-entries/${dep.json().entry.journalEntryId}/post`, {})).statusCode).toBe(200);

    // Kâr hesabı seçilmeden kârlı satış kaydedilmez
    expect((await w.c.post(`/api/fixed-assets/${asset.id}/dispose`, { ...sale, gainAccountId: null })).statusCode).toBe(400);
    const sold = await w.c.post(`/api/fixed-assets/${asset.id}/dispose`, sale);
    expect(sold.statusCode, sold.body).toBe(201);
    expect(sold.json().asset).toMatchObject({ active: false, disposedOn: TODAY_LOCAL });
    const disposal = sold.json().disposals[0];
    expect(disposal).toMatchObject({ method: 'sale', cost: '1000.00', accumulated: '300.00', bookValue: '700.00', gainLoss: '100.00', proceeds: '800.00' });
    const journal = await kit.journalOf(w.c, disposal.journalEntryId);
    expect(journal.entry.status).toBe('posted');
    expect(journal.byCode('257')).toEqual([['257', 300, 0]]);
    expect(journal.byCode('100')).toEqual([['100', 800, 0]]);
    expect(journal.byCode('253')).toEqual([['253', 0, 1000]]);
    expect(journal.byCode('679')).toEqual([['679', 0, 100]]);

    // Kapalı kart: ikinci kez çıkarılamaz, etkinleştirilemez, amortisman yazılamaz
    const version = sold.json().asset.version;
    expect((await w.c.post(`/api/fixed-assets/${asset.id}/dispose`, { ...sale, version })).statusCode).toBe(409);
    expect((await w.c.patch(`/api/fixed-assets/${asset.id}/active`, { active: true, version })).statusCode).toBe(409);
    expect((await w.c.post(`/api/fixed-assets/${asset.id}/depreciation`, { month, version })).statusCode).toBe(409);
    expect((await w.c.post(`/api/journal-entries/${disposal.journalEntryId}/reverse`, {})).statusCode).toBe(422);
    await asOwner(async (q) => {
      expect((await expectDbError(q, "update asset_disposals set proceeds='1' where id=$1", [disposal.id])).code).toBe('ERP19');
      expect((await expectDbError(q, 'update fixed_assets set active=true where id=$1', [asset.id])).code).toBe('ERP19');
      expect((await expectDbError(q, 'delete from asset_disposals where id=$1', [disposal.id])).code).toBe('ERP19');
    });

    const cancelled = await w.c.post(`/api/fixed-assets/${asset.id}/disposals/${disposal.id}/cancel`, { reason: 'Satış geri döndü', date: TODAY_LOCAL });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().asset).toMatchObject({ active: true, disposedOn: null });
    expect(cancelled.json().disposals[0].reversalEntryId).toBeTruthy();

    // Hurdaya ayırma: bedel yok, defter değeri zarar olarak yazılır
    const scrapped = await w.c.post(`/api/fixed-assets/${asset.id}/dispose`, {
      date: TODAY_LOCAL,
      method: 'scrap',
      assetAccountId: ids['253'],
      lossAccountId: ids['689'],
      version: cancelled.json().asset.version,
    });
    expect(scrapped.statusCode, scrapped.body).toBe(201);
    const scrap = scrapped.json().disposals.find((d: { cancelledAt: string | null }) => !d.cancelledAt);
    expect(scrap).toMatchObject({ method: 'scrap', bookValue: '700.00', gainLoss: '-700.00' });
    const scrapJournal = await kit.journalOf(w.c, scrap.journalEntryId);
    expect(scrapJournal.byCode('689')).toEqual([['689', 700, 0]]);
    expect(scrapJournal.byCode('253')).toEqual([['253', 0, 1000]]);
  });

  it('önceki aylarda kayıtsız amortisman varsa elden çıkarma engellenir', async () => {
    const w = await kit.setup('EldenEksik', { sector: 'CONSTRUCTION' });
    for (const [code, name] of [
      ['253', 'Tesis makine ve cihazlar'],
      ['257', 'Birikmiş amortismanlar'],
      ['689', 'Diğer olağandışı gider ve zararlar'],
    ])
      expect([201, 409]).toContain((await w.c.post('/api/accounts', { code, name })).statusCode);
    const ids = Object.fromEntries(((await w.c.get('/api/accounts')).json().accounts as { code: string; id: string }[]).map((a) => [a.code, a.id]));
    const created = await w.c.post('/api/fixed-assets', {
      code: 'KAM-2',
      name: 'Eski kamyon',
      cost: '1200',
      startMonth: prevMonth,
      acquisitionDate: `${prevMonth}-01`,
      usefulMonths: 12,
      expenseAccountId: ids['632'],
      accumulatedAccountId: ids['257'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const blocked = await w.c.post(`/api/fixed-assets/${created.json().asset.id}/dispose`, {
      date: TODAY_LOCAL,
      method: 'scrap',
      assetAccountId: ids['253'],
      lossAccountId: ids['689'],
      version: 1,
    });
    expect(blocked.statusCode, blocked.body).toBe(422);
    expect(blocked.json().error.code).toBe('ASSET_DEPRECIATION_MISSING');
  });
});
