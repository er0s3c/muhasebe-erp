import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../src/files/xlsx-read';
import { accountIds, addMember, asDb, client, createCompany, day, makeApp, orgOf, registerUser } from './helpers';

describe('şantiye projeleri (B1b): kaynaklar (fatura, stok, kasa), maliyet raporu, dışa aktarma', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string, overrides: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, overrides);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids, orgId: await orgOf(app, s.token) };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;
  type C = Ctx['c'];

  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`istek başarısız (${res.statusCode}): ${res.body}`);
    return res.json();
  };
  const mkProject = async (c: C, body: Record<string, unknown> = {}) => (await ok(c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own', ...body }))).project as { id: string; code: string };
  type Wbs = { id: string; code: string };
  const mkWbs = async (c: C, projectId: string, code: string, parentId?: string) =>
    ((await ok(c.post(`/api/projects/${projectId}/wbs`, { code, name: `İş ${code}`, ...(parentId ? { parentId } : {}) }))).wbs as Wbs[]).find((w) => w.code === code)!;
  const approveBudget = async (c: C, projectId: string, lines: { wbsId: string; amount: string }[]) => {
    const b = (await ok(c.post(`/api/projects/${projectId}/budgets`, {}))).budget.id as string;
    await ok(c.put(`/api/project-budgets/${b}/lines`, { lines }));
    await ok(c.post(`/api/project-budgets/${b}/approve`));
    return b;
  };
  const progress = (c: C, projectId: string, asOfDate: string, items: { wbsId: string; percent: string; etcOverride?: string }[]) =>
    ok(c.post(`/api/projects/${projectId}/progress`, { asOfDate, items }));
  const entry = (c: C, ids: Record<string, string>, date: string, code: string, amount: string, tag: Record<string, unknown> = {}, counter = '500', side: 'debit' | 'credit' = 'debit') =>
    c.post('/api/journal-entries', {
      entryDate: date,
      description: 'Şantiye kaydı',
      post: true,
      lines: [
        { accountId: ids[code], currency: 'TRY', [side]: amount, ...tag },
        { accountId: ids[counter], currency: 'TRY', [side === 'debit' ? 'credit' : 'debit']: amount },
      ],
    });
  const report = async (c: C, projectId: string, asOf = day(12, 31)) => (await ok(c.get(`/api/projects/${projectId}/cost-report?asOf=${asOf}`))) as {
    project: { code: string };
    budget: { revisionNo: number } | null;
    rows: Record<string, any>[];
    totals: Record<string, any>;
  };
  const rowOf = (r: Awaited<ReturnType<typeof report>>, code: string) => r.rows.find((x) => x.code === code)!;
  const taggedLines = (x: Ctx, sourceId: string) =>
    asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) =>
      (
        await q(
          `select a.code as account, pw.code as wbs, p.code as project, jl.debit_base::float as d, jl.credit_base::float as c
             from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
             left join projects p on p.id = jl.project_id left join project_wbs pw on pw.id = jl.wbs_id
            where je.source_id = $1 and je.reversal_of_id is null order by jl.line_no`,
          [sourceId],
        )
      ).rows as { account: string; wbs: string | null; project: string | null; d: number; c: number }[],
    );
  const projectNet = (x: Ctx, projectId: string) =>
    asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) => Number((await q(`select coalesce(sum(debit_base - credit_base), 0) as n from journal_lines where project_id = $1`, [projectId])).rows[0].n));

  // ------------------------------------------------------------------ maliyet raporu

  it('maliyet raporu: ağaç toplamları, EAC/ETC/CPI, atanmamış satır, asOf süzmesi, gelir ayrı', async () => {
    const x = await setup('Rapor');
    const p = await mkProject(x.c);
    const root = await mkWbs(x.c, p.id, '1');
    const kazi = await mkWbs(x.c, p.id, '1.1', root.id);
    const temel = await mkWbs(x.c, p.id, '1.2', root.id);
    const ince = await mkWbs(x.c, p.id, '2');
    await approveBudget(x.c, p.id, [
      { wbsId: kazi.id, amount: '1000' },
      { wbsId: temel.id, amount: '4000' },
      { wbsId: ince.id, amount: '2000' },
    ]);

    // Gerçekleşen: 1.1 → 400 (Mart), 1.2 → 4.500 (Haziran); iş kalemi atanmamış 100; gelir 1.000 (60x)
    expect((await entry(x.c, x.ids, day(3, 10), '770', '400', { projectId: p.id, wbsId: kazi.id })).statusCode).toBe(201);
    expect((await entry(x.c, x.ids, day(6, 10), '710', '4500', { projectId: p.id, wbsId: temel.id })).statusCode).toBe(201);
    expect((await entry(x.c, x.ids, day(6, 11), '720', '100', { projectId: p.id })).statusCode).toBe(201);
    expect((await entry(x.c, x.ids, day(6, 12), '600', '1000', { projectId: p.id }, '500', 'credit')).statusCode).toBe(201);
    await progress(x.c, p.id, day(6, 30), [{ wbsId: kazi.id, percent: '50' }]);

    const r = await report(x.c, p.id);
    expect(r.budget!.revisionNo).toBe(1);
    // Yaprak: ilerlemeli — BAC 1.000, AC 400, %50 → EV 500, ETC 500, EAC 900, sapma +100, CPI 1,25
    expect(rowOf(r, '1.1')).toMatchObject({ budget: '1000.00', actual: '400.00', percent: '50.00', earnedValue: '500.00', etc: '500.00', eac: '900.00', variance: '100.00', cpi: '1.2500', isLeaf: true });
    // Yaprak: ilerlemesiz, bütçe aşıldı — ETC 0, EAC = AC
    expect(rowOf(r, '1.2')).toMatchObject({ budget: '4000.00', actual: '4500.00', remaining: '-500.00', etc: '0.00', eac: '4500.00', variance: '-500.00', percent: null, cpi: null });
    expect(rowOf(r, '2')).toMatchObject({ budget: '2000.00', actual: '0.00', etc: '2000.00', eac: '2000.00', variance: '0.00' });
    // Üst düğüm: yaprakların toplamı; yüzde = ΣEV / ΣBAC
    expect(rowOf(r, '1')).toMatchObject({ budget: '5000.00', actual: '4900.00', earnedValue: '500.00', percent: '10.00', etc: '500.00', eac: '5400.00', variance: '-400.00', cpi: '1.2500', isLeaf: false });
    // Atanmamış satır (bütçesiz)
    const unassigned = r.rows.find((row) => row.unassigned)!;
    expect(unassigned).toMatchObject({ wbsId: null, actual: '100.00', eac: '100.00', variance: '-100.00', budget: '0.00' });
    // Toplam: BAC 7.000, AC 5.000, ETC 2.500, EAC 7.500 + atanmamış 100 → 7.500
    expect(r.totals).toMatchObject({ budget: '7000.00', actual: '5000.00', etc: '2500.00', eac: '7500.00', variance: '-500.00', revenue: '1000.00' });
    // Gelir maliyete girmez
    expect(Number(r.totals.actual)).toBe(5000);

    // asOf: Nisan sonunda yalnızca Mart'taki 400 vardır; ilerleme o tarihte henüz girilmemiştir
    const april = await report(x.c, p.id, day(4, 30));
    expect(rowOf(april, '1.1')).toMatchObject({ actual: '400.00', percent: null, etc: '600.00', eac: '1000.00' });
    expect(rowOf(april, '1.2').actual).toBe('0.00');
    expect(april.totals).toMatchObject({ actual: '400.00', revenue: '0.00' });

    // ETC elle girilirse öncelikli: 1.1 için 700 → EAC 1.100, sapma −100
    await progress(x.c, p.id, day(7, 15), [{ wbsId: kazi.id, percent: '50', etcOverride: '700' }]);
    const overridden = await report(x.c, p.id);
    expect(rowOf(overridden, '1.1')).toMatchObject({ etc: '700.00', eac: '1100.00', variance: '-100.00' });
    expect(rowOf(overridden, '1.1').progress).toMatchObject({ percent: '50.00', etcOverride: '700.00', asOfDate: day(7, 15) });
  });

  it('bütçe revizyonu yürürlüğe girince rapor yeni bütçeyle hesaplanır, geçmiş revizyon durur', async () => {
    const x = await setup('Revizyon');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    await approveBudget(x.c, p.id, [{ wbsId: w.id, amount: '1000' }]);
    await entry(x.c, x.ids, day(3, 10), '770', '1200', { projectId: p.id, wbsId: w.id });
    expect(rowOf(await report(x.c, p.id), '1')).toMatchObject({ budget: '1000.00', variance: '-200.00' });

    const b2 = (await ok(x.c.post(`/api/projects/${p.id}/budgets`, { copyFromCurrent: true }))).budget.id as string;
    await ok(x.c.put(`/api/project-budgets/${b2}/lines`, { lines: [{ wbsId: w.id, amount: '1500' }] }));
    // taslak henüz yürürlükte değil
    expect(rowOf(await report(x.c, p.id), '1').budget).toBe('1000.00');
    await ok(x.c.post(`/api/project-budgets/${b2}/approve`));
    const after = await report(x.c, p.id);
    expect(after.budget!.revisionNo).toBe(2);
    // ilerleme yok: ETC = kalan bütçe (300), EAC = 1.500, sapma 0
    expect(rowOf(after, '1')).toMatchObject({ budget: '1500.00', remaining: '300.00', etc: '300.00', eac: '1500.00', variance: '0.00' });
  });

  it('mutabakat: projeye etiketli + projesiz maliyet = defterdeki maliyet tarafı (mizan); proje özeti ve hareket dökümü', async () => {
    const x = await setup('Mutabakat');
    const p1 = await mkProject(x.c);
    const p2 = await mkProject(x.c, { name: 'İkinci proje' });
    const w1 = await mkWbs(x.c, p1.id, 'A');
    const w2 = await mkWbs(x.c, p2.id, 'B');
    await approveBudget(x.c, p1.id, [{ wbsId: w1.id, amount: '1000' }]);
    await entry(x.c, x.ids, day(3, 1), '770', '300', { projectId: p1.id, wbsId: w1.id });
    await entry(x.c, x.ids, day(3, 2), '710', '200.50', { projectId: p2.id, wbsId: w2.id });
    await entry(x.c, x.ids, day(3, 3), '770', '75.25'); // projesiz
    await entry(x.c, x.ids, day(3, 4), '632', '40'); // projesiz (sınıf 6 gider)
    await entry(x.c, x.ids, day(3, 5), '600', '999', {}, '500', 'credit'); // gelir: maliyet tarafına girmez
    // bir fişi ters çevir: net sıfırlanır
    const wrong = await entry(x.c, x.ids, day(3, 6), '770', '60', { projectId: p1.id, wbsId: w1.id });
    await ok(x.c.post(`/api/journal-entries/${wrong.json().entry.id}/reverse`, { entryDate: day(3, 7) }));

    const sum = await ok(x.c.get(`/api/projects/summary?asOf=${day(12, 31)}`));
    expect(sum.allocatedCost).toBe('500.50');
    expect(sum.unallocatedCost).toBe('115.25');
    expect(sum.ledgerCost).toBe('615.75');
    expect(sum.projects.map((p: { code: string; actual: string }) => [p.code, p.actual])).toEqual([[p1.code, '300.00'], [p2.code, '200.50']]);

    // Mizan: maliyet tarafı hesapların (gelir/gider/maliyet türü; 60/61/64 hariç) borç−alacak toplamı
    const tb = (await ok(x.c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`))).rows as { code: string; isPostable: boolean; closing: string }[];
    const ledgerCost = tb
      .filter((r) => r.isPostable && /^[678]/.test(r.code) && !/^(60|61|64)/.test(r.code))
      .reduce((s, r) => s + Number(r.closing), 0);
    expect(ledgerCost).toBeCloseTo(Number(sum.ledgerCost));

    // Hareket dökümü: ters kayıt dahil net 300 (p1)
    const tx = await ok(x.c.get(`/api/projects/${p1.id}/transactions`));
    expect(tx.total).toBe(3); // 300 + 60 + (−60 ters)
    expect(Number(tx.costNet)).toBe(300);
    expect(tx.transactions.some((t: { reversalOfId: string | null }) => t.reversalOfId)).toBe(true);
    const filtered = await ok(x.c.get(`/api/projects/${p1.id}/transactions?wbsId=${w1.id}&from=${day(3, 1)}&to=${day(3, 2)}`));
    expect(filtered.total).toBe(1);
    expect(filtered.transactions[0]).toMatchObject({ accountCode: '770', wbsCode: 'A', side: 'cost', debitBase: '300.0000' });
    expect((await ok(x.c.get(`/api/projects/${p1.id}/transactions?unassigned=true`))).total).toBe(0);
  });

  it('seçiciler: yalnızca açık projeler ve aktif yaprak iş kalemleri', async () => {
    const x = await setup('Secici');
    const open = await mkProject(x.c);
    const done = await mkProject(x.c, { name: 'Biten' });
    const root = await mkWbs(x.c, open.id, '1');
    await mkWbs(x.c, open.id, '1.1', root.id);
    const hidden = await mkWbs(x.c, open.id, '2');
    await ok(x.c.patch(`/api/project-wbs/${hidden.id}`, { isActive: false }));
    await mkWbs(x.c, done.id, 'X');
    await ok(x.c.post(`/api/projects/${done.id}/status`, { status: 'active' }));
    await ok(x.c.post(`/api/projects/${done.id}/status`, { status: 'completed' }));

    const opts = (await ok(x.c.get('/api/projects/options'))).projects as { code: string; wbs: { code: string }[] }[];
    expect(opts.map((p) => p.code)).toEqual([open.code]);
    expect(opts[0]!.wbs.map((w) => w.code)).toEqual(['1.1']);
  });

  // ------------------------------------------------------------------ kaynak: fatura

  it('alış/gider faturası: stoksuz kalem proje+iş kalemine yazılır (KDV ve cari satırı etiketsiz); iptal net sıfırlar', async () => {
    const x = await setup('Fatura');
    const p = await mkProject(x.c);
    const w1 = await mkWbs(x.c, p.id, '1');
    const w2 = await mkWbs(x.c, p.id, '2');
    const sup = (await ok(x.c.post('/api/parties', { name: 'Taşıma Ltd.', kind: 'supplier' }))).party as { id: string };

    const res = await ok(
      x.c.post('/api/invoices', {
        post: true,
        type: 'expense',
        partyId: sup.id,
        invoiceDate: day(3, 10),
        externalNo: 'G-100',
        lines: [
          { description: 'Nakliye', quantity: '1', unitPrice: '1000', vatCode: 'KDV-16', projectId: p.id, wbsId: w1.id },
          { description: 'Nakliye 2', quantity: '1', unitPrice: '500', vatCode: 'KDV-16', projectId: p.id, wbsId: w1.id },
          { description: 'Kiralama', quantity: '1', unitPrice: '300', vatCode: 'KDV-16', projectId: p.id, wbsId: w2.id },
          { description: 'Genel', quantity: '1', unitPrice: '200', vatCode: 'KDV-16' },
        ],
      }),
    );
    const invoiceId = res.invoice.id as string;
    expect(res.lines[0]).toMatchObject({ projectCode: p.code, wbsCode: '1' });
    const lines = await taggedLines(x, invoiceId);
    const expense = lines.filter((l) => l.account === '632');
    // aynı hesap+proje+iş kalemi tek satırda toplanır; etiketsiz satır ayrı
    expect(expense.map((l) => [l.wbs, l.project, l.d])).toEqual([['1', p.code, 1500], ['2', p.code, 300], [null, null, 200]]);
    expect(lines.filter((l) => l.account === '191').every((l) => l.project === null)).toBe(true);
    expect(lines.filter((l) => l.account === '320').every((l) => l.project === null)).toBe(true);

    const r = await report(x.c, p.id);
    expect(rowOf(r, '1').actual).toBe('1500.00');
    expect(rowOf(r, '2').actual).toBe('300.00');

    // İptal: ters kayıt etiketi nötrler
    await ok(x.c.post(`/api/invoices/${invoiceId}/cancel`, { reason: 'Hatalı fatura', date: day(3, 11) }));
    expect(await projectNet(x, p.id)).toBe(0);
    expect((await report(x.c, p.id)).totals.actual).toBe('0.00');
  });

  it('fatura kuralları: satış faturası, stoklu kalem, yabancı/üst iş kalemi ve taslakta kapanan proje reddedilir', async () => {
    const x = await setup('FaturaRed');
    const p = await mkProject(x.c);
    const root = await mkWbs(x.c, p.id, '1');
    const leaf = await mkWbs(x.c, p.id, '1.1', root.id);
    const sup = (await ok(x.c.post('/api/parties', { name: 'Tedarikçi', kind: 'supplier' }))).party as { id: string };
    const cust = (await ok(x.c.post('/api/parties', { name: 'Müşteri', kind: 'customer' }))).party as { id: string };
    const goods = (await ok(x.c.post('/api/items', { name: 'Çimento' }))).item as { id: string };
    const svc = (await ok(x.c.post('/api/items', { name: 'Nakliye hizmeti', kind: 'service' }))).item as { id: string };
    const base = { partyId: sup.id, invoiceDate: day(3, 10), externalNo: 'X-1' };
    const line = (extra: Record<string, unknown>) => ({ description: 'Kalem', quantity: '1', unitPrice: '100', ...extra });

    const sale = await x.c.post('/api/invoices', { type: 'sales', partyId: cust.id, invoiceDate: day(3, 10), lines: [line({ projectId: p.id, wbsId: leaf.id })] });
    expect(sale.statusCode).toBe(400);
    const stock = await x.c.post('/api/invoices', { ...base, type: 'purchase', lines: [line({ itemId: goods.id, projectId: p.id })] });
    expect(stock.statusCode).toBe(422);
    expect(stock.json().error.code).toBe('PROJECT_ON_STOCK_LINE');
    const parent = await x.c.post('/api/invoices', { ...base, type: 'expense', lines: [line({ projectId: p.id, wbsId: root.id })] });
    expect(parent.json().error.code).toBe('WBS_NOT_LEAF');
    expect((await x.c.post('/api/invoices', { ...base, type: 'expense', lines: [line({ wbsId: leaf.id })] })).statusCode).toBe(400);
    // hizmet kartı (stoksuz) etiketlenebilir
    const good = await x.c.post('/api/invoices', { ...base, type: 'expense', lines: [line({ itemId: svc.id, projectId: p.id, wbsId: leaf.id })] });
    expect(good.statusCode).toBe(201);

    // taslakta etiketli kalem; proje kaydetmeden önce tamamlanır → kayıt reddedilir
    const draft = await ok(x.c.post('/api/invoices', { ...base, externalNo: 'X-2', type: 'expense', lines: [line({ projectId: p.id, wbsId: leaf.id })] }));
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'active' }));
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'completed' }));
    const post = await x.c.post(`/api/invoices/${draft.invoice.id}/post`);
    expect(post.statusCode).toBe(422);
    expect(post.json().error.code).toBe('PROJECT_CLOSED');
    // proje yeniden açılınca kaydedilir
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'active' }));
    expect((await x.c.post(`/api/invoices/${draft.invoice.id}/post`)).statusCode).toBe(200);
  });

  // ------------------------------------------------------------------ kaynak: stok sarfı

  async function stockSetup(x: Ctx) {
    const wh = ((await ok(x.c.get('/api/warehouses'))).warehouses as { id: string; isDefault: boolean }[]).find((w) => w.isDefault)!.id;
    const mk = async (name: string) => (await ok(x.c.post('/api/items', { name }))).item as { id: string };
    const cement = await mk('Çimento');
    const iron = await mk('Demir');
    const receipt = await ok(
      x.c.post('/api/stock-documents', {
        type: 'receipt',
        docDate: day(2, 1),
        warehouseId: wh,
        lines: [
          { itemId: cement.id, quantity: '100', unitCost: '10' }, // 1.000
          { itemId: iron.id, quantity: '50', unitCost: '20' }, // 1.000
        ],
      }),
    );
    expect(receipt.document.id).toBeTruthy();
    return { wh, cement, iron };
  }

  it('stok sarfı: tüketim satırı proje/iş kalemi bazında bölünür, stok tarafı toplu kalır; ters belge net sıfırlar', async () => {
    const x = await setup('Sarf');
    const { wh, cement, iron } = await stockSetup(x);
    const p = await mkProject(x.c);
    const w1 = await mkWbs(x.c, p.id, '1');
    const w2 = await mkWbs(x.c, p.id, '2');

    const doc = await ok(
      x.c.post('/api/stock-documents', {
        type: 'issue',
        docDate: day(3, 5),
        warehouseId: wh,
        lines: [
          { itemId: cement.id, quantity: '10', projectId: p.id, wbsId: w1.id }, // 100
          { itemId: iron.id, quantity: '5', projectId: p.id, wbsId: w2.id }, // 100
          { itemId: cement.id, quantity: '20', projectId: p.id, wbsId: w1.id }, // 200 (aynı iş kalemi: toplanır)
          { itemId: iron.id, quantity: '10' }, // 200 etiketsiz
        ],
      }),
    );
    expect(doc.lines[0]).toMatchObject({ projectCode: p.code, wbsCode: '1' });
    const lines = await taggedLines(x, doc.document.id);
    const debits = lines.filter((l) => l.d > 0 && l.account === '710').map((l) => [l.wbs, l.d]);
    expect(debits).toEqual([['1', 300], ['2', 100], [null, 200]]);
    const stockCredit = lines.filter((l) => l.c > 0 && ['150', '153'].includes(l.account));
    expect(stockCredit).toHaveLength(1);
    expect(stockCredit[0]!.c).toBe(600);
    expect(stockCredit[0]!.project).toBeNull();

    const r = await report(x.c, p.id);
    expect(rowOf(r, '1').actual).toBe('300.00');
    expect(rowOf(r, '2').actual).toBe('100.00');
    expect(r.totals.actual).toBe('400.00');

    // Ters belge: hareket ve yevmiye etiketi birlikte nötrlenir (proje tamamlanmış olsa da)
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'active' }));
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'completed' }));
    const rev = await x.c.post(`/api/stock-documents/${doc.document.id}/reverse`, { docDate: day(3, 6) });
    expect(rev.statusCode).toBe(200);
    expect(await projectNet(x, p.id)).toBe(0);
    const moves = await asDb(handle, { companyId: x.company.id, orgId: x.orgId }, async (q) =>
      Number((await q(`select coalesce(sum(value), 0) as n from stock_movements where project_id = $1`, [p.id])).rows[0].n),
    );
    expect(moves).toBe(0);
  });

  it('stok fire: fire maliyeti projeye yazılır; alış/devir belgesinde etiket reddedilir; kapalı projeye sarf yazılamaz', async () => {
    const x = await setup('Fire');
    const { wh, cement } = await stockSetup(x);
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');

    const waste = await ok(x.c.post('/api/stock-documents', { type: 'waste', docDate: day(3, 5), warehouseId: wh, lines: [{ itemId: cement.id, quantity: '4', projectId: p.id, wbsId: w.id }] }));
    const wl = await taggedLines(x, waste.document.id);
    expect(wl.find((l) => l.d > 0)).toMatchObject({ account: '659', wbs: '1', project: p.code, d: 40 });
    expect(rowOf(await report(x.c, p.id), '1').actual).toBe('40.00');

    const inbound = await x.c.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 6), warehouseId: wh, lines: [{ itemId: cement.id, quantity: '1', unitCost: '10', projectId: p.id }] });
    expect(inbound.statusCode).toBe(400);
    const transfer = await x.c.post('/api/stock-documents', { type: 'count', docDate: day(3, 6), warehouseId: wh, lines: [{ itemId: cement.id, quantity: '1', projectId: p.id }] });
    expect([400, 422]).toContain(transfer.statusCode);

    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'active' }));
    await ok(x.c.post(`/api/projects/${p.id}/status`, { status: 'completed' }));
    const closed = await x.c.post('/api/stock-documents', { type: 'issue', docDate: day(3, 7), warehouseId: wh, lines: [{ itemId: cement.id, quantity: '1', projectId: p.id, wbsId: w.id }] });
    expect(closed.statusCode).toBe(422);
    expect(closed.json().error.code).toBe('PROJECT_CLOSED');
  });

  // ------------------------------------------------------------------ kaynak: kasa/banka

  it('kasa/banka: diğer ödeme karşı hesap satırı projeye yazılır, iptal nötrler; cari ödemesinde etiket reddedilir', async () => {
    const x = await setup('Kasa');
    const p = await mkProject(x.c);
    const w = await mkWbs(x.c, p.id, '1');
    const bank = (await ok(x.c.post('/api/treasury/accounts', { kind: 'bank', name: 'TL banka', currency: 'TRY' }))).account as { id: string };
    await ok(x.c.post('/api/treasury/transactions', { type: 'other_receipt', date: day(2, 1), accountId: bank.id, amount: '10000', glAccountId: x.ids['500'] }));

    const paid = await ok(
      x.c.post('/api/treasury/transactions', { type: 'other_payment', date: day(3, 10), accountId: bank.id, amount: '750', glAccountId: x.ids['720'], projectId: p.id, wbsId: w.id }),
    );
    const txnId = paid.transaction.id as string;
    const lines = await taggedLines(x, txnId);
    expect(lines.find((l) => l.account === '720')).toMatchObject({ wbs: '1', project: p.code, d: 750 });
    expect(lines.find((l) => l.account === '102.001' || l.account.startsWith('102'))!.project).toBeNull();
    expect(rowOf(await report(x.c, p.id), '1').actual).toBe('750.00');

    // bilanço hesabına etiket: uygulama doğrulaması
    const bad = await x.c.post('/api/treasury/transactions', { type: 'other_payment', date: day(3, 11), accountId: bank.id, amount: '10', glAccountId: x.ids['255'], projectId: p.id });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('PROJECT_ACCOUNT_NOT_ALLOWED');
    // cari ödemesinde proje yok (maliyet faturada doğar)
    const sup = (await ok(x.c.post('/api/parties', { name: 'Taşeron', kind: 'supplier' }))).party as { id: string };
    const pay = await x.c.post('/api/treasury/transactions', { type: 'payment', date: day(3, 12), accountId: bank.id, amount: '10', partyId: sup.id, projectId: p.id });
    expect(pay.statusCode).toBe(400);

    await ok(x.c.post(`/api/treasury/transactions/${txnId}/cancel`, { reason: 'Yanlış proje', date: day(3, 13) }));
    expect(await projectNet(x, p.id)).toBe(0);
  });

  // ------------------------------------------------------------------ dışa aktarma ve yetki

  it('dışa aktarma: proje maliyet raporu ve özeti xlsx/csv; tam veri dışa aktarma proje sayfalarını içerir; izinler', async () => {
    const x = await setup('Export');
    const p = await mkProject(x.c);
    const root = await mkWbs(x.c, p.id, '1');
    const kazi = await mkWbs(x.c, p.id, '1.1', root.id);
    await approveBudget(x.c, p.id, [{ wbsId: kazi.id, amount: '1000' }]);
    await entry(x.c, x.ids, day(3, 10), '770', '400', { projectId: p.id, wbsId: kazi.id });
    await progress(x.c, p.id, day(3, 31), [{ wbsId: kazi.id, percent: '50' }]);

    const csv = await x.c.get(`/api/exports/project-cost-report?format=csv&projectId=${p.id}&asOf=${day(12, 31)}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('İş kalemi');
    expect(csv.body).toContain('1.000,00');
    expect(csv.body).toContain('900,00'); // EAC

    const res = await x.c.get(`/api/exports/project-cost-report?format=xlsx&projectId=${p.id}&asOf=${day(12, 31)}`);
    expect(res.statusCode).toBe(200);
    const sheets = readXlsx(new Uint8Array(res.rawPayload));
    const sheet = sheets.find((s) => s.name === 'Proje maliyeti')!;
    expect(sheet).toBeTruthy();
    expect(JSON.stringify(sheet.rows)).toContain('İş 1.1');

    const summary = await x.c.get(`/api/exports/projects-summary?format=xlsx&asOf=${day(12, 31)}`);
    expect(summary.statusCode).toBe(200);
    const names = readXlsx(new Uint8Array(summary.rawPayload)).map((s) => s.name);
    expect(names).toEqual(['Projeler', 'Mutabakat']);

    const full = readXlsx(new Uint8Array((await x.c.get('/api/exports/full-data?format=xlsx')).rawPayload)).map((s) => s.name);
    expect(full).toEqual(expect.arrayContaining(['Projeler', 'İş kırılımı', 'Proje bütçeleri']));

    // izinler: izleyici okur; satış temsilcisi ve modülü olmayan şirket 403
    const viewer = await addMember(app, x.c, x.company.id, 'viewer');
    expect((await viewer.client.get(`/api/exports/projects-summary?format=csv&asOf=${day(12, 31)}`)).statusCode).toBe(200);
    expect((await viewer.client.get(`/api/projects/${p.id}/cost-report`)).statusCode).toBe(200);
    const sales = await addMember(app, x.c, x.company.id, 'sales');
    expect((await sales.client.get(`/api/exports/projects-summary?format=csv&asOf=${day(12, 31)}`)).statusCode).toBe(403);
    expect((await sales.client.get(`/api/projects/summary`)).statusCode).toBe(403);
    const market = await setup('ExportMarket', { sector: 'RETAIL_MARKET' });
    expect((await market.c.get(`/api/exports/projects-summary?format=csv&asOf=${day(12, 31)}`)).json().error.code).toBe('MODULE_DISABLED');
    // projesiz şirketin tam veri dışa aktarması proje sayfaları içermez
    const empty = await setup('ExportBos');
    const emptyFull = readXlsx(new Uint8Array((await empty.c.get('/api/exports/full-data?format=xlsx')).rawPayload)).map((s) => s.name);
    expect(emptyFull).not.toContain('Projeler');
  });

  it('RLS: başka şirketin projesi raporlanamaz', async () => {
    const a = await setup('RaporA');
    const b = await setup('RaporB');
    const p = await mkProject(a.c);
    expect((await b.c.get(`/api/projects/${p.id}/cost-report`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/projects/${p.id}/transactions`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/exports/project-cost-report?format=csv&projectId=${p.id}&asOf=${day(12, 31)}`)).statusCode).toBe(404);
    expect((await b.c.get(`/api/projects/${randomUUID()}/cost-report`)).statusCode).toBe(404);
  });
});
