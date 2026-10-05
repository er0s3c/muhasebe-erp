import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ACCESS_AREA_KEYS, effectivePermissions, ROLE_PERMISSIONS, todayIso, type AccessAreaKey, type Role } from '@erp/shared';
import { withContext } from '../src/db/client';
import { decide, requestApproval, registerApprovalHandler } from '../src/modules/approvals/service';
import { readXlsx } from '../src/files/xlsx-read';
import { scanCompany } from '../src/modules/notifications/scan';
import { addMember, asDb, client, createCompany, execAsOwner, expectDbError, makeApp, orgOf, registerUser, PASSWORD } from './helpers';

/**
 * Kullanıcı bazlı modül erişimi: sahip/yönetici her üye için her alanda "Erişim yok / Sadece görüntüle / Görüntüle ve düzenle" seçer.
 * Bu dosya ADVERSARIAL: API davranışı (okuma/yazma, hata kodları), menü, rütbe kuralları, rol-bağlı izinler, RLS, denetim izi, anında etki,
 * dışa aktarma, bildirim, onay ve rol değişimi.
 */
type C = ReturnType<typeof client>;

/** Alan → (okuma ucu, yazma ucu). Yazma ucu boş gövdeyle çağrılır: izin varsa doğrulama hatası (400/422), yoksa 403 (kapı doğrulamadan önce çalışır). */
const ENDPOINTS: Record<string, { area: AccessAreaKey; get: string; post: string }> = {
  ledger: { area: 'core.ledger', get: '/api/journal-entries', post: '/api/journal-entries' },
  parties: { area: 'core.parties', get: '/api/parties', post: '/api/parties' },
  inventory: { area: 'core.inventory', get: '/api/items', post: '/api/items' },
  invoices: { area: 'core.invoices', get: '/api/invoices', post: '/api/invoices' },
  treasury: { area: 'core.treasury', get: '/api/treasury/accounts', post: '/api/treasury/accounts' },
  projects: { area: 'construction.projects', get: '/api/projects', post: '/api/projects' },
  subcontracts: { area: 'construction.subcontracts', get: '/api/subcontracts', post: '/api/subcontracts' },
  hr: { area: 'hr.core', get: '/api/employees', post: '/api/employees' },
  payroll: { area: 'hr.payroll', get: '/api/payroll/runs', post: '/api/payroll/runs' },
  directory: { area: 'core.directory', get: '/api/directory/contacts', post: '/api/directory/contacts' },
};

