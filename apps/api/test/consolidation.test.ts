import { describe, expect, it } from 'vitest';
import { PASSWORD, accountIds, asDb, asOwner, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser, thisYear } from './helpers';

/**
 * Çoklu şirket konsolidasyonu (X7): güvenlik (üyelik/rol/modül her istekte, sızıntı yok, RLS), aritmetik (kur, çevrim farkı,
 * eliminasyon, kod eşleme), döviz pozisyonu (defter ve açık kalemlerle mutabakat), yönetici özeti (izin/modül kapıları), dışa aktarma.
 */
describe('çoklu şirket konsolidasyonu', async () => {
  const { app, handle } = await makeApp();

  type Cl = ReturnType<typeof client>;
  const tl = (accountId: string, side: 'debit' | 'credit', amount: string, currency = 'TRY') => ({ accountId, currency, [side]: amount });
  async function post(c: Cl, ids: Record<string, string>, date: string, currency: string, lines: [string, 'debit' | 'credit', string][]) {
    const res = await c.post('/api/journal-entries', { entryDate: date, description: 'Test', post: true, lines: lines.map(([code, side, amt]) => tl(ids[code]!, side, amt, currency)) });
    if (res.statusCode !== 201) throw new Error(`journal failed: ${res.body}`);
  }

  /** U: A (TRY) ve B (GBP) şirketlerinin sahibi; yukarıdaki sayı örneği (bkz. docs/ARCHITECTURE X7). */
  async function seed(name: string) {
    const u = await registerUser(app, name);
    const A = await createCompany(app, u.token, { name: `${name} A Ltd`, baseCurrency: 'TRY', taxNumber: '1111111111' });
    const B = await createCompany(app, u.token, { name: `${name} B Ltd`, baseCurrency: 'GBP', taxNumber: '2222222222' });
    const ca = client(app, u.token, A.id);
    const cb = client(app, u.token, B.id);
    const ia = await accountIds(app, u.token, A.id);
    const ib = await accountIds(app, u.token, B.id);
    // A (TRY): kasa 800, sermaye -1000, banka 600, satış -900, genel yönetim 200, diğer alacak 300
    await post(ca, ia, day(1, 10), 'TRY', [['100', 'debit', '1000'], ['500', 'credit', '1000']]);
    await post(ca, ia, day(2, 10), 'TRY', [['102', 'debit', '600'], ['600', 'credit', '600']]);
    await post(ca, ia, day(3, 10), 'TRY', [['632', 'debit', '200'], ['100', 'credit', '200']]);
    await post(ca, ia, day(4, 10), 'TRY', [['136', 'debit', '300'], ['600', 'credit', '300']]);
    // B (GBP): kasa 450, sermaye -500, genel yönetim 57.5, diğer borç -7.5
    await post(cb, ib, day(1, 10), 'GBP', [['100', 'debit', '500'], ['500', 'credit', '500']]);
    await post(cb, ib, day(2, 10), 'GBP', [['632', 'debit', '50'], ['100', 'credit', '50']]);
    await post(cb, ib, day(3, 10), 'GBP', [['632', 'debit', '7.5'], ['336', 'credit', '7.5']]);
    for (const [d, r] of [[day(3, 1), '38'], [day(6, 1), '40'], [day(9, 1), '42']] as const) {
      expect((await cb.put('/api/exchange-rates', { rateDate: d, currencyCode: 'GBP', quoteCode: 'TRY', buy: r })).statusCode).toBe(200);
    }
    const g = await client(app, u.token).post('/api/consolidation/groups', { name: `${name} Grubu`, reportingCurrency: 'TRY', companyIds: [A.id, B.id] });
    expect(g.statusCode).toBe(201);
    return { u, A, B, ca, cb, ia, ib, groupId: g.json().group.id as string, orgId: await orgOf(app, u.token), api: client(app, u.token) };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  const rep = async (s: Seed, qs = '') => {
    const res = await s.api.get(`/api/consolidation/groups/${s.groupId}/report?from=${day(1, 1)}&to=${day(12, 31)}${qs}`);
    return res;
  };
  const rowOf = (r: any, code: string) => r.rows.find((x: any) => x.code === code);

  // ---------------------------------------------------------------------------------------------------------------------
  describe('güvenlik', () => {
    it('yalnızca üyesi olunan, konsolidasyon izni olan şirket gruba eklenebilir; istemci kimliğine güvenilmez', async () => {
      const s = await seed('Guv1');
      // Başka kuruluştaki şirket
      const x = await registerUser(app, 'Yabanci');
      const Z = await createCompany(app, x.token);
      const r1 = await s.api.post('/api/consolidation/groups', { name: 'Sızıntı', reportingCurrency: 'TRY', companyIds: [s.A.id, Z.id] });
      expect(r1.statusCode).toBe(403);
      expect(r1.json().error.code).toBe('GROUP_MEMBER_DENIED');
      expect(r1.json().error.details).toMatchObject({ companyId: Z.id, reason: 'NOT_A_MEMBER' });
      // Aynı kuruluşta ama üyesi olunmayan şirket
      const m = await client(app, s.u.token, s.A.id).post('/api/company/members', { email: `m-${Date.now()}@example.com`, fullName: 'Mehmet Kişi', role: 'admin', password: PASSWORD, mustChangePassword: false });
      expect(m.statusCode).toBe(201);
      const mLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.json().member.email, password: PASSWORD } });
      const mTok = mLogin.json().accessToken as string;
      const C = await createCompany(app, mTok, { name: 'M şirketi' });
      expect(await orgOf(app, mTok)).toBe(s.orgId);
      const r2 = await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id });
      expect(r2.statusCode).toBe(403);
      expect(r2.json().error.details.reason).toBe('NOT_A_MEMBER');
      // Rapor ucu şirket kimliği ya da başlığı dikkate almaz: yabancı şirket başlığı ve sorgu parametresi sonucu değiştirmez
      const base = (await rep(s, '&closingRates=GBP:40')).json().report;
      const spoof = await app.inject({
        method: 'GET',
        url: `/api/consolidation/groups/${s.groupId}/report?from=${day(1, 1)}&to=${day(12, 31)}&closingRates=GBP:40&companyIds=${Z.id}&companyId=${Z.id}`,
        headers: { authorization: `Bearer ${s.u.token}`, 'x-company-id': Z.id },
      });
      expect(spoof.statusCode).toBe(200);
      expect(spoof.json().report.companies.map((c: any) => c.id).sort()).toEqual([s.A.id, s.B.id].sort());
      expect(spoof.json().report.rows).toEqual(base.rows);
    });

    it('başka kullanıcı grubu göremez, çalıştıramaz, değiştiremez', async () => {
      const s = await seed('Guv2');
      const o = await registerUser(app, 'Baskasi');
      const oc = client(app, o.token);
      expect((await oc.get('/api/consolidation/groups')).json().groups).toEqual([]);
      for (const url of [
        `/api/consolidation/groups/${s.groupId}/report?from=${day(1, 1)}&to=${day(12, 31)}`,
        `/api/consolidation/groups/${s.groupId}/fx-position?asOf=${day(12, 31)}`,
        `/api/consolidation/groups/${s.groupId}/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}`,
        `/api/consolidation/groups/${s.groupId}/intercompany-hints?asOf=${day(12, 31)}`,
        `/api/consolidation/groups/${s.groupId}/export/consolidated?from=${day(1, 1)}&to=${day(12, 31)}`,
        `/api/consolidation/groups/${s.groupId}/eliminations`,
      ]) {
        expect((await oc.get(url)).statusCode, url).toBe(404);
      }
      expect((await oc.patch(`/api/consolidation/groups/${s.groupId}`, { name: 'Ele geçirildi' })).statusCode).toBe(404);
      expect((await oc.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: s.A.id })).statusCode).toBe(404);
      expect((await oc.delete(`/api/consolidation/groups/${s.groupId}/members/${s.A.id}`)).statusCode).toBe(404);
      expect((await s.api.get('/api/consolidation/groups')).json().groups).toHaveLength(1);
      // Kimliksiz erişim
      expect((await app.inject({ method: 'GET', url: '/api/consolidation/groups' })).statusCode).toBe(401);
    });

    it('rol yetersizse gruba eklenemez; sonradan düşürülen rol raporda şirketi düşürür (ROLE_INSUFFICIENT)', async () => {
      const s = await seed('Guv3');
      // M, U'yu kendi şirketine bağlayabilsin diye U'nun tüm şirketlerinde sahip olmalı (mevcut kullanıcıyı bağlama kuralı)
      const m = await client(app, s.u.token, s.A.id).post('/api/company/members', { email: `m3-${Date.now()}@example.com`, fullName: 'Mehmet Kişi', role: 'owner', password: PASSWORD, mustChangePassword: false });
      const email = m.json().member.email as string;
      expect((await client(app, s.u.token, s.B.id).post('/api/company/members', { email, fullName: 'Mehmet Kişi', role: 'owner' })).statusCode).toBe(201);
      const mTok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })).json().accessToken as string;
      const C = await createCompany(app, mTok, { name: 'M şirketi 3' });
      const mc = client(app, mTok, C.id);
      // U, C'ye muhasebeci (konsolidasyon izni yok) olarak eklenir
      const add = await mc.post('/api/company/members', { email: s.u.email, fullName: 'Umut Kişi', role: 'accountant' });
      expect(add.statusCode).toBe(201);
      const deny = await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id });
      expect(deny.statusCode).toBe(403);
      expect(deny.json().error.details.reason).toBe('ROLE_INSUFFICIENT');
      expect((await s.api.get('/api/consolidation/eligible-companies')).json().companies.map((c: any) => c.id).sort()).toEqual([s.A.id, s.B.id].sort());
      // Yönetici yapılınca eklenir; sonra muhasebeciye düşürülünce raporda eksik görünür
      expect((await mc.patch(`/api/company/members/${s.u.userId}`, { role: 'admin' })).statusCode).toBe(200);
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id })).statusCode).toBe(201);
      const ok = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(ok.complete).toBe(true);
      expect(ok.companies).toHaveLength(3);
      expect((await mc.patch(`/api/company/members/${s.u.userId}`, { role: 'accountant' })).statusCode).toBe(200);
      const after = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(after.complete).toBe(false);
      expect(after.excluded).toEqual([{ companyId: C.id, reason: 'ROLE_INSUFFICIENT' }]);
      expect(after.companies.map((c: any) => c.id)).not.toContain(C.id);
      // Grup listesi güncel durumu söyler ve kapalı şirketin adını göstermez
      const list = (await s.api.get('/api/consolidation/groups')).json().groups[0].members as any[];
      expect(list.find((x) => x.companyId === C.id)).toMatchObject({ status: 'ROLE_INSUFFICIENT', name: null });
    });

    it('üyelik kaldırılınca şirket raporlardan (mizan, döviz pozisyonu, özet, ipucu, dışa aktarma) düşer', async () => {
      const s = await seed('Guv4');
      const m = await client(app, s.u.token, s.A.id).post('/api/company/members', { email: `m4-${Date.now()}@example.com`, fullName: 'Mehmet Kişi', role: 'owner', password: PASSWORD, mustChangePassword: false });
      expect((await client(app, s.u.token, s.B.id).post('/api/company/members', { email: m.json().member.email, fullName: 'Mehmet Kişi', role: 'owner' })).statusCode).toBe(201);
      const mTok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.json().member.email, password: PASSWORD } })).json().accessToken as string;
      const C = await createCompany(app, mTok, { name: 'M şirketi 4', baseCurrency: 'TRY' });
      const mc = client(app, mTok, C.id);
      expect((await mc.post('/api/company/members', { email: s.u.email, fullName: 'Umut Kişi', role: 'admin' })).statusCode).toBe(201);
      const ic = await accountIds(app, mTok, C.id);
      await post(mc, ic, day(1, 5), 'TRY', [['100', 'debit', '5000'], ['500', 'credit', '5000']]);
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id })).statusCode).toBe(201);

      const full = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(rowOf(full, '100').perCompany[C.id]).toBe('5000.0000');
      expect(rowOf(full, '100').consolidated).toBe('23800.0000'); // 800 + 18000 + 5000

      // M, U'nun C üyeliğini kaldırır
      expect((await mc.delete(`/api/company/members/${s.u.userId}`)).statusCode).toBe(200);
      const dropped = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(dropped.complete).toBe(false);
      expect(dropped.excluded).toEqual([{ companyId: C.id, reason: 'NOT_A_MEMBER' }]);
      expect(rowOf(dropped, '100').perCompany[C.id]).toBeUndefined();
      expect(rowOf(dropped, '100').consolidated).toBe('18800.0000');
      expect(JSON.stringify(dropped)).not.toContain('M şirketi 4');
      const fx = (await s.api.get(`/api/consolidation/groups/${s.groupId}/fx-position?asOf=${day(12, 31)}`)).json().report;
      expect(fx.excluded).toEqual([{ companyId: C.id, reason: 'NOT_A_MEMBER' }]);
      expect(fx.perCompany.map((c: any) => c.company.id)).not.toContain(C.id);
      const ex = (await s.api.get(`/api/consolidation/groups/${s.groupId}/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}&rates=GBP:40`)).json().report;
      expect(ex.complete).toBe(false);
      expect(ex.scope.companies).toBe(2);
      const hints = (await s.api.get(`/api/consolidation/groups/${s.groupId}/intercompany-hints?asOf=${day(12, 31)}`)).json();
      expect(hints.excluded).toHaveLength(1);
      const csv = await s.api.get(`/api/consolidation/groups/${s.groupId}/export/consolidated?format=csv&from=${day(1, 1)}&to=${day(12, 31)}&closingRates=GBP:40`);
      expect(csv.statusCode).toBe(200);
      expect(csv.body).toContain('EKSİK: 1 şirket');
      expect(csv.body).not.toContain('M şirketi 4');
    });

    it('şirket konsolidasyon modülünü kapatırsa rapordan düşer (MODULE_DISABLED); tüm şirketler düşerse GROUP_NO_ACCESS', async () => {
      const s = await seed('Guv5');
      const off = await s.cb.put('/api/company/modules/reports.consolidation', { enabled: false });
      expect(off.statusCode).toBe(200);
      const r = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(r.excluded).toEqual([{ companyId: s.B.id, reason: 'MODULE_DISABLED' }]);
      expect(r.companies.map((c: any) => c.id)).toEqual([s.A.id]);
      expect((await s.api.get('/api/consolidation/eligible-companies')).json().companies.map((c: any) => c.id)).toEqual([s.A.id]);
      await s.ca.put('/api/company/modules/reports.consolidation', { enabled: false });
      const none = await rep(s, '&closingRates=GBP:40');
      expect(none.statusCode).toBe(403);
      expect(none.json().error.code).toBe('GROUP_NO_ACCESS');
      // Modül kapalıyken şirket yeni bir gruba da eklenemez
      const again = await s.api.post('/api/consolidation/groups', { name: 'Yeni', reportingCurrency: 'TRY', companyIds: [s.A.id] });
      expect(again.statusCode).toBe(403);
      expect(again.json().error.details.reason).toBe('MODULE_DISABLED');
    });

    it('ham SQL: RLS grup/eliminasyon verisini sahibine bağlar, şirket verisi yalnızca kendi bağlamında görünür, yabancı şirkete üye eklenemez', async () => {
      const s = await seed('Guv6');
      const o = await registerUser(app, 'Ham');
      const oOrg = await orgOf(app, o.token);
      await s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations`, {
        periodFrom: day(1, 1), periodTo: day(12, 31), description: 'Ham deneme',
        lines: [{ accountCode: '336', debit: '1' }, { accountCode: '136', credit: '1' }],
      });
      // Sahibi olmayan kullanıcı (aynı oturum bağlamı olsa bile) hiçbir satır görmez
      await asDb(handle, { userId: o.userId, orgId: oOrg }, async (q) => {
        for (const t of ['consolidation_groups', 'consolidation_members', 'consolidation_eliminations', 'consolidation_elimination_lines']) {
          expect((await q(`select count(*)::int as n from ${t}`)).rows[0].n, t).toBe(0);
        }
      });
      // Sahibi: kendi grubunu görür; şirket bağlamı OLMADAN hiçbir şirket verisi görmez
      await asDb(handle, { userId: s.u.userId, orgId: s.orgId }, async (q) => {
        expect((await q('select count(*)::int as n from consolidation_groups')).rows[0].n).toBe(1);
        expect((await q('select count(*)::int as n from consolidation_members')).rows[0].n).toBe(2);
        for (const t of ['journal_lines', 'journal_entries', 'accounts', 'parties', 'treasury_accounts']) {
          expect((await q(`select count(*)::int as n from ${t}`)).rows[0].n, t).toBe(0);
        }
      });
      // A bağlamında yalnızca A'nın satırları görünür (B'ninki görünmez): konsolidasyon tabloları RLS'i gevşetmez
      await asDb(handle, { userId: s.u.userId, orgId: s.orgId, companyId: s.A.id }, async (q) => {
        const lines = await q('select distinct company_id from journal_lines');
        expect(lines.rows.map((r) => r.company_id)).toEqual([s.A.id]);
        expect((await q('select count(*)::int as n from consolidation_groups')).rows[0].n).toBe(1);
      });
      // Üyesi olunmayan şirket üye satırı olarak eklenemez (RLS WITH CHECK)
      const x = await registerUser(app, 'Yab2');
      const Z = await createCompany(app, x.token);
      await asDb(handle, { userId: s.u.userId, orgId: s.orgId }, async (q) => {
        const err = await expectDbError(q, 'insert into consolidation_members (id, group_id, member_company_id) values (gen_random_uuid(), $1, $2)', [s.groupId, Z.id]);
        expect(err.message).toMatch(/row-level security|üyesi değil/);
      });
      // Başkasının grubuna üye eklenemez
      await asDb(handle, { userId: o.userId, orgId: oOrg }, async (q) => {
        await expectDbError(q, 'insert into consolidation_members (id, group_id, member_company_id) values (gen_random_uuid(), $1, $2)', [s.groupId, s.A.id]);
      });
      // Tablo sahibi bile (tetikleyici) eliminasyonu değiştiremez/silemez, grubu silemez, para birimini değiştiremez
      await asOwner(async (q) => {
        expect((await expectDbError(q, 'delete from consolidation_eliminations')).code).toBe('ERP22');
        expect((await expectDbError(q, `update consolidation_eliminations set description = 'x'`)).code).toBe('ERP22');
        expect((await expectDbError(q, 'update consolidation_elimination_lines set debit = 5')).code).toBe('ERP22');
        expect((await expectDbError(q, 'delete from consolidation_elimination_lines')).code).toBe('ERP22');
        expect((await expectDbError(q, 'delete from consolidation_groups')).code).toBe('ERP22');
        expect((await expectDbError(q, `update consolidation_groups set reporting_currency = 'EUR'`)).code).toBe('ERP22');
        expect((await expectDbError(q, `update consolidation_members set member_company_id = group_id`)).code).toBe('ERP22');
        // Denetim izi: grup, üye ve eliminasyon yazımları audit_log'dadır
        const audit = await q(`select table_name, count(*)::int as n from audit_log where table_name like 'consolidation_%' group by 1 order by 1`);
        expect(audit.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['consolidation_groups', 'consolidation_members', 'consolidation_eliminations', 'consolidation_elimination_lines']));
      });
    });

    it('DB düzeyinde: dengesiz eliminasyon işlem sonunda reddedilir; sahibi olmayan üye eklenemez; çalışma zamanı rolü silme yetkisine sahip değil', async () => {
      const s = await seed('Guv7');
      await asOwner(async (q) => {
        await q(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`, [s.u.userId, s.orgId]);
        await q(`insert into consolidation_eliminations (id, group_id, period_from, period_to, description, created_by) values ('00000000-0000-7000-8000-000000000001', $1, '${day(1, 1)}', '${day(12, 31)}', 'Dengesiz', $2)`, [s.groupId, s.u.userId]);
        await q(`insert into consolidation_elimination_lines (id, elimination_id, group_id, line_no, account_code, debit, credit) values (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', $1, 1, '336', 10, 0), (gen_random_uuid(), '00000000-0000-7000-8000-000000000001', $1, 2, '136', 0, 9)`, [s.groupId]);
        // Ertelenmiş kısıt işlem sonunda çalışır: hemen çalıştırınca dengesizlik yakalanır
        const err = await expectDbError(q, 'SET CONSTRAINTS ALL IMMEDIATE');
        expect(err.code).toBe('ERP22');
        expect(err.message).toMatch(/dengesiz/);
      });
      // Başlıksız (satırsız) eliminasyon da reddedilir
      await asOwner(async (q) => {
        await q(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`, [s.u.userId, s.orgId]);
        await q(`insert into consolidation_eliminations (id, group_id, period_from, period_to, description, created_by) values (gen_random_uuid(), $1, '${day(1, 1)}', '${day(12, 31)}', 'Satırsız', $2)`, [s.groupId, s.u.userId]);
        expect((await expectDbError(q, 'SET CONSTRAINTS ALL IMMEDIATE')).code).toBe('ERP22');
      });
      // Aynı sınama API üzerinden: eliminasyon gövdesi dengesizse doğrulama reddeder
      const bad = await s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations`, {
        periodFrom: day(1, 1), periodTo: day(12, 31), description: 'Dengesiz', lines: [{ accountCode: '336', debit: '10' }, { accountCode: '136', credit: '9' }],
      });
      expect(bad.statusCode).toBe(400);
      await asDb(handle, { userId: s.u.userId, orgId: s.orgId }, async (q) => {
        // erp_app: grup/eliminasyon silme yetkisi yok
        await expectDbError(q, 'delete from consolidation_groups');
        await expectDbError(q, 'delete from consolidation_eliminations');
        await expectDbError(q, 'update consolidation_elimination_lines set debit = 1');
      });
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  describe('konsolide mizan ve tablolar', () => {
    it('elle kurla: şirket sütunları, hesap koduna göre birleşme ve dengeli toplam', async () => {
      const s = await seed('Mizan1');
      const res = await rep(s, '&closingRates=GBP:40');
      expect(res.statusCode).toBe(200);
      const r = res.json().report;
      expect(r.complete).toBe(true);
      expect(r.companies.find((c: any) => c.id === s.B.id)).toMatchObject({ baseCurrency: 'GBP', closingRate: '40', closingSource: 'manual', plRate: '40' });
      expect(r.companies.find((c: any) => c.id === s.A.id)).toMatchObject({ closingRate: '1', closingSource: 'identity' });
      const net = (code: string) => rowOf(r, code).consolidated;
      expect(rowOf(r, '100').perCompany).toEqual({ [s.A.id]: '800.0000', [s.B.id]: '18000.0000' });
      expect(net('100')).toBe('18800.0000');
      expect(net('500')).toBe('-21000.0000');
      expect(net('102')).toBe('600.0000');
      expect(net('600')).toBe('-900.0000');
      expect(net('632')).toBe('2500.0000');
      expect(net('136')).toBe('300.0000');
      expect(net('336')).toBe('-300.0000');
      expect(r.totals.consolidated).toBe('0.0000');
      expect(r.totals.translationDiff).toBe('0.0000');
      // Şirket mizanı ile birebir (A: TRY; B: kendi mizanı × kur)
      const tbA = (await s.ca.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
      expect(tbA.rows.find((x: any) => x.code === '100').closing).toBe('800.0000');
      const tbB = (await s.cb.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
      expect(Number(tbB.rows.find((x: any) => x.code === '100').closing) * 40).toBe(18000);
      // Bilanço ve gelir tablosu
      const st = r.statements;
      const bs = (k: string) => st.balanceSheet.find((l: any) => l.key === k).values;
      const is = (k: string) => st.incomeStatement.find((l: any) => l.key === k).values;
      expect(st.difference).toEqual({ [s.A.id]: '0.0000', [s.B.id]: '0.0000', consolidated: '0.0000' });
      expect(bs('assets_total').consolidated).toBe('19700.0000'); // 18800 + 600 + 300
      expect(is('net_sales').consolidated).toBe('900.0000');
      expect(is('net_profit').consolidated).toBe('-1600.0000'); // 900 − 200 − 2300
      expect(r.note).toMatch(/Doğrulanmadı/);
    });

    it('kapanış ve dönem kuru ayrı seçilirse çevrim farkı mizanı dengeler', async () => {
      const s = await seed('Mizan2');
      const r = (await rep(s, '&closingRates=GBP:40&plRates=GBP:38')).json().report;
      expect(rowOf(r, '632').perCompany[s.B.id]).toBe('2185.0000'); // 57.5 × 38
      expect(rowOf(r, '100').perCompany[s.B.id]).toBe('18000.0000');
      expect(r.translationDiff[s.B.id]).toBe('115.0000');
      expect(r.translationDiff[s.A.id]).toBe('0.0000');
      expect(r.totals.consolidated).toBe('0.0000');
      expect(r.statements.difference.consolidated).toBe('0.0000');
    });

    it('kayıtlı kur: kapanış tarihindeki kur, gelir tablosu için dönem ortalaması; kur yoksa 422', async () => {
      const s = await seed('Mizan3');
      const res = await rep(s, `&closingDate=${day(9, 5)}&plMethod=average`);
      expect(res.statusCode).toBe(200);
      const r = res.json().report;
      expect(r.companies.find((c: any) => c.id === s.B.id)).toMatchObject({ closingRate: '42.00000000', closingSource: 'stored', plRate: '40.00000000', plSource: 'average' });
      expect(rowOf(r, '100').perCompany[s.B.id]).toBe('18900.0000'); // 450 × 42
      expect(rowOf(r, '632').perCompany[s.B.id]).toBe('2300.0000'); // 57.5 × 40
      expect(r.translationDiff[s.B.id]).toBe('115.0000');
      expect(r.totals.consolidated).toBe('0.0000');
      const missing = await rep(s, `&closingDate=${day(1, 1)}`);
      expect(missing.statusCode).toBe(422);
      expect(missing.json().error.code).toBe('FX_RATE_MISSING');
    });

    it('eliminasyon: yalnızca konsolide sütunu etkiler; dönem dışı ve iptal edilen uygulanmaz; salt eklenir', async () => {
      const s = await seed('Elim');
      const create = (body: Record<string, unknown>) => s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations`, body);
      const e1 = await create({ periodFrom: day(1, 1), periodTo: day(12, 31), kind: 'intercompany_balance', description: 'A alacağı / B borcu', lines: [{ accountCode: '336', debit: '300' }, { accountCode: '136', credit: '300' }] });
      expect(e1.statusCode).toBe(201);
      const e2 = await create({ periodFrom: day(1, 1), periodTo: day(12, 31), kind: 'intercompany_sales', description: 'Şirketler arası satış', lines: [{ accountCode: '600', debit: '300' }, { accountCode: '632', credit: '300' }] });
      // Dönem dışı (gelecek yıl)
      const e3 = await create({ periodFrom: day(1, 1, thisYear + 1), periodTo: day(12, 31, thisYear + 1), description: 'Gelecek yıl', lines: [{ accountCode: '336', debit: '99' }, { accountCode: '136', credit: '99' }] });
      expect([e2.statusCode, e3.statusCode]).toEqual([201, 201]);
      let r = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(r.eliminations).toHaveLength(2);
      expect(rowOf(r, '136')).toMatchObject({ elimination: '-300.0000', consolidated: '0.0000' });
      expect(rowOf(r, '336')).toMatchObject({ elimination: '300.0000', consolidated: '0.0000' });
      expect(rowOf(r, '600')).toMatchObject({ elimination: '300.0000', consolidated: '-600.0000' });
      expect(rowOf(r, '632')).toMatchObject({ elimination: '-300.0000', consolidated: '2200.0000' });
      expect(rowOf(r, '136').perCompany[s.A.id]).toBe('300.0000'); // şirket sütunu dokunulmaz
      expect(r.totals.elimination).toBe('0.0000');
      expect(r.totals.consolidated).toBe('0.0000');
      expect(r.statements.incomeStatement.find((l: any) => l.key === 'net_profit').values.consolidated).toBe('-1600.0000'); // karşılıklı: değişmez
      expect(r.statements.incomeStatement.find((l: any) => l.key === 'net_sales').values.consolidated).toBe('600.0000');

      // İptal: gerekçe zorunlu, bir kez, uygulanmaz; silme/düzenleme yok
      const eid = e1.json().elimination.id as string;
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations/${eid}/void`, { reason: 'x' })).statusCode).toBe(400);
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations/${eid}/void`, { reason: 'Hatalı tutar' })).statusCode).toBe(200);
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/eliminations/${eid}/void`, { reason: 'Tekrar' })).statusCode).toBe(404);
      r = (await rep(s, '&closingRates=GBP:40')).json().report;
      expect(r.eliminations).toHaveLength(1);
      expect(rowOf(r, '136').consolidated).toBe('300.0000');
      const list = (await s.api.get(`/api/consolidation/groups/${s.groupId}/eliminations`)).json().eliminations as any[];
      expect(list).toHaveLength(3);
      expect(list.find((e) => e.id === eid)).toMatchObject({ voidReason: 'Hatalı tutar' });
      // Dengesiz / tek satırlı reddedilir
      expect((await create({ periodFrom: day(1, 1), periodTo: day(12, 31), description: 'Bozuk', lines: [{ accountCode: '336', debit: '5' }, { accountCode: '136', credit: '4' }] })).statusCode).toBe(400);
      expect((await create({ periodFrom: day(1, 1), periodTo: day(12, 31), description: 'Tek', lines: [{ accountCode: '336', debit: '5' }] })).statusCode).toBe(400);
      // Arşivlenmiş gruba eliminasyon girilemez
      expect((await s.api.patch(`/api/consolidation/groups/${s.groupId}`, { isArchived: true })).statusCode).toBe(200);
      expect((await create({ periodFrom: day(1, 1), periodTo: day(12, 31), description: 'Arşiv', lines: [{ accountCode: '336', debit: '5' }, { accountCode: '136', credit: '5' }] })).statusCode).toBe(422);
    });

    it('hesap kodu eşleme: alt hesap 3 hanede üst koda birleşir; tam kodda yalnızca bir şirkette olan kod eşleşmeyen sayılır', async () => {
      const s = await seed('Esle');
      const sub = await s.ca.post('/api/accounts', { code: '630.001', name: 'Ar-Ge (özel)' });
      expect(sub.statusCode).toBe(201);
      const idsA = await accountIds(app, s.u.token, s.A.id);
      await post(s.ca, idsA, day(5, 5), 'TRY', [['630.001', 'debit', '10'], ['100', 'credit', '10']]);
      const lvl3 = (await rep(s, '&closingRates=GBP:40&mapLevel=3')).json().report;
      expect(rowOf(lvl3, '630')).toMatchObject({ consolidated: '10.0000', unmapped: false });
      expect(rowOf(lvl3, '630.001')).toBeUndefined();
      expect(lvl3.unmapped).toEqual([]);
      const full = (await rep(s, '&closingRates=GBP:40&mapLevel=full')).json().report;
      const row = rowOf(full, '630.001');
      expect(row).toMatchObject({ unmapped: true, consolidated: '10.0000', presentIn: [s.A.id] });
      expect(full.unmapped.map((x: any) => x.code)).toEqual(['630.001']);
      expect(full.totals.consolidated).toBe('0.0000'); // eşleşmeyen kod de toplamdadır
      expect(rowOf(full, '100').unmapped).toBe(false);
    });

    it('şirketler arası ipucu: vergi numarası eşleşen cari listelenir (yalnızca ipucu)', async () => {
      const s = await seed('Ipucu');
      const p = await s.ca.post('/api/parties', { name: 'B Ltd (kardeş)', kind: 'customer', taxNumber: '2222222222' });
      expect(p.statusCode).toBe(201);
      await s.ca.post('/api/parties', { name: 'Başka müşteri', kind: 'customer', taxNumber: '9999999999' });
      const h = (await s.api.get(`/api/consolidation/groups/${s.groupId}/intercompany-hints?asOf=${day(12, 31)}`)).json();
      expect(h.hints).toHaveLength(1);
      expect(h.hints[0]).toMatchObject({ company: { id: s.A.id }, matchedCompany: { id: s.B.id }, party: { name: 'B Ltd (kardeş)' }, receivable: '0.0000', payable: '0.0000' });
    });

    it('üye ekleme/çıkarma ve mükerrer koruması; arşiv', async () => {
      const s = await seed('Uye');
      const C = await createCompany(app, s.u.token, { name: 'Üçüncü' });
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id })).statusCode).toBe(201);
      expect((await s.api.post(`/api/consolidation/groups/${s.groupId}/members`, { companyId: C.id })).statusCode).toBe(409);
      expect((await s.api.delete(`/api/consolidation/groups/${s.groupId}/members/${C.id}`)).statusCode).toBe(200);
      expect((await s.api.delete(`/api/consolidation/groups/${s.groupId}/members/${C.id}`)).statusCode).toBe(404);
      expect((await s.api.post('/api/consolidation/groups', { name: `${'Uye'} Grubu`, reportingCurrency: 'TRY', companyIds: [s.A.id] })).statusCode).toBe(409);
      expect((await s.api.post('/api/consolidation/groups', { name: 'Tekrar', reportingCurrency: 'XXX', companyIds: [s.A.id] })).statusCode).toBe(400);
      expect((await s.api.post('/api/consolidation/groups', { name: 'Boş', reportingCurrency: 'TRY', companyIds: [] })).statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  describe('döviz pozisyonu', () => {
    async function fxSeed(name: string) {
      const u = await registerUser(app, name);
      const A = await createCompany(app, u.token, { name: `${name} TRY Ltd`, baseCurrency: 'TRY' });
      const c = client(app, u.token, A.id);
      const ids = await accountIds(app, u.token, A.id);
      const usd = await c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB USD', currency: 'USD' });
      expect(usd.statusCode).toBe(201);
      const eur = await c.post('/api/treasury/accounts', { kind: 'cash', name: 'EUR kasa', currency: 'EUR' });
      const fund = async (accountId: string, amount: string, fxRate: string) => {
        const r = await c.post('/api/treasury/transactions', { type: 'other_receipt', date: day(2, 1), accountId, amount, glAccountId: ids['500'], fxRate });
        if (r.statusCode !== 201) throw new Error(r.body);
      };
      await fund(usd.json().account.id, '1000', '30');
      await fund(eur.json().account.id, '200', '33');
      const cust = (await c.post('/api/parties', { name: 'Dış müşteri', kind: 'customer' })).json().party.id as string;
      const sup = (await c.post('/api/parties', { name: 'Dış tedarikçi', kind: 'supplier' })).json().party.id as string;
      const inv = await c.post('/api/invoices', { post: true, type: 'sales', partyId: cust, invoiceDate: day(3, 1), currency: 'USD', fxRate: '32', lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '500' }] });
      expect(inv.statusCode).toBe(201);
      const exp = await c.post('/api/invoices', { post: true, type: 'expense', partyId: sup, invoiceDate: day(3, 5), externalNo: 'G-1', currency: 'USD', fxRate: '31', lines: [{ description: 'Gider', quantity: '1', unitPrice: '200' }] });
      expect(exp.statusCode).toBe(201);
      for (const [cur, d, r] of [['USD', day(12, 30), '35'], ['EUR', day(12, 30), '38']] as const) await c.put('/api/exchange-rates', { rateDate: d, currencyCode: cur, quoteCode: 'TRY', buy: r });
      return { u, A, c, ids, usdId: usd.json().account.id as string, cust, sup };
    }

    it('net pozisyon ve tahmini kur farkı; rakamlar kasa/banka bakiyesi ve cari açık kalemleriyle mutabık', async () => {
      const f = await fxSeed('Fx1');
      const res = await f.c.get(`/api/reports/fx-position?asOf=${day(12, 31)}`);
      expect(res.statusCode).toBe(200);
      const d = res.json().report;
      const usd = d.rows.find((r: any) => r.currency === 'USD');
      // Bağımsız kaynaklar: banka hesabı bakiyesi + cari açık kalemler (API)
      const bank = (await f.c.get(`/api/treasury/accounts/${f.usdId}`)).json().account;
      const rec = (await f.c.get(`/api/parties/${f.cust}/open-items?asOf=${day(12, 31)}&type=receivable`)).json().receivable.items as any[];
      const pay = (await f.c.get(`/api/parties/${f.sup}/open-items?asOf=${day(12, 31)}&type=payable`)).json().payable.items as any[];
      const recDoc = rec.reduce((s, i) => s + Number(i.remaining), 0);
      const payDoc = pay.reduce((s, i) => s + Number(i.remaining), 0);
      const recBase = rec.reduce((s, i) => s + Number(i.remainingBase), 0);
      const payBase = pay.reduce((s, i) => s + Number(i.remainingBase), 0);
      expect(Number(usd.cash)).toBe(Number(bank.balance));
      expect(Number(usd.receivables)).toBeCloseTo(recDoc, 4);
      expect(Number(usd.payables)).toBeCloseTo(payDoc, 4);
      expect(recDoc).toBeGreaterThan(0);
      expect(payDoc).toBeGreaterThan(0);
      const net = Number(bank.balance) + recDoc - payDoc;
      expect(Number(usd.net)).toBeCloseTo(net, 4);
      const book = Number(bank.balanceBase) + recBase - payBase;
      expect(Number(usd.bookNet)).toBeCloseTo(book, 2);
      expect(usd.rate).toBe('35.00000000');
      expect(Number(usd.equivalent)).toBeCloseTo(net * 35, 2);
      expect(Number(usd.unrealized)).toBeCloseTo(net * 35 - book, 2);
      const eur = d.rows.find((r: any) => r.currency === 'EUR');
      expect(eur).toMatchObject({ cash: '200.0000', net: '200.0000', bookNet: '6600.0000', equivalent: '7600.0000', unrealized: '1000.0000' });
      expect(d.totals.equivalent).toBe((Number(usd.equivalent) + 7600).toFixed(4));
      // Gerçekleşmiş kambiyo raporuyla aynı kaynak
      const fxr = (await f.c.get(`/api/reports/fx-differences?from=${day(1, 1)}&to=${day(12, 31)}`)).json().totals;
      expect(d.realized).toMatchObject({ gain: fxr.gain, loss: fxr.loss, net: fxr.net });
      // Yevmiye yazılmaz
      expect((await f.c.get('/api/journal-entries')).json().entries.every((e: any) => e.description !== 'Kur değerleme')).toBe(true);
    });

    it('kullanıcı kuru: elle kur ve kur tarihi; kur yoksa karşılık null', async () => {
      const f = await fxSeed('Fx2');
      const manual = (await f.c.get(`/api/reports/fx-position?asOf=${day(12, 31)}&rates=USD:40,EUR:36`)).json().report;
      expect(manual.rows.find((r: any) => r.currency === 'EUR')).toMatchObject({ rate: '36', equivalent: '7200.0000', unrealized: '600.0000' });
      expect(manual.rows.find((r: any) => r.currency === 'USD').rate).toBe('40');
      // Kur tarihi çok eski: kayıtlı kur bulunamaz
      const old = (await f.c.get(`/api/reports/fx-position?asOf=${day(12, 31)}&rateDate=${day(1, 1)}`)).json().report;
      expect(old.rows.every((r: any) => r.equivalent === null && r.unrealized === null)).toBe(true);
      expect(old.totals).toBeNull();
      // Daha önceki tarihte kasa bakiyesi yok
      const early = (await f.c.get(`/api/reports/fx-position?asOf=${day(1, 15)}&rates=USD:40`)).json().report;
      expect(early.rows).toEqual([]);
    });

    it('grup: para birimi başına toplam, her şirketin kendi para birimi pozisyon sayılmaz; şirket bazında dökümle toplanır', async () => {
      const f = await fxSeed('Fx3');
      // İkinci şirket: GBP defter para birimi, USD kasası; GBP/TRY ve USD/GBP kurları
      const B = await createCompany(app, f.u.token, { name: 'Fx3 GBP Ltd', baseCurrency: 'GBP' });
      const cb = client(app, f.u.token, B.id);
      const ib = await accountIds(app, f.u.token, B.id);
      const cashB = await cb.post('/api/treasury/accounts', { kind: 'cash', name: 'USD kasa', currency: 'USD' });
      await cb.put('/api/exchange-rates', { rateDate: day(12, 30), currencyCode: 'USD', quoteCode: 'GBP', buy: '0.8' });
      await cb.put('/api/exchange-rates', { rateDate: day(12, 30), currencyCode: 'GBP', quoteCode: 'TRY', buy: '44' });
      await cb.put('/api/exchange-rates', { rateDate: day(12, 30), currencyCode: 'USD', quoteCode: 'TRY', buy: '35' });
      const r = await cb.post('/api/treasury/transactions', { type: 'other_receipt', date: day(2, 1), accountId: cashB.json().account.id, amount: '100', glAccountId: ib['500'], fxRate: '0.7' });
      expect(r.statusCode).toBe(201);
      const g = await client(app, f.u.token).post('/api/consolidation/groups', { name: 'Fx3 Grubu', reportingCurrency: 'TRY', companyIds: [f.A.id, B.id] });
      expect(g.statusCode).toBe(201);
      const gid = g.json().group.id as string;
      const rep2 = (await client(app, f.u.token).get(`/api/consolidation/groups/${gid}/fx-position?asOf=${day(12, 31)}`)).json().report;
      const single = (await f.c.get(`/api/reports/fx-position?asOf=${day(12, 31)}`)).json().report;
      const usdA = single.rows.find((x: any) => x.currency === 'USD');
      const usdG = rep2.rows.find((x: any) => x.currency === 'USD');
      expect(usdG.companies).toBe(2);
      expect(Number(usdG.net)).toBeCloseTo(Number(usdA.net) + 100, 4);
      expect(Number(usdG.cash)).toBeCloseTo(Number(usdA.cash) + 100, 4);
      // Grup karşılığı: her şirketin kendi kayıtlı USD/TRY kuru (35)
      expect(Number(usdG.equivalent)).toBeCloseTo((Number(usdA.net) + 100) * 35, 2);
      // Gerçekleşmemiş tahmin: A (TRY) tahmini + B (GBP) tahmini × GBP/TRY
      const bPos = rep2.perCompany.find((c: any) => c.company.id === B.id).rows.find((x: any) => x.currency === 'USD');
      expect(bPos).toMatchObject({ net: '100.0000', bookNet: '70.0000', equivalent: '80.0000', unrealized: '10.0000' });
      expect(Number(usdG.unrealized)).toBeCloseTo(Number(usdA.unrealized) + 10 * 44, 2);
      // EUR yalnızca A'da
      expect(rep2.rows.find((x: any) => x.currency === 'EUR').companies).toBe(1);
      // Grup elle kuru (USD→TRY)
      const man = (await client(app, f.u.token).get(`/api/consolidation/groups/${gid}/fx-position?asOf=${day(12, 31)}&rates=USD:40`)).json().report;
      expect(Number(man.rows.find((x: any) => x.currency === 'USD').equivalent)).toBeCloseTo((Number(usdA.net) + 100) * 40, 2);
    });

    it('izin: reports.read olmayan rol 403; modül kapalıysa 403', async () => {
      const f = await fxSeed('Fx4');
      const sales = await f.c.post('/api/company/members', { email: `s-${Date.now()}@example.com`, fullName: 'Selin Kişi', role: 'sales', password: PASSWORD, mustChangePassword: false });
      const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: sales.json().member.email, password: PASSWORD } })).json().accessToken as string;
      expect((await client(app, tok, f.A.id).get(`/api/reports/fx-position?asOf=${day(12, 31)}`)).statusCode).toBe(403);
      expect((await client(app, tok, f.A.id).get(`/api/exports/fx-position?asOf=${day(12, 31)}`)).statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  describe('yönetici özeti', () => {
    async function execSeed(name: string) {
      const s = await seed(name);
      // A'ya ek: banka dövizi yok; müşteri faturası (cari yaşlandırma) ve personel
      const cust = (await s.ca.post('/api/parties', { name: 'Büyük Müşteri', kind: 'customer' })).json().party.id as string;
      const inv = await s.ca.post('/api/invoices', { post: true, type: 'sales', partyId: cust, invoiceDate: day(5, 1), dueDate: day(6, 1), lines: [{ description: 'Hizmet', quantity: '1', unitPrice: '1000' }] });
      expect(inv.statusCode).toBe(201);
      const emp = await s.ca.post('/api/employees', { fullName: 'Aylin Personel', hireDate: day(2, 1) });
      expect(emp.statusCode).toBe(201);
      return { ...s, cust };
    }
    const exec = async (c: Cl, qs = '') => c.get(`/api/reports/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}${qs}`);

    it('gelir, gider, kâr, nakit, alacak yaşlandırma, stok, en büyük müşteri, İK özeti; rakamlar mizanla mutabık', async () => {
      const s = await execSeed('Ozet1');
      const res = await exec(s.ca, '&compare=none');
      expect(res.statusCode).toBe(200);
      const d = res.json().report;
      const tb = (await s.ca.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`)).json();
      const sumCode = (prefix: string, f: 'debit' | 'credit') => tb.rows.filter((r: any) => r.isPostable && r.code.startsWith(prefix)).reduce((a: number, r: any) => a + Number(r[f]), 0);
      const sales = sumCode('60', 'credit') - sumCode('60', 'debit');
      expect(Number(d.income.current.netSales)).toBeCloseTo(sales, 4);
      expect(Number(d.income.current.expenses)).toBeCloseTo(sumCode('63', 'debit') + sumCode('62', 'debit'), 4);
      expect(Number(d.income.current.profit)).toBeCloseTo(Number(d.income.current.revenue) - Number(d.income.current.expenses), 4);
      expect(d.income.previous).toBeNull();
      expect(d.compare).toBeNull();
      // Alacak: fatura (KDV dahil) açık; vadesi geçmiş
      const aging = (await s.ca.get(`/api/reports/party-aging?type=receivable&asOf=${day(12, 31)}`)).json();
      void aging;
      expect(Number(d.receivables.total)).toBeGreaterThan(0);
      expect(Number(d.receivables.overdue)).toBeCloseTo(Number(d.receivables.total), 4);
      expect(d.topCustomers[0]).toMatchObject({ name: 'Büyük Müşteri', net: '1000.0000' });
      expect(d.cash.total).toBe('0.0000');
      expect(d.hr).toMatchObject({ headcount: 1, hires: 1, leavers: 0 });
      expect(d.hr.payroll).toMatchObject({ months: 0 });
      expect(d.projects).toMatchObject({ count: 0 });
      expect(d.stock).toMatchObject({ stockValue: '0.0000' });
      expect(d.kpis.current.overdueReceivablesPct).toBe('100.00');
      expect(d.kpis.current.grossMarginPct).not.toBeNull();
      expect(d.income.currentAssets).not.toBeUndefined();
    });

    it('dönem karşılaştırması: önceki dönem ve geçen yıl aynı günler', async () => {
      const s = await execSeed('Ozet2');
      // Yılın ilk yarısı (1/1–6/30) ile önceki dönem (önceki 181 gün): ocak–haziran satışları
      const r = (await s.ca.get(`/api/reports/executive-summary?from=${day(7, 1)}&to=${day(12, 31)}&compare=previous`)).json().report;
      expect(r.compare.to).toBe(day(6, 30));
      expect(Number(r.income.previous.netSales)).toBe(1900); // 600 + 300 + 1000
      expect(Number(r.income.current.netSales)).toBe(0);
      expect(r.income.change.revenue).toBe('-100.00');
      const ly = (await s.ca.get(`/api/reports/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}&compare=last_year`)).json().report;
      expect(ly.compare).toEqual({ from: day(1, 1, thisYear - 1), to: day(12, 31, thisYear - 1) });
      expect(Number(ly.income.previous.netSales)).toBe(0);
      expect(ly.income.change.revenue).toBeNull();
    });

    it('bölümler izin ve modüle göre ÇIKARILIR (sıfırlanmaz): izleyici İK/bordro görmez, kapalı modül bölümü kalkar', async () => {
      const s = await execSeed('Ozet3');
      const login = async (role: string) => {
        const m = await s.ca.post('/api/company/members', { email: `${role}-${Date.now()}@example.com`, fullName: `${role} Kişi`, role, password: PASSWORD, mustChangePassword: false });
        const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.json().member.email, password: PASSWORD } })).json().accessToken as string;
        return client(app, tok, s.A.id);
      };
      const viewer = await login('viewer');
      const dv = (await exec(viewer)).json().report;
      expect(dv.income).toBeDefined();
      expect(dv.cash).toBeDefined();
      expect('hr' in dv).toBe(false);
      expect('payroll' in dv).toBe(false);
      const acc = await login('accountant');
      const da = (await exec(acc)).json().report;
      expect(da.hr.payroll).toBeDefined();
      expect('projects' in da).toBe(true);
      // Satış rolü reports.read'e sahip değil
      expect((await exec(await login('sales'))).statusCode).toBe(403);
      // Modüller: stok ve bordro kapatılır
      for (const k of ['invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports', 'core.invoices', 'core.inventory', 'hr.socialsecurity', 'hr.employee_ledger', 'hr.payroll']) {
        expect((await s.ca.put(`/api/company/modules/${k}`, { enabled: false })).statusCode, k).toBe(200);
      }
      const dOff = (await exec(s.ca)).json().report;
      expect('stock' in dOff).toBe(false);
      expect('topCustomers' in dOff).toBe(false);
      expect(dOff.receivables).toBeDefined();
      expect('hr' in dOff).toBe(true);
      expect(dOff.hr.payroll).toBeUndefined();
      // Ticari sektör: proje bölümü yok
      const u2 = await registerUser(app, 'Ozet3b');
      const K = await createCompany(app, u2.token, { sector: 'COMMERCE', name: 'Ticaret' });
      const dk = (await exec(client(app, u2.token, K.id))).json().report;
      expect('projects' in dk).toBe(false);
      expect(dk.income).toBeDefined();
      // Yönetici özeti modülü kapalıysa uç 403
      expect((await s.ca.put('/api/company/modules/reports.executive', { enabled: false })).statusCode).toBe(200);
      expect((await exec(s.ca)).statusCode).toBe(403);
    });

    it('grup özeti: şirketler grup para birimine çevrilip toplanır; kur yoksa 422; bölümler yalnızca görünür şirketlerden', async () => {
      const s = await execSeed('Ozet4');
      const res = await s.api.get(`/api/consolidation/groups/${s.groupId}/executive-summary?from=${day(1, 1)}&to=${day(12, 31)}&compare=none&rates=GBP:40`);
      expect(res.statusCode).toBe(200);
      const g = res.json().report;
      const a = (await exec(s.ca, '&compare=none')).json().report;
      const b = (await exec(s.cb, '&compare=none')).json().report;
      expect(g.scope).toMatchObject({ kind: 'group', currency: 'TRY', companies: 2 });
      expect(Number(g.income.current.netSales)).toBeCloseTo(Number(a.income.current.netSales) + Number(b.income.current.netSales) * 40, 2);
      expect(Number(g.income.current.expenses)).toBeCloseTo(Number(a.income.current.expenses) + Number(b.income.current.expenses) * 40, 2);
      expect(Number(g.receivables.total)).toBeCloseTo(Number(a.receivables.total), 2);
      expect(g.sectionCompanies.income).toBe(2);
      expect(g.complete).toBe(true);
      expect(g.note).toMatch(/ELENMEZ/);
      const miss = await s.api.get(`/api/consolidation/groups/${s.groupId}/executive-summary?from=${day(1, 1)}&to=${day(1, 5)}`);
      expect(miss.statusCode).toBe(422);
      expect(miss.json().error.code).toBe('FX_RATE_MISSING');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------------
  describe('dışa aktarma', () => {
    it('grup konsolide xlsx/csv ve şirket düzeyi dışa aktarmalar ekrandaki rakamlarla aynıdır', async () => {
      const s = await seed('Disa');
      const q = `from=${day(1, 1)}&to=${day(12, 31)}&closingRates=GBP:40`;
      const csv = await s.api.get(`/api/consolidation/groups/${s.groupId}/export/consolidated?format=csv&${q}`);
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-disposition']).toContain('konsolide-');
      expect(csv.headers['cache-control']).toBe('no-store');
      expect(csv.body).toContain('Konsolide');
      expect(csv.body).toContain('18.800,00');
      expect(csv.body).toContain('DOĞRULANMADI');
      const xlsx = await s.api.get(`/api/consolidation/groups/${s.groupId}/export/consolidated?format=xlsx&${q}`);
      expect(xlsx.statusCode).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
      const fx = await s.api.get(`/api/consolidation/groups/${s.groupId}/export/fx-position?format=csv&asOf=${day(12, 31)}`);
      expect(fx.statusCode).toBe(200);
      const ex = await s.api.get(`/api/consolidation/groups/${s.groupId}/export/executive-summary?format=csv&from=${day(1, 1)}&to=${day(12, 31)}&compare=none&rates=GBP:40`);
      expect(ex.statusCode).toBe(200);
      expect(ex.body).toContain('Net satışlar');
      expect((await s.api.get(`/api/consolidation/groups/${s.groupId}/export/bilinmeyen`)).statusCode).toBe(400);
      // Şirket düzeyi
      expect((await s.ca.get(`/api/exports/executive-summary?format=xlsx&from=${day(1, 1)}&to=${day(12, 31)}`)).statusCode).toBe(200);
      const fxc = await s.ca.get(`/api/exports/fx-position?format=csv&asOf=${day(12, 31)}`);
      expect(fxc.statusCode).toBe(200);
      expect(fxc.body).toContain('Para birimi');
    });
  });

  it('konsolidasyon izni yalnızca sahip ve yönetici rollerindedir; menü yalnızca onlara gösterir', async () => {
    const s = await seed('Menu');
    const nav = async (c: Cl) => (await c.get('/api/navigation')).json();
    const owner = await nav(s.ca);
    expect(owner.permissions).toContain('reports.consolidation');
    const keys = owner.groups.flatMap((g: any) => g.items.map((i: any) => i.key));
    expect(keys).toEqual(expect.arrayContaining(['consolidation', 'executive-summary', 'report-fx-position']));
    const acc = await s.ca.post('/api/company/members', { email: `acc-${Date.now()}@example.com`, fullName: 'Ayşe Kişi', role: 'accountant', password: PASSWORD, mustChangePassword: false });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: acc.json().member.email, password: PASSWORD } })).json().accessToken as string;
    const an = await nav(client(app, tok, s.A.id));
    expect(an.permissions).not.toContain('reports.consolidation');
    expect(an.groups.flatMap((g: any) => g.items.map((i: any) => i.key))).not.toContain('consolidation');
    expect(an.groups.flatMap((g: any) => g.items.map((i: any) => i.key))).toContain('executive-summary');
  });
});
