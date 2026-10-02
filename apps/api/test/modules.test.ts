import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, makeApp, orgOf, registerUser } from './helpers';

const { app, handle } = await makeApp();

const put = (c: ReturnType<typeof client>, key: string, enabled: boolean) => c.put(`/api/company/modules/${key}`, { enabled });
/** Kasa/banka kapatılmadan önce ona bağlı çek/senet ve teminat mektubu modülleri kapatılır (bağımlılık). */
const treasuryOff = async (c: ReturnType<typeof client>) => {
  await put(c, 'treasury.cheques', false);
  await put(c, 'treasury.guarantees', false);
  return put(c, 'core.treasury', false);
};
/** Fatura kapatılmadan önce ona bağlı satış teklif/sipariş modülü kapatılır (bağımlılık). */
const invoicesOff = async (c: ReturnType<typeof client>) => {
  await put(c, 'invoices.orders', false);
  await put(c, 'sales.pricelists', false);
  return put(c, 'core.invoices', false);
};
const navKeys = async (c: ReturnType<typeof client>) =>
  (await c.get('/api/navigation')).json().groups.map((g: any) => g.key) as string[];
const byKey = (res: any) => Object.fromEntries(res.json().modules.map((m: any) => [m.key, m]));

async function setup(name: string, sector = 'CONSTRUCTION') {
  const owner = await registerUser(app, name);
  const company = await createCompany(app, owner.token, { sector });
  return { owner, company, c: client(app, owner.token, company.id) };
}

