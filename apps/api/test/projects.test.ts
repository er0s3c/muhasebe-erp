import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountIds,
  addMember,
  asDb,
  client,
  createCompany,
  day,
  execAsOwner,
  expectDbError,
  makeApp,
  orgOf,
  registerUser,
} from './helpers';

describe('şantiye projeleri (B1a): proje, iş kırılımı, bütçe, ilerleme, yevmiye boyutu', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const mkProject = async (c: C, body: Record<string, unknown> = {}) => {
    const res = await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own', ...body });
    if (res.statusCode !== 201) throw new Error(`project failed: ${res.body}`);
    return res.json().project as { id: string; code: string; status: string; kind: string };
  };
  type Wbs = { id: string; code: string; parentId: string | null; isLeaf: boolean; hasPostings: boolean; depth: number; isActive: boolean };
  const listWbs = async (c: C, projectId: string) => (await c.get(`/api/projects/${projectId}/wbs`)).json().wbs as Wbs[];
  const mkWbs = async (c: C, projectId: string, code: string, parentId?: string) => {
    const res = await c.post(`/api/projects/${projectId}/wbs`, { code, name: `İş ${code}`, ...(parentId ? { parentId } : {}) });
    if (res.statusCode !== 201) throw new Error(`wbs failed: ${res.body}`);
    return (res.json().wbs as Wbs[]).find((w) => w.code === code)!;
  };
  const mkParty = async (c: C, name: string, kind = 'customer') => {
    const res = await c.post('/api/parties', { name, kind });
    if (res.statusCode !== 201) throw new Error(`party failed: ${res.body}`);
    return res.json().party as { id: string };
  };
  /** Gider hesabına borç, sermayeye alacak; isteğe bağlı proje etiketi. */
  const entry = (c: C, ids: Record<string, string>, date: string, code: string, amount: string, tag: Record<string, unknown> = {}, post = true) =>
    c.post('/api/journal-entries', {
      entryDate: date,
      description: 'Şantiye gideri',
      post,
      lines: [
        { accountId: ids[code], currency: 'TRY', debit: amount, ...tag },
        { accountId: ids['500'], currency: 'TRY', credit: amount },
      ],
    });
  const budgetLines = (c: C, budgetId: string, lines: { wbsId: string; amount: string }[]) => c.put(`/api/project-budgets/${budgetId}/lines`, { lines });
  const newBudget = async (c: C, projectId: string, lines: { wbsId: string; amount: string }[], opts: { copy?: boolean; approve?: boolean } = {}) => {
    const created = await c.post(`/api/projects/${projectId}/budgets`, { copyFromCurrent: opts.copy ?? false });
    if (created.statusCode !== 201) throw new Error(`budget failed: ${created.body}`);
    const id = created.json().budget.id as string;
    if (lines.length > 0 || !opts.copy) {
      const put = await budgetLines(c, id, lines);
      if (put.statusCode !== 200) throw new Error(`budget lines failed: ${put.body}`);
    }
    if (opts.approve !== false) {
      const ok = await c.post(`/api/project-budgets/${id}/approve`);
      if (ok.statusCode !== 200) throw new Error(`approve failed: ${ok.body}`);
    }
    return id;
  };
  const taggedSum = (x: Ctx, projectId: string) =>
    asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) =>
      Number((await q(`select coalesce(sum(debit_base - credit_base), 0) as n from journal_lines where project_id = $1`, [projectId])).rows[0].n),
    );

  // ------------------------------------------------------------------ modül, yetki, proje

  it('modül yalnızca inşaat şirketinde: market şirketinde uçlar 403 MODULE_DISABLED, menüde yok', async () => {
    const market = await setup('Market', { sector: 'RETAIL_MARKET' });
    const res = await market.c.get('/api/projects');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODULE_DISABLED');
    const nav = (await market.c.get('/api/navigation')).json();
    expect(JSON.stringify(nav)).not.toContain('/projects');

    const x = await setup('Insaat');
    expect((await x.c.get('/api/projects')).statusCode).toBe(200);
    const navC = (await x.c.get('/api/navigation')).json();
    expect(JSON.stringify(navC)).toContain('/projects');
  });

  it('proje: otomatik kod PRJ-0001/0002, yinelenen kod 409, tür kuralları (işveren)', async () => {
    const x = await setup('Kod');
    const p1 = await mkProject(x.c);
    const p2 = await mkProject(x.c, { name: 'İkinci' });
    expect(p1.code).toBe('PRJ-0001');
    expect(p2.code).toBe('PRJ-0002');
    expect(p1.status).toBe('planned');

    const dup = await x.c.post('/api/projects', { name: 'Yinelenen', code: 'PRJ-0001' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('PROJECT_CODE_TAKEN');
    // Elle girilen kod otomatik sayacın ilerleyeceği numarayla çakışırsa atlanır
    await mkProject(x.c, { name: 'Elle', code: 'PRJ-0003' });
    const p4 = await mkProject(x.c, { name: 'Otomatik' });
    expect(p4.code).toBe('PRJ-0004');

    // contract: işveren zorunlu; own: işveren yok; tedarikçi işveren olamaz
    expect((await x.c.post('/api/projects', { name: 'İşverensiz', kind: 'contract' })).statusCode).toBe(400);
    const supplier = await mkParty(x.c, 'Tedarikçi A.Ş.', 'supplier');
    const customer = await mkParty(x.c, 'Müşteri Ltd.', 'customer');
    const both = await mkParty(x.c, 'Hem Hem', 'both');
    const sup = await x.c.post('/api/projects', { name: 'Yanlış işveren', kind: 'contract', clientPartyId: supplier.id });
    expect(sup.statusCode).toBe(422);
    expect(sup.json().error.code).toBe('PROJECT_CLIENT_KIND');
    expect((await x.c.post('/api/projects', { name: 'Kendi ama işverenli', kind: 'own', clientPartyId: customer.id })).statusCode).toBe(400);
    const ok = await mkProject(x.c, { name: 'Kuzey Villa', kind: 'contract', clientPartyId: customer.id });
    expect(ok.kind).toBe('contract');
    await mkProject(x.c, { name: 'İkili işveren', kind: 'contract', clientPartyId: both.id });

    const detail = (await x.c.get(`/api/projects/${ok.id}`)).json().project;
    expect(detail.clientName).toBe('Müşteri Ltd.');
    expect(detail.hasPostings).toBe(false);

    // Güncelleme: ad, tarih; tür değişmez; contract işverensiz bırakılamaz
    const upd = await x.c.patch(`/api/projects/${ok.id}`, { name: 'Kuzey Villa II', startDate: day(3, 1), endDate: day(11, 1) });
    expect(upd.json().project.name).toBe('Kuzey Villa II');
    expect((await x.c.patch(`/api/projects/${ok.id}`, { endDate: day(1, 1) })).statusCode).toBe(422);
    expect((await x.c.patch(`/api/projects/${ok.id}`, { clientPartyId: null })).statusCode).toBe(422);

    const list = (await x.c.get('/api/projects?kind=contract')).json();
    expect(list.projects.every((p: { kind: string }) => p.kind === 'contract')).toBe(true);
    expect((await x.c.get('/api/projects?q=kuzey')).json().projects).toHaveLength(1);
  });

  it('durum geçişleri: geçersiz geçiş 422; maliyetli proje iptal/silinemez; boş proje silinir', async () => {
    const x = await setup('Durum');
    const p = await mkProject(x.c);
    const st = (s: string) => x.c.post(`/api/projects/${p.id}/status`, { status: s });
    expect((await st('completed')).statusCode).toBe(422); // planned → completed yok
    expect((await st('active')).statusCode).toBe(200);
    expect((await st('on_hold')).statusCode).toBe(200);
    expect((await st('active')).statusCode).toBe(200);

    const w = await mkWbs(x.c, p.id, '1');
    expect((await entry(x.c, x.ids, day(3, 10), '770', '500', { projectId: p.id, wbsId: w.id })).statusCode).toBe(201);
    const cancel = await st('cancelled');
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('PROJECT_HAS_POSTINGS');
    const del = await x.c.delete(`/api/projects/${p.id}`);
    expect(del.statusCode).toBe(422);
    expect(del.json().error.code).toBe('PROJECT_HAS_POSTINGS');
    expect((await st('completed')).statusCode).toBe(200);
    expect((await st('active')).statusCode).toBe(200); // yeniden aç

    const empty = await mkProject(x.c, { name: 'Boş' });
    expect((await x.c.delete(`/api/projects/${empty.id}`)).statusCode).toBe(204);
    expect((await x.c.get(`/api/projects/${empty.id}`)).statusCode).toBe(404);

    const withWbs = await mkProject(x.c, { name: 'Yapılı' });
    await mkWbs(x.c, withWbs.id, 'A');
    expect((await x.c.delete(`/api/projects/${withWbs.id}`)).json().error.code).toBe('PROJECT_HAS_STRUCTURE');
    expect((await x.c.post(`/api/projects/${withWbs.id}/status`, { status: 'cancelled' })).statusCode).toBe(200);
  });

  it('yetkiler: muhasebeci hepsi, şantiye sorumlusu proje+ilerleme ama bütçe onayı yok, izleyici okur, satış 403', async () => {
    const x = await setup('Yetki');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const budgetId = await newBudget(x.c, p.id, [{ wbsId: w.id, amount: '1000' }], { approve: false });

    const acc = await addMember(app, x.c, x.company.id, 'accountant');
    const site = await addMember(app, x.c, x.company.id, 'site_manager');
    const viewer = await addMember(app, x.c, x.company.id, 'viewer');
    const sales = await addMember(app, x.c, x.company.id, 'sales');

    expect((await acc.client.post(`/api/project-budgets/${budgetId}/approve`)).statusCode).toBe(200);
    expect((await site.client.get('/api/projects')).statusCode).toBe(200);
    expect((await site.client.post('/api/projects', { name: 'Şef projesi' })).statusCode).toBe(201);
    expect((await site.client.post(`/api/projects/${p.id}/progress`, { asOfDate: day(4, 1), items: [{ wbsId: w.id, percent: '10' }] })).statusCode).toBe(201);
    expect((await site.client.post(`/api/projects/${p.id}/budgets`, {})).statusCode).toBe(403);
    expect((await site.client.post(`/api/project-budgets/${budgetId}/approve`)).statusCode).toBe(403);
    expect((await viewer.client.get(`/api/projects/${p.id}`)).statusCode).toBe(200);
    expect((await viewer.client.post('/api/projects', { name: 'İzleyici' })).statusCode).toBe(403);
    expect((await sales.client.get('/api/projects')).statusCode).toBe(403);
  });

  // ------------------------------------------------------------------ iş kırılımı (WBS)

  it('WBS: ağaç sırası, yaprak/üst, yinelenen kod 409, derinlik sınırı 6, döngüye taşıma reddi', async () => {
    const x = await setup('Wbs');
    const p = await mkProject(x.c);
    const a = await mkWbs(x.c, p.id, '1');
    const a1 = await mkWbs(x.c, p.id, '1.1', a.id);
    const a11 = await mkWbs(x.c, p.id, '1.1.1', a1.id);
    await mkWbs(x.c, p.id, '2');

    const list = await listWbs(x.c, p.id);
    expect(list.map((w) => w.code)).toEqual(['1', '1.1', '1.1.1', '2']);
    expect(list.map((w) => w.depth)).toEqual([1, 2, 3, 1]);
    expect(list.map((w) => w.isLeaf)).toEqual([false, false, true, true]);

    const dup = await x.c.post(`/api/projects/${p.id}/wbs`, { code: '1.1', name: 'Tekrar' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('WBS_CODE_TAKEN');

    // derinlik: 1 > 1.1 > 1.1.1 > d4 > d5 > d6 tamam, d7 reddedilir
    let parent = a11;
    for (const code of ['d4', 'd5', 'd6']) parent = await mkWbs(x.c, p.id, code, parent.id);
    const tooDeep = await x.c.post(`/api/projects/${p.id}/wbs`, { code: 'd7', name: 'Çok derin', parentId: parent.id });
    expect(tooDeep.statusCode).toBe(422);
    expect(tooDeep.json().error.code).toBe('PROJECT_RULE_VIOLATION');
    expect(tooDeep.json().error.message).toMatch(/6 seviye/);

    // kendi altına / torununun altına taşıma
    expect((await x.c.patch(`/api/project-wbs/${a.id}`, { parentId: a11.id })).json().error.code).toBe('PROJECT_RULE_VIOLATION');
    expect((await x.c.patch(`/api/project-wbs/${a.id}`, { parentId: a.id })).statusCode).toBe(422);
    // alt ağacı derin olan düğümü daha derine taşımak sınırı aşar
    const other = await mkWbs(x.c, p.id, '3');
    const deepMove = await x.c.patch(`/api/project-wbs/${a1.id}`, { parentId: other.id });
    expect(deepMove.statusCode).toBe(200); // 3 > 1.1 > 1.1.1 > d4 > d5 > d6 = 6 seviye
    const other2 = await mkWbs(x.c, p.id, '4');
    const other3 = await mkWbs(x.c, p.id, '4.1', other2.id);
    const over = await x.c.patch(`/api/project-wbs/${a1.id}`, { parentId: other3.id });
    expect(over.statusCode).toBe(422);

    // başka projenin düğümü üst olamaz
    const p2 = await mkProject(x.c, { name: 'Diğer' });
    const foreign = await x.c.post(`/api/projects/${p2.id}/wbs`, { code: 'X', name: 'Yabancı', parentId: a.id });
    expect(foreign.json().error.code).toBe('WBS_PARENT_INVALID');
  });

  it('WBS: kaydı (maliyet, bütçe, ilerleme) olan düğüme alt iş eklenemez, silinemez; yaprak silinir', async () => {
    const x = await setup('WbsKayit');
    const p = await mkProject(x.c);
    const cost = await mkWbs(x.c, p.id, 'M');
    const budgeted = await mkWbs(x.c, p.id, 'B');
    const progressed = await mkWbs(x.c, p.id, 'P');
    const free = await mkWbs(x.c, p.id, 'F');

    expect((await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: p.id, wbsId: cost.id })).statusCode).toBe(201);
    await newBudget(x.c, p.id, [{ wbsId: budgeted.id, amount: '50' }]);
    expect((await x.c.post(`/api/projects/${p.id}/progress`, { asOfDate: day(4, 1), items: [{ wbsId: progressed.id, percent: '5' }] })).statusCode).toBe(201);

    for (const w of [cost, budgeted, progressed]) {
      const child = await x.c.post(`/api/projects/${p.id}/wbs`, { code: `${w.code}.1`, name: 'Alt', parentId: w.id });
      expect(child.statusCode, w.code).toBe(422);
      expect(child.json().error.code).toBe('PROJECT_RULE_VIOLATION');
      expect(child.json().error.message).toMatch(/alt iş eklenemez/);
      const del = await x.c.delete(`/api/project-wbs/${w.id}`);
      expect(del.statusCode, w.code).toBe(422);
    }
    const flags = Object.fromEntries((await listWbs(x.c, p.id)).map((w) => [w.code, w.hasPostings]));
    expect(flags).toEqual({ M: true, B: true, P: true, F: false });

    // kaydı olmayan yaprağa alt iş eklenir; üst düğüm silinemez, yaprak silinir
    const c1 = await mkWbs(x.c, p.id, 'F.1', free.id);
    expect((await x.c.delete(`/api/project-wbs/${free.id}`)).statusCode).toBe(422);
    expect((await x.c.delete(`/api/project-wbs/${c1.id}`)).statusCode).toBe(204);
    // pasifleştirme
    expect((await x.c.patch(`/api/project-wbs/${cost.id}`, { isActive: false })).statusCode).toBe(200);
    const inactive = await entry(x.c, x.ids, day(3, 11), '770', '10', { projectId: p.id, wbsId: cost.id });
    expect(inactive.statusCode).toBe(422);
    expect(inactive.json().error.code).toBe('WBS_INACTIVE');
  });

  // ------------------------------------------------------------------ bütçe revizyonları

  it('bütçe: taslak → onay → yürürlükteki; yeni revizyon öncekini devre dışı bırakır; boş/üst düğüm/ikinci taslak reddedilir', async () => {
    const x = await setup('Butce');
    const p = await mkProject(x.c);
    const root = await mkWbs(x.c, p.id, '1');
    const kazi = await mkWbs(x.c, p.id, '1.1', root.id);
    const temel = await mkWbs(x.c, p.id, '1.2', root.id);

    const created = await x.c.post(`/api/projects/${p.id}/budgets`, { title: 'İlk bütçe' });
    expect(created.statusCode).toBe(201);
    const b1 = created.json().budget.id as string;
    expect(created.json().budget.revisionNo).toBe(1);
    expect(created.json().budget.status).toBe('draft');

    // ikinci taslak açılamaz; boş taslak onaylanamaz; üst düğüme bütçe girilemez
    expect((await x.c.post(`/api/projects/${p.id}/budgets`, {})).json().error.code).toBe('BUDGET_DRAFT_EXISTS');
    expect((await x.c.post(`/api/project-budgets/${b1}/approve`)).json().error.code).toBe('BUDGET_EMPTY');
    const onParent = await budgetLines(x.c, b1, [{ wbsId: root.id, amount: '100' }]);
    expect(onParent.statusCode).toBe(422);
    expect(onParent.json().error.code).toBe('PROJECT_RULE_VIOLATION');

    const put = await budgetLines(x.c, b1, [
      { wbsId: kazi.id, amount: '1000' },
      { wbsId: temel.id, amount: '4000.50' },
    ]);
    expect(put.statusCode).toBe(200);
    expect(put.json().budget.total).toBe('5000.50');
    // aynı iş kalemi iki kez → doğrulama hatası
    expect((await budgetLines(x.c, b1, [{ wbsId: kazi.id, amount: '1' }, { wbsId: kazi.id, amount: '2' }])).statusCode).toBe(400);
    // sıfır tutarlı satırlar atlanır, PUT tüm satırları değiştirir
    const zero = await budgetLines(x.c, b1, [{ wbsId: kazi.id, amount: '1000' }, { wbsId: temel.id, amount: '0' }]);
    expect(zero.json().lines).toHaveLength(1);
    const replaced = await budgetLines(x.c, b1, [{ wbsId: kazi.id, amount: '1000' }, { wbsId: temel.id, amount: '4000.50' }]);
    expect(replaced.json().lines).toHaveLength(2);

    const ok = await x.c.post(`/api/project-budgets/${b1}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().budget.status).toBe('approved');
    // onaylı revizyon düzenlenemez / silinemez
    expect((await budgetLines(x.c, b1, [{ wbsId: kazi.id, amount: '1' }])).json().error.code).toBe('BUDGET_NOT_DRAFT');
    expect((await x.c.delete(`/api/project-budgets/${b1}`)).json().error.code).toBe('BUDGET_NOT_DRAFT');
    expect((await x.c.post(`/api/project-budgets/${b1}/approve`)).json().error.code).toBe('BUDGET_NOT_DRAFT');

    // rev.2: yürürlüktekinden kopyala, tutarı değiştir, onayla
    const b2 = await newBudget(x.c, p.id, [{ wbsId: kazi.id, amount: '1500' }, { wbsId: temel.id, amount: '4000.50' }], { copy: true });
    const list = (await x.c.get(`/api/projects/${p.id}/budgets`)).json().budgets as { id: string; revisionNo: number; status: string; isCurrent: boolean; total: string }[];
    expect(list.map((b) => [b.revisionNo, b.status, b.isCurrent])).toEqual([
      [2, 'approved', true],
      [1, 'superseded', false],
    ]);
    expect(list[0]!.total).toBe('5500.50');
    expect(list[1]!.id).toBe(b1);
    expect(b2).not.toBe(b1);

    // kopyalı taslak, kopyalanan satırları taşır; taslak silinebilir; silinince numara tekrar kullanılır
    const b3 = await x.c.post(`/api/projects/${p.id}/budgets`, { copyFromCurrent: true });
    expect(b3.json().budget.revisionNo).toBe(3);
    expect(b3.json().lines).toHaveLength(2);
    expect((await x.c.delete(`/api/project-budgets/${b3.json().budget.id}`)).statusCode).toBe(204);
    const b3again = await x.c.post(`/api/projects/${p.id}/budgets`, {});
    expect(b3again.json().budget.revisionNo).toBe(3);
  });

  it('bütçe: eşzamanlı iki onay → yalnızca biri başarılı, tek yürürlükteki revizyon', async () => {
    const x = await setup('ButceYaris');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    await newBudget(x.c, p.id, [{ wbsId: w.id, amount: '100' }]); // rev.1 onaylı
    const created = await x.c.post(`/api/projects/${p.id}/budgets`, { copyFromCurrent: true });
    const b2 = created.json().budget.id as string;

    const results = await Promise.all([x.c.post(`/api/project-budgets/${b2}/approve`), x.c.post(`/api/project-budgets/${b2}/approve`)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    const list = (await x.c.get(`/api/projects/${p.id}/budgets`)).json().budgets as { status: string; isCurrent: boolean }[];
    expect(list.filter((b) => b.status === 'approved')).toHaveLength(1);
    expect(list.filter((b) => b.isCurrent)).toHaveLength(1);
  });

  it('bütçe değişmezliği (ham SQL): onaylı revizyon ve satırları UPDATE/DELETE edilemez; taslak dışında satır eklenemez; numara atlanamaz', async () => {
    const x = await setup('ButceSql');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const w2 = await mkWbs(x.c, p.id, '2');
    const b1 = await newBudget(x.c, p.id, [{ wbsId: w.id, amount: '100' }]);

    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      let e = await expectDbError(q, `update project_budget_lines set amount = 1 where budget_id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      e = await expectDbError(q, `delete from project_budget_lines where budget_id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      e = await expectDbError(q, `insert into project_budget_lines (id, company_id, budget_id, project_id, wbs_id, amount) values ($1, $2, $3, $4, $5, 5)`, [randomUUID(), x.company.id, b1, p.id, w2.id]);
      expect(e.code).toBe('ERP09');
      e = await expectDbError(q, `update project_budgets set revision_no = 9 where id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      e = await expectDbError(q, `update project_budgets set status = 'draft', approved_at = null where id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      e = await expectDbError(q, `delete from project_budgets where id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      // yeni yürürlükte onaylı yokken superseded'e çekilemez
      e = await expectDbError(q, `update project_budgets set status = 'superseded' where id = $1`, [b1]);
      expect(e.code).toBe('ERP09');
      // ardışık olmayan numara
      e = await expectDbError(q, `insert into project_budgets (id, company_id, project_id, revision_no, status) values ($1, $2, $3, 7, 'draft')`, [randomUUID(), x.company.id, p.id]);
      expect(e.code).toBe('ERP09');
      // doğrudan onaylı olarak açılamaz
      e = await expectDbError(q, `insert into project_budgets (id, company_id, project_id, revision_no, status, approved_at) values ($1, $2, $3, 2, 'approved', now())`, [randomUUID(), x.company.id, p.id]);
      expect(e.code).toBe('ERP09');
    });
  });

  // ------------------------------------------------------------------ ilerleme

  it('ilerleme: en son kayıt geçerli (asOf süzmesi), geçmiş durur; değiştirilemez/silinemez (ham SQL)', async () => {
    const x = await setup('Ilerleme');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const post = (asOfDate: string, percent: string, extra: Record<string, unknown> = {}) =>
      x.c.post(`/api/projects/${p.id}/progress`, { asOfDate, items: [{ wbsId: w.id, percent, ...extra }] });

    expect((await post(day(3, 1), '20')).statusCode).toBe(201);
    expect((await post(day(5, 1), '45', { etcOverride: '700.50', note: 'Kalıp gecikti' })).statusCode).toBe(201);
    expect((await post(day(5, 1), '50')).statusCode).toBe(201); // aynı gün düzeltme: sonraki kayıt geçerli

    const at = async (asOf: string) => (await x.c.get(`/api/projects/${p.id}/progress?asOf=${asOf}`)).json();
    expect((await at(day(2, 1))).latest).toHaveLength(0);
    expect((await at(day(3, 15))).latest[0].percent).toBe('20.00');
    const may = await at(day(5, 1));
    expect(may.latest[0].percent).toBe('50.00');
    expect(may.latest[0].etcOverride).toBeNull();
    expect(may.history).toHaveLength(3);

    // doğrulama: yüzde 100'ü aşamaz, sayı biçimi, yabancı iş kalemi
    expect((await post(day(6, 1), '101')).statusCode).toBe(400);
    expect((await post(day(6, 1), '-1')).statusCode).toBe(400);
    const other = await mkProject(x.c, { name: 'Diğer' });
    const ow = await mkWbs(x.c, other.id, 'Z');
    const cross = await x.c.post(`/api/projects/${p.id}/progress`, { asOfDate: day(6, 1), items: [{ wbsId: ow.id, percent: '10' }] });
    expect(cross.json().error.code).toBe('WBS_NOT_FOUND');

    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      // erp_app'in yetkisi yalnızca SELECT/INSERT; tetikleyici ikinci savunma olarak sahip rolle sınanır
      const e = await expectDbError(q, `update project_progress set percent = 1 where project_id = $1`, [p.id]);
      expect(e.message).toMatch(/permission denied|değiştirilemez/);
    });
    const rows = await execAsOwner(`select 1 from project_progress where project_id = $1`, [p.id]);
    expect(rows.rows.length).toBe(3);
    await expect(execAsOwner(`update project_progress set percent = 1 where project_id = $1`, [p.id])).rejects.toMatchObject({ code: 'ERP09' });
    await expect(execAsOwner(`delete from project_progress where project_id = $1`, [p.id])).rejects.toMatchObject({ code: 'ERP09' });
  });

  // ------------------------------------------------------------------ yevmiye boyutu

  it('yevmiye: maliyet hesabına proje+iş kalemi etiketi yazılır ve detayda görünür; ters kayıt etiketi nötrler', async () => {
    const x = await setup('Yevmiye');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1.1');
    const res = await entry(x.c, x.ids, day(3, 10), '770', '1250.75', { projectId: p.id, wbsId: w.id });
    expect(res.statusCode).toBe(201);
    const e = res.json().entry;
    const tagged = e.lines.find((l: { accountCode: string }) => l.accountCode === '770');
    expect(tagged).toMatchObject({ projectId: p.id, projectCode: p.code, wbsId: w.id, wbsCode: '1.1' });
    expect(e.lines.find((l: { accountCode: string }) => l.accountCode === '500').projectId).toBeNull();
    expect(await taggedSum(x, p.id)).toBeCloseTo(1250.75);

    // proje yalnızca projeli satırı etkiler; iş kalemi olmadan yalnız proje de olur
    expect((await entry(x.c, x.ids, day(3, 11), '720', '200', { projectId: p.id })).statusCode).toBe(201);
    expect(await taggedSum(x, p.id)).toBeCloseTo(1450.75);

    // ters kayıt: etiket kopyalanır, toplam sıfırlanır; proje tamamlanmış olsa da yazılır
    expect((await x.c.post(`/api/projects/${p.id}/status`, { status: 'active' })).statusCode).toBe(200);
    const rev = await x.c.post(`/api/journal-entries/${e.id}/reverse`, { entryDate: day(3, 12) });
    expect(rev.statusCode).toBe(201);
    expect(await taggedSum(x, p.id)).toBeCloseTo(200);
    expect((await x.c.post(`/api/projects/${p.id}/status`, { status: 'completed' })).statusCode).toBe(200);
    const blocked = await entry(x.c, x.ids, day(3, 13), '770', '5', { projectId: p.id });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('PROJECT_CLOSED');
  });

  it('yevmiye: bilanço hesabına, yabancı projenin iş kalemine, üst düğüme etiket reddedilir; iş kalemi projesiz verilemez', async () => {
    const x = await setup('YevmiyeRed');
    const p = await mkProject(x.c);
    const p2 = await mkProject(x.c, { name: 'Diğer' });
    const root = await mkWbs(x.c, p.id, '1');
    const leaf = await mkWbs(x.c, p.id, '1.1', root.id);
    const foreign = await mkWbs(x.c, p2.id, 'X');

    const asset = await entry(x.c, x.ids, day(3, 10), '255', '100', { projectId: p.id });
    expect(asset.statusCode).toBe(422);
    expect(asset.json().error.code).toBe('PROJECT_ACCOUNT_NOT_ALLOWED');
    const wrong = await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: p.id, wbsId: foreign.id });
    expect(wrong.json().error.code).toBe('WBS_NOT_FOUND');
    const parent = await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: p.id, wbsId: root.id });
    expect(parent.json().error.code).toBe('WBS_NOT_LEAF');
    const noProject = await entry(x.c, x.ids, day(3, 10), '770', '100', { wbsId: leaf.id });
    expect(noProject.statusCode).toBe(400);
    const unknown = await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: randomUUID() });
    expect(unknown.json().error.code).toBe('PROJECT_NOT_FOUND');
    // iptal edilmiş projeye yazılamaz
    const dead = await mkProject(x.c, { name: 'İptal' });
    await x.c.post(`/api/projects/${dead.id}/status`, { status: 'cancelled' });
    expect((await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: dead.id })).json().error.code).toBe('PROJECT_CLOSED');
    expect(await taggedSum(x, p.id)).toBe(0);
  });

  it('yevmiye taslağı: etiketli taslak düzenlenebilir ve kaydedilince etiket değiştirilemez olur', async () => {
    const x = await setup('Taslak');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const w2 = await mkWbs(x.c, p.id, '2');
    const draft = await entry(x.c, x.ids, day(3, 10), '770', '300', { projectId: p.id, wbsId: w.id }, false);
    expect(draft.statusCode).toBe(201);
    const id = draft.json().entry.id as string;
    const upd = await x.c.put(`/api/journal-entries/${id}`, {
      entryDate: day(3, 10),
      description: 'Düzeltildi',
      lines: [
        { accountId: x.ids['770'], currency: 'TRY', debit: '300', projectId: p.id, wbsId: w2.id },
        { accountId: x.ids['500'], currency: 'TRY', credit: '300' },
      ],
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().entry.lines.find((l: { accountCode: string }) => l.accountCode === '770').wbsCode).toBe('2');
    const posted = await x.c.post(`/api/journal-entries/${id}/post`);
    expect(posted.statusCode).toBe(200);

    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      const e = await expectDbError(q, `update journal_lines set wbs_id = $2 where entry_id = $1 and project_id is not null`, [id, w.id]);
      expect(e.code).toBe('ERP01'); // kaydedilmiş satır değiştirilemez (mevcut koruma)
      const e2 = await expectDbError(q, `update journal_lines set project_id = null, wbs_id = null where entry_id = $1 and project_id is not null`, [id]);
      expect(e2.code).toBe('ERP01');
    });
  });

  it('modül kapatılınca etiket reddedilir (PROJECT_MODULE_DISABLED); açılınca çalışır', async () => {
    const x = await setup('ModulKapali');
    const p = await mkProject(x.c);
    // Taşeron modülü projeye bağlıdır: önce o kapatılır, proje modülü bağımlı açıkken kapatılamaz
    expect((await x.c.put('/api/company/modules/construction.projects', { enabled: false })).statusCode).toBe(422);
    expect((await x.c.put('/api/company/modules/construction.subcontracts', { enabled: false })).statusCode).toBe(200);
    expect((await x.c.put('/api/company/modules/construction.procurement', { enabled: false })).statusCode).toBe(200);
    const off = await x.c.put('/api/company/modules/construction.projects', { enabled: false });
    expect(off.statusCode).toBe(200);
    const res = await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: p.id });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROJECT_MODULE_DISABLED');
    expect((await x.c.get('/api/projects')).json().error.code).toBe('MODULE_DISABLED');
    // etiketsiz yevmiye etkilenmez
    expect((await entry(x.c, x.ids, day(3, 10), '770', '100')).statusCode).toBe(201);
    expect((await x.c.put('/api/company/modules/construction.projects', { enabled: true })).statusCode).toBe(200);
    expect((await x.c.put('/api/company/modules/construction.subcontracts', { enabled: true })).statusCode).toBe(200);
    expect((await x.c.put('/api/company/modules/construction.procurement', { enabled: true })).statusCode).toBe(200);
    expect((await entry(x.c, x.ids, day(3, 10), '770', '100', { projectId: p.id })).statusCode).toBe(201);
  });

  // ------------------------------------------------------------------ veritabanı kuralları (ham SQL)

  it('ham SQL: ERP09 kuralları — yaprak olmayan iş kalemi, bilanço hesabı, kapalı proje (ters kayıt hariç), modül dışı değişmezler', async () => {
    const x = await setup('HamSql');
    const p = await mkProject(x.c);
    const p2 = await mkProject(x.c, { name: 'Diğer' });
    const root = await mkWbs(x.c, p.id, '1');
    const leaf = await mkWbs(x.c, p.id, '1.1', root.id);
    const foreign = await mkWbs(x.c, p2.id, 'X');
    const draft = await entry(x.c, x.ids, day(3, 10), '770', '10', {}, false);
    const entryId = draft.json().entry.id as string;

    const insertLine = (account: string, projectId: string | null, wbsId: string | null, lineNo = 50): [string, unknown[]] =>
      [
        `insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, fx_rate, debit, credit, debit_base, credit_base, project_id, wbs_id)
         values ($1, $2, $3, $4, $5, 'TRY', 1, 5, 0, 5, 0, $6, $7)`,
        [randomUUID(), x.company.id, entryId, lineNo, x.ids[account], projectId, wbsId],
      ];

    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      // geçerli: yaprak + gider hesabı
      await q(...insertLine('770', p.id, leaf.id, 50));
      // üst düğüm
      expect((await expectDbError(q, ...insertLine('770', p.id, root.id, 51))).code).toBe('ERP09');
      // bilanço hesabı (255 demirbaş)
      expect((await expectDbError(q, ...insertLine('255', p.id, null, 52))).code).toBe('ERP09');
      // yabancı projenin iş kalemi: tetikleyici reddeder (bileşik FK de çift tutmadığı için ikinci savunmadır)
      expect((await expectDbError(q, ...insertLine('770', p.id, foreign.id, 53))).code).toBe('ERP09');
      // iş kalemi projesiz: CHECK
      expect((await expectDbError(q, ...insertLine('770', null, leaf.id, 54))).code).toBe('23514');
      // var olmayan proje
      expect((await expectDbError(q, ...insertLine('770', randomUUID(), null, 55))).code).toBe('ERP09');
    });

    // kapalı proje: yeni satır reddedilir, ters kayıt fişine yazılabilir
    await x.c.post(`/api/projects/${p.id}/status`, { status: 'active' });
    const real = await entry(x.c, x.ids, day(3, 11), '770', '40', { projectId: p.id, wbsId: leaf.id });
    await x.c.post(`/api/projects/${p.id}/status`, { status: 'completed' });
    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      expect((await expectDbError(q, ...insertLine('770', p.id, leaf.id, 60))).code).toBe('ERP09');
    });
    const rev = await x.c.post(`/api/journal-entries/${real.json().entry.id}/reverse`, { entryDate: day(3, 12) });
    expect(rev.statusCode).toBe(201);
  });

  it('ham SQL: proje türü/kodu değişmez, geçersiz durum geçişi ve işveren türü (proje koruması)', async () => {
    const x = await setup('ProjeSql');
    const customer = await mkParty(x.c, 'Müşteri', 'customer');
    const supplier = await mkParty(x.c, 'Tedarikçi', 'supplier');
    const own = await mkProject(x.c);
    const contract = await mkProject(x.c, { name: 'Sözleşmeli', kind: 'contract', clientPartyId: customer.id });
    await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => {
      expect((await expectDbError(q, `update projects set kind = 'contract', client_party_id = $2 where id = $1`, [own.id, customer.id])).code).toBe('ERP09');
      expect((await expectDbError(q, `update projects set code = 'XYZ' where id = $1`, [own.id])).code).toBe('ERP09');
      expect((await expectDbError(q, `update projects set status = 'completed' where id = $1`, [own.id])).code).toBe('ERP09'); // planned → completed
      expect((await expectDbError(q, `update projects set client_party_id = $2 where id = $1`, [contract.id, supplier.id])).code).toBe('ERP09');
      expect((await expectDbError(q, `update projects set client_party_id = null where id = $1`, [contract.id])).code).toBe('ERP09');
    });
  });

  // ------------------------------------------------------------------ RLS ve eşzamanlılık

  it('RLS: başka şirketin projesi görünmez, bağlanamaz, etiketlenemez', async () => {
    const a = await setup('RlsA');
    const b = await setup('RlsB');
    const pa = await mkProject(a.c);
    const wa = await mkWbs(a.c, pa.id, '1');
    const pb = await mkProject(b.c);

    expect((await b.c.get(`/api/projects/${pa.id}`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/projects/${pa.id}/wbs`)).statusCode).toBe(404);
    expect((await b.c.post(`/api/projects/${pa.id}/status`, { status: 'active' })).statusCode).toBe(404);
    expect((await b.c.get('/api/projects')).json().projects.map((p: { id: string }) => p.id)).toEqual([pb.id]);
    const cross = await entry(b.c, b.ids, day(3, 10), '770', '10', { projectId: pa.id, wbsId: wa.id });
    expect(cross.json().error.code).toBe('PROJECT_NOT_FOUND');
    // B bağlamında A'nın projesine ham SQL ile satır bağlama: RLS görünürlüğü + FK
    const draft = await entry(b.c, b.ids, day(3, 10), '770', '10', {}, false);
    await asDb(handle, { companyId: b.company.id, orgId: b.orgId }, async (q) => {
      const seen = await q(`select count(*)::int as n from projects where id = $1`, [pa.id]);
      expect(seen.rows[0].n).toBe(0);
      const e = await expectDbError(
        q,
        `insert into journal_lines (id, company_id, entry_id, line_no, account_id, currency_code, fx_rate, debit, credit, debit_base, credit_base, project_id)
         values ($1, $2, $3, 70, $4, 'TRY', 1, 5, 0, 5, 0, $5)`,
        [randomUUID(), b.company.id, draft.json().entry.id, b.ids['770'], pa.id],
      );
      expect(['23503', 'ERP09']).toContain(e.code);
    });
  });

  it('eşzamanlılık: yaprağa kayıt yazarken alt iş eklenemez (iki yönde serileşir, geride ERP09 kalır)', async () => {
    const x = await setup('Yaris');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const w2 = await mkWbs(x.c, p.id, '2');
    const ctx = [x.s.userId, x.orgId, x.company.id];

    const open = async () => {
      const conn = await handle.pool.connect();
      await conn.query('BEGIN');
      await conn.query(`select set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.company_id', $3, true)`, ctx);
      await conn.query(`set local lock_timeout = '400ms'`);
      return conn;
    };
    const addChild = (conn: Awaited<ReturnType<typeof open>>, parentId: string, code: string) =>
      conn.query(`insert into project_wbs (id, company_id, project_id, parent_id, code, name) values ($1, $2, $3, $4, $5, 'Alt')`, [randomUUID(), x.company.id, p.id, parentId, code]);
    const addProgress = (conn: Awaited<ReturnType<typeof open>>, wbsId: string) =>
      conn.query(`insert into project_progress (id, company_id, project_id, wbs_id, as_of_date, percent) values ($1, $2, $3, $4, current_date, 10)`, [randomUUID(), x.company.id, p.id, wbsId]);

    // 1) kayıt yazan işlem açıkken alt iş ekleme bekler (kilit zaman aşımı), kayıt işlenince ERP09 alır
    const t1 = await open();
    const t2 = await open();
    try {
      await addProgress(t1, w.id);
      await expect(addChild(t2, w.id, '1.1')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await t1.query('COMMIT');
      await t2.query('ROLLBACK');
      t1.release();
      t2.release();
    }
    const t3 = await open();
    try {
      await expect(addChild(t3, w.id, '1.1')).rejects.toMatchObject({ code: 'ERP09' });
    } finally {
      await t3.query('ROLLBACK');
      t3.release();
    }

    // 2) alt iş ekleyen işlem açıkken kayıt yazma bekler, alt iş işlenince yaprak olmadığı için ERP09 alır
    const t4 = await open();
    const t5 = await open();
    try {
      await addChild(t4, w2.id, '2.1');
      await expect(addProgress(t5, w2.id)).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await t4.query('COMMIT');
      await t5.query('ROLLBACK');
      t4.release();
      t5.release();
    }
    const t6 = await open();
    try {
      await expect(addProgress(t6, w2.id)).rejects.toMatchObject({ code: 'ERP09' });
    } finally {
      await t6.query('ROLLBACK');
      t6.release();
    }
  });
});
