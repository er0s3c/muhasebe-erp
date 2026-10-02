import { describe, expect, it } from 'vitest';
import { accountIds, addMember, asDb, asOwner, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

const Y = thisYear;

/**
 * Yıl sonu kapanışı ve devir (Faz Y1): ön kontrol, önizleme = kayıt, kapanış fişi, rapor dışlaması, devir, kilit (veritabanı tetikleyicisi dahil),
 * yeniden açma (gerekçe, sıra, yetki), çoklu para birimi, proje etiketi, alt defter mutabakatı. Hesap seçimleri doğrulanmamıştır (LEGAL-NOTES §23).
 */
describe('yıl sonu kapanışı ve devir', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids, orgId: await orgOf(app, s.token) };
  }
  type World = Awaited<ReturnType<typeof setup>>;
  type C = World['c'];

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  /** Dengeli yevmiye: [hesap kodu, 'debit'|'credit', tutar, ek alanlar]. */
  const post = async (w: World, date: string, lines: [string, 'debit' | 'credit', string, Record<string, unknown>?][], extra: Record<string, unknown> = {}) =>
    ok(
      w.c.post('/api/journal-entries', {
        entryDate: date,
        description: 'Test',
        post: true,
        ...extra,
        lines: lines.map(([code, side, amt, more]) => ({ accountId: w.ids[code], currency: 'TRY', [side]: amt, ...(more ?? {}) })),
      }),
      201,
    );

  /** Kâr senaryosu: sermaye, satış (KDV'li), gider, 7. sınıf maliyet, dövizli (EUR) gelir hesabı. */
  async function seedProfit(w: World, opts: { project?: string } = {}) {
    await post(w, day(2, 1), [['100', 'debit', '10000'], ['500', 'credit', '10000']]);
    await post(w, day(3, 10), [['100', 'debit', '1180'], ['600', 'credit', '1000'], ['391', 'credit', '180']]);
    await post(w, day(4, 10), [['632', 'debit', '300'], ['100', 'credit', '300']]);
    await post(w, day(5, 10), [['770', 'debit', '400', opts.project ? { projectId: opts.project } : {}], ['100', 'credit', '400']]);
    // 646.001: EUR cinsinden gelir hesabı; 100 EUR @40 = 4000 TL
    const acc = await ok(w.c.post('/api/accounts', { code: '646.001', name: 'Kambiyo kârı EUR', currencyCode: 'EUR' }), 201);
    w.ids['646.001'] = acc.account.id;
    await ok(
      w.c.post('/api/journal-entries', {
        entryDate: day(6, 10),
        description: 'Dövizli gelir',
        post: true,
        lines: [
          { accountId: w.ids['100'], currency: 'TRY', debit: '4000' },
          { accountId: w.ids['646.001'], currency: 'EUR', credit: '100', fxRate: '40' },
        ],
      }),
      201,
    );
  }

  const years = async (c: C) => (await ok(c.get('/api/fiscal-years'))) as { years: any[]; suggestions: any[] };
  const mkYear = async (c: C, start = `${Y}-01-01`, end = `${Y}-12-31`, name?: string) =>
    (await ok(c.post('/api/fiscal-years', { startDate: start, endDate: end, ...(name ? { name } : {}) }), 201)).year as { id: string; name: string };
  const preflight = async (c: C, id: string, qs = '') => (await ok(c.get(`/api/fiscal-years/${id}/preflight${qs}`))) as { checks: any[]; canClose: boolean; blockers: number; result: any };
  const check = (p: { checks: any[] }, key: string) => p.checks.find((x) => x.key === key);
  const preview = async (c: C, id: string, qs = '') => (await ok(c.get(`/api/fiscal-years/${id}/preview${qs}`))) as any;
  const close = (c: C, id: string, name: string, extra: Record<string, unknown> = {}) => c.post(`/api/fiscal-years/${id}/close`, { confirm: name, ...extra });
  const tb = async (c: C, from: string, to: string, qs = '') => {
    const r = await ok(c.get(`/api/reports/trial-balance?from=${from}&to=${to}${qs}`));
    return { raw: r, closing: (code: string) => Number(r.rows.find((x: any) => x.code === code)?.closing ?? 0), row: (code: string) => r.rows.find((x: any) => x.code === code) };
  };
  const entryOf = async (c: C, id: string) => (await ok(c.get(`/api/journal-entries/${id}`))).entry;
  const classBalances = (r: { raw: { rows: any[] } }, classes: string) =>
    Object.fromEntries(r.raw.rows.filter((x) => x.isPostable && classes.includes(x.code[0])).map((x) => [x.code, x.closing]));

  // ---------------------------------------------------------------------------------------------------------------------
  it('mali yıl tanımı: tam aylara oturur, çakışmaz, önerilir; eşleme anahtarları 46 ve varsayılanlar 590/591/570/580', async () => {
    const w = await setup('YsTanim');
    const bad = await w.c.post('/api/fiscal-years', { startDate: `${Y}-01-15`, endDate: `${Y}-12-31` });
    expect(bad.statusCode).toBe(400);
    expect((await w.c.post('/api/fiscal-years', { startDate: `${Y}-01-01`, endDate: `${Y + 1}-02-28` })).statusCode).toBe(400); // 14 ay
    const ys = await mkYear(w.c);
    expect(ys.name).toBe(String(Y));
    const overlap = await w.c.post('/api/fiscal-years', { startDate: `${Y}-07-01`, endDate: `${Y + 1}-06-30` });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json().error.code).toBe('FISCAL_YEAR_RULE_VIOLATION');
    const dup = await w.c.post('/api/fiscal-years', { startDate: `${Y + 1}-01-01`, endDate: `${Y + 1}-12-31`, name: String(Y) });
    expect(dup.statusCode).toBe(409);
    // Öneri: tanımlı yıl önerilmez
    const list = await years(w.c);
    expect(list.suggestions.find((s) => s.name === String(Y))).toBeUndefined();

    const maps = (await ok(w.c.get('/api/account-mappings'))).mappings as { key: string; accountCode: string }[];
    expect(maps).toHaveLength(46);
    expect(Object.fromEntries(maps.filter((m) => m.key.startsWith('year_end_')).map((m) => [m.key, m.accountCode]))).toEqual({
      year_end_profit: '590', year_end_loss: '591', year_end_retained_profit: '570', year_end_retained_loss: '580',
    });
    const n = (await execAsOwner(`select count(*)::int as n from account_mappings where company_id = $1`, [w.company.id])).rows[0].n;
    expect(n).toBe(46);
    // Silinebilir (açık ve geçmişsiz)
    expect((await w.c.delete(`/api/fiscal-years/${ys.id}`)).statusCode).toBe(200);
  });

  it('ön kontrol: taslak yevmiye/fatura, eksik eşleme, kur değerlemesi uyarısı, önceki yıl sırası, kapatılamayan döviz kalıntısı', async () => {
    const w = await setup('YsOnKontrol');
    await seedProfit(w);
    const y = await mkYear(w.c);
    let p = await preflight(w.c, y.id);
    expect(p.canClose).toBe(true);
    expect(check(p, 'trial_balance').severity).toBe('ok');
    expect(check(p, 'fx_revaluation_not_done').severity).toBe('warning'); // her zaman: M7b yapılmadı
    expect(check(p, 'draft_entries').severity).toBe('ok');
    expect(check(p, 'cost_class_balances').severity).toBe('warning'); // 770 bakiyesi
    expect(p.result).toMatchObject({ kind: 'profit', net: '4300.0000' });

    // Taslak yevmiye ve taslak fatura engeller
    const draft = await ok(w.c.post('/api/journal-entries', { entryDate: day(7, 1), description: 'Taslak', lines: [{ accountId: w.ids['100'], currency: 'TRY', debit: '5' }, { accountId: w.ids['500'], currency: 'TRY', credit: '5' }] }), 201);
    const party = (await ok(w.c.post('/api/parties', { name: 'Müşteri', kind: 'customer' }), 201)).party;
    await ok(w.c.post('/api/invoices', { type: 'sales', partyId: party.id, invoiceDate: day(7, 2), lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '10' }] }), 201);
    p = await preflight(w.c, y.id);
    expect(p.canClose).toBe(false);
    expect(check(p, 'draft_entries')).toMatchObject({ severity: 'blocker', count: 1 });
    expect(check(p, 'draft_invoices')).toMatchObject({ severity: 'blocker', count: 1 });
    const blocked = await close(w.c, y.id, y.name);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('YEAR_END_BLOCKED');
    await ok(w.c.delete(`/api/journal-entries/${draft.entry.id}`));

    // Eksik eşleme
    await execAsOwner(`delete from account_mappings where company_id = $1 and key = 'year_end_profit'`, [w.company.id]);
    p = await preflight(w.c, y.id);
    expect(check(p, 'mappings_missing')).toMatchObject({ severity: 'blocker', count: 1 });
    await execAsOwner(`insert into account_mappings (id, company_id, key, account_id) values (gen_random_uuid(), $1, 'year_end_profit', $2)`, [w.company.id, w.ids['590']]);

    // Kapatılamayan döviz kalıntısı: EUR net 0 ama defter farkı var
    const e2 = await ok(w.c.post('/api/accounts', { code: '646.002', name: 'Kambiyo EUR 2', currencyCode: 'EUR' }), 201);
    await ok(w.c.post('/api/journal-entries', { entryDate: day(8, 1), description: 'a', post: true, lines: [{ accountId: w.ids['100'], currency: 'TRY', debit: '400' }, { accountId: e2.account.id, currency: 'EUR', credit: '10', fxRate: '40' }] }), 201);
    await ok(w.c.post('/api/journal-entries', { entryDate: day(8, 2), description: 'b', post: true, lines: [{ accountId: w.ids['100'], currency: 'TRY', credit: '410' }, { accountId: e2.account.id, currency: 'EUR', debit: '10', fxRate: '41' }] }), 201);
    p = await preflight(w.c, y.id);
    expect(check(p, 'fx_residual')).toMatchObject({ severity: 'blocker', count: 1 });
    expect(p.canClose).toBe(false);
  });

  it('katı sıra: önceki mali yıl açıkken sonraki kapatılamaz (uygulama ve veritabanı)', async () => {
    const w = await setup('YsSira');
    await post(w, day(2, 1), [['100', 'debit', '100'], ['600', 'credit', '100']]);
    const prev = await mkYear(w.c, `${Y - 1}-01-01`, `${Y - 1}-12-31`);
    const cur = await mkYear(w.c);
    const p = await preflight(w.c, cur.id);
    expect(check(p, 'previous_year_open')).toMatchObject({ severity: 'blocker', count: 1 });
    const res = await close(w.c, cur.id, cur.name);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('YEAR_END_BLOCKED');
    await ok(close(w.c, prev.id, prev.name));
    await ok(close(w.c, cur.id, cur.name));
    // Önceki yılı yeniden açmak sonraki kapalıyken engellenir
    const re = await w.c.post(`/api/fiscal-years/${prev.id}/reopen`, { reason: 'Düzeltme gerekli' });
    expect(re.statusCode).toBe(422);
    expect(re.json().error.code).toBe('FISCAL_YEAR_ORDER');
    // Veritabanı: aynısı ham SQL ile (tablo sahibi) de reddedilir; gerekçesiz açma da
    await asOwner(async (q) => {
      const e1 = await expectDbError(q, `update fiscal_years set status = 'open', reopen_reason = 'gerekçe var', closed_at = null, closed_by = null where id = $1`, [prev.id]);
      expect(e1.code).toBe('ERP23');
      const e2 = await expectDbError(q, `update fiscal_years set status = 'open', closed_at = null, closed_by = null where id = $1`, [cur.id]);
      expect(e2.code).toBe('ERP23');
      expect(e2.message).toContain('gerekçe');
    });
    // Sırayla açılır
    await ok(w.c.post(`/api/fiscal-years/${cur.id}/reopen`, { reason: 'Düzeltme gerekli' }));
    await ok(w.c.post(`/api/fiscal-years/${prev.id}/reopen`, { reason: 'Düzeltme gerekli' }));
  });

  it('önizleme = kayıt; kapanış tüm gelir/gider hesaplarını sıfırlar, fiş dengelidir, devir ertesi yılın ilk gününe yazılır', async () => {
    const w = await setup('YsKapanis');
    await seedProfit(w);
    const before = await tb(w.c, day(1, 1), day(12, 31));
    const y = await mkYear(w.c);

    const pv = await preview(w.c, y.id);
    expect(pv.kind).toBe('profit');
    expect(pv.net).toBe('4300.0000');
    expect(pv.closingEntry.date).toBe(`${Y}-12-31`);
    expect(pv.carryEntry.date).toBe(`${Y + 1}-01-01`);
    const eur = pv.closingEntry.lines.find((l: any) => l.accountCode === '646.001');
    expect(eur).toMatchObject({ currencyCode: 'EUR', debit: '100.0000', debitBase: '4000.0000', fxRate: '40.00000000' }); // dövizli hesap kendi para biriminde kapanır
    // Önizleme hiçbir şey yazmaz
    expect((await tb(w.c, day(1, 1), day(12, 31))).raw.totals).toEqual(before.raw.totals);
    expect((await entryOf(w.c, (await ok(w.c.get(`/api/journal-entries?limit=1`))).entries[0].id)).sourceType).toBeNull();

    // Yanlış onay metni
    const wrong = await close(w.c, y.id, 'yanlış');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('CONFIRMATION_MISMATCH');

    const done = await ok(close(w.c, y.id, y.name));
    expect(done.kind).toBe('profit');
    expect(done.net).toBe('4300.0000');
    const ce = await entryOf(w.c, done.closeEntry.id);
    expect(ce).toMatchObject({ status: 'posted', sourceType: 'year_end_close', entryDate: `${Y}-12-31` });
    // Önizleme satırları = kaydedilen satırlar
    const norm = (l: any) => [l.accountCode, l.currencyCode, l.debit, l.credit, l.debitBase, l.creditBase, l.fxRate];
    expect(ce.lines.map(norm)).toEqual(pv.closingEntry.lines.map((l: any) => [l.accountCode, l.currencyCode, l.debit, l.credit, l.debitBase, l.creditBase, l.fxRate]));
    // Dengeli
    const sumD = ce.lines.reduce((s: number, l: any) => s + Number(l.debitBase), 0);
    const sumC = ce.lines.reduce((s: number, l: any) => s + Number(l.creditBase), 0);
    expect(sumD).toBeCloseTo(sumC, 4);
    expect(ce.lines.at(-1)).toMatchObject({ accountCode: '590', creditBase: '4300.0000' });
    const cy = await entryOf(w.c, done.carryEntry.id);
    expect(cy).toMatchObject({ sourceType: 'year_end_carry', entryDate: `${Y + 1}-01-01` });
    expect(cy.lines.map((l: any) => [l.accountCode, l.debitBase, l.creditBase])).toEqual([['590', '4300.0000', '0.0000'], ['570', '0.0000', '4300.0000']]);

    // Kapanıştan sonra (kapanış fişleri dahil) tüm gelir/gider hesapları sıfır; mizan dengeli
    const after = await tb(w.c, day(1, 1), day(12, 31));
    for (const code of ['600', '632', '770', '646.001']) expect(after.closing(code)).toBe(0);
    expect(after.raw.totals.difference).toBe('0.0000');
    expect(after.closing('590')).toBe(-4300); // devir ertesi yılın ilk günü: yıl içinde 590'da kâr durur
    // Bilanço hesapları değişmez
    expect(classBalances(after, '1234')).toEqual(classBalances(before, '1234'));
    expect(after.closing('500')).toBe(before.closing('500'));
    // Kapanış fişleri hariç tutulursa mizan kapanış öncesiyle birebir aynıdır
    const excl = await tb(w.c, day(1, 1), day(12, 31), '&excludeClosing=true');
    expect(excl.raw.rows).toEqual(before.raw.rows);
    expect(excl.raw.totals).toEqual(before.raw.totals);

    // Gelecek yıl: gelir/gider hesapları sıfırdan başlar, bilanço hesapları devreder, sonuç geçmiş yıllar kârlarında
    const next = await tb(w.c, `${Y + 1}-01-01`, `${Y + 1}-12-31`);
    for (const code of ['600', '632', '770', '646.001']) expect(Number(next.row(code)?.opening ?? 0)).toBe(0); // gelir/gider yeni yıla bakiye taşımaz
    for (const code of ['600', '632', '770', '646.001']) expect(next.closing(code)).toBe(0);
    expect(next.row('100').opening).toBe(before.row('100').closing);
    expect(Number(next.row('570').closing)).toBe(-4300);
    expect(next.closing('590')).toBe(0);
    expect(next.raw.totals.difference).toBe('0.0000');
    const nextExcl = await tb(w.c, `${Y + 1}-01-01`, `${Y + 1}-12-31`, '&excludeClosing=true');
    expect(Number(nextExcl.row('600').opening)).toBe(-1000); // kapanışsız görünümde önceki yılın birikmiş sonucu
    // Yeni yılda kayıt serbest
    await post(w, `${Y + 1}-02-01`, [['100', 'debit', '50'], ['600', 'credit', '50']]);
    // Hesap ekstresinde kapanış satırı ayrı işaretlidir ve kapanışsız görünüm seçilebilir
    const al = await ok(w.c.get(`/api/reports/account-ledger?accountId=${w.ids['600']}&from=${day(1, 1)}&to=${day(12, 31)}`));
    expect(al.lines.map((l: any) => l.closingSource)).toEqual([null, 'year_end_close']);
    expect(al.closing).toBe('0.0000');
    const al2 = await ok(w.c.get(`/api/reports/account-ledger?accountId=${w.ids['600']}&from=${day(1, 1)}&to=${day(12, 31)}&excludeClosing=true`));
    expect(al2.lines).toHaveLength(1);
    expect(al2.closing).toBe('-1000.0000');
  });

  it('zarar: 591 borç, devir 580; gelir tablosu raporları kapanışı varsayılan olarak dışlar (yönetici özeti, konsolidasyon), isteğe bağlı dahil eder', async () => {
    const w = await setup('YsZarar');
    await post(w, day(2, 1), [['100', 'debit', '5000'], ['500', 'credit', '5000']]);
    await post(w, day(3, 1), [['100', 'debit', '200'], ['600', 'credit', '200']]);
    await post(w, day(4, 1), [['632', 'debit', '900'], ['100', 'credit', '900']]);
    const g = await ok(client(app, w.s.token).post('/api/consolidation/groups', { name: 'Grup', reportingCurrency: 'TRY', companyIds: [w.company.id] }), 201);
    const rep = async (qs = '') => (await ok(client(app, w.s.token).get(`/api/consolidation/groups/${g.group.id}/report?from=${day(1, 1)}&to=${day(12, 31)}${qs}`))).report;
    const exec = async (qs = '') => (await ok(w.c.get(`/api/reports/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}&compare=none${qs}`))).report;
    const stmt = (r: any, k: string) => r.statements.incomeStatement.find((l: any) => l.key === k).values.consolidated;

    const rb = await rep();
    const eb = await exec();
    expect(stmt(rb, 'net_profit')).toBe('-700.0000');
    expect(eb.income.current.profit).toBe('-700.0000');

    const y = await mkYear(w.c);
    const pv = await preview(w.c, y.id);
    expect(pv).toMatchObject({ kind: 'loss', net: '-700.0000' });
    const done = await ok(close(w.c, y.id, y.name));
    const ce = await entryOf(w.c, done.closeEntry.id);
    expect(ce.lines.at(-1)).toMatchObject({ accountCode: '591', debitBase: '700.0000' });
    expect((await entryOf(w.c, done.carryEntry.id)).lines.map((l: any) => [l.accountCode, l.debitBase, l.creditBase])).toEqual([['591', '0.0000', '700.0000'], ['580', '700.0000', '0.0000']]);

    // Kapalı yılın gelir tablosu kapanıştan etkilenmez (varsayılan: kapanış hariç)
    const ra = await rep();
    expect(stmt(ra, 'net_profit')).toBe('-700.0000');
    expect(ra.statements.incomeStatement).toEqual(rb.statements.incomeStatement);
    expect(ra.statements.balanceSheet).toEqual(rb.statements.balanceSheet);
    const ea = await exec();
    expect(ea.income.current).toEqual(eb.income.current);
    // Kapanış dahil istenirse gelir/gider sıfırdır
    const ri = await rep('&includeClosing=true');
    expect(stmt(ri, 'net_profit')).toBe('0.0000');
    const ei = await exec('&includeClosing=true');
    expect(ei.income.current.profit).toBe('0.0000');
    expect(ei.income.current.expenses).toBe('0.0000');
  });

  it('kilit: kapalı yıla kayıt yok (uygulama + dönem + veritabanı tetikleyicisi, tablo sahibi dahil); dönem yeniden açılamaz', async () => {
    const w = await setup('YsKilit');
    await seedProfit(w);
    const y = await mkYear(w.c);
    await ok(close(w.c, y.id, y.name));

    const periods = (await ok(w.c.get(`/api/periods?year=${Y}`))).periods as { id: string; status: string; month: number }[];
    expect(periods.every((p) => p.status === 'closed')).toBe(true);
    const blocked = await w.c.post('/api/journal-entries', { entryDate: day(5, 5), description: 'x', post: true, lines: [{ accountId: w.ids['100'], currency: 'TRY', debit: '1' }, { accountId: w.ids['500'], currency: 'TRY', credit: '1' }] });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('PERIOD_CLOSED');
    // Dönemi tek başına açmak da engellenir
    const reopenPeriod = await w.c.post(`/api/periods/${periods[4]!.id}/reopen`);
    expect(reopenPeriod.statusCode).toBe(422);
    expect(reopenPeriod.json().error.code).toBe('FISCAL_YEAR_RULE_VIOLATION');
    // Kapalı yılda yeni dönem/yevmiye: mali yıl durumunda taslak bırakılamaz; listeden de kapalı görünür
    const closed = await ok(w.c.get(`/api/fiscal-years/closed?from=${day(1, 1)}&to=${day(1, 2)}`));
    expect(closed.years).toHaveLength(1);
    expect((await ok(w.c.get(`/api/fiscal-years/closed?from=${Y + 1}-02-01&to=${Y + 1}-02-02`))).years).toHaveLength(0);

    // Ham SQL (tablo sahibi): dönem açma, yevmiye kaydetme ve yıl silme/değiştirme
    await asOwner(async (q) => {
      const e1 = await expectDbError(q, `update fiscal_periods set status = 'open' where id = $1`, [periods[4]!.id]);
      expect(e1.code).toBe('ERP23');
      const e2 = await expectDbError(q, `delete from fiscal_periods where id = $1`, [periods[4]!.id]);
      expect(e2.code).toBe('ERP23');
      const e3 = await expectDbError(q, `delete from fiscal_years where id = $1`, [y.id]);
      expect(e3.code).toBe('ERP23');
      const e4 = await expectDbError(q, `update fiscal_years set name = 'başka' where id = $1`, [y.id]);
      expect(e4.code).toBe('ERP23');
      const e5 = await expectDbError(q, `update fiscal_years set end_date = '${Y + 1}-12-31' where id = $1`, [y.id]);
      expect(e5.code).toBe('ERP23');
      const e6 = await expectDbError(q, `delete from fiscal_year_events where fiscal_year_id = $1`, [y.id]);
      expect(e6.code).toBe('ERP23');
    });
    // Savunma derinliği: dönem tetikleyicisi kapalı olsa bile (sahip rolü) yevmiye tetikleyicisi kapalı yıla kayıt yapılmasına izin vermez
    await asOwner(async (q) => {
      await q(`alter table fiscal_periods disable trigger fiscal_periods_year_guard`);
      await q(`update fiscal_periods set status = 'open' where id = $1`, [periods[4]!.id]);
      const ent = await q(
        `insert into journal_entries (id, company_id, entry_date, period_id, description) values (gen_random_uuid(), $1, $2, $3, 'ham') returning id`,
        [w.company.id, day(5, 5), periods[4]!.id],
      );
      await q(`insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, debit, debit_base) values (gen_random_uuid(), $1, $2, 1, $3, 'TRY', 1, 1)`, [w.company.id, ent.rows[0].id, w.ids['100']]);
      await q(`insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, credit, credit_base) values (gen_random_uuid(), $1, $2, 2, $3, 'TRY', 1, 1)`, [w.company.id, ent.rows[0].id, w.ids['500']]);
      const e = await expectDbError(q, `update journal_entries set status = 'posted', entry_no = 'X-1', posted_at = now() where id = $1`, [ent.rows[0].id]);
      expect(e.code).toBe('ERP23');
    });
    // Yıl kapatma tetikleyicisi: açık dönem varken mali yıl kapatılamaz
    const w2 = await setup('YsKilit2');
    const y2 = await mkYear(w2.c);
    await asOwner(async (q) => {
      const e = await expectDbError(q, `update fiscal_years set status = 'closed', closed_at = now(), closed_by = $2 where id = $1`, [y2.id, w2.s.userId]);
      expect(e.code).toBe('ERP23');
      expect(e.message).toContain('dönemleri');
    });
  });

  it('idempotence: ikinci kapanış reddedilir; paralel iki kapanıştan yalnızca biri uygulanır; kapanış fişi API ile ters çevrilemez', async () => {
    const w = await setup('YsIdem');
    await seedProfit(w);
    const y = await mkYear(w.c);
    const [a, b] = await Promise.all([close(w.c, y.id, y.name), close(w.c, y.id, y.name)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const again = await close(w.c, y.id, y.name);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('FISCAL_YEAR_CLOSED');
    const n = (await execAsOwner(`select count(*)::int as n from journal_entries where company_id = $1 and source_type = 'year_end_close'`, [w.company.id])).rows[0].n;
    expect(n).toBe(1);
    const ok1 = [a, b].find((r) => r.statusCode === 200)!.json();
    const rev = await w.c.post(`/api/journal-entries/${ok1.closeEntry.id}/reverse`, {});
    expect(rev.statusCode).toBe(422);
    expect(rev.json().error.code).toBe('ENTRY_HAS_SOURCE');
  });

  it('yeniden açma: gerekçe zorunlu, yetki yalnızca sahip/yönetici, kapanış ve devir fişleri ters kaydedilir, dönemler açılır, yeniden kapanabilir, geçmiş tutulur', async () => {
    const w = await setup('YsAcma');
    await seedProfit(w);
    const before = await tb(w.c, day(1, 1), day(12, 31));
    const y = await mkYear(w.c);
    const done = await ok(close(w.c, y.id, y.name));

    const accountant = await addMember(app, w.c, w.company.id, 'accountant');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    const sales = await addMember(app, w.c, w.company.id, 'sales');
    // Muhasebeci/izleyici durumu okur, işlem yapamaz
    expect((await accountant.client.get('/api/fiscal-years')).statusCode).toBe(200);
    expect((await viewer.client.get('/api/fiscal-years')).statusCode).toBe(200);
    expect((await sales.client.get('/api/fiscal-years')).statusCode).toBe(403);
    for (const call of [
      () => accountant.client.post('/api/fiscal-years', { startDate: `${Y + 1}-01-01`, endDate: `${Y + 1}-12-31` }),
      () => accountant.client.get(`/api/fiscal-years/${y.id}/preflight`),
      () => accountant.client.get(`/api/fiscal-years/${y.id}/preview`),
      () => accountant.client.post(`/api/fiscal-years/${y.id}/reopen`, { reason: 'Gerekçe yazıldı' }),
      () => accountant.client.post(`/api/fiscal-years/${y.id}/close`, { confirm: y.name }),
      () => viewer.client.post(`/api/fiscal-years/${y.id}/reopen`, { reason: 'Gerekçe yazıldı' }),
    ]) expect((await call()).statusCode).toBe(403);

    // Gerekçe zorunlu
    expect((await w.c.post(`/api/fiscal-years/${y.id}/reopen`, {})).statusCode).toBe(400);
    expect((await w.c.post(`/api/fiscal-years/${y.id}/reopen`, { reason: 'kısa' })).statusCode).toBe(400);
    expect((await w.c.post(`/api/fiscal-years/${y.id}/reopen`, { reason: 'Düzeltme gerekli' })).statusCode).toBe(200);

    const list = (await years(w.c)).years.find((x) => x.id === y.id);
    expect(list).toMatchObject({ status: 'open', reopenReason: 'Düzeltme gerekli' });
    expect(list.events.map((e: any) => e.action)).toEqual(['close', 'reopen']);
    const periods = (await ok(w.c.get(`/api/periods?year=${Y}`))).periods as { status: string }[];
    expect(periods.every((p) => p.status === 'open')).toBe(true);

    // Fişler ters kaydedildi (kapanış ve devir); kapanış dahil mizanda gelir/gider geri geldi, 590/570 sıfırlandı
    const orig = await entryOf(w.c, done.closeEntry.id);
    expect(orig.reversedById).toBeTruthy();
    expect((await entryOf(w.c, orig.reversedById)).sourceType).toBe('year_end_close'); // ters kayıt da kapanış sayılır (rapor dışlaması)
    expect((await entryOf(w.c, done.carryEntry.id)).reversedById).toBeTruthy();
    const mid = await tb(w.c, day(1, 1), day(12, 31));
    expect(mid.closing('600')).toBe(before.closing('600'));
    expect(mid.closing('590')).toBe(0);
    expect((await tb(w.c, `${Y + 1}-01-01`, `${Y + 1}-12-31`)).closing('570')).toBe(0);
    // Açıkken kayıt yapılır; sonra yeniden kapanır (yeni olay, yeni fiş) ve sonuç yeni bakiyeyi yansıtır
    await post(w, day(9, 9), [['100', 'debit', '100'], ['600', 'credit', '100']]);
    const done2 = await ok(close(w.c, y.id, y.name));
    expect(done2.net).toBe('4400.0000');
    expect(done2.closeEntry.id).not.toBe(done.closeEntry.id);
    const after = await tb(w.c, day(1, 1), day(12, 31));
    for (const code of ['600', '632', '770', '646.001']) expect(after.closing(code)).toBe(0);
    expect(after.closing('590')).toBe(-4400);
    expect((await years(w.c)).years.find((x) => x.id === y.id).events.map((e: any) => e.action)).toEqual(['close', 'reopen', 'close']);
    // Olay geçmişi değiştirilemez
    await asOwner(async (q) => expect((await expectDbError(q, `update fiscal_year_events set reason = 'x' where fiscal_year_id = $1`, [y.id])).code).toBe('ERP23'));
  });

  it('proje etiketi korunur ve proje maliyeti/kârlılığı kapanıştan etkilenmez; tamamlanmış projeye de kapanış yazılabilir', async () => {
    const w = await setup('YsProje');
    const project = (await ok(w.c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' }), 201)).project as { id: string };
    await seedProfit(w, { project: project.id });
    const cost = async () => (await ok(w.c.get(`/api/projects/${project.id}/cost-report?asOf=${day(12, 31)}`))) as any;
    const summary = async () => (await ok(w.c.get(`/api/projects/summary?asOf=${day(12, 31)}`))) as any;
    const profit = async () => (await ok(w.c.get(`/api/projects/profitability?asOf=${day(12, 31)}`))) as any;
    const tx = async () => (await ok(w.c.get(`/api/projects/${project.id}/transactions`))) as any;
    // Proje tamamlanır: normal yazım engellenir, kapanış satırı yine de yazılır
    await ok(w.c.post(`/api/projects/${project.id}/status`, { status: 'active' }));
    await ok(w.c.post(`/api/projects/${project.id}/status`, { status: 'completed' }));
    const c0 = await cost();
    const s0 = await summary();
    const p0 = await profit();
    const t0 = await tx();
    expect(c0.totals.actual).toBe('400.00');
    const y = await mkYear(w.c);
    const pv = await preview(w.c, y.id);
    const line = pv.closingEntry.lines.find((l: any) => l.accountCode === '770');
    expect(line).toMatchObject({ projectId: project.id, creditBase: '400.0000' });
    const done = await ok(close(w.c, y.id, y.name));
    const ce = await entryOf(w.c, done.closeEntry.id);
    expect(ce.lines.find((l: any) => l.accountCode === '770')).toMatchObject({ projectId: project.id });

    expect(await cost()).toEqual(c0);
    expect(await summary()).toEqual(s0);
    expect(await profit()).toEqual(p0);
    expect(await tx()).toEqual(t0);
  });

  it('alt defterler (cari açık kalem, stok, kasa/banka) ve nakit projeksiyonu kapanıştan etkilenmez; mutabakat 0 kalır', async () => {
    const w = await setup('YsAlt');
    const party = (await ok(w.c.post('/api/parties', { name: 'Ali Yılmaz', kind: 'customer' }), 201)).party;
    const item = (await ok(w.c.post('/api/items', { name: 'Çimento', vatCode: 'KDV-16' }), 201)).item;
    const wh = ((await ok(w.c.get('/api/warehouses'))).warehouses as any[]).find((x) => x.isDefault);
    const cash = (await ok(w.c.post('/api/treasury/accounts', { kind: 'cash', name: 'Ana kasa', currency: 'TRY' }), 201)).account;
    await ok(w.c.post('/api/treasury/transactions', { type: 'other_receipt', date: day(2, 1), accountId: cash.id, amount: '5000', glAccountId: w.ids['500'] }), 201);
    await ok(w.c.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 1), warehouseId: wh.id, lines: [{ itemId: item.id, quantity: '10', unitCost: '50' }] }), 201);
    await ok(w.c.post('/api/invoices', { post: true, type: 'sales', partyId: party.id, invoiceDate: day(3, 10), dueDate: day(11, 1), lines: [{ itemId: item.id, description: 'Çimento', quantity: '4', unitPrice: '100', vatCode: 'KDV-16' }] }), 201);
    await post(w, day(4, 1), [['632', 'debit', '123'], ['500', 'credit', '123']]);

    const snap = async () => ({
      party: (await ok(w.c.get(`/api/parties/${party.id}`))).summary,
      open: (await ok(w.c.get(`/api/parties/${party.id}/open-items?asOf=${day(12, 31)}&type=receivable`))).receivable,
      stock: (await ok(w.c.get(`/api/reports/stock-status?asOf=${day(12, 31)}`))).ledger,
      item: (await ok(w.c.get(`/api/items/${item.id}`))).stock,
      cash: (await ok(w.c.get(`/api/treasury/accounts/${cash.id}`))).account,
      forecast: (await ok(w.c.get('/api/cash-forecast'))),
    });
    const b = await snap();
    expect(b.stock.difference).toBe('0.0000');
    const y = await mkYear(w.c);
    await ok(close(w.c, y.id, y.name));
    const a = await snap();
    expect(a).toEqual(b);
    expect(a.stock.difference).toBe('0.0000');
    // Cari açık kalem sonraki yılda da devam eder (kapanış fişi cari satırı üretmez)
    expect((await ok(w.c.get(`/api/parties/${party.id}/open-items?asOf=${Y + 1}-06-30&type=receivable`))).receivable.items).toHaveLength(1);
  });

  it('özel mali yıl (Temmuz–Haziran): takvim yılı varsayılmaz; yalnızca yılın kendi hareketleri kapanır, önceki hareket uyarı verir', async () => {
    const w = await setup('YsOzel');
    // Takvim yılı başı (Y-01..Y-06) mali yıl dışındadır; Y-07..Y+1-06 içindedir
    await post(w, day(3, 1), [['100', 'debit', '700'], ['600', 'credit', '700']]);
    await post(w, day(8, 1), [['100', 'debit', '1000'], ['600', 'credit', '1000']]);
    await ok(w.c.post('/api/periods/generate', { year: Y + 1 }));
    await post(w, `${Y + 1}-02-01`, [['632', 'debit', '250'], ['100', 'credit', '250']]);
    const y = await mkYear(w.c, `${Y}-07-01`, `${Y + 1}-06-30`);
    expect(y.name).toBe(`${Y}/${Y + 1}`);
    const p = await preflight(w.c, y.id);
    expect(check(p, 'earlier_result_balance')).toMatchObject({ severity: 'warning', count: 1 }); // Y-03 satışı mali yıldan önce ve kapatılmamış
    const pv = await preview(w.c, y.id);
    expect(pv.net).toBe('750.0000'); // 1000 - 250
    expect(pv.closingEntry.date).toBe(`${Y + 1}-06-30`);
    expect(pv.carryEntry.date).toBe(`${Y + 1}-07-01`);
    await ok(close(w.c, y.id, y.name));
    const periods = (await ok(w.c.get(`/api/periods?year=${Y}`))).periods as { month: number; status: string }[];
    expect(periods.filter((x) => x.month >= 7).every((x) => x.status === 'closed')).toBe(true);
    expect(periods.filter((x) => x.month < 7).every((x) => x.status === 'open')).toBe(true); // yalnızca mali yılın ayları kilitlenir
    const closedBlock = await w.c.post('/api/journal-entries', { entryDate: day(10, 1), description: 'x', post: true, lines: [{ accountId: w.ids['100'], currency: 'TRY', debit: '1' }, { accountId: w.ids['500'], currency: 'TRY', credit: '1' }] });
    expect(closedBlock.statusCode).toBe(422);
  });

  it('boş yıl: kapanış fişi yazılmaz ama yıl kilitlenir; yalnızca bilanço hareketli yılda da kilitlenir', async () => {
    const w = await setup('YsBos');
    await post(w, day(2, 1), [['100', 'debit', '10'], ['500', 'credit', '10']]);
    const y = await mkYear(w.c);
    const p = await preflight(w.c, y.id);
    expect(check(p, 'nothing_to_close').severity).toBe('info');
    const done = await ok(close(w.c, y.id, y.name));
    expect(done).toMatchObject({ kind: 'zero', closeEntry: null, carryEntry: null });
    expect((await years(w.c)).years[0].status).toBe('closed');
    expect((await tb(w.c, day(1, 1), day(12, 31))).raw.totals.difference).toBe('0.0000');
  });

  it('seçenekler: devir kapalıysa 590 kalır; 7. sınıf maliyet hariç tutulabilir', async () => {
    const w = await setup('YsSecenek');
    await seedProfit(w);
    const y = await mkYear(w.c);
    const pv = await preview(w.c, y.id, '?carryForward=false&includeCostAccounts=false');
    expect(pv.carryEntry).toBeNull();
    expect(pv.closingEntry.lines.some((l: any) => l.accountCode === '770')).toBe(false);
    expect(pv.net).toBe('4700.0000'); // 770 (400) kapatılmadı
    const done = await ok(close(w.c, y.id, y.name, { carryForward: false, includeCostAccounts: false }));
    expect(done.carryEntry).toBeNull();
    const after = await tb(w.c, day(1, 1), day(12, 31));
    expect(after.closing('770')).toBe(400);
    expect(after.closing('590')).toBe(-4700);
  });

  it('RLS: başka şirket mali yıl ve olayları göremez, kimlikle erişemez', async () => {
    const a = await setup('YsRlsA');
    const b = await setup('YsRlsB');
    const ya = await mkYear(a.c);
    await post(a, day(2, 1), [['100', 'debit', '10'], ['600', 'credit', '10']]);
    await ok(close(a.c, ya.id, ya.name));
    expect((await years(b.c)).years).toHaveLength(0);
    expect((await b.c.get(`/api/fiscal-years/${ya.id}/preview`)).statusCode).toBe(404);
    expect((await close(b.c, ya.id, ya.name)).statusCode).toBe(404);
    expect((await b.c.post(`/api/fiscal-years/${ya.id}/reopen`, { reason: 'Gerekçe yazıldı' })).statusCode).toBe(404);
    const n = await asDb(handle, { companyId: b.company.id, orgId: b.orgId, userId: b.s.userId }, async (q) => ({
      years: (await q(`select count(*)::int as n from fiscal_years`)).rows[0].n,
      events: (await q(`select count(*)::int as n from fiscal_year_events`)).rows[0].n,
    }));
    expect(n).toEqual({ years: 0, events: 0 });
    // Kendi şirketi için bağlam yoksa hiçbir satır görünmez
    const none = await asDb(handle, {}, async (q) => (await q(`select count(*)::int as n from fiscal_years`)).rows[0].n);
    expect(none).toBe(0);
  });

  it('dışa aktarma: kapanış fişi (önizleme/kayıtlı) xlsx/csv, yalnızca ledger.yearend; mizan dışa aktarma kapanış hariç seçeneği', async () => {
    const w = await setup('YsDisa');
    await seedProfit(w);
    const y = await mkYear(w.c);
    const prev = await w.c.get(`/api/exports/year-end-closing?fiscalYearId=${y.id}&format=csv`);
    expect(prev.statusCode).toBe(200);
    expect(prev.body).toContain('ÖNİZLEME-KAPANIŞ');
    expect(prev.body).toContain('Doğrulanmadı');
    await ok(close(w.c, y.id, y.name));
    const csv = await w.c.get(`/api/exports/year-end-closing?fiscalYearId=${y.id}&format=csv`);
    expect(csv.body).toContain('YV-');
    expect(csv.body).not.toContain('ÖNİZLEME');
    expect(csv.body).toContain('590');
    const xlsx = await w.c.get(`/api/exports/year-end-closing?fiscalYearId=${y.id}&format=xlsx`);
    expect(xlsx.statusCode).toBe(200);
    const acc = await addMember(app, w.c, w.company.id, 'accountant');
    expect((await acc.client.get(`/api/exports/year-end-closing?fiscalYearId=${y.id}&format=csv`)).statusCode).toBe(403);
    const t1 = await w.c.get(`/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=csv&excludeClosing=true`);
    const t2 = await w.c.get(`/api/exports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&format=csv`);
    expect(t1.body).toContain('600');
    expect(t1.body).not.toEqual(t2.body);
  });
});
