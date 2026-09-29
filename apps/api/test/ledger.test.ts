import { describe, expect, it } from 'vitest';
import { accountIds, asDb, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

describe('genel muhasebe', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, companyOverrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, companyOverrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    return { s, company, c, ids, orgId };
  }

  const tl = (accountId: string, side: 'debit' | 'credit', amount: string, extra = {}) => ({
    accountId, currency: 'TRY', [side]: amount, ...extra,
  });

  it('dengeli TRY yevmiyesi kaydedilir; numara boşluksuz artar', async () => {
    const { c, ids } = await setup('Temel');
    const lines = [tl(ids['100']!, 'debit', '1000.00'), tl(ids['500']!, 'credit', '1000.00')];
    const e1 = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Sermaye', lines, post: true });
    expect(e1.statusCode).toBe(201);
    expect(e1.json().entry).toMatchObject({ status: 'posted', entryNo: `YV-${thisYear}-000001` });
    const e2 = await c.post('/api/journal-entries', { entryDate: day(2, 2), description: 'İkinci', lines, post: true });
    expect(e2.json().entry.entryNo).toBe(`YV-${thisYear}-000002`);

    const line = e1.json().entry.lines[0];
    expect(line).toMatchObject({ accountCode: '100', debit: '1000.0000', debitBase: '1000.0000', fxRate: '1.00000000' });
  });

  it('dengesiz yevmiye kaydedilemez; işlem geri alınır ve numara tüketilmez', async () => {
    const { c, ids } = await setup('Dengesiz');
    const bad = [tl(ids['100']!, 'debit', '1000'), tl(ids['500']!, 'credit', '999.99')];
    const res = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Hatalı', lines: bad, post: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('LEDGER_RULE_VIOLATION');
    expect(res.json().error.message).toMatch(/dengesiz/);
    // Hiçbir şey kalmadı (tek işlem)
    expect((await c.get('/api/journal-entries')).json().entries).toHaveLength(0);

    // Taslak olarak oluşturulabilir ama kaydedilemez
    const draft = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Taslak', lines: bad });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().entry.status).toBe('draft');
    expect(draft.json().entry.entryNo).toBeNull();
    const id = draft.json().entry.id;
    expect((await c.post(`/api/journal-entries/${id}/post`)).statusCode).toBe(422);

    // Düzeltip kaydet: ilk numara hâlâ 1 (başarısız denemeler tüketmedi)
    const fixed = [tl(ids['100']!, 'debit', '1000'), tl(ids['500']!, 'credit', '1000')];
    const put = await c.put(`/api/journal-entries/${id}`, { entryDate: day(2, 1), description: 'Düzeltilmiş', lines: fixed });
    expect(put.statusCode).toBe(200);
    const posted = await c.post(`/api/journal-entries/${id}/post`);
    expect(posted.json().entry.entryNo).toBe(`YV-${thisYear}-000001`);
  });

  it('eş zamanlı kayıtlarda numaralar tekil ve boşluksuz', async () => {
    const { c, ids } = await setup('Es');
    const lines = [tl(ids['100']!, 'debit', '10'), tl(ids['500']!, 'credit', '10')];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        c.post('/api/journal-entries', { entryDate: day(2, 3), description: `Eş zamanlı ${i}`, lines, post: true }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const numbers = results.map((r) => r.json().entry.entryNo as string).sort();
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => `YV-${thisYear}-${String(i + 1).padStart(6, '0')}`));
  });

  it('kaydedilmiş yevmiye veritabanı seviyesinde de değiştirilemez ve silinemez', async () => {
    const { c, ids, s, company, orgId } = await setup('Degismez');
    const lines = [tl(ids['100']!, 'debit', '500'), tl(ids['500']!, 'credit', '500')];
    const created = (await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Sabit', lines, post: true })).json().entry;

    // API'de silme
    expect((await c.delete(`/api/journal-entries/${created.id}`)).json().error.code).toBe('ENTRY_NOT_DRAFT');
    expect((await c.put(`/api/journal-entries/${created.id}`, { entryDate: day(2, 1), description: 'x', lines })).json().error.code).toBe('ENTRY_NOT_DRAFT');

    // Doğrudan SQL ile (uygulama hatası/kötü niyet senaryosu)
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      for (const stmt of [
        `update journal_entries set description = 'kurcalandı' where id = $1`,
        `update journal_entries set entry_date = entry_date + 1 where id = $1`,
        `update journal_entries set status = 'draft' where id = $1`,
        `delete from journal_entries where id = $1`,
        `update journal_lines set debit = 1, debit_base = 1 where entry_id = $1`,
        `delete from journal_lines where entry_id = $1`,
      ]) {
        const err = await expectDbError(q, stmt, [created.id]);
        expect(err.code, stmt).toBe('ERP01');
      }
      // Kaydedilmiş yevmiyeye yeni satır eklenemez
      const err = await expectDbError(
        q,
        `insert into journal_lines (company_id, entry_id, line_no, account_id, currency_code, debit, debit_base)
         values ($1, $2, 99, $3, 'TRY', 1, 1)`,
        [company.id, created.id, ids['100']],
      );
      expect(err.code).toBe('ERP01');
    });
  });

  it('ters kayıt: net etki sıfır, iki kayıt bağlı; tekrar ters çevrilemez', async () => {
    const { c, ids } = await setup('Ters');
    const lines = [tl(ids['100']!, 'debit', '250.50'), tl(ids['600']!, 'credit', '250.50')];
    const orig = (await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Satış', lines, post: true })).json().entry;

    const rev = await c.post(`/api/journal-entries/${orig.id}/reverse`, { entryDate: day(2, 5) });
    expect(rev.statusCode).toBe(201);
    const reversal = rev.json().entry;
    expect(reversal.reversalOfId).toBe(orig.id);
    expect(reversal.description).toContain(orig.entryNo);
    expect(reversal.lines.find((l: any) => l.accountCode === '100')).toMatchObject({ debit: '0.0000', credit: '250.5000' });

    const origAfter = (await c.get(`/api/journal-entries/${orig.id}`)).json().entry;
    expect(origAfter.reversedById).toBe(reversal.id);

    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    const kasa = tb.rows.find((r: any) => r.code === '100');
    expect(kasa).toMatchObject({ debit: '250.5000', credit: '250.5000', closing: '0.0000' });

    expect((await c.post(`/api/journal-entries/${orig.id}/reverse`, {})).json().error.code).toBe('ENTRY_ALREADY_REVERSED');
    expect((await c.post(`/api/journal-entries/${reversal.id}/reverse`, {})).json().error.code).toBe('ENTRY_IS_REVERSAL');
  });

  it('dönem kilidi: kapalı döneme kayıt atılamaz, taslak varken dönem kapatılamaz', async () => {
    const { c, ids } = await setup('Kilit');
    const lines = [tl(ids['100']!, 'debit', '100'), tl(ids['500']!, 'credit', '100')];
    const periods = (await c.get(`/api/periods?year=${thisYear}`)).json().periods;
    const march = periods.find((p: any) => p.month === 3);

    const draft = (await c.post('/api/journal-entries', { entryDate: day(3, 5), description: 'Taslak', lines })).json().entry;
    const blocked = await c.post(`/api/periods/${march.id}/close`);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('PERIOD_HAS_DRAFTS');

    await c.post(`/api/journal-entries/${draft.id}/post`);
    expect((await c.post(`/api/periods/${march.id}/close`)).statusCode).toBe(200);

    const closed = await c.post('/api/journal-entries', { entryDate: day(3, 6), description: 'Geç kalmış', lines, post: true });
    expect(closed.statusCode).toBe(422);
    expect(closed.json().error.code).toBe('PERIOD_CLOSED');
    // Kapalı dönemdeki kaydı ters çevirmek de mümkün değil (ters kayıt açık bir tarihe yazılır)
    expect((await c.post(`/api/journal-entries/${draft.id}/reverse`, { entryDate: day(3, 20) })).json().error.code).toBe('PERIOD_CLOSED');
    const inApril = await c.post(`/api/journal-entries/${draft.id}/reverse`, { entryDate: day(4, 2) });
    expect(inApril.statusCode).toBe(201);

    // Yeniden açınca yazılabilir
    await c.post(`/api/periods/${march.id}/reopen`);
    expect((await c.post('/api/journal-entries', { entryDate: day(3, 6), description: 'Açıldı', lines, post: true })).statusCode).toBe(201);
  });

  it('dönem tanımsız yıla kayıt atılamaz', async () => {
    const { c, ids } = await setup('Yil');
    const lines = [tl(ids['100']!, 'debit', '1'), tl(ids['500']!, 'credit', '1')];
    const res = await c.post('/api/journal-entries', { entryDate: day(6, 1, thisYear + 5), description: 'Uzak gelecek', lines, post: true });
    expect(res.json().error.code).toBe('PERIOD_MISSING');
  });

  it('grup hesabına, pasif hesaba ve yanlış para birimine kayıt atılamaz', async () => {
    const { c, ids } = await setup('Kural');
    const ok = tl(ids['500']!, 'credit', '10');
    const group = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Grup', lines: [tl(ids['10']!, 'debit', '10'), ok], post: true });
    expect(group.json().error.code).toBe('ACCOUNT_NOT_POSTABLE');

    await c.patch(`/api/accounts/${ids['100']}`, { isActive: false });
    const inactive = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'Pasif', lines: [tl(ids['100']!, 'debit', '10'), ok], post: true });
    expect(inactive.json().error.code).toBe('ACCOUNT_INACTIVE');

    // Dövizli (GBP) hesap yalnızca GBP kabul eder
    const gbpAcc = (await c.post('/api/accounts', { code: '102.001', name: 'GBP Banka', currencyCode: 'GBP' })).json().account;
    const wrong = await c.post('/api/journal-entries', { entryDate: day(2, 1), description: 'TL', lines: [tl(gbpAcc.id, 'debit', '10'), ok], post: true });
    expect(wrong.json().error.code).toBe('ACCOUNT_CURRENCY_MISMATCH');
  });

  it('dövizli satırlar: kayıtlı kurdan defter ve raporlama tutarı hesaplanır', async () => {
    const { c, ids } = await setup('Doviz');
    const gbp = (await c.post('/api/accounts', { code: '102.001', name: 'GBP Banka', currencyCode: 'GBP' })).json().account;
    const lines = [
      { accountId: gbp.id, currency: 'GBP', debit: '100.00' },
      tl(ids['600']!, 'credit', '4000.00'),
    ];

    // Kur yokken açık hata
    const missing = await c.post('/api/journal-entries', { entryDate: day(2, 10), description: 'Kurlu', lines, post: true });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('FX_RATE_MISSING');

    await c.put('/api/exchange-rates', { rateDate: day(2, 10), currencyCode: 'GBP', quoteCode: 'TRY', buy: '40' });
    const ok = await c.post('/api/journal-entries', { entryDate: day(2, 10), description: 'Kurlu', lines, post: true });
    expect(ok.statusCode).toBe(201);
    const gbpLine = ok.json().entry.lines.find((l: any) => l.accountCode === '102.001');
    expect(gbpLine).toMatchObject({ currencyCode: 'GBP', debit: '100.0000', fxRate: '40.00000000', debitBase: '4000.0000' });
    // Raporlama para birimi GBP: 4000 TRY × (1/40) = 100 GBP
    expect(gbpLine.debitReporting).toBe('100.0000');

    // Serbest kur girilirse o kullanılır ve dengeyi bozarsa kayıt reddedilir
    const custom = await c.post('/api/journal-entries', {
      entryDate: day(2, 10), description: 'Özel kur', post: true,
      lines: [{ accountId: gbp.id, currency: 'GBP', debit: '10', fxRate: '41' }, tl(ids['600']!, 'credit', '410')],
    });
    expect(custom.statusCode).toBe(201);
    const unbalanced = await c.post('/api/journal-entries', {
      entryDate: day(2, 10), description: 'Dengesiz kur', post: true,
      lines: [{ accountId: gbp.id, currency: 'GBP', debit: '10', fxRate: '41' }, tl(ids['600']!, 'credit', '400')],
    });
    expect(unbalanced.statusCode).toBe(422);
  });

  it('raporlama tutarı kur yokken boş kalır (kayıt engellenmez), kur girilince doldurulur', async () => {
    const { c, ids, s, company, orgId } = await setup('Geri');
    const lines = [tl(ids['100']!, 'debit', '4000'), tl(ids['500']!, 'credit', '4000')];
    const created = await c.post('/api/journal-entries', { entryDate: day(2, 10), description: 'Kursuz', lines, post: true });
    expect(created.statusCode).toBe(201);
    expect(created.json().entry.lines[0].debitReporting).toBeNull();

    const before = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&currency=reporting`)).json();
    expect(before.missingReportingLines).toBe(2);

    // Kur yokken yeniden hesaplama bir şey yapmaz
    expect((await c.post('/api/ledger/backfill-reporting')).json()).toEqual({ updated: 0, stillMissing: 2 });

    await c.put('/api/exchange-rates', { rateDate: day(2, 9), currencyCode: 'GBP', quoteCode: 'TRY', buy: '40' });
    const filled = await c.post('/api/ledger/backfill-reporting');
    expect(filled.json()).toEqual({ updated: 2, stillMissing: 0 });

    const entry = (await c.get(`/api/journal-entries/${created.json().entry.id}`)).json().entry;
    expect(entry.lines[0].debitReporting).toBe('100.0000');
    const after = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&currency=reporting`)).json();
    expect(after.missingReportingLines).toBe(0);
    expect(after.rows.find((r: any) => r.code === '100').closing).toBe('100.0000');

    // Defter tutarları ve DOLU raporlama tutarları hâlâ değiştirilemez
    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      const e1 = await expectDbError(q, `update journal_lines set debit_base = debit_base + 1 where entry_id = $1`, [entry.id]);
      expect(e1.code).toBe('ERP01');
      const e2 = await expectDbError(q, `update journal_lines set debit_reporting = 1 where entry_id = $1 and debit_reporting is not null`, [entry.id]);
      expect(e2.code).toBe('ERP01');
    });
  });

  it('mizan: gruplara toplanır, borç=alacak, taslaklar dahil edilmez', async () => {
    const { c, ids } = await setup('Mizan');
    const post = (d: string, lines: any[], p = true) =>
      c.post('/api/journal-entries', { entryDate: d, description: 'Kayıt', lines, post: p });
    await post(day(1, 5), [tl(ids['100']!, 'debit', '1000'), tl(ids['500']!, 'credit', '1000')]);
    await post(day(1, 20), [tl(ids['102']!, 'debit', '300'), tl(ids['100']!, 'credit', '300')]);
    await post(day(2, 10), [tl(ids['320']!, 'debit', '50'), tl(ids['102']!, 'credit', '50')]);
    // Taslak sonuca girmez
    await post(day(2, 11), [tl(ids['100']!, 'debit', '9999'), tl(ids['500']!, 'credit', '9999')], false);

    const tb = (await c.get(`/api/reports/trial-balance?from=${day(2, 1)}&to=${day(2, 28)}`)).json();
    const row = (code: string) => tb.rows.find((r: any) => r.code === code);
    // Şubat raporu: Ocak hareketleri açılış bakiyesi olur
    expect(row('100')).toMatchObject({ opening: '700.0000', debit: '0.0000', credit: '0.0000', closing: '700.0000' });
    expect(row('102')).toMatchObject({ opening: '300.0000', credit: '50.0000', closing: '250.0000' });
    expect(row('320')).toMatchObject({ debit: '50.0000', closing: '50.0000' });
    // Grup satırı alt hesapları toplar (10 = 100 + 102)
    expect(row('10')).toMatchObject({ opening: '1000.0000', closing: '950.0000', isPostable: false });
    expect(row('1').closing).toBe('950.0000'); // sınıf toplamı
    expect(tb.totals).toEqual({ debit: '50.0000', credit: '50.0000', difference: '0.0000' });

    const full = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
    expect(full.totals).toEqual({ debit: '1350.0000', credit: '1350.0000', difference: '0.0000' });
  });

  it('mizan raporlama para biriminde; eksik kurlu satır uyarısı', async () => {
    const { c, ids } = await setup('MizanGbp');
    await c.put('/api/exchange-rates', { rateDate: day(1, 5), currencyCode: 'GBP', quoteCode: 'TRY', buy: '50' });
    await c.post('/api/journal-entries', {
      entryDate: day(1, 5), description: 'Sermaye', post: true,
      lines: [tl(ids['100']!, 'debit', '5000'), tl(ids['500']!, 'credit', '5000')],
    });
    const tb = (await c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&currency=reporting`)).json();
    expect(tb.currency).toBe('GBP');
    expect(tb.rows.find((r: any) => r.code === '100').closing).toBe('100.0000');
    expect(tb.missingReportingLines).toBe(0);

    const none = await setup('MizanYok', { reportingCurrency: null });
    const res = await none.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}&currency=reporting`);
    expect(res.json().error.code).toBe('REPORTING_CURRENCY_NOT_SET');
  });

  it('hesap ekstresi: açılış bakiyesi, yürüyen bakiye ve alt hesaplar', async () => {
    const { c, ids } = await setup('Ekstre');
    const sub = (await c.post('/api/accounts', { code: '100.001', name: 'Merkez Kasa' })).json().account;
    const post = (d: string, lines: any[]) =>
      c.post('/api/journal-entries', { entryDate: d, description: `Kayıt ${d}`, lines, post: true });
    await post(day(1, 10), [tl(sub.id, 'debit', '1000'), tl(ids['500']!, 'credit', '1000')]);
    await post(day(2, 5), [tl(ids['320']!, 'debit', '200'), tl(sub.id, 'credit', '200')]);
    await post(day(2, 15), [tl(sub.id, 'debit', '75.25'), tl(ids['600']!, 'credit', '75.25')]);

    // Üst hesap (100) seçilince alt hesap hareketleri de gelir
    const led = (await c.get(`/api/reports/account-ledger?accountId=${ids['100']}&from=${day(2, 1)}&to=${day(2, 28)}`)).json();
    expect(led.account.code).toBe('100');
    expect(led.opening).toBe('1000.0000');
    expect(led.lines.map((l: any) => [l.accountCode, l.balance])).toEqual([
      ['100.001', '800.0000'],
      ['100.001', '875.2500'],
    ]);
    expect(led.totals).toEqual({ debitBase: '75.2500', creditBase: '200.0000' });
    expect(led.closing).toBe('875.2500');
    expect((await c.get(`/api/reports/account-ledger?accountId=0198f2c4-7b1a-7000-8000-000000000001&from=${day(1, 1)}&to=${day(2, 1)}`)).statusCode).toBe(404);
  });

  it('muhasebe uçları rol izinlerine uyar (izleyici yazamaz, satış rolü okuyamaz)', async () => {
    const { c, ids, company } = await setup('Yetki');
    await c.post('/api/company/members', { email: 'v-led@example.com', fullName: 'İzleyici', role: 'viewer', password: 'Izleyici-12345' });
    await c.post('/api/company/members', { email: 's-led@example.com', fullName: 'Satış', role: 'sales', password: 'Satis-1234567' });
    const tok = async (email: string, password: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json().accessToken;
    const viewer = client(app, await tok('v-led@example.com', 'Izleyici-12345'), company.id);
    const sales = client(app, await tok('s-led@example.com', 'Satis-1234567'), company.id);

    const body = { entryDate: day(2, 1), description: 'x', post: true, lines: [tl(ids['100']!, 'debit', '1'), tl(ids['500']!, 'credit', '1')] };
    expect((await viewer.post('/api/journal-entries', body)).statusCode).toBe(403);
    expect((await viewer.get('/api/journal-entries')).statusCode).toBe(200);
    expect((await viewer.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).statusCode).toBe(200);
    expect((await sales.get('/api/journal-entries')).statusCode).toBe(403);
    expect((await sales.get('/api/accounts')).statusCode).toBe(403);
  });

  it('şirketler arası yalıtım: başka şirketin hesabıyla yevmiye atılamaz', async () => {
    const a = await setup('IzoleA');
    const b = await setup('IzoleB');
    const res = await b.c.post('/api/journal-entries', {
      entryDate: day(2, 1), description: 'Sızıntı', post: true,
      lines: [tl(a.ids['100']!, 'debit', '1'), tl(b.ids['500']!, 'credit', '1')],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
    expect((await a.c.get('/api/journal-entries')).json().entries).toHaveLength(0);
  });
});