describe('modül istisnaları (Ayarlar > Modüller)', () => {
  it('liste: sektör varsayılanları, kilitli/planlı/bağımlılık bilgisi', async () => {
    const { c } = await setup('Liste');
    const res = await c.get('/api/company/modules');
    expect(res.statusCode).toBe(200);
    const m = byKey(res);
    expect(m['core.invoices']).toMatchObject({ enabled: true, locked: false, override: null, requires: ['core.ledger', 'core.parties', 'core.inventory'] });
    expect(m['core.ledger'].dependents).toEqual(expect.arrayContaining(['core.parties', 'core.inventory', 'core.invoices', 'core.treasury']));
    expect(m['invoices.orders']).toMatchObject({ enabled: true, requires: ['core.invoices', 'core.inventory'] });
    expect(m['core.invoices'].dependents).toContain('invoices.orders');
    expect(m['sales.pricelists']).toMatchObject({ enabled: true, requires: ['core.invoices', 'core.inventory'] });
    expect(m['inventory.serials']).toMatchObject({ enabled: true, requires: ['core.inventory'] });
    expect(m['treasury.cheques']).toMatchObject({ enabled: true, requires: ['core.treasury'] });
    expect(m['treasury.guarantees']).toMatchObject({ enabled: true, requires: ['core.treasury'] });
    expect(m['core.treasury'].dependents).toEqual(expect.arrayContaining(['treasury.cheques', 'treasury.guarantees']));
    expect(m['core.ledger'].blocked).toMatchObject({ reason: 'REQUIRED_BY' });
    expect(m['core.dashboard']).toMatchObject({ locked: true, blocked: { reason: 'LOCKED' } });
    // Proje modülü inşaat şirketinde açık; yalnızca muhasebeye bağlı
    expect(m['construction.projects']).toMatchObject({ status: 'available', enabled: true, sectorDefault: true, requires: ['core.ledger'] });
    expect(m['core.ledger'].dependents).toContain('construction.projects');
    // Planlı ve sektöre uymayan modül (inşaat şirketinde POS) açılamaz
    expect(m['retail.pos']).toMatchObject({ enabled: false, sectorDefault: false, blocked: { reason: 'PLANNED' } });
  });

  it('faturayı kapatınca menü grubu ve uçlar kalkar; açınca geri gelir ve istisna satırı silinir', async () => {
    const { c, company } = await setup('Fatura');
    expect(await navKeys(c)).toContain('invoices');
    expect((await c.get('/api/invoices?type=sales')).statusCode).toBe(200);

    const off = await invoicesOff(c);
    expect(off.statusCode).toBe(200);
    expect(byKey(off)['core.invoices']).toMatchObject({ enabled: false, override: false });

    expect(await navKeys(c)).not.toContain('invoices');
    const blocked = await c.get('/api/invoices?type=sales');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MODULE_DISABLED');
    // Fatura kapalı: bağımlı olduğu modüller hâlâ açık
    expect((await c.get('/api/parties')).statusCode).toBe(200);

    const on = await put(c, 'core.invoices', true);
    expect(on.statusCode).toBe(200);
    expect(byKey(on)['core.invoices']).toMatchObject({ enabled: true, override: null });
    expect(await navKeys(c)).toContain('invoices');
    expect((await c.get('/api/invoices?type=sales')).statusCode).toBe(200);
    // Teklif/sipariş modülünün istisnası da açınca silinir
    expect((await put(c, 'invoices.orders', true)).statusCode).toBe(200);
    expect((await put(c, 'sales.pricelists', true)).statusCode).toBe(200);

    const rows = await asDb(handle, { companyId: company.id }, async (q) =>
      (await q(`select module from company_modules where company_id = $1`, [company.id])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('aynı duruma geçiş etkisizdir (iki kez kapat / iki kez aç)', async () => {
    const { c } = await setup('Idempotent');
    expect((await treasuryOff(c)).statusCode).toBe(200);
    expect((await treasuryOff(c)).statusCode).toBe(200);
    expect((await put(c, 'core.treasury', true)).statusCode).toBe(200);
    expect((await put(c, 'core.treasury', true)).statusCode).toBe(200);
  });

  it('bağımlılık kuralları: açık bağımlısı olan modül kapatılamaz, gereksinimi kapalı modül açılamaz', async () => {
    const { c } = await setup('Bagimli');
    const a = await put(c, 'core.inventory', false);
    expect(a.statusCode).toBe(422);
    expect(a.json().error.code).toBe('MODULE_REQUIRED_BY');
    expect(a.json().error.details.modules).toContain('core.invoices');
    expect(a.json().error.message).toContain('Fatura ve irsaliye');

    const b = await put(c, 'core.ledger', false);
    expect(b.json().error.code).toBe('MODULE_REQUIRED_BY');

    // Sırayla: faturayı kapat → stoku kapat → faturayı açmayı dene (stok kapalı)
    expect((await invoicesOff(c)).statusCode).toBe(200);
    expect((await put(c, 'inventory.serials', false)).statusCode).toBe(200);
    expect((await put(c, 'core.inventory', false)).statusCode).toBe(200);
    const d = await put(c, 'core.invoices', true);
    expect(d.statusCode).toBe(422);
    expect(d.json().error.code).toBe('MODULE_MISSING_REQUIREMENT');
    expect(d.json().error.details.modules).toEqual(['core.inventory']);
    // Stok kapalıyken stok uçları 403
    expect((await c.get('/api/items')).statusCode).toBe(403);
    expect((await put(c, 'core.inventory', true)).statusCode).toBe(200);
    expect((await put(c, 'core.invoices', true)).statusCode).toBe(200);
  });

  it('kilitli, planlı ve bilinmeyen modül reddedilir', async () => {
    const { c } = await setup('Ret');
    for (const key of ['core.dashboard', 'core.settings']) {
      const r = await put(c, key, false);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('MODULE_LOCKED');
    }
    // Planlı modül (POS): henüz kullanıma açılmadı. Sektöre uymayan planlı modülde planlı kuralı önce gelir.
    const planned = await put(c, 'retail.pos', true);
    expect(planned.statusCode).toBe(422);
    expect(planned.json().error.code).toBe('MODULE_PLANNED');
    // Sektöre uymayan kullanılabilir modül: ticaret şirketinde proje modülü açılamaz
    const commerce = await setup('RetSektor', 'COMMERCE');
    const mismatch = await put(commerce.c, 'construction.projects', true);
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('MODULE_SECTOR_MISMATCH');
    const unknown = await put(c, 'core.nope', false);
    expect(unknown.statusCode).toBe(404);
    // Gövde şeması
    expect((await c.put('/api/company/modules/core.invoices', { enabled: 'evet' })).statusCode).toBe(400);
  });

  it('izinler: owner ve admin değiştirir; muhasebeci/satış/izleyici yalnız okur', async () => {
    const { owner, c, company } = await setup('Izin');
    const admin = await addMember(app, c, company.id, 'admin');
    const accountant = await addMember(app, c, company.id, 'accountant');
    const sales = await addMember(app, c, company.id, 'sales');
    const viewer = await addMember(app, c, company.id, 'viewer');

    for (const m of [accountant, sales, viewer]) {
      expect((await m.client.get('/api/company/modules')).statusCode).toBe(200);
      const r = await put(m.client, 'core.treasury', false);
      expect(r.statusCode).toBe(403);
    }
    expect((await treasuryOff(admin.client)).statusCode).toBe(200);
    expect((await put(c, 'core.treasury', true)).statusCode).toBe(200);
    expect(owner.token).toBeTruthy();
    // Kimliksiz
    expect((await app.inject({ method: 'PUT', url: '/api/company/modules/core.treasury', payload: { enabled: false } })).statusCode).toBe(401);
  });

  it('şirketler arası yalıtım: A şirketindeki istisna B şirketini etkilemez', async () => {
    const a = await setup('IzolA');
    const b = await setup('IzolB');
    expect((await treasuryOff(a.c)).statusCode).toBe(200);
    expect(byKey(await b.c.get('/api/company/modules'))['core.treasury']).toMatchObject({ enabled: true, override: null });
    expect((await b.c.get('/api/treasury/accounts')).statusCode).toBe(200);
    expect((await a.c.get('/api/treasury/accounts')).statusCode).toBe(403);

    // B şirketinin bağlamıyla A'nın istisna satırı görünmez (RLS)
    const orgB = await orgOf(app, b.owner.token);
    const rows = await asDb(handle, { userId: b.owner.userId, orgId: orgB, companyId: b.company.id }, async (q) =>
      (await q(`select company_id from company_modules`)).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('ham SQL ile yazılmış tutarsız istisna (defter kapalı) bağımlıları da düşürür; arayüz bunu gösterir', async () => {
    const { owner, company, c } = await setup('Tutarsiz');
    const orgId = await orgOf(app, owner.token);
    const conn = await handle.pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.company_id', $3, true)`, [owner.userId, orgId, company.id]);
      await conn.query(`insert into company_modules (company_id, module, enabled) values ($1, 'core.ledger', false)`, [company.id]);
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }
    const m = byKey(await c.get('/api/company/modules'));
    for (const key of ['core.ledger', 'core.parties', 'core.inventory', 'core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'core.treasury']) {
      expect(m[key].enabled, key).toBe(false);
    }
    expect(m['core.settings'].enabled).toBe(true);
    // Bağımlı modülün ucu da kapalı
    expect((await c.get('/api/parties')).statusCode).toBe(403);
    // Defteri yeniden açmak istisnayı siler; bağımlılar geri gelir
    expect((await put(c, 'core.ledger', true)).statusCode).toBe(200);
    expect((await c.get('/api/parties')).statusCode).toBe(200);
  });

  it('kilitli modüle ham SQL ile yazılan istisna yok sayılır (panel/ayarlar hep açık)', async () => {
    const { owner, company, c } = await setup('Kilitli');
    const orgId = await orgOf(app, owner.token);
    const conn = await handle.pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.company_id', $3, true)`, [owner.userId, orgId, company.id]);
      await conn.query(`insert into company_modules (company_id, module, enabled) values ($1, 'core.settings', false)`, [company.id]);
      await conn.query('COMMIT');
    } finally {
      conn.release();
    }
    expect(byKey(await c.get('/api/company/modules'))['core.settings'].enabled).toBe(true);
    expect((await c.get('/api/company')).statusCode).toBeLessThan(500);
  });

  it('eşzamanlılık: bağımlıyı açarken gereksinimi kapatan iki istek kuralı aşamaz', async () => {
    for (let i = 0; i < 6; i++) {
      const { c } = await setup(`Yaris${i}`);
      expect((await invoicesOff(c)).statusCode).toBe(200);
      // Faturayı aç + stoğu kapat: ikisi birden olursa fatura açık ama stok kapalı kalırdı.
      const [open, close] = await Promise.all([put(c, 'core.invoices', true), put(c, 'core.inventory', false)]);
      const codes = [open.statusCode, close.statusCode].sort();
      expect(codes, `tur ${i}`).toEqual([200, 422]);
      const m = byKey(await c.get('/api/company/modules'));
      // Tutarlılık: fatura açıksa stok da açık
      if (m['core.invoices'].enabled) expect(m['core.inventory'].enabled).toBe(true);
    }
  });

  it('tam veri dışa aktarma kapalı modüllerden bağımsızdır (veri taşınabilirliği)', async () => {
    const { c } = await setup('Tasinir');
    expect((await c.post('/api/parties', { name: 'Taşınabilir Cari', kind: 'customer' })).statusCode).toBe(201);
    expect((await invoicesOff(c)).statusCode).toBe(200);
    expect((await treasuryOff(c)).statusCode).toBe(200);
    const res = await c.get('/api/exports/full-data?format=xlsx');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // Kapalı modülün ayrı rapor ucu ise kapalıdır
    expect((await c.get('/api/exports/fx-differences?format=csv&from=2020-01-01&to=2030-01-01')).statusCode).toBe(403);
  });
});
