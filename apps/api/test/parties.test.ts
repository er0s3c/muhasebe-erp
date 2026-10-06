import { describe, expect, it } from 'vitest';
import { accountIds, asDb, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('cari (müşteri / tedarikçi)', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids, orgId: await orgOf(app, s.token) };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const mkParty = async (c: Ctx['c'], name: string, kind = 'customer', extra: Record<string, unknown> = {}) => {
    const res = await c.post('/api/parties', { name, kind, ...extra });
    if (res.statusCode !== 201) throw new Error(`party failed: ${res.body}`);
    return res.json().party as { id: string; code: string };
  };

  const L = (accountId: string, side: 'debit' | 'credit', amount: string, extra: Record<string, unknown> = {}) => ({
    accountId,
    currency: 'TRY',
    [side]: amount,
    ...extra,
  });

  /** Kaydedilmiş yevmiye; cari tarafını (120/320) partyId ile, karşı tarafı verilen hesapla atar. */
  const post = (c: Ctx['c'], date: string, lines: unknown[], description = 'Kayıt') =>
    c.post('/api/journal-entries', { entryDate: date, description, lines, post: true });

  it('kart oluşturur: kod otomatik ve boşluksuz, benzersiz, doğrulanır; günceller ve süzer', async () => {
    const { c } = await setup('Kart');
    const a = await mkParty(c, 'Ali Yılmaz', 'customer', { phone: '0533 111 22 33', taxNumber: '1234567' });
    const b = await mkParty(c, 'Demir Çelik A.Ş.', 'supplier');
    const both = await mkParty(c, 'Usta Ltd.', 'both');
    expect([a.code, b.code, both.code]).toEqual(['CR-000001', 'CR-000002', 'CR-000003']);

    expect((await c.post('/api/parties', { name: 'Özel kodlu', code: 'CR-000001' })).json().error.code).toBe('PARTY_CODE_TAKEN');
    const custom = await c.post('/api/parties', { name: 'Özel kodlu', code: 'MUS-01' });
    expect(custom.statusCode).toBe(201);
    expect(custom.json().party.code).toBe('MUS-01');

    expect((await c.post('/api/parties', { name: 'A' })).statusCode).toBe(400);
    expect((await c.post('/api/parties', { name: 'Geçerli ad', email: 'bozuk' })).statusCode).toBe(400);
    expect((await c.post('/api/parties', { name: 'Geçerli ad', creditLimit: '-5' })).statusCode).toBe(400);

    const updated = await c.patch(`/api/parties/${a.id}`, { phone: '0542 000 00 00', creditLimit: '50000', notes: 'VIP' });
    expect(updated.json().party).toMatchObject({ phone: '0542 000 00 00', creditLimit: '50000.0000', notes: 'VIP' });
    // Boş metin alanı temizler; gönderilmeyen alana dokunulmaz; limit null ile kaldırılır
    const cleared = await c.patch(`/api/parties/${a.id}`, { phone: '', creditLimit: null });
    expect(cleared.json().party).toMatchObject({ phone: null, creditLimit: null, notes: 'VIP', taxNumber: '1234567' });

    const names = async (qs: string) => (await c.get(`/api/parties?${qs}`)).json().parties.map((p: any) => p.name);
    expect(await names('kind=customer')).toEqual(['Ali Yılmaz', 'Özel kodlu', 'Usta Ltd.']); // "her ikisi" de müşteri sayılır
    expect(await names('kind=supplier')).toEqual(['Demir Çelik A.Ş.', 'Usta Ltd.']);
    expect(await names('query=demir')).toEqual(['Demir Çelik A.Ş.']);
    expect(await names('query=MUS-01')).toEqual(['Özel kodlu']);

    await c.patch(`/api/parties/${b.id}`, { isActive: false });
    expect(await names('active=false')).toEqual(['Demir Çelik A.Ş.']);
    const page = (await c.get('/api/parties?limit=2&offset=0')).json();
    expect(page.parties).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('Türkçe sıralama ve arama: Ç, Ğ, İ, Ö, Ş, Ü doğru yerde; İ→i, I→ı büyük/küçük harf kuralı', async () => {
    const { c } = await setup('Turkce');
    for (const n of ['Zeynep Kaya', 'Özel İnşaat', 'Usta Ltd.', 'Çelik Demir', 'Ali Yılmaz', 'Şahin Market', 'Ilgaz Yapı', 'İpek Tekstil', 'Oğuz Nakliyat']) {
      await mkParty(c, n);
    }
    const names = async (qs = '') => (await c.get(`/api/parties?${qs}`)).json().parties.map((p: any) => p.name);
    expect(await names()).toEqual([
      'Ali Yılmaz', 'Çelik Demir', 'Ilgaz Yapı', 'İpek Tekstil', 'Oğuz Nakliyat', 'Özel İnşaat', 'Şahin Market', 'Usta Ltd.', 'Zeynep Kaya',
    ]);
    expect(await names('query=' + encodeURIComponent('ÖZEL'))).toEqual(['Özel İnşaat']); // Ö → ö
    expect(await names('query=' + encodeURIComponent('ipek'))).toEqual(['İpek Tekstil']); // İ → i
    expect(await names('query=' + encodeURIComponent('ILGAZ'))).toEqual(['Ilgaz Yapı']); // I → ı
    expect(await names('query=' + encodeURIComponent('%'))).toEqual([]); // joker karakter düz metin sayılır
  });

  it('cari kontrol hesaplarında cari zorunlu, diğerlerinde yasak; tür ve durum uyumu denetlenir', async () => {
    const { c, ids } = await setup('Kural');
    const customer = await mkParty(c, 'Müşteri', 'customer');
    const supplier = await mkParty(c, 'Tedarikçi', 'supplier');
    const both = await mkParty(c, 'Her ikisi', 'both');
    const counter = L(ids['600']!, 'credit', '100');
    const code = async (lines: unknown[]) => (await post(c, day(2, 1), lines)).json().error?.code;

    expect(await code([L(ids['120']!, 'debit', '100'), counter])).toBe('PARTY_REQUIRED');
    expect(await code([L(ids['120']!, 'debit', '100', { partyId: supplier.id }), counter])).toBe('PARTY_KIND_MISMATCH');
    expect(await code([L(ids['320']!, 'credit', '100', { partyId: customer.id }), L(ids['100']!, 'debit', '100')])).toBe('PARTY_KIND_MISMATCH');
    expect(await code([L(ids['100']!, 'debit', '100', { partyId: customer.id }), counter])).toBe('PARTY_NOT_ALLOWED');
    expect(await code([L(ids['100']!, 'debit', '100', { dueDate: day(3, 1) }), counter])).toBe('DUE_DATE_WITHOUT_PARTY');
    expect(await code([L(ids['120']!, 'debit', '100', { partyId: '0198f2c4-7b1a-7000-8000-000000000001' }), counter])).toBe('PARTY_NOT_FOUND');

    // Geçerli: müşteri 120'de, tedarikçi 320'de, "her ikisi" ikisinde de
    expect((await post(c, day(2, 1), [L(ids['120']!, 'debit', '100', { partyId: customer.id, dueDate: day(3, 1) }), counter])).statusCode).toBe(201);
    expect((await post(c, day(2, 1), [L(ids['320']!, 'credit', '100', { partyId: supplier.id }), L(ids['100']!, 'debit', '100')])).statusCode).toBe(201);
    expect((await post(c, day(2, 1), [L(ids['120']!, 'debit', '50', { partyId: both.id }), L(ids['320']!, 'credit', '50', { partyId: both.id })])).statusCode).toBe(201);

    // Pasif cariye kayıt atılamaz
    await c.patch(`/api/parties/${customer.id}`, { isActive: false });
    expect(await code([L(ids['120']!, 'debit', '100', { partyId: customer.id }), counter])).toBe('PARTY_INACTIVE');
  });

  it('veritabanı tetikleyicisi de aynı kuralı uygular (uygulama atlansa bile)', async () => {
    const { c, ids, s, company, orgId } = await setup('Trigger');
    const draft = (
      await c.post('/api/journal-entries', {
        entryDate: day(2, 1),
        description: 'Taslak',
        lines: [L(ids['100']!, 'debit', '10'), L(ids['600']!, 'credit', '10')],
      })
    ).json().entry;
    const party = await mkParty(c, 'Müşteri');

    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      const insert = `insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, debit, debit_base, party_id)
                      values (gen_random_uuid(), $1, $2, 9, $3, 'TRY', 1, 1, $4)`;
      // cari kontrol hesabı + cari yok
      expect((await expectDbError(q, insert, [company.id, draft.id, ids['120'], null])).code).toBe('ERP01');
      // cari kontrol hesabı olmayan hesapta cari var
      expect((await expectDbError(q, insert, [company.id, draft.id, ids['100'], party.id])).code).toBe('ERP01');
      // vade tarihi cari olmadan
      const due = `insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, debit, debit_base, due_date)
                   values (gen_random_uuid(), $1, $2, 9, $3, 'TRY', 1, 1, '2026-01-01')`;
      expect((await expectDbError(q, due, [company.id, draft.id, ids['100']])).code).toBe('ERP01');
      // başka şirketin carisine bağlanamaz: bileşik yabancı anahtar
      const foreign = await expectDbError(q, insert, [company.id, draft.id, ids['120'], '0198f2c4-7b1a-7000-8000-000000000009']);
      expect(foreign.message).toMatch(/violates foreign key/);
    });
  });

  it('alt hesap cari kontrol türünü devralır', async () => {
    const { c, ids } = await setup('Devral');
    const list = (await c.get('/api/accounts')).json().accounts;
    expect(list.find((a: any) => a.code === '120').partyControl).toBe('receivable');
    expect(list.find((a: any) => a.code === '320').partyControl).toBe('payable');
    expect(list.find((a: any) => a.code === '100').partyControl).toBeNull();

    const sub = (await c.post('/api/accounts', { code: '120.001', name: 'Daire alıcıları' })).json().account;
    expect(sub.partyControl).toBe('receivable');
    const party = await mkParty(c, 'Alıcı');
    expect((await post(c, day(2, 1), [L(sub.id, 'debit', '10'), L(ids['600']!, 'credit', '10')])).json().error.code).toBe('PARTY_REQUIRED');
    expect((await post(c, day(2, 1), [L(sub.id, 'debit', '10', { partyId: party.id }), L(ids['600']!, 'credit', '10')])).statusCode).toBe(201);
  });

  it('ekstre: açılış bakiyesi, yürüyen bakiye, taslak hariç, ters kayıt cariyi korur', async () => {
    const { c, ids } = await setup('Ekstre');
    const p = await mkParty(c, 'Ali Yılmaz');
    const inv = (d: string, amount: string, due?: string) =>
      post(c, d, [L(ids['120']!, 'debit', amount, { partyId: p.id, ...(due ? { dueDate: due } : {}) }), L(ids['600']!, 'credit', amount)], `Fatura ${d}`);

    await inv(day(1, 10), '1000', day(2, 10));
    await post(c, day(2, 5), [L(ids['100']!, 'debit', '400'), L(ids['120']!, 'credit', '400', { partyId: p.id })], 'Tahsilat');
    const last = (await inv(day(2, 20), '250')).json().entry;
    // Taslak sonuca girmez
    await c.post('/api/journal-entries', {
      entryDate: day(2, 25), description: 'Taslak', post: false,
      lines: [L(ids['120']!, 'debit', '9999', { partyId: p.id }), L(ids['600']!, 'credit', '9999')],
    });

    const st = (await c.get(`/api/parties/${p.id}/statement?from=${day(2, 1)}&to=${day(2, 28)}`)).json();
    expect(st.opening).toBe('1000.0000');
    expect(st.lines.map((l: any) => [l.description, l.balance])).toEqual([
      ['Tahsilat', '600.0000'],
      ['Fatura ' + day(2, 20), '850.0000'],
    ]);
    expect(st.totals).toEqual({ debitBase: '250.0000', creditBase: '400.0000' });
    expect(st.closing).toBe('850.0000');
    expect(st.lines[0].control).toBe('receivable');

    const detail = (await c.get(`/api/parties/${p.id}`)).json();
    expect(detail.summary).toMatchObject({ debit: '1250.0000', credit: '400.0000', balance: '850.0000', movements: 3 });
    expect(detail.summary.byCurrency).toEqual([{ currency: 'TRY', balance: '850.0000' }]);

    // Ters kayıt aynı cariye işler; bakiye düşer
    const rev = await c.post(`/api/journal-entries/${last.id}/reverse`, { entryDate: day(2, 21) });
    expect(rev.statusCode).toBe(201);
    expect(rev.json().entry.lines.find((l: any) => l.accountCode === '120').partyId).toBe(p.id);
    expect((await c.get(`/api/parties/${p.id}`)).json().summary.balance).toBe('600.0000');

    // Bakiye listesi: 1000 B + 250 B (fatura), 400 A (tahsilat) + 250 A (ters kayıt); taslak hariç
    const row = (await c.get('/api/parties')).json().parties.find((x: any) => x.id === p.id);
    expect(row).toMatchObject({ debit: '1250.0000', credit: '650.0000', balance: '600.0000', movements: 4 });
    expect((await c.get('/api/parties?hasBalance=true')).json().parties).toHaveLength(1);
  });

  it('dövizli cari satırı: para birimi bazında bakiye görünür', async () => {
    const { c, ids } = await setup('Doviz');
    await c.put('/api/exchange-rates', { rateDate: day(3, 1), currencyCode: 'GBP', quoteCode: 'TRY', buy: '40' });
    const p = await mkParty(c, 'Sarah Thompson', 'customer', { currencyCode: 'GBP' });
    const res = await post(c, day(3, 2), [
      { accountId: ids['120'], currency: 'GBP', debit: '100', partyId: p.id },
      L(ids['600']!, 'credit', '4000'),
    ]);
    expect(res.statusCode).toBe(201);
    const s = (await c.get(`/api/parties/${p.id}`)).json().summary;
    expect(s.balance).toBe('4000.0000');
    expect(s.byCurrency).toEqual([{ currency: 'GBP', balance: '100.0000' }]);
    const st = (await c.get(`/api/parties/${p.id}/statement?from=${day(3, 1)}&to=${day(3, 31)}`)).json();
    expect(st.lines[0]).toMatchObject({ currencyCode: 'GBP', debit: '100.0000', debitBase: '4000.0000' });
  });

  it('yaşlandırma: ödemeler en eski vadeden başlayarak uygulanır (FIFO), avans ayrı gösterilir', async () => {
    const { c, ids } = await setup('Yas');
    const a = await mkParty(c, 'Ali Yılmaz');
    const b = await mkParty(c, 'Avansçı Müşteri');
    const sup = await mkParty(c, 'Hazır Beton', 'supplier');
    const charge = (p: { id: string }, d: string, amount: string, due: string) =>
      post(c, d, [L(ids['120']!, 'debit', amount, { partyId: p.id, dueDate: due }), L(ids['600']!, 'credit', amount)]);

    await charge(a, day(1, 10), '1000', day(2, 10)); // ödemeyle tamamen kapanır
    await charge(a, day(3, 1), '500', day(3, 31)); // 200 uygulanır, 300 kalır -> 90+ gün
    await charge(a, day(8, 1), '200', day(8, 31)); // 30 gün gecikmiş
    await charge(a, day(9, 1), '300', day(10, 15)); // vadesi gelmemiş
    await post(c, day(4, 1), [L(ids['100']!, 'debit', '1200'), L(ids['120']!, 'credit', '1200', { partyId: a.id })], 'Tahsilat');
    // Yalnızca ödeme yapmış müşteri: avans
    await post(c, day(5, 1), [L(ids['100']!, 'debit', '100'), L(ids['120']!, 'credit', '100', { partyId: b.id })], 'Avans');
    // Tedarikçi (borç tarafı)
    await post(c, day(8, 20), [L(ids['150']!, 'debit', '600'), L(ids['320']!, 'credit', '600', { partyId: sup.id, dueDate: day(9, 19) })]);

    const asOf = day(9, 30);
    const aging = (await c.get(`/api/reports/party-aging?type=receivable&asOf=${asOf}`)).json();
    const ali = aging.rows.find((r: any) => r.partyId === a.id);
    expect(ali).toMatchObject({ notDue: '300.00', d1_30: '200.00', d31_60: '0.00', d61_90: '0.00', d90plus: '300.00', unapplied: '0.00', total: '800.00' });
    const adv = aging.rows.find((r: any) => r.partyId === b.id);
    expect(adv).toMatchObject({ unapplied: '100.00', total: '-100.00' });
    expect(aging.totals).toMatchObject({ notDue: '300.00', d1_30: '200.00', d90plus: '300.00', unapplied: '100.00', total: '700.00' });
    expect(aging.rows.find((r: any) => r.partyId === sup.id)).toBeUndefined(); // tedarikçi alacak raporunda yok

    const pay = (await c.get(`/api/reports/party-aging?type=payable&asOf=${asOf}`)).json();
    expect(pay.rows).toHaveLength(1);
    expect(pay.rows[0]).toMatchObject({ partyId: sup.id, d1_30: '600.00', total: '600.00' }); // 11 gün gecikmiş

    // Açık kalemler: kaynağı ve kalan tutarı gösterir
    const oi = (await c.get(`/api/parties/${a.id}/open-items?asOf=${asOf}&type=receivable`)).json();
    expect(oi.receivable.items.map((i: any) => [i.dueDate, i.remainingBase, i.bucket])).toEqual([
      [day(3, 31), '300.00', 'd90plus'],
      [day(8, 31), '200.00', 'd1_30'],
      [day(10, 15), '300.00', 'notDue'],
    ]);
    expect(oi.receivable.items[0].amountBase).toBe('500.00');
    expect(oi.receivable.unapplied).toBe('0.00');
    expect(oi.payable).toBeUndefined();

    // Geçmiş tarihli görünüm: 1 Şubat itibarıyla ilk fatura henüz vadesinde, ödeme yok
    const early = (await c.get(`/api/reports/party-aging?type=receivable&asOf=${day(2, 1)}`)).json();
    expect(early.rows.find((r: any) => r.partyId === a.id)).toMatchObject({ notDue: '1000.00', total: '1000.00' });
  });

  it('silme ve tür daraltma: hareketli cari silinemez, ters türde hareketi olanın türü daraltılamaz', async () => {
    const { c, ids } = await setup('Sil');
    const unused = await mkParty(c, 'Kullanılmayan');
    expect((await c.delete(`/api/parties/${unused.id}`)).statusCode).toBe(200);
    expect((await c.get(`/api/parties/${unused.id}`)).statusCode).toBe(404);

    const used = await mkParty(c, 'Hareketli', 'both');
    await post(c, day(2, 1), [L(ids['320']!, 'credit', '100', { partyId: used.id }), L(ids['100']!, 'debit', '100')]);
    const del = await c.delete(`/api/parties/${used.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('PARTY_HAS_MOVEMENTS');
    // Tedarikçi olarak hareket görmüş: "müşteri"ye daraltılamaz, "tedarikçi"ye daraltılabilir
    expect((await c.patch(`/api/parties/${used.id}`, { kind: 'customer' })).json().error.code).toBe('PARTY_KIND_IN_USE');
    expect((await c.patch(`/api/parties/${used.id}`, { kind: 'supplier' })).statusCode).toBe(200);
  });

  it('şirketler arası yalıtım: başka şirketin carisi görünmez ve kullanılamaz', async () => {
    const a = await setup('IzoleA');
    const b = await setup('IzoleB');
    const party = await mkParty(a.c, 'Gizli Müşteri');

    expect((await b.c.get(`/api/parties/${party.id}`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/parties/${party.id}/statement?from=${day(1, 1)}&to=${day(12, 31)}`)).statusCode).toBe(404);
    expect((await b.c.delete(`/api/parties/${party.id}`)).statusCode).toBe(404);
    expect((await b.c.get('/api/parties')).json().parties).toHaveLength(0);
    const use = await post(b.c, day(2, 1), [L(b.ids['120']!, 'debit', '10', { partyId: party.id }), L(b.ids['600']!, 'credit', '10')]);
    expect(use.json().error.code).toBe('PARTY_NOT_FOUND');

    await asDb(handle, { userId: b.s.userId, orgId: b.orgId, companyId: b.company.id }, async (q) => {
      expect((await q('select count(*)::int as n from parties where company_id = $1', [a.company.id])).rows[0].n).toBe(0);
      const err = await expectDbError(q, `insert into parties (company_id, code, name) values ($1, 'X', 'Sızıntı')`, [a.company.id]);
      expect(err.message).toMatch(/row-level security/);
    });
  });

  it('roller: izleyici okur, satış temsilcisi yönetir, şantiye şefi göremez', async () => {
    const { c, company } = await setup('Roller');
    const p = await mkParty(c, 'Müşteri');
    const login = async (email: string, role: string) => {
      await c.post('/api/company/members', { email, fullName: `Kişi ${role}`, role, password: 'Sifre-12345-xyz', mustChangePassword: false });
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'Sifre-12345-xyz' } });
      return client(app, r.json().accessToken, company.id);
    };
    const viewer = await login('v-cari@example.com', 'viewer');
    const sales = await login('s-cari@example.com', 'sales');
    const site = await login('sm-cari@example.com', 'site_manager');

    expect((await viewer.get('/api/parties')).statusCode).toBe(200);
    expect((await viewer.post('/api/parties', { name: 'Yeni müşteri' })).statusCode).toBe(403);
    expect((await viewer.patch(`/api/parties/${p.id}`, { phone: '1' })).statusCode).toBe(403);
    expect((await sales.post('/api/parties', { name: 'Satış müşterisi' })).statusCode).toBe(201);
    expect((await sales.get(`/api/reports/party-aging?type=receivable&asOf=${day(9, 30)}`)).statusCode).toBe(200);
    expect((await sales.get('/api/journal-entries')).statusCode).toBe(403); // muhasebe defterini göremez
    // Şantiye sorumlusu cari seçicileri için yalnızca okur
    expect((await site.get('/api/parties')).statusCode).toBe(200);
    expect((await site.post('/api/parties', { name: 'Şantiye carisi' })).statusCode).toBe(403);
    expect((await site.patch(`/api/parties/${p.id}`, { phone: '1' })).statusCode).toBe(403);

    const nav = async (cl: typeof sales) =>
      (await cl.get('/api/navigation')).json().groups.map((g: any) => g.key);
    expect(await nav(sales)).toEqual(['overview', 'parties', 'invoices', 'stock', 'directory', 'reports', 'settings']);
    expect(await nav(site)).toContain('parties');
  });
});

