import { describe, expect, it } from 'vitest';
import { accountIds, asDb, client, createCompany, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('şirket kurulumu ve kiracı yalıtımı', async () => {
  const { app, handle } = await makeApp();

  it('şirket oluşturulunca varsayılanlar kurulur', async () => {
    const s = await registerUser(app, 'Kurulum');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);

    const accounts = (await c.get('/api/accounts')).json().accounts;
    expect(accounts.length).toBeGreaterThan(150);
    const kasa = accounts.find((a: any) => a.code === '100');
    expect(kasa).toMatchObject({ name: 'Kasa', type: 'asset', isPostable: true });
    const grup = accounts.find((a: any) => a.code === '10');
    expect(grup.isPostable).toBe(false);

    const year = new Date().getUTCFullYear();
    const periods = (await c.get(`/api/periods?year=${year}`)).json().periods;
    expect(periods).toHaveLength(12);
    expect(periods.every((p: any) => p.status === 'open')).toBe(true);

    const rates = (await c.get('/api/tax-rates')).json().taxRates;
    expect(rates.map((r: any) => r.code).sort()).toEqual(['KDV-0', 'KDV-10', 'KDV-16', 'KDV-5']);
    // Kapsam belgesinden gelen oranlar doğrulanmamış olarak işaretlenir
    expect(rates.every((r: any) => r.verifiedAt === null)).toBe(true);

    const me = (await client(app, s.token).get('/api/me')).json();
    expect(me.companies).toHaveLength(1);
    expect(me.companies[0]).toMatchObject({ id: company.id, role: 'owner', baseCurrency: 'TRY', reportingCurrency: 'GBP' });
  });

  it('başka kuruluşun şirketine erişilemez; başlık zorunludur', async () => {
    const a = await registerUser(app, 'Alfa');
    const b = await registerUser(app, 'Beta');
    const companyA = await createCompany(app, a.token, { name: 'Alfa İnşaat' });
    await createCompany(app, b.token, { name: 'Beta İnşaat' });

    const cross = await client(app, b.token, companyA.id).get('/api/accounts');
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error.code).toBe('NOT_A_MEMBER');

    const noHeader = await client(app, a.token).get('/api/accounts');
    expect(noHeader.statusCode).toBe(400);
    expect(noHeader.json().error.code).toBe('COMPANY_REQUIRED');

    // B kullanıcısı A'nın şirketini kendi listesinde de görmez
    expect((await client(app, b.token).get('/api/me')).json().companies.map((x: any) => x.name)).toEqual(['Beta İnşaat']);
  });

  it('RLS: uygulama hatası olsa bile veritabanı başka şirketin satırlarını vermez', async () => {
    const a = await registerUser(app, 'RlsA');
    const b = await registerUser(app, 'RlsB');
    const companyA = await createCompany(app, a.token);
    const companyB = await createCompany(app, b.token);
    const orgB = await orgOf(app, b.token);

    // B bağlamında, doğrudan SQL ile A'nın hesaplarını istemek
    await asDb(handle, { userId: b.userId, orgId: orgB, companyId: companyB.id }, async (q) => {
      const own = await q('select count(*)::int as n from accounts');
      expect(own.rows[0].n).toBeGreaterThan(150);
      const foreign = await q('select count(*)::int as n from accounts where company_id = $1', [companyA.id]);
      expect(foreign.rows[0].n).toBe(0);
      const foreignCompany = await q('select count(*)::int as n from companies where id = $1', [companyA.id]);
      expect(foreignCompany.rows[0].n).toBe(0);

      // A adına satır eklemeye çalışmak RLS'e takılır
      const err = await expectDbError(
        q,
        `insert into accounts (company_id, code, name, type) values ($1, '999', 'Sızıntı', 'asset')`,
        [companyA.id],
      );
      expect(err.message).toMatch(/row-level security/);

      // A'nın verisini güncelleme/silme etkisiz (0 satır)
      const upd = await q(`update accounts set name = 'Ele geçirildi' where company_id = $1`, [companyA.id]);
      expect((upd as any).rowCount ?? 0).toBe(0);
    });

    // Bağlam hiç yoksa hiçbir şey görünmez
    await asDb(handle, {}, async (q) => {
      expect((await q('select count(*)::int as n from accounts')).rows[0].n).toBe(0);
      expect((await q('select count(*)::int as n from companies')).rows[0].n).toBe(0);
      expect((await q('select count(*)::int as n from memberships')).rows[0].n).toBe(0);
      expect((await q('select count(*)::int as n from audit_log')).rows[0].n).toBe(0);
    });
  });

  it('RLS: memberships tablosuna başka şirketin kimliğiyle üyelik eklenemez', async () => {
    const a = await registerUser(app, 'MemA');
    const b = await registerUser(app, 'MemB');
    const companyA = await createCompany(app, a.token);
    const orgB = await orgOf(app, b.token);
    await asDb(handle, { userId: b.userId, orgId: orgB }, async (q) => {
      const err = await expectDbError(
        q,
        `insert into memberships (company_id, user_id, role) values ($1, $2, 'owner')`,
        [companyA.id, b.userId],
      );
      expect(err.message).toMatch(/row-level security|violates foreign key/);
    });
  });

  it('roller: sahip kullanıcı ekler; yetkisiz roller reddedilir; son sahip silinemez', async () => {
    const owner = await registerUser(app, 'Sahip');
    const company = await createCompany(app, owner.token);
    const oc = client(app, owner.token, company.id);

    const add = await oc.post('/api/company/members', {
      email: 'muhasebeci@example.com', fullName: 'Muhasebe Müdürü', role: 'accountant', password: 'Muhasebe-12345',
    });
    expect(add.statusCode).toBe(201);
    const addViewer = await oc.post('/api/company/members', {
      email: 'izleyici@example.com', fullName: 'İzleyici Kişi', role: 'viewer', password: 'Izleyici-12345',
    });
    expect(addViewer.statusCode).toBe(201);
    expect((await oc.post('/api/company/members', { email: 'izleyici@example.com', fullName: 'İzleyici Kişi', role: 'viewer' })).json().error.code).toBe('ALREADY_MEMBER');

    const login = async (email: string, password: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
      return r.json().accessToken as string;
    };
    const viewer = client(app, await login('izleyici@example.com', 'Izleyici-12345'), company.id);
    const accountant = client(app, await login('muhasebeci@example.com', 'Muhasebe-12345'), company.id);

    // İzleyici okur ama yazamaz
    expect((await viewer.get('/api/accounts')).statusCode).toBe(200);
    expect((await viewer.post('/api/accounts', { code: '100.001', name: 'Merkez Kasa' })).statusCode).toBe(403);
    // Muhasebeci hesap açar ama üye yönetemez
    expect((await accountant.post('/api/accounts', { code: '100.001', name: 'Merkez Kasa' })).statusCode).toBe(201);
    expect((await accountant.get('/api/company/members')).statusCode).toBe(403);

    // Son sahip silinemez / rolü düşürülemez
    expect((await oc.delete(`/api/company/members/${owner.userId}`)).json().error.code).toBe('LAST_OWNER');
    expect((await oc.patch(`/api/company/members/${owner.userId}`, { role: 'viewer' })).json().error.code).toBe('LAST_OWNER');
  });

  it('menü rol ve sektöre göre süzülür', async () => {
    const owner = await registerUser(app, 'Menu');
    const company = await createCompany(app, owner.token);
    const oc = client(app, owner.token, company.id);
    await oc.post('/api/company/members', { email: 'satis@example.com', fullName: 'Satış Temsilcisi', role: 'sales', password: 'Satis-1234567' });

    const nav = (await oc.get('/api/navigation')).json();
    const keys = nav.groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(keys).toEqual(expect.arrayContaining(['dashboard', 'journal', 'accounts', 'trial-balance', 'currencies']));
    expect(nav.modules).toEqual(expect.arrayContaining(['core.ledger', 'core.settings', 'core.dashboard']));
    expect(nav.modules).not.toContain('retail.pos');

    const salesToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'satis@example.com', password: 'Satis-1234567' } })).json().accessToken;
    const salesNav = (await client(app, salesToken, company.id).get('/api/navigation')).json();
    const salesKeys = salesNav.groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(salesKeys).toContain('dashboard');
    expect(salesKeys).not.toContain('journal');
    expect(salesKeys).not.toContain('trial-balance');
  });

  it('kapatılan modülün uçları 403 MODULE_DISABLED verir ve menüden kalkar', async () => {
    const owner = await registerUser(app, 'Modul');
    const company = await createCompany(app, owner.token);
    const orgId = await orgOf(app, owner.token);
    const c = client(app, owner.token, company.id);
    expect((await c.get('/api/accounts')).statusCode).toBe(200);

    // company_modules'e istisna yaz (henüz arayüzü yok; ileride yönetim ekranı yazacak)
    const pool = handle.pool;
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.company_id', $3, true)`, [owner.userId, orgId, company.id]);
      await conn.query(`insert into company_modules (company_id, module, enabled) values ($1, 'core.ledger', false)`, [company.id]);
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }

    const res = await c.get('/api/accounts');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
    const nav = (await c.get('/api/navigation')).json();
    expect(nav.groups.map((g: any) => g.key)).not.toContain('accounting');
  });

  it('denetim izi: değişiklikler kaydedilir, uygulama rolü audit_log a yazamaz/değiştiremez', async () => {
    const owner = await registerUser(app, 'Denetim');
    const company = await createCompany(app, owner.token);
    const orgId = await orgOf(app, owner.token);
    const c = client(app, owner.token, company.id);
    const created = (await c.post('/api/accounts', { code: '120.001', name: 'Test Müşteri' })).json().account;
    await c.patch(`/api/accounts/${created.id}`, { name: 'Test Müşteri (yeni)' });

    await asDb(handle, { userId: owner.userId, orgId, companyId: company.id }, async (q) => {
      const rows = (
        await q(
          `select action, user_id, old_data->>'name' as old_name, new_data->>'name' as new_name
             from audit_log where table_name = 'accounts' and row_id = $1 order by id`,
          [created.id],
        )
      ).rows;
      expect(rows.map((r) => r.action)).toEqual(['INSERT', 'UPDATE']);
      expect(rows[0].user_id).toBe(owner.userId);
      expect(rows[1]).toMatchObject({ old_name: 'Test Müşteri', new_name: 'Test Müşteri (yeni)' });

      for (const stmt of [
        `insert into audit_log (table_name, action) values ('x', 'INSERT')`,
        `update audit_log set action = 'DELETE'`,
        `delete from audit_log`,
      ]) {
        const err = await expectDbError(q, stmt);
        expect(err.message).toMatch(/permission denied/);
      }
    });
  });

  it('hesap kodu benzersiz; hareketli hesabın altına alt hesap açılmaz', async () => {
    const owner = await registerUser(app, 'Hesap');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    expect((await c.post('/api/accounts', { code: '100', name: 'Yinelenen' })).json().error.code).toBe('ACCOUNT_CODE_TAKEN');
    expect((await c.post('/api/accounts', { code: '105.001', name: 'Üst yok' })).json().error.code).toBe('PARENT_ACCOUNT_MISSING');
    const sub = await c.post('/api/accounts', { code: '100.001', name: 'Merkez Kasa' });
    expect(sub.statusCode).toBe(201);
    // Üst hesap artık gruptur
    const ids = await accountIds(app, owner.token, company.id);
    const parent = (await c.get('/api/accounts')).json().accounts.find((a: any) => a.id === ids['100']);
    expect(parent.isPostable).toBe(false);
  });
});