describe('kullanıcı bazlı modül erişimi', async () => {
  const { app, handle } = await makeApp();
  registerApprovalHandler('progress_payment', { onResolved: async () => undefined });

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => {
    const res = await p;
    if (res.statusCode !== status) throw new Error(`beklenen ${status}, gelen ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  async function world(name: string, sector = 'CONSTRUCTION') {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { sector });
    const owner = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const m = {
      admin: await addMember(app, owner, company.id, 'admin'),
      admin2: await addMember(app, owner, company.id, 'admin', 'admin2'),
      accountant: await addMember(app, owner, company.id, 'accountant'),
      sales: await addMember(app, owner, company.id, 'sales'),
      site: await addMember(app, owner, company.id, 'site_manager'),
      viewer: await addMember(app, owner, company.id, 'viewer'),
    };
    const set = (who: { userId: string }, levels: Record<string, string>, by: C = owner) => by.put(`/api/company/members/${who.userId}/module-access`, { levels });
    const get = (who: { userId: string }, by: C = owner) => by.get(`/api/company/members/${who.userId}/module-access`);
    const dump = async (userId: string) => (await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, (q) => q(`select module_key, level from member_module_access where user_id = $1 order by 1`, [userId]))).rows;
    return { s, company, owner, orgId, m, set, get, dump };
  }

  const denial = (res: { statusCode: number; json: () => any }) => (res.statusCode === 403 ? (res.json().error.code as string) : null);

  // -------------------------------------------------------------------------------------------------------------------
  describe('düzey matrisi (API)', () => {
    const levels = ['none', 'read', 'write'] as const;
    for (const role of ['viewer', 'accountant', 'sales', 'site', 'admin'] as const) {
      it(`${role}: her alan × her düzey için okuma/yazma ucu doğru yanıt verir`, async () => {
        const w = await world(`Mat${role}`);
        const who = w.m[role];
        for (const [name, e] of Object.entries(ENDPOINTS)) {
          for (const level of levels) {
            await ok(w.set(who, { [e.area]: level }));
            const g = await who.client.get(e.get);
            const p = await who.client.post(e.post, {});
            const label = `${role}/${name}/${level}`;
            if (level === 'none') {
              expect(denial(g), `${label} GET`).toBe('MODULE_ACCESS_DENIED');
              expect(denial(p), `${label} POST`).toBe('MODULE_ACCESS_DENIED');
              expect(g.json().error.message, label).toBe('Bu modüle erişiminiz yönetici tarafından kapatıldı');
            } else if (level === 'read') {
              expect(g.statusCode, `${label} GET ${g.body}`).toBe(200);
              expect(denial(p), `${label} POST`).toBe('MODULE_READ_ONLY');
            } else {
              expect(g.statusCode, `${label} GET ${g.body}`).toBe(200);
              expect([400, 422], `${label} POST ${p.statusCode} ${p.body}`).toContain(p.statusCode);
            }
          }
          await ok(w.set(who, { [e.area]: 'default' }));
        }
      }, 120_000);
    }

    it('görüntüleyici tek modülde düzenleyiciye terfi eder (gerçek kayıt oluşturur); diğer modüllere dokunmaz', async () => {
      const w = await world('Terfi');
      const v = w.m.viewer;
      expect((await v.client.post('/api/parties', { name: 'Müşteri', kind: 'customer' })).statusCode).toBe(403);
      await ok(w.set(v, { 'core.parties': 'write' }));
      const created = await ok(v.client.post('/api/parties', { name: 'Müşteri Ltd.', kind: 'customer' }), 201);
      expect(created.party.name).toBe('Müşteri Ltd.');
      expect(denial(await v.client.post('/api/items', {}))).toBe('FORBIDDEN');
      expect(denial(await v.client.post('/api/treasury/accounts', {}))).toBe('FORBIDDEN');
      // Rol varsayılanında zaten olmayan yazma izni için olağan 403 (istisna sebebi değil)
      expect((await v.client.post('/api/items', {})).json().error.message).toBe('Bu işlem için yetkiniz yok');
    });

    it('muhasebeci "sadece görüntüle"ye indirilir; satış "erişim yok"; istisna olmayanlar etkilenmez', async () => {
      const w = await world('Indir');
      await ok(w.set(w.m.accountant, { 'core.invoices': 'read', 'core.treasury': 'read' }));
      await ok(w.set(w.m.sales, { 'core.parties': 'none' }));
      expect((await w.m.accountant.client.get('/api/invoices')).statusCode).toBe(200);
      expect(denial(await w.m.accountant.client.post('/api/invoices', {}))).toBe('MODULE_READ_ONLY');
      expect(denial(await w.m.accountant.client.post('/api/treasury/accounts', {}))).toBe('MODULE_READ_ONLY');
      expect([400, 422]).toContain((await w.m.accountant.client.post('/api/parties', {})).statusCode); // cari etkilenmedi
      expect(denial(await w.m.sales.client.get('/api/parties'))).toBe('MODULE_ACCESS_DENIED');
      expect((await w.m.sales.client.get('/api/invoices')).statusCode).toBe(200);
      // İstisnasız roller bugünkü gibi
      expect((await w.m.viewer.client.get('/api/invoices')).statusCode).toBe(200);
      expect((await w.owner.get('/api/parties')).statusCode).toBe(200);
    });

    it('fatura gövdesindeki "muhasebeleştir" bayrağı da etkin izne bakar (read düzeyinde reddedilir)', async () => {
      const w = await world('Bayrak');
      await ok(w.set(w.m.accountant, { 'core.invoices': 'read' }));
      // Okuma düzeyinde uç zaten 403; yazma düzeyine alınıp bayrak denendiğinde invoices.post vardır (yazma dahil)
      await ok(w.set(w.m.sales, { 'core.invoices': 'write' }));
      const res = await w.m.sales.client.post('/api/invoices', { post: true });
      expect([400, 422]).toContain(res.statusCode); // doğrulama (tür/cari yok) — 403 değil: yazma düzeyi invoices.post verir
      // Satış varsayılanda invoices.post taşımaz: bayraklı istek tam gövdeyle 403 olurdu; burada izin kümesi kanıtlanır
      await ok(w.set(w.m.sales, { 'core.invoices': 'default' }));
      expect((await w.m.sales.client.get('/api/me/access')).json().permissions).not.toContain('invoices.post');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('menü ve /api/me/access', () => {
    it('menüden modül düşer, "sadece görüntüle"de kalır; izinler etkin kümedir; moduleAccess özel seçimi gösterir', async () => {
      const w = await world('Menu');
      const keys = async (c: C) => {
        const nav = (await ok(c.get('/api/navigation'))) as { groups: { items: { key: string }[] }[]; permissions: string[]; moduleAccess: Record<string, string> };
        return { items: nav.groups.flatMap((g) => g.items.map((i) => i.key)), perms: nav.permissions, access: nav.moduleAccess };
      };
      const before = await keys(w.m.accountant.client);
      expect(before.items).toContain('sales-invoices');
      expect(before.items).toContain('treasury-accounts');
      expect(before.access).toEqual({});

      await ok(w.set(w.m.accountant, { 'core.invoices': 'none', 'core.treasury': 'read' }));
      const after = await keys(w.m.accountant.client);
      expect(after.items).not.toContain('sales-invoices');
      expect(after.items).not.toContain('sales-delivery-notes');
      expect(after.items).not.toContain('sales-quotes'); // invoices.orders aynı alan
      expect(after.items).not.toContain('report-sales');
      expect(after.items).toContain('treasury-accounts');
      expect(after.items).toContain('cheques'); // treasury.cheques alanı: read
      expect(after.perms).not.toContain('invoices.read');
      expect(after.perms).toContain('treasury.read');
      expect(after.perms).not.toContain('treasury.post');
      expect(after.access).toEqual({ 'core.invoices': 'none', 'core.treasury': 'read' });

      const me = await ok(w.m.accountant.client.get('/api/me/access'));
      const inv = me.areas.find((a: any) => a.key === 'core.invoices');
      expect(inv).toMatchObject({ level: 'none', custom: 'none', roleDefault: 'write' });
      expect(me.areas.find((a: any) => a.key === 'core.treasury')).toMatchObject({ level: 'read', custom: 'read', roleDefault: 'write' });
      expect(me.permissions).toEqual(after.perms);
      // Sahip: hiç kısıtlanmaz
      expect((await keys(w.owner)).items).toContain('sales-invoices');
    });

    it('çekirdek ekranlar (genel bakış, ayarlar) hiçbir istisnayla kapanmaz; bildirimler ve oturum uçları çalışır', async () => {
      const w = await world('Cekirdek');
      await ok(w.set(w.m.viewer, Object.fromEntries(ACCESS_AREA_KEYS.map((k) => [k, 'none']))));
      const nav = await ok(w.m.viewer.client.get('/api/navigation'));
      const items = nav.groups.flatMap((g: any) => g.items.map((i: any) => i.key));
      expect(items).toContain('dashboard');
      expect(items).toContain('notifications');
      expect(items).not.toContain('parties');
      expect((await w.m.viewer.client.get('/api/notifications')).statusCode).toBe(200);
      expect((await w.m.viewer.client.get('/api/me/access')).statusCode).toBe(200);
      expect((await w.m.viewer.client.get('/api/company')).statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rol-bağlı izinler asla verilmez / hassas veri', () => {
    it('her alanda "görüntüle ve düzenle" verilse bile rol-bağlı izinler gelmez (görüntüleyici, satış, şantiye, muhasebeci)', async () => {
      const w = await world('Bagli');
      const all = Object.fromEntries(ACCESS_AREA_KEYS.map((k) => [k, 'write']));
      for (const role of ['viewer', 'sales', 'site', 'accountant'] as const) {
        await ok(w.set(w.m[role], all));
        const perms: string[] = (await ok(w.m[role].client.get('/api/me/access'))).permissions;
        for (const p of ['hr.sensitive', 'ledger.yearend', 'reports.consolidation', 'company.manage', 'members.manage', 'privacy.manage', 'settings.manage']) {
          expect(perms, `${role}: ${p}`).not.toContain(p);
        }
        const c = w.m[role].client;
        expect((await c.post('/api/employees/00000000-0000-4000-8000-000000000001/reveal', { field: 'idNumber', reason: 'deneme gerekçesi' })).statusCode).toBe(403);
        expect((await c.patch('/api/company', { name: 'Ele geçirildi' })).statusCode).toBe(403);
        expect((await c.get('/api/company/members')).statusCode).toBe(403);
        expect((await c.put(`/api/company/members/${w.m.viewer.userId}/module-access`, { levels: { 'core.parties': 'none' } })).statusCode).toBe(403);
        expect((await c.get('/api/privacy/access-log')).statusCode).toBe(403);
      }
      // Rol varsayılanı korunur: muhasebeci hâlâ ücret dışı kalemleri göremez gibi bir kayıp yok; yalnızca verilenler eklendi
      expect(effectivePermissions('accountant', all as Record<string, 'write'>).has('hr.sensitive')).toBe(false);
    });

    it('yönetici: personel alanı "erişim yok" iken hr.sensitive ve privacy.manage bastırılır; "sadece görüntüle"de hassas görme korunur ama yazma gider', async () => {
      const w = await world('Hassas');
      const perms = async () => ((await ok(w.m.admin.client.get('/api/me/access'))).permissions as string[]);
      expect(await perms()).toEqual(expect.arrayContaining(['hr.sensitive', 'privacy.manage', 'hr.manage']));
      await ok(w.set(w.m.admin, { 'hr.core': 'read' }));
      const readOnly = await perms();
      expect(readOnly).toContain('hr.sensitive');
      expect(readOnly).toContain('hr.read');
      expect(readOnly).not.toContain('privacy.manage');
      expect(readOnly).not.toContain('hr.manage');
      await ok(w.set(w.m.admin, { 'hr.core': 'none' }));
      const none = await perms();
      for (const p of ['hr.sensitive', 'privacy.manage', 'hr.manage', 'hr.read']) expect(none).not.toContain(p);
      expect(none).toContain('members.manage'); // alansız rol-bağlı izin korunur
      expect(denial(await w.m.admin.client.post('/api/employees/00000000-0000-4000-8000-000000000001/reveal', { field: 'idNumber', reason: 'gerekçe metni' }))).toBe('MODULE_ACCESS_DENIED');
      expect(denial(await w.m.admin.client.get('/api/privacy/access-log'))).toBe('MODULE_ACCESS_DENIED');
      // Yönetici bordro alanı açık kalır: ayrı alan
      expect((await w.m.admin.client.get('/api/payroll/runs')).statusCode).toBe(200);
    });

    it('yıl sonu kapanışı ve konsolidasyon: muhasebe alanı "sadece görüntüle"de yıl sonu gider, "erişim yok"ta konsolidasyon da gider', async () => {
      const w = await world('Yilsonu');
      const perms = async () => ((await ok(w.m.admin.client.get('/api/me/access'))).permissions as string[]);
      await ok(w.set(w.m.admin, { 'core.ledger': 'read' }));
      let p = await perms();
      expect(p).not.toContain('ledger.yearend');
      expect(p).toContain('reports.consolidation');
      expect(p).not.toContain('ledger.post');
      await ok(w.set(w.m.admin, { 'core.ledger': 'none' }));
      p = await perms();
      expect(p).not.toContain('reports.consolidation');
      expect(p).not.toContain('reports.read');
      // Konsolidasyon uygun-şirket listesi: şirketin kendi bağlamında etkin izinle yeniden doğrulanır
      const elig = async () => ((await ok(w.m.admin.client.get('/api/consolidation/eligible-companies'))).companies as { id: string }[]).map((c) => c.id);
      await ok(w.set(w.m.admin, { 'core.ledger': 'default' }));
      expect(await elig()).toContain(w.company.id);
      await ok(w.set(w.m.admin, { 'core.ledger': 'none' }));
      expect(await elig()).not.toContain(w.company.id);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rütbe ve verme kuralları', () => {
    it('yönetici: sahibin, başka yöneticinin ve KENDİ erişimini değiştiremez; alt rolü değiştirebilir', async () => {
      const w = await world('Rutbe');
      const ownerId = w.s.userId;
      const adminC = w.m.admin.client;
      const r1 = await adminC.put(`/api/company/members/${ownerId}/module-access`, { levels: { 'core.parties': 'none' } });
      expect(r1.statusCode).toBe(403);
      expect(r1.json().error.code).toBe('MODULE_ACCESS_OWNER');
      const r2 = await w.set(w.m.admin2, { 'core.parties': 'none' }, adminC);
      expect(r2.statusCode).toBe(403);
      expect(r2.json().error.code).toBe('MODULE_ACCESS_ADMIN_ONLY_OWNER');
      const r3 = await w.set(w.m.admin, { 'core.parties': 'none' }, adminC);
      expect(r3.statusCode).toBe(403);
      expect(r3.json().error.code).toBe('MODULE_ACCESS_SELF');
      expect((await adminC.delete(`/api/company/members/${w.m.admin.userId}/module-access`)).statusCode).toBe(403);
      expect((await w.set(w.m.viewer, { 'core.parties': 'none' }, adminC)).statusCode).toBe(200);
      expect(await w.dump(ownerId)).toEqual([]);
      expect(await w.dump(w.m.admin2.userId)).toEqual([]);
      // GET: yönetici görebilir ama düzenleyemez
      const g = await ok(w.get(w.m.admin2, adminC));
      expect(g.canEdit).toBe(false);
      expect(g.blockedReason).toContain('yalnızca şirket sahibi');
    });

    it('sahip: kendi erişimini değiştiremez, başka sahibin erişimini kısıtlayamaz; yöneticiyi kısıtlayabilir', async () => {
      const w = await world('Sahipler');
      const o2 = await addMember(app, w.owner, w.company.id, 'owner', 'owner2');
      expect((await w.set({ userId: w.s.userId }, { 'core.parties': 'none' })).json().error.code).toBe('MODULE_ACCESS_SELF');
      expect((await w.set(o2, { 'core.parties': 'none' })).json().error.code).toBe('MODULE_ACCESS_OWNER');
      expect((await w.set(w.m.admin, { 'core.parties': 'none' })).statusCode).toBe(200);
      expect(denial(await w.m.admin.client.get('/api/parties'))).toBe('MODULE_ACCESS_DENIED');
      // İkinci sahip, birinciyi de kısıtlayamaz
      expect((await o2.client.put(`/api/company/members/${w.s.userId}/module-access`, { levels: { 'core.parties': 'none' } })).json().error.code).toBe('MODULE_ACCESS_OWNER');
      expect(await w.dump(w.s.userId)).toEqual([]);
      expect(await w.dump(o2.userId)).toEqual([]);
    });

    it('yönetici olmayanlar (muhasebeci, satış, şantiye, görüntüleyici) hiçbir uçta erişim yönetemez', async () => {
      const w = await world('Yetkisiz');
      for (const role of ['accountant', 'sales', 'site', 'viewer'] as const) {
        const c = w.m[role].client;
        expect((await c.get(`/api/company/members/${w.m.viewer.userId}/module-access`)).statusCode, role).toBe(403);
        expect((await w.set(w.m.sales, { 'core.parties': 'none' }, c)).statusCode, role).toBe(403);
        expect((await c.delete(`/api/company/members/${w.m.sales.userId}/module-access`)).statusCode, role).toBe(403);
      }
      expect(await w.dump(w.m.sales.userId)).toEqual([]);
    });

    it('çağıran, kendinde olmayanı veremez: sahibin kısıtladığı yönetici başkasına "düzenle" veremez, kısıtlamayı kaldıramaz', async () => {
      const w = await world('Sinir');
      await ok(w.set(w.m.admin, { 'core.invoices': 'read' })); // yönetici: faturada yalnız görüntüler
      const adminC = w.m.admin.client;
      const up = await w.set(w.m.viewer, { 'core.invoices': 'write' }, adminC);
      expect(up.statusCode).toBe(403);
      expect(up.json().error.code).toBe('MODULE_ACCESS_EXCEEDS_OWN');
      expect(await w.dump(w.m.viewer.userId)).toEqual([]);
      // Kendisinin olan düzeyi (read) ve kısıtlamayı (none) verebilir
      expect((await w.set(w.m.viewer, { 'core.invoices': 'read' }, adminC)).statusCode).toBe(200);
      expect((await w.set(w.m.sales, { 'core.invoices': 'none' }, adminC)).statusCode).toBe(200);
      // Muhasebeciye faturada "erişim yok" konup yönetici (read) bunu "varsayılan"a (yazma) döndürmek isterse: kendinde yok → reddedilir
      await ok(w.set(w.m.accountant, { 'core.invoices': 'none' }));
      const back = await w.set(w.m.accountant, { 'core.invoices': 'default' }, adminC);
      expect(back.statusCode).toBe(403);
      expect(back.json().error.code).toBe('MODULE_ACCESS_EXCEEDS_OWN');
      expect((await adminC.delete(`/api/company/members/${w.m.accountant.userId}/module-access`)).json().error.code).toBe('MODULE_ACCESS_EXCEEDS_OWN');
      // Sahip dilediğini yapar
      expect((await w.set(w.m.accountant, { 'core.invoices': 'default' })).statusCode).toBe(200);
    });

    it('geçersiz girdiler: bilinmeyen alan, sektörde olmayan alan, geçersiz düzey, boş gövde, olmayan üye; yabancı şirket üyesi', async () => {
      const w = await world('Gecersiz');
      expect((await w.set(w.m.viewer, { 'core.dashboard': 'none' })).json().error.code).toBe('MODULE_ACCESS_UNKNOWN_MODULE');
      expect((await w.set(w.m.viewer, { 'treasury.cheques': 'none' })).json().error.code).toBe('MODULE_ACCESS_UNKNOWN_MODULE'); // alt modül: alan değil
      expect((await w.set(w.m.viewer, { 'retail.pos': 'none' })).statusCode).toBe(422);
      expect((await w.set(w.m.viewer, { 'core.parties': 'admin' })).statusCode).toBe(400);
      expect((await w.set(w.m.viewer, {})).statusCode).toBe(400);
      expect((await w.owner.put(`/api/company/members/${w.m.viewer.userId}/module-access`, {})).statusCode).toBe(400);
      expect((await w.set({ userId: randomUUID() }, { 'core.parties': 'none' })).statusCode).toBe(404);
      expect((await w.owner.put(`/api/company/members/not-a-uuid/module-access`, { levels: { 'core.parties': 'none' } })).statusCode).toBe(400);
      // Sektör: market şirketinde inşaat alanları yazılamaz ve listelenmez
      const market = await world('Market', 'RETAIL_MARKET');
      expect((await market.set(market.m.viewer, { 'construction.projects': 'none' })).json().error.code).toBe('MODULE_ACCESS_UNKNOWN_MODULE');
      const areas = (await ok(market.get(market.m.viewer))).areas.map((a: any) => a.key);
      expect(areas).toContain('core.parties');
      expect(areas).not.toContain('construction.projects');
      // Başka şirketin üyesi bu şirketin yolundan erişilemez
      const other = await registerUser(app, 'Baska');
      const oc = await createCompany(app, other.token);
      const foreign = client(app, other.token, oc.id);
      expect((await foreign.put(`/api/company/members/${w.m.viewer.userId}/module-access`, { levels: { 'core.parties': 'none' } })).statusCode).toBe(404);
      expect((await foreign.get(`/api/company/members/${w.m.viewer.userId}/module-access`)).statusCode).toBe(404);
      const xc = client(app, other.token, w.company.id);
      expect((await xc.get(`/api/company/members/${w.m.viewer.userId}/module-access`)).json().error.code).toBe('NOT_A_MEMBER');
      expect(await w.dump(w.m.viewer.userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('şirket modül anahtarı önceliği', () => {
    it('şirket modülü kapalıysa üyeye "görüntüle ve düzenle" verilse de kapalıdır; menüde de yoktur', async () => {
      const w = await world('Oncelik');
      await ok(w.set(w.m.viewer, { 'construction.subcontracts': 'write' }));
      expect((await w.m.viewer.client.get('/api/subcontracts')).statusCode).toBe(200);
      // construction.subcontracts, onu gerektiren başka modül yok → kapatılabilir
      await ok(w.owner.put('/api/company/modules/construction.subcontracts', { enabled: false }));
      const g = await w.m.viewer.client.get('/api/subcontracts');
      expect(g.statusCode).toBe(403);
      expect(g.json().error.code).toBe('MODULE_DISABLED');
      const nav = await ok(w.m.viewer.client.get('/api/navigation'));
      expect(nav.groups.flatMap((x: any) => x.items.map((i: any) => i.key))).not.toContain('subcontracts');
      // Modülü yeniden açınca istisna korunur
      await ok(w.owner.put('/api/company/modules/construction.subcontracts', { enabled: true }));
      expect((await w.m.viewer.client.get('/api/subcontracts')).statusCode).toBe(200);
    });

    it('alt modül (çek/senet) bağlı olduğu alanın düzeyini izler: erişim yok → çek ucu ve dışa aktarma kapalı', async () => {
      const w = await world('Alt');
      await ok(w.set(w.m.accountant, { 'core.treasury': 'none' }));
      expect(denial(await w.m.accountant.client.get('/api/cheques'))).toBe('MODULE_ACCESS_DENIED');
      expect(denial(await w.m.accountant.client.get('/api/bank-guarantees'))).toBe('MODULE_ACCESS_DENIED');
      expect(denial(await w.m.accountant.client.get('/api/expense-entries'))).toBe('MODULE_ACCESS_DENIED');
      await ok(w.set(w.m.accountant, { 'core.treasury': 'read' }));
      expect((await w.m.accountant.client.get('/api/cheques')).statusCode).toBe(200);
      expect(denial(await w.m.accountant.client.post('/api/cheques', {}))).toBe('MODULE_READ_ONLY');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('anında etki ve önbellek yok', () => {
    it('değişiklik AYNI erişim belirteciyle bir sonraki istekte geçerlidir (kısıtla, aç, sıfırla)', async () => {
      const w = await world('Anlik');
      const v = w.m.viewer.client;
      expect((await v.get('/api/parties')).statusCode).toBe(200);
      await ok(w.set(w.m.viewer, { 'core.parties': 'none' }));
      expect(denial(await v.get('/api/parties'))).toBe('MODULE_ACCESS_DENIED');
      await ok(w.set(w.m.viewer, { 'core.parties': 'write' }));
      expect([400, 422]).toContain((await v.post('/api/parties', {})).statusCode);
      await ok(w.set(w.m.viewer, { 'core.parties': 'read' }));
      expect(denial(await v.post('/api/parties', {}))).toBe('MODULE_READ_ONLY');
      await ok(w.owner.delete(`/api/company/members/${w.m.viewer.userId}/module-access`));
      expect(denial(await v.post('/api/parties', {}))).toBe('FORBIDDEN');
      expect((await v.get('/api/parties')).statusCode).toBe(200);
    });

    it('eşzamanlı isteklerde son yazılan kazanır, tutarsız satır oluşmaz (tekil kısıt)', async () => {
      const w = await world('Yaris');
      const results = await Promise.all(['none', 'read', 'write', 'none', 'read'].map((level) => w.set(w.m.viewer, { 'core.parties': level })));
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      const rows = await w.dump(w.m.viewer.userId);
      expect(rows.length).toBeLessThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rol değişimi ve üyelik', () => {
    it('rol değişince üyenin özel erişimi silinir (yeni rol şablonu aynen geçerli); yanıtta kaç satır silindiği bildirilir', async () => {
      const w = await world('RolDegis');
      await ok(w.set(w.m.viewer, { 'core.parties': 'write', 'core.treasury': 'none' }));
      expect(await w.dump(w.m.viewer.userId)).toHaveLength(2);
      const res = await ok(w.owner.patch(`/api/company/members/${w.m.viewer.userId}`, { role: 'sales' }));
      expect(res.clearedModuleAccess).toBe(2);
      expect(await w.dump(w.m.viewer.userId)).toEqual([]);
      const me = await ok(w.m.viewer.client.get('/api/me/access'));
      expect(me.role).toBe('sales');
      expect(me.areas.every((a: any) => a.custom === null)).toBe(true);
      expect(new Set(me.permissions)).toEqual(new Set(ROLE_PERMISSIONS.sales));
    });

    it('üye çıkarılınca satırları silinir; yeniden eklenince eski istisna geri gelmez', async () => {
      const w = await world('Cikar');
      await ok(w.set(w.m.sales, { 'core.parties': 'none' }));
      await ok(w.owner.delete(`/api/company/members/${w.m.sales.userId}`));
      expect(await w.dump(w.m.sales.userId)).toEqual([]);
      const back = await w.owner.post('/api/company/members', { email: w.m.sales.email, fullName: 'Geri', role: 'sales', password: PASSWORD, mustChangePassword: false });
      expect(back.statusCode).toBe(201);
      const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: w.m.sales.email, password: PASSWORD } })).json().accessToken as string;
      expect((await client(app, tok, w.company.id).get('/api/parties')).statusCode).toBe(200);
    });

    it('özel erişimi olan üye kendi rolünü değiştiremez/kendini çıkaramaz; özel erişimli yöneticiyi yalnızca sahip değiştirir', async () => {
      const w = await world('Kacis');
      await ok(w.set(w.m.admin, { 'hr.payroll': 'none' }));
      // Kısıtlı yönetici kendini "muhasebeci" yapıp kısıtını sıfırlayamaz (muhasebecinin bordro izni var)
      const self = await w.m.admin.client.patch(`/api/company/members/${w.m.admin.userId}`, { role: 'accountant' });
      expect(self.statusCode).toBe(403);
      expect(self.json().error.code).toBe('MODULE_ACCESS_SELF');
      // Başka yönetici, kısıtlı yöneticinin rolünü değiştirip kısıtı silemez
      const other = await w.m.admin2.client.patch(`/api/company/members/${w.m.admin.userId}`, { role: 'viewer' });
      expect(other.statusCode).toBe(403);
      expect(other.json().error.code).toBe('MODULE_ACCESS_ADMIN_ONLY_OWNER');
      expect((await w.m.admin2.client.delete(`/api/company/members/${w.m.admin.userId}`)).json().error.code).toBe('MODULE_ACCESS_ADMIN_ONLY_OWNER');
      expect(await w.dump(w.m.admin.userId)).toHaveLength(1);
      // Sahip değiştirebilir
      expect((await w.owner.patch(`/api/company/members/${w.m.admin.userId}`, { role: 'accountant' })).statusCode).toBe(200);
      expect(await w.dump(w.m.admin.userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('uç yanıtları', () => {
    it('GET: rol varsayılanı, özel seçim, etkin sonuç, kim/ne zaman; üye listesinde özel erişim sayısı; DELETE sıfırlar', async () => {
      const w = await world('Yanit');
      await ok(w.set(w.m.sales, { 'core.treasury': 'read', 'core.invoices': 'write' }));
      const g = await ok(w.get(w.m.sales));
      expect(g.canEdit).toBe(true);
      expect(g.member.role).toBe('sales');
      const tr = g.areas.find((a: any) => a.key === 'core.treasury');
      expect(tr).toMatchObject({ roleDefault: { level: 'none' }, override: 'read', effective: { level: 'read' } });
      expect(tr.setBy).toContain('Kullanıcı');
      expect(tr.setAt).not.toBeNull();
      expect(tr.modules.map((m: any) => m.key)).toEqual(expect.arrayContaining(['core.treasury', 'treasury.cheques', 'treasury.guarantees', 'treasury.expenses']));
      const inv = g.areas.find((a: any) => a.key === 'core.invoices');
      expect(inv).toMatchObject({ override: 'write', effective: { level: 'write', partial: false }, roleDefault: { level: 'write', partial: true } });
      expect(g.areas.find((a: any) => a.key === 'core.parties')).toMatchObject({ override: null, setBy: null });
      // Sahip: salt okunur görünüm
      const og = await ok(w.owner.get(`/api/company/members/${w.s.userId}/module-access`));
      expect(og.canEdit).toBe(false);
      expect(og.areas.every((a: any) => a.effective.level === 'write' && a.override === null)).toBe(true);
      const list = await ok(w.owner.get('/api/company/members'));
      expect(list.members.find((m: any) => m.userId === w.m.sales.userId).customAccessCount).toBe(2);
      expect(list.members.find((m: any) => m.userId === w.m.viewer.userId).customAccessCount).toBe(0);
      const reset = await ok(w.owner.delete(`/api/company/members/${w.m.sales.userId}/module-access`));
      expect(reset.areas.every((a: any) => a.override === null)).toBe(true);
      expect(await w.dump(w.m.sales.userId)).toEqual([]);
    });

    it('PUT yalnızca değişen satırı yazar; aynı değeri yeniden göndermek denetim gürültüsü üretmez; "default" satırı siler', async () => {
      const w = await world('Degisen');
      await ok(w.set(w.m.viewer, { 'core.parties': 'write' }));
      const auditCount = async () => Number((await execAsOwner(`select count(*)::int as n from audit_log where company_id = $1 and table_name = 'member_module_access'`, [w.company.id])).rows[0].n);
      const n1 = await auditCount();
      await ok(w.set(w.m.viewer, { 'core.parties': 'write' }));
      expect(await auditCount()).toBe(n1);
      await ok(w.set(w.m.viewer, { 'core.parties': 'default' }));
      expect(await w.dump(w.m.viewer.userId)).toEqual([]);
      expect(await auditCount()).toBe(n1 + 1);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('denetim izi', () => {
    it('her ekleme/değiştirme/silme audit_log ve güvenlik olayına yazılır; kim verdi sunucuda damgalanır', async () => {
      const w = await world('Denetim');
      await ok(w.set(w.m.viewer, { 'core.parties': 'none' }));
      await ok(w.set(w.m.viewer, { 'core.parties': 'write' }));
      await ok(w.owner.delete(`/api/company/members/${w.m.viewer.userId}/module-access`));
      const log = (await execAsOwner(`select action, old_data, new_data, user_id from audit_log where company_id = $1 and table_name = 'member_module_access' order by at, id`, [w.company.id])).rows;
      expect(log.map((r) => r.action)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
      expect(log[0].new_data).toMatchObject({ module_key: 'core.parties', level: 'none', user_id: w.m.viewer.userId, set_by: w.s.userId });
      expect(log[1].old_data.level).toBe('none');
      expect(log[1].new_data.level).toBe('write');
      expect(log[2].old_data.level).toBe('write');
      for (const r of log) expect(r.user_id).toBe(w.s.userId);
      const ev = (await execAsOwner(`select meta from security_events where event = 'member_module_access_changed' and user_id = $1 order by at`, [w.m.viewer.userId])).rows;
      expect(ev).toHaveLength(3);
      expect(ev[0].meta).toMatchObject({ companyId: w.company.id, by: w.s.userId, role: 'viewer', changes: [{ area: 'core.parties', from: null, to: 'none' }] });
      expect(ev[2].meta.reset).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('veritabanı: RLS ve koruyucu (ERP26)', () => {
    it('üye yalnızca KENDİ satırlarını okur; sahip/yönetici şirketin hepsini; başka şirket hiçbirini görmez', async () => {
      const w = await world('Rls');
      await ok(w.set(w.m.viewer, { 'core.parties': 'none' }));
      await ok(w.set(w.m.sales, { 'core.parties': 'read' }));
      const other = await world('RlsB');
      await ok(other.set(other.m.viewer, { 'core.parties': 'write' }));
      const rows = (ctx: { userId: string; orgId: string; companyId: string }) => asDb(handle, ctx, (q) => q(`select user_id from member_module_access`)).then((r) => r.rows.map((x) => x.user_id as string).sort());
      expect(await rows({ userId: w.m.viewer.userId, orgId: w.orgId, companyId: w.company.id })).toEqual([w.m.viewer.userId]);
      expect(await rows({ userId: w.m.sales.userId, orgId: w.orgId, companyId: w.company.id })).toEqual([w.m.sales.userId]);
      expect(await rows({ userId: w.m.accountant.userId, orgId: w.orgId, companyId: w.company.id })).toEqual([]);
      expect(await rows({ userId: w.s.userId, orgId: w.orgId, companyId: w.company.id })).toEqual([w.m.viewer.userId, w.m.sales.userId].sort());
      expect(await rows({ userId: w.m.admin.userId, orgId: w.orgId, companyId: w.company.id })).toEqual([w.m.viewer.userId, w.m.sales.userId].sort());
      // Başka şirketin sahibi bu şirketin bağlamına geçemez; kendi bağlamında yalnızca kendi şirketinin satırını görür
      expect(await rows({ userId: other.s.userId, orgId: other.orgId, companyId: w.company.id })).toEqual([]);
      expect(await rows({ userId: other.s.userId, orgId: other.orgId, companyId: other.company.id })).toEqual([other.m.viewer.userId]);
      // Bağlamsız hiçbir şey
      expect(await rows({ userId: w.s.userId, orgId: w.orgId, companyId: '' })).toEqual([]);
    });

    it('üye kendi satırını DB düzeyinde de yazamaz/silemez/yükseltemez; yönetici olmayan hiçbir yazma yapamaz', async () => {
      const w = await world('RlsYaz');
      await ok(w.set(w.m.viewer, { 'core.parties': 'none' }));
      const ctx = (userId: string) => ({ userId, orgId: w.orgId, companyId: w.company.id });
      await asDb(handle, ctx(w.m.viewer.userId), async (q) => {
        const up = await q(`update member_module_access set level = 'write' where user_id = $1`, [w.m.viewer.userId]);
        expect(up.rows).toEqual([]);
        expect((await q(`select level from member_module_access`)).rows).toEqual([{ level: 'none' }]);
        const del = await q(`delete from member_module_access where user_id = $1 returning id`, [w.m.viewer.userId]);
        expect(del.rows).toEqual([]);
        const ins = await expectDbError(q, `insert into member_module_access (id, company_id, user_id, module_key, level, set_by) values (gen_random_uuid(), $1, $2, 'core.treasury', 'write', $2)`, [w.company.id, w.m.viewer.userId]);
        expect(ins.code).toMatch(/^(42501|ERP26)$/); // BEFORE koruyucusu RLS WITH CHECK'ten önce çalışır; ikisi de reddeder
      });
      await asDb(handle, ctx(w.m.accountant.userId), async (q) => {
        const ins = await expectDbError(q, `insert into member_module_access (id, company_id, user_id, module_key, level, set_by) values (gen_random_uuid(), $1, $2, 'core.treasury', 'none', $3)`, [w.company.id, w.m.viewer.userId, w.m.accountant.userId]);
        expect(ins.code).toMatch(/^(42501|ERP26)$/); // BEFORE koruyucusu RLS WITH CHECK'ten önce çalışır; ikisi de reddeder
      });
      expect(await w.dump(w.m.viewer.userId)).toEqual([{ module_key: 'core.parties', level: 'none' }]);
    });

    it('koruyucu: kendi satırı, sahip satırı, yönetici satırı (yönetici yazarsa), üye olmayan, kimlik değişimi; set_by/set_at sunucuda damgalanır', async () => {
      const w = await world('Koruyucu');
      const ins = (userId: string, key = 'core.treasury', level = 'none', setBy?: string): [string, unknown[]] => [
        `insert into member_module_access (id, company_id, user_id, module_key, level, set_by) values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [w.company.id, userId, key, level, setBy ?? w.s.userId],
      ];
      // Sahip bağlamı: kendi satırı yasak, sahip yasak, üye olmayan yasak
      await asDb(handle, { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id }, async (q) => {
        expect((await expectDbError(q, ...ins(w.s.userId))).code).toBe('ERP26');
        expect((await expectDbError(q, ...ins(randomUUID()))).code).toMatch(/ERP26|23503/);
        // Başka şirkete ait satır: RLS (42501)
        expect((await expectDbError(q, `insert into member_module_access (id, company_id, user_id, module_key, level, set_by) values (gen_random_uuid(), $1, $2, 'core.parties', 'none', $3)`, [randomUUID(), w.m.viewer.userId, w.s.userId])).code).toMatch(/^(42501|ERP26)$/);
        // Geçersiz düzey / anahtar: CHECK
        expect((await expectDbError(q, ...ins(w.m.viewer.userId, 'core.treasury', 'admin'))).code).toBe('23514');
        expect((await expectDbError(q, ...ins(w.m.viewer.userId, 'Core Treasury', 'none'))).code).toBe('23514');
        // Damga: istemcinin yazdığı set_by yok sayılır
        await q(...ins(w.m.viewer.userId, 'core.treasury', 'none', w.m.admin.userId));
        const r = await q(`select set_by, set_at from member_module_access where user_id = $1`, [w.m.viewer.userId]);
        expect(r.rows[0].set_by).toBe(w.s.userId);
        // Kimlik değişimi yasak
        expect((await expectDbError(q, `update member_module_access set user_id = $2 where user_id = $1`, [w.m.viewer.userId, w.m.sales.userId])).code).toBe('ERP26');
        expect((await expectDbError(q, `update member_module_access set module_key = 'core.parties' where user_id = $1`, [w.m.viewer.userId])).code).toBe('ERP26');
      });
      // Yönetici bağlamı: başka yöneticiye ve sahibe yazamaz; alt role yazabilir
      await asDb(handle, { userId: w.m.admin.userId, orgId: w.orgId, companyId: w.company.id }, async (q) => {
        expect((await expectDbError(q, ...ins(w.m.admin2.userId, 'core.treasury', 'none', w.m.admin.userId))).code).toBe('ERP26');
        expect((await expectDbError(q, ...ins(w.s.userId, 'core.treasury', 'none', w.m.admin.userId))).code).toBe('ERP26');
        expect((await expectDbError(q, ...ins(w.m.admin.userId, 'core.treasury', 'none', w.m.admin.userId))).code).toBe('ERP26');
        await q(...ins(w.m.sales.userId, 'core.treasury', 'none', w.m.admin.userId));
      });
    });

    it('üyelik silinince (yönetici kendini çıkarsa bile) satırlar tetikleyiciyle temizlenir', async () => {
      const w = await world('Temizle');
      await ok(w.set(w.m.viewer, { 'core.parties': 'none' }));
      await execAsOwner(`delete from memberships where company_id = $1 and user_id = $2`, [w.company.id, w.m.viewer.userId]);
      const left = await execAsOwner(`select count(*)::int as n from member_module_access where company_id = $1 and user_id = $2`, [w.company.id, w.m.viewer.userId]);
      expect(left.rows[0].n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('dışa aktarma', () => {
    it('alan "erişim yok" ise o alanın dışa aktarmaları 403; "sadece görüntüle"de açık; tüm veri dosyasından alan sayfaları çıkar', async () => {
      const w = await world('Disa');
      const a = w.m.accountant.client;
      expect((await a.get('/api/exports/cheques?format=csv')).statusCode).toBe(200);
      await ok(w.set(w.m.accountant, { 'core.treasury': 'none' }));
      const blocked = await a.get('/api/exports/cheques?format=csv');
      expect(denial(blocked)).toBe('MODULE_ACCESS_DENIED');
      expect(denial(await a.get('/api/exports/treasury-statement?format=csv'))).toBe('MODULE_ACCESS_DENIED');
      await ok(w.set(w.m.accountant, { 'core.treasury': 'read' }));
      expect((await a.get('/api/exports/cheques?format=csv')).statusCode).toBe(200);
      // Rapor dışa aktarması (reports.read): muhasebe alanı none → engel
      await ok(w.set(w.m.accountant, { 'core.ledger': 'none' }));
      expect(denial(await a.get(`/api/exports/trial-balance?format=csv&from=${todayIso().slice(0, 4)}-01-01&to=${todayIso()}`))).toBe('MODULE_ACCESS_DENIED');
      await ok(w.set(w.m.accountant, { 'core.ledger': 'default' }));

      // Tüm veri dosyası: personel/bordro/kasa alanları kapalı üyenin dosyasında yok
      await ok(w.owner.post('/api/parties', { name: 'Dosya Cari', kind: 'customer' }), 201).catch(() => undefined);
      const sheetsOf = async (c: C) => {
        const res = await c.get('/api/exports/full-data?format=xlsx');
        expect(res.statusCode, res.body).toBe(200);
        return readXlsx(new Uint8Array(res.rawPayload)).map((s) => s.name);
      };
      const full = await sheetsOf(a);
      expect(full).toContain('Cariler');
      expect(full).toContain('Kasa ve banka hesapları');
      await ok(w.set(w.m.accountant, { 'core.treasury': 'none', 'core.parties': 'none', 'hr.core': 'none' }));
      const reduced = await sheetsOf(a);
      expect(reduced).not.toContain('Cariler');
      expect(reduced).not.toContain('Kasa ve banka hesapları');
      expect(reduced).not.toContain('Kasa ve banka hareketleri');
      expect(reduced).not.toContain('Personel');
      expect(reduced).toContain('Hesap planı');
      // Sahip hepsini alır
      expect(await sheetsOf(w.owner)).toContain('Cariler');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('bildirimler', () => {
    it('"erişim yok" üyeye kaynak bildirimi üretilmez; mevcut açık bildirim listeden hemen kalkar; erişim dönünce yeniden üretilir; e-posta özeti uygun türlerle', async () => {
      const w = await world('Bildirim');
      const party = (await ok(w.owner.post('/api/parties', { name: 'Müşteri', kind: 'customer' }), 201)).party as { id: string };
      await ok(
        w.owner.post('/api/cheques', { direction: 'received', docType: 'cheque', docNo: `CK-${randomUUID().slice(0, 6)}`, bankName: 'Banka', partyId: party.id, amount: '100', issueDate: '2020-01-01', dueDate: todayIso(), registerDate: todayIso() }),
        201,
      );
      const scan = () => scanCompany(handle.db, { companyId: w.company.id, orgId: w.orgId }, { wait: true });
      const kinds = async (c: C) => ((await ok(c.get('/api/notifications?status=active'))).notifications as { kind: string }[]).map((n) => n.kind);
      await scan();
      expect(await kinds(w.m.accountant.client)).toContain('cheque_due');
      expect(await kinds(w.m.viewer.client)).toContain('cheque_due');
      const count = async (c: C) => (await ok(c.get('/api/notifications/unread-count'))).count as number;
      expect(await count(w.m.accountant.client)).toBeGreaterThan(0);

      await ok(w.set(w.m.accountant, { 'core.treasury': 'none' }));
      // Tarama beklemeden: eski açık bildirim listede ve sayıda yok
      expect(await kinds(w.m.accountant.client)).not.toContain('cheque_due');
      await scan();
      expect(await kinds(w.m.accountant.client)).not.toContain('cheque_due');
      expect(await kinds(w.m.viewer.client)).toContain('cheque_due'); // başkası etkilenmez
      expect(await kinds(w.owner)).toContain('cheque_due');
      const prefs = (await ok(w.m.accountant.client.get('/api/notification-preferences'))).kinds as { kind: string }[];
      expect(prefs.map((p) => p.kind)).not.toContain('cheque_due');
      expect((await w.m.accountant.client.put('/api/notification-preferences', { preferences: [{ kind: 'cheque_due', email: true }] })).statusCode).toBe(422);

      // "Sadece görüntüle": okuma izni kaynağa yeter
      await ok(w.set(w.m.accountant, { 'core.treasury': 'read' }));
      await scan();
      expect(await kinds(w.m.accountant.client)).toContain('cheque_due');
      // Satış rolü hazinede erişim almadan bildirim almaz; "sadece görüntüle" verilince alır
      expect(await kinds(w.m.sales.client)).not.toContain('cheque_due');
      await ok(w.set(w.m.sales, { 'core.treasury': 'read' }));
      await scan();
      expect(await kinds(w.m.sales.client)).toContain('cheque_due');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('onaylar', () => {
    it('onay kutusu ve karar ucu: taşeron alanı "erişim yok" → 403; karar motoru etkin izne bakar (sadece görüntüle = karar veremez)', async () => {
      const w = await world('Onay');
      const orgId = w.orgId;
      const run = <T>(userId: string, fn: Parameters<typeof withContext<T>>[2]) => withContext(handle.db, { userId, orgId, companyId: w.company.id }, fn);
      const ctxFor = (userId: string, role: Role, overrides: Record<string, 'none' | 'read' | 'write'> = {}) => ({ companyId: w.company.id, userId, role, permissions: effectivePermissions(role, overrides) });
      const docId = randomUUID();
      const req = await run(w.s.userId, (tx) => requestApproval(tx, ctxFor(w.s.userId, 'owner'), { docType: 'progress_payment', docId, projectId: null, amount: '1000.00' }));

      // Uç: erişim yok → kutu ve karar 403
      await ok(w.set(w.m.accountant, { 'construction.subcontracts': 'none' }));
      expect(denial(await w.m.accountant.client.get('/api/approvals/inbox'))).toBe('MODULE_ACCESS_DENIED');
      expect(denial(await w.m.accountant.client.post(`/api/approvals/${req.id}/decide`, { decision: 'approve' }))).toBe('MODULE_ACCESS_DENIED');
      // Sadece görüntüle: uca girer ama onay izni yok → karar verilemez
      await ok(w.set(w.m.accountant, { 'construction.subcontracts': 'read' }));
      expect((await w.m.accountant.client.get('/api/approvals/inbox')).statusCode).toBe(200);
      expect((await ok(w.m.accountant.client.get('/api/approvals/inbox'))).requests).toEqual([]);
      const d = await w.m.accountant.client.post(`/api/approvals/${req.id}/decide`, { decision: 'approve' });
      expect(d.statusCode).toBe(403);
      // Motor düzeyi: etkin izin onay vermiyorsa rol eşleşmesi yetmez
      await expect(run(w.m.accountant.userId, (tx) => decide(tx, ctxFor(w.m.accountant.userId, 'accountant', { 'construction.subcontracts': 'read' }), req.id, { decision: 'approve' }))).rejects.toMatchObject({ status: 403 });
      // Yazma düzeyi (onay dahil) → karar verilir; talep onaylı
      await ok(w.set(w.m.accountant, { 'construction.subcontracts': 'write' }));
      const done = await ok(w.m.accountant.client.post(`/api/approvals/${req.id}/decide`, { decision: 'approve' }));
      expect(done.request.status).toBe('approved');
    });

    it('görüntüleyiciye taşeron "düzenle" verilince onay verebilir; rol varsayılanında veremez', async () => {
      const w = await world('OnayTerfi');
      const docId = randomUUID();
      const req = await withContext(handle.db, { userId: w.s.userId, orgId: w.orgId, companyId: w.company.id }, (tx) =>
        requestApproval(tx, { companyId: w.company.id, userId: w.s.userId, role: 'owner', permissions: effectivePermissions('owner') }, { docType: 'progress_payment', docId, projectId: null, amount: '10.00' }),
      );
      expect((await w.m.viewer.client.post(`/api/approvals/${req.id}/decide`, { decision: 'approve' })).statusCode).toBe(403);
      await ok(w.set(w.m.viewer, { 'construction.subcontracts': 'write' }));
      expect((await ok(w.m.viewer.client.post(`/api/approvals/${req.id}/decide`, { decision: 'approve' }))).request.status).toBe('approved');
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('çok kiracılı yalıtım', () => {
    it('başka şirketteki üyelik/istisna bu şirketin kararını etkilemez; aynı kullanıcı iki şirkette farklı düzeye sahip olabilir', async () => {
      const a = await world('IkiA');
      const b = await world('IkiB');
      // a.viewer'ı B şirketine de görüntüleyici olarak ekle (aynı kuruluş değil: ekleme reddedilir → aynı kuruluşta ikinci şirket aç)
      const second = await createCompany(app, a.s.token, { name: 'İkinci Şirket' });
      const owner2 = client(app, a.s.token, second.id);
      const add = await owner2.post('/api/company/members', { email: a.m.viewer.email, fullName: 'Xx Kişi', role: 'viewer' });
      expect(add.statusCode).toBe(201);
      const v2 = client(app, a.m.viewer.token, second.id);
      await ok(a.set(a.m.viewer, { 'core.parties': 'none' }));
      expect(denial(await a.m.viewer.client.get('/api/parties'))).toBe('MODULE_ACCESS_DENIED');
      expect((await v2.get('/api/parties')).statusCode).toBe(200); // diğer şirkette etkilenmez
      // Üyelikleri olmayan şirketin istisnası okunamaz
      expect(b.company.id).not.toBe(a.company.id);
      expect((await a.m.viewer.client.get('/api/me/access')).json().areas.find((x: any) => x.key === 'core.parties').custom).toBe('none');
      expect((await v2.get('/api/me/access')).json().areas.find((x: any) => x.key === 'core.parties').custom).toBeNull();
    });
  });
});
