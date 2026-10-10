import { describe, expect, it } from 'vitest';
import { closeFiscalYearSchema } from '@erp/shared';
import { withContext } from '../src/db/client';
import { createJournalEntry } from '../src/modules/ledger/journal';
import { closePeriod } from '../src/modules/settings/periods';
import { closeFiscalYear } from '../src/modules/yearend/service';
import { accountIds, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

/**
 * Veritabanı denetimi (DB-2…8, DB-11) düzeltmelerinin kalıcı regresyon testleri. Yarış testleri iki ayrı bağlantıyla
 * (iki işlem) çalışır: biri kilidi tutarken diğerinin beklediği/sonucu doğrulanır.
 */
describe('denetim düzeltmeleri: veritabanı bütünlüğü', async () => {
  const { app, handle } = await makeApp();

  async function world(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const dbctx = { userId: s.userId, orgId, companyId: company.id };
    const lctx = { companyId: company.id, userId: s.userId, baseCurrency: 'TRY', reportingCurrency: null };
    const entry = (date: string, description = 'yarış') => ({
      entryDate: date,
      description,
      post: true,
      lines: [
        { accountId: ids['632']!, debit: '100', credit: '0', currency: 'TRY' as const },
        { accountId: ids['100']!, debit: '0', credit: '100', currency: 'TRY' as const },
      ],
    });
    return { s, company, c, ids, orgId, dbctx, lctx, entry };
  }

  /** Tutulan bir işlem: `fn` çalışır, sonra `release()` çağrılana dek işlem açık kalır. */
  function held<T>(dbctx: { userId: string; orgId: string; companyId: string }, fn: Parameters<typeof withContext<T>>[2]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    const done = withContext(handle.db, dbctx, async (tx) => {
      const out = await fn(tx);
      ready();
      await gate;
      return out;
    });
    done.catch(() => ready());
    return { started, release, done };
  }
  /** Sözün `ms` içinde sonuçlanıp sonuçlanmadığı (beklemede kalıyorsa false). */
  const settlesWithin = async (p: Promise<unknown>, ms: number) => {
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, ms));
    return settled;
  };
  const periodOf = async (companyId: string, month: number) =>
    (await execAsOwner('select id from fiscal_periods where company_id = $1 and year = $2 and month = $3', [companyId, thisYear, month])).rows[0].id as string;
  const postedCount = async (companyId: string, description: string) =>
    Number((await execAsOwner(`select count(*)::int as n from journal_entries where company_id = $1 and status = 'posted' and description = $2`, [companyId, description])).rows[0].n);

  it('DB-2: dönem kapanışı sürerken atılan kayıt bekler ve kapalı dönemi görüp reddedilir', async () => {
    const w = await world('Db2Kapanis');
    const periodId = await periodOf(w.company.id, 3);
    const closer = held(w.dbctx, (tx) => closePeriod(tx, periodId, w.s.userId));
    await closer.started;
    const poster = withContext(handle.db, w.dbctx, (tx) => createJournalEntry(tx, w.lctx, w.entry(day(3, 2), 'kapanış-yarışı')));
    expect(await settlesWithin(poster, 400)).toBe(false); // dönem satırı kilitli: kayıt bekliyor
    closer.release();
    await closer.done;
    await expect(poster).rejects.toThrow(/kapalı/i);
    expect(await postedCount(w.company.id, 'kapanış-yarışı')).toBe(0);
  });

  it('DB-2: kayıt sürerken dönem kapanışı bekler; kapanış kaydı görür', async () => {
    const w = await world('Db2Kayit');
    const periodId = await periodOf(w.company.id, 4);
    const poster = held(w.dbctx, (tx) => createJournalEntry(tx, w.lctx, w.entry(day(4, 2), 'kayıt-yarışı')));
    await poster.started;
    const closer = withContext(handle.db, w.dbctx, (tx) => closePeriod(tx, periodId, w.s.userId));
    expect(await settlesWithin(closer, 400)).toBe(false); // kayıt işlemi bitene dek kapanış bekler
    poster.release();
    await poster.done;
    expect((await closer).status).toBe('closed');
    expect(await postedCount(w.company.id, 'kayıt-yarışı')).toBe(1);
  });

  it('DB-2: mali yıl kapanışı sürerken o yıla atılan kayıt bekler ve reddedilir', async () => {
    const w = await world('Db2Yil');
    await withContext(handle.db, w.dbctx, (tx) => createJournalEntry(tx, w.lctx, w.entry(day(2, 1), 'ilk')));
    const y = (await w.c.post('/api/fiscal-years', { startDate: `${thisYear}-01-01`, endDate: `${thisYear}-12-31` })).json().year as { id: string; name: string };
    const closer = held(w.dbctx, (tx) => closeFiscalYear(tx, w.lctx, y.id, closeFiscalYearSchema.parse({ confirm: y.name })));
    await closer.started;
    const poster = withContext(handle.db, w.dbctx, (tx) => createJournalEntry(tx, w.lctx, w.entry(day(6, 15), 'yıl-yarışı')));
    expect(await settlesWithin(poster, 400)).toBe(false);
    closer.release();
    await closer.done;
    await expect(poster).rejects.toThrow(/kapalı/i);
    expect(await postedCount(w.company.id, 'yıl-yarışı')).toBe(0);
  });

  it('DB-4: aramalar Türkçe büyük/küçük harfe duyarsız ve LIKE joker karakterlerinden kaçar', async () => {
    const w = await world('Db4Arama', { sector: 'CONSTRUCTION' });
    for (const fullName of ['IŞIK ÇELİK', 'Ayşe %50 Kaya', 'Mehmet Öz']) {
      expect((await w.c.post('/api/employees', { fullName, hireDate: day(1, 5) })).statusCode).toBe(201);
    }
    const names = async (q: string) => ((await w.c.get(`/api/employees?q=${encodeURIComponent(q)}`)).json().employees as { fullName: string }[]).map((e) => e.fullName);
    expect(await names('ışık')).toEqual(['IŞIK ÇELİK']);
    expect(await names('çelik')).toEqual(['IŞIK ÇELİK']);
    expect(await names('%')).toEqual(['Ayşe %50 Kaya']);
    expect(await names('_')).toEqual([]);
  });

  it('DB-7: numara sayaçları ve hesap eşlemeleri uygulama rolüyle silinemez', async () => {
    const w = await world('Db7Yetki');
    await asDb(handle, w.dbctx, async (q) => {
      expect((await expectDbError(q, 'delete from document_sequences')).code).toBe('42501');
      expect((await expectDbError(q, 'delete from account_mappings')).code).toBe('42501');
    });
  });

  it('DB-7: kayıtlı faturada kullanılmış KDV oranı silinemez/değiştirilemez; kullanılmamış oran silinir', async () => {
    const w = await world('Db7Kdv');
    const party = (await w.c.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).json().party;
    const inv = await w.c.post('/api/invoices', { type: 'sales', partyId: party.id, invoiceDate: day(5, 10), post: true, lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '100', vatCode: 'KDV-16' }] });
    expect(inv.statusCode, inv.body).toBe(201);
    const rates = (await w.c.get('/api/tax-rates')).json().taxRates as { id: string; code: string; validFrom: string }[];
    const used = rates.find((r) => r.code === 'KDV-16' && r.validFrom <= day(5, 10))!;
    const unused = rates.find((r) => r.code === 'KDV-5')!;
    const del = await w.c.delete(`/api/tax-rates/${used.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('SETTINGS_RULE_VIOLATION');
    await asDb(handle, w.dbctx, async (q) => {
      expect((await expectDbError(q, `update tax_rates set rate = 18 where id = $1`, [used.id])).code).toBe('ERP24');
      expect((await expectDbError(q, `update tax_rates set valid_to = $2 where id = $1`, [used.id, day(5, 1)])).code).toBe('ERP24');
      // Doğrulama alanları serbest
      expect((await q(`update tax_rates set verified_by = 'Mali müşavir', verified_at = now() where id = $1 returning id`, [used.id])).rows).toHaveLength(1);
    });
    expect((await w.c.delete(`/api/tax-rates/${unused.id}`)).statusCode).toBe(200);
  });

  it('DB-7: kapalı döneme ya da kaydedilmiş dövizli yevmiyeye ait kur değiştirilemez/silinemez; aynı değerle yeniden yazmak serbest', async () => {
    const w = await world('Db7Kur');
    const put = (rateDate: string, buy: string) => w.c.put('/api/exchange-rates', { rateDate, currencyCode: 'EUR', quoteCode: 'TRY', buy });
    const closed = (await put(day(2, 10), '40')).json().rate as { id: string };
    expect((await w.c.post(`/api/periods/${await periodOf(w.company.id, 2)}/close`)).statusCode).toBe(200);
    expect((await put(day(2, 10), '40')).statusCode).toBe(200);
    const upd = await put(day(2, 10), '41');
    expect(upd.statusCode).toBe(422);
    expect(upd.json().error.code).toBe('SETTINGS_RULE_VIOLATION');
    expect((await w.c.delete(`/api/exchange-rates/${closed.id}`)).statusCode).toBe(422);

    const usedRate = (await put(day(6, 10), '42')).json().rate as { id: string };
    const eur = (await w.c.post('/api/accounts', { code: '102.900', name: 'EUR banka', currencyCode: 'EUR' })).json().account;
    const je = await w.c.post('/api/journal-entries', {
      entryDate: day(6, 10),
      description: 'EUR tahsilat',
      post: true,
      lines: [{ accountId: eur.id, currency: 'EUR', debit: '10', fxRate: '42' }, { accountId: w.ids['600'], currency: 'TRY', credit: '420' }],
    });
    expect(je.statusCode, je.body).toBe(201);
    expect((await w.c.delete(`/api/exchange-rates/${usedRate.id}`)).statusCode).toBe(422);
    const free = (await put(day(7, 10), '43')).json().rate as { id: string };
    expect((await w.c.delete(`/api/exchange-rates/${free.id}`)).statusCode).toBe(200);
  });

  it('DB-8: toplu faturalama sonucunun faturası bileşik FK ile bağlı (yetim kimlik yazılamaz)', async () => {
    const fk = await execAsOwner(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'invoice_batch_items_invoice_fk'`);
    expect(fk.rows[0]?.def).toMatch(/FOREIGN KEY \(invoice_id, company_id\) REFERENCES invoices\(id, company_id\) ON DELETE SET NULL \(invoice_id\)/);
    const w = await world('Db8Fk');
    const party = (await w.c.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).json().party;
    const err = await execAsOwner(
      `with b as (insert into invoice_batches (id, company_id, invoice_date, grouping, post, created_by) values (gen_random_uuid(), $1, current_date, 'party', false, $3) returning id)
       insert into invoice_batch_items (id, company_id, batch_id, party_id, status, invoice_id) select gen_random_uuid(), $1, b.id, $2, 'created', gen_random_uuid() from b`,
      [w.company.id, party.id, w.s.userId],
    ).catch((e: { code: string }) => e);
    expect((err as { code?: string }).code).toBe('23503');
  });

  it('DB-11: kesilmiş kısıt adı yok; FK indeksleri var; gereksiz indeks kaldırıldı', async () => {
    const long = await execAsOwner(`select conname from pg_constraint where connamespace = 'public'::regnamespace and length(conname) >= 63`);
    expect(long.rows).toEqual([]);
    const idx = (await execAsOwner(`select indexname from pg_indexes where schemaname = 'public'`)).rows.map((r) => r.indexname as string);
    for (const name of ['journal_lines_cost_code_idx', 'attendance_entries_cost_code_idx', 'attendance_entries_wbs_idx', 'invoices_journal_idx', 'refresh_tokens_family_idx', 'price_list_items_uq', 'party_prices_uq']) {
      expect(idx).toContain(name);
    }
    expect(idx).not.toContain('social_declaration_lines_decl_idx');
  });
});
