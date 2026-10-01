import { describe, expect, it } from 'vitest';
import { accountIds, addMember, asDb, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('KDV tevkifatı ve taşerona malzeme mahsubu (Faz B kapanışı)', async () => {
  const { app, handle } = await makeApp();

  /** Taşeron (payable) ya da işveren (receivable) sözleşmeli dünya; BOQ 15.000 m × 3 + 30 adet × 500 = 60.000 (yalnızca 2 satır). */
  async function world(name: string, direction: 'payable' | 'receivable' = 'payable', contract: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const orgId = await orgOf(app, s.token);
    const ids = await accountIds(app, s.token, company.id);
    const party =
      direction === 'payable'
        ? ((await c.post('/api/parties', { name: 'XYZ Elektrik Ltd', kind: 'supplier' })).json().party as { id: string })
        : ((await c.post('/api/parties', { name: 'Deniz Yatırım Ltd.', kind: 'customer' })).json().party as { id: string });
    const project = (
      await c.post('/api/projects', direction === 'payable' ? { name: 'Güneş Sitesi', kind: 'own' } : { name: 'Kuzey Villa', kind: 'contract', clientPartyId: party.id })
    ).json().project as { id: string };
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '05', name: 'Elektrik' })).json().wbs[0] as { id: string };
    const created = await c.post('/api/subcontracts', {
      direction,
      projectId: project.id,
      partyId: party.id,
      title: 'Elektrik tesisatı',
      currencyCode: 'TRY',
      paymentDays: 30,
      retentionPct: '0',
      advanceRecoupPct: '0',
      withholdingPct: '0',
      ...contract,
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    const sc = created.json().subcontract as { id: string; vatWithholdingPct: string };
    const rev = created.json().revisions[0].id as string;
    const put = await c.put(`/api/subcontract-revisions/${rev}/lines`, {
      lines: [
        { itemNo: '1', description: 'Kablo çekimi', unit: 'm', quantity: '15000', unitPrice: '3', wbsId: wbs.id },
        { itemNo: '2', description: 'Pano kurulumu', unit: 'adet', quantity: '30', unitPrice: '500', wbsId: wbs.id },
      ],
    });
    await c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const keys = Object.fromEntries((put.json().lines as { itemNo: string; lineKey: string }[]).map((l) => [l.itemNo, l.lineKey]));
    const payload = (cum1: string, cum2: string, extra: Record<string, unknown> = {}) => ({
      subcontractId: sc.id,
      periodEnd: day(3, 31),
      lines: [
        { lineKey: keys['1']!, cumulativeQty: cum1 },
        { lineKey: keys['2']!, cumulativeQty: cum2 },
      ],
      ...extra,
    });
    const approveFlow = async (id: string) => {
      const sub = await c.post(`/api/progress-payments/${id}/submit`, {});
      if (sub.statusCode !== 200) throw new Error(`submit failed: ${sub.body}`);
      const dec = await c.post(`/api/approvals/${sub.json().approvals[0].id}/decide`, { decision: 'approve' });
      if (dec.statusCode !== 200) throw new Error(`decide failed: ${dec.body}`);
      return (await c.get(`/api/progress-payments/${id}`)).json();
    };
    const entry = async (entryId: string) => {
      const e = (await c.get(`/api/journal-entries/${entryId}`)).json().entry;
      const lines = e.lines as { accountCode: string; debit: string; credit: string; debitBase: string; creditBase: string; projectId: string | null; partyId: string | null }[];
      return { e, lines, of: (code: string) => lines.filter((l) => l.accountCode === code) };
    };
    return { s, company, c, orgId, ids, party, project, wbs, sc, keys, payload, approveFlow, entry };
  }

  it('taşeron: KDV tevkifatı — KDV tam yazılır, tevkifat A 360; cari net; yevmiye dengeli', async () => {
    const w = await world('TevkifatTaseron', 'payable', { vatWithholdingPct: '40' });
    expect(w.sc.vatWithholdingPct).toBe('40.0000');
    const p = await w.c.post('/api/progress-payments', w.payload('10000', '20', { vatCode: 'KDV-16' }));
    expect(p.statusCode, p.body).toBe(201);
    // brüt 40.000, KDV %16 = 6.400, tevkifat %40 = 2.560 → net 43.840
    expect(p.json().payment).toMatchObject({ gross: '40000.00', vat: '6400.00', vatWithholding: '2560.00', vatWithholdingPct: '40.0000', material: '0.00', net: '43840.00' });
    const posted = await w.approveFlow(p.json().payment.id);
    const j = await w.entry(posted.payment.entryId);
    expect(j.of('191')[0]).toMatchObject({ debitBase: '6400.0000' });
    expect(j.of('360')[0]).toMatchObject({ creditBase: '2560.0000' });
    expect(j.of('320')[0]).toMatchObject({ creditBase: '43840.0000', partyId: w.party.id });
    expect(j.lines.reduce((s, l) => s + Number(l.debitBase) - Number(l.creditBase), 0)).toBe(0);
  });

  it('işveren: KDV tevkifatı — işverence tevkif edilen KDV alacağı B 136; cari net', async () => {
    const w = await world('TevkifatIsveren', 'receivable', { vatWithholdingPct: '50' });
    const p = await w.c.post('/api/progress-payments', w.payload('10000', '20', { vatCode: 'KDV-16' }));
    expect(p.json().payment).toMatchObject({ vat: '6400.00', vatWithholding: '3200.00', net: '43200.00' });
    const posted = await w.approveFlow(p.json().payment.id);
    const j = await w.entry(posted.payment.entryId);
    expect(j.of('391')[0]).toMatchObject({ creditBase: '6400.0000' });
    expect(j.of('136')[0]).toMatchObject({ debitBase: '3200.0000' });
    expect(j.of('120')[0]).toMatchObject({ debitBase: '43200.0000' });
    expect(j.lines.reduce((s, l) => s + Number(l.debitBase) - Number(l.creditBase), 0)).toBe(0);
  });

  it('tevkifat parametresi tarihli kopyalanır; sonradan değişse sözleşme değişmez; yürürlükte değiştirilemez; 0 iken eşleme istenmez', async () => {
    const s = await registerUser(app, 'TevkifatParam');
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const prm = await c.post('/api/construction-params', { kind: 'vat_withholding_pct', value: '30', validFrom: day(1, 1), sourceNote: 'Deneme (doğrulanmadı)' });
    expect(prm.statusCode, prm.body).toBe(201);
    const party = (await c.post('/api/parties', { name: 'ABC Ltd', kind: 'supplier' })).json().party as { id: string };
    const project = (await c.post('/api/projects', { name: 'Proje X', kind: 'own' })).json().project as { id: string };
    const made = await c.post('/api/subcontracts', { projectId: project.id, partyId: party.id, title: 'İş', currencyCode: 'TRY' });
    if (made.statusCode !== 201) throw new Error(made.body);
    expect(made.json().subcontract.vatWithholdingPct).toBe('30.0000');
    await c.post('/api/construction-params', { kind: 'vat_withholding_pct', value: '10', validFrom: day(6, 1) });
    expect((await c.get(`/api/subcontracts/${made.json().subcontract.id}`)).json().subcontract.vatWithholdingPct).toBe('30.0000');
    // Yürürlüğe girince yüzde kilitlenir
    const rev = made.json().revisions[0].id as string;
    const wbs = (await c.post(`/api/projects/${project.id}/wbs`, { code: '01', name: 'İş' })).json().wbs[0] as { id: string };
    await c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [{ description: 'Kalem', unit: 'adet', quantity: '1', unitPrice: '1000', wbsId: wbs.id }] });
    await c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const lock = await c.patch(`/api/subcontracts/${made.json().subcontract.id}`, { vatWithholdingPct: '20' });
    expect(lock.statusCode).toBe(422);
    expect(lock.json().error.code).toBe('SUBCONTRACT_PCT_LOCKED');
  });

  /** Malzemeli dünya: 100 adet × 50 TL stok girişi (maliyet 5.000), taşerona 20 adet = 1.000 TL malzeme verilir. */
  async function materialWorld(name: string) {
    const w = await world(name);
    const warehouse = ((await w.c.get('/api/warehouses')).json().warehouses as { id: string; isDefault: boolean }[]).find((x) => x.isDefault)!;
    const item = (await w.c.post('/api/items', { name: 'NYY kablo makarası' })).json().item as { id: string };
    const rec = await w.c.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 1), warehouseId: warehouse.id, lines: [{ itemId: item.id, quantity: '100', unitCost: '50' }] });
    expect(rec.statusCode, rec.body).toBe(201);
    const give = (qty: string) =>
      w.c.post(`/api/subcontracts/${w.sc.id}/material-issues`, { date: day(3, 10), warehouseId: warehouse.id, note: 'Kablo', lines: [{ itemId: item.id, quantity: qty, wbsId: w.wbs.id }] });
    return { ...w, warehouse, item, give };
  }

  it('malzeme ver → stok düşer, gider projeye etiketli, bakiye artar; hakedişte mahsup → net düşer, maliyet çift sayılmaz; iptalde bakiye geri gelir', async () => {
    const w = await materialWorld('MalzemeAkis');
    const given = await w.give('20');
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json().balances).toMatchObject({ materialGiven: '1000.00', materialRecouped: '0.00', materialBalance: '1000.00' });
    // Stok 80'e indi; sarf gideri proje + iş kalemi etiketli
    expect(((await w.c.get(`/api/items/${w.item.id}`)).json().stock as { qty: string }).qty).toBe('80.0000');
    const list = (await w.c.get(`/api/subcontracts/${w.sc.id}/material-issues`)).json();
    expect(list.issues).toHaveLength(1);
    expect(list.issues[0]).toMatchObject({ amount: '1000.0000', amountBase: '1000.0000' });

    // Bakiyeyi aşan mahsup
    const over = await w.c.post('/api/progress-payments', w.payload('10000', '20', { materialRecoup: '1500' }));
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('MATERIAL_OVER_BALANCE');

    // 1.000 mahsup: brüt 40.000 → net 39.000
    const draft = await w.c.post('/api/progress-payments', w.payload('10000', '20', { materialRecoup: '1000' }));
    expect(draft.statusCode, draft.body).toBe(201);
    expect(draft.json().payment).toMatchObject({ gross: '40000.00', material: '1000.00', net: '39000.00' });
    const posted = await w.approveFlow(draft.json().payment.id);
    const j = await w.entry(posted.payment.entryId);
    // Maliyet satırları brüt − mahsup (39.000); cari net 39.000
    const cost = j.of('740').reduce((s, l) => s + Number(l.debitBase), 0);
    expect(cost).toBe(39000);
    expect(j.of('320')[0]).toMatchObject({ creditBase: '39000.0000' });
    // Proje maliyeti = sarf (1.000) + hakediş (39.000) = brüt (40.000): çift sayım yok
    const report = (await w.c.get(`/api/projects/${w.project.id}/cost-report?asOf=${day(12, 31)}`)).json();
    expect(report.totals.actual).toBe('40000.00');
    const bal = (await w.c.get(`/api/subcontracts/${w.sc.id}/balances`)).json().balances;
    expect(bal).toMatchObject({ materialGiven: '1000.00', materialRecouped: '1000.00', materialBalance: '0.00' });

    // İptal: mahsup bakiyeye geri döner
    const cancelled = await w.c.post(`/api/progress-payments/${posted.payment.id}/cancel`, { reason: 'Hatalı metraj' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await w.c.get(`/api/subcontracts/${w.sc.id}/balances`)).json().balances).toMatchObject({ materialRecouped: '0.00', materialBalance: '1000.00' });
  });

  it('korumalar: bağlı stok belgesi ters çevrilemez; malzeme kaydı değişmez; işverende malzeme yok; yetki; bedel stok maliyetine eşit olmalı', async () => {
    const w = await materialWorld('MalzemeKoruma');
    const given = await w.give('10');
    const docId = given.json().document.id as string;
    const rev = await w.c.post(`/api/stock-documents/${docId}/reverse`, { docDate: day(3, 11) });
    expect(rev.statusCode).toBe(422);

    // Ham SQL: kayıt değişmez/silinmez; yanlış bedel reddedilir
    const issueId = (await w.c.get(`/api/subcontracts/${w.sc.id}/material-issues`)).json().issues[0].id as string;
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      let e = await expectDbError(q, `update subcontract_material_issues set note = 'x' where id = $1`, [issueId]);
      expect(['ERP10', '42501']).toContain(e.code);
      e = await expectDbError(q, `delete from subcontract_material_issues where id = $1`, [issueId]);
      expect(['ERP10', '42501']).toContain(e.code);
    });
    // Sözleşmeye bağlanmamış, projeye etiketli ayrı bir sarf belgesi: yanlış bedelle kayıt reddedilir
    const loose = await w.c.post('/api/stock-documents', {
      type: 'issue',
      docDate: day(3, 12),
      warehouseId: w.warehouse.id,
      lines: [{ itemId: w.item.id, quantity: '2', projectId: w.project.id, wbsId: w.wbs.id }],
    });
    expect(loose.statusCode, loose.body).toBe(201);
    await asDb(handle, { companyId: w.company.id, orgId: w.orgId }, async (q) => {
      const e = await expectDbError(
        q,
        `insert into subcontract_material_issues (id, company_id, subcontract_id, issue_date, stock_document_id, amount, amount_base)
         values (gen_random_uuid(), $1, $2, $3, $4, 1, 1)`,
        [w.company.id, w.sc.id, day(3, 12), loose.json().document.id],
      );
      expect(e.code).toBe('ERP10'); // bedel stok çıkış maliyetine (100 TL) eşit olmalı
      // Doğru bedelle (2 × 50 = 100) kayıt geçer
      await q(
        `insert into subcontract_material_issues (id, company_id, subcontract_id, issue_date, stock_document_id, amount, amount_base)
         values (gen_random_uuid(), $1, $2, $3, $4, 100, 100)`,
        [w.company.id, w.sc.id, day(3, 12), loose.json().document.id],
      );
    });

    // Görüntüleyici malzeme veremez; sözleşme yönetimi olup stok hareketi izni olmayan rol da veremez
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    expect(
      (await viewer.client.post(`/api/subcontracts/${w.sc.id}/material-issues`, { date: day(3, 12), warehouseId: w.warehouse.id, lines: [{ itemId: w.item.id, quantity: '1', wbsId: w.wbs.id }] })).statusCode,
    ).toBe(403);
    // Şantiye sorumlusu (inventory.move + subcontracts.manage) verebilir
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    expect(
      (await sm.client.post(`/api/subcontracts/${w.sc.id}/material-issues`, { date: day(3, 12), warehouseId: w.warehouse.id, lines: [{ itemId: w.item.id, quantity: '1', wbsId: w.wbs.id }] })).statusCode,
    ).toBe(201);
  });

  it('işveren sözleşmesine malzeme verilemez ve işveren hakedişinde malzeme mahsubu yoktur', async () => {
    const w = await world('MalzemeIsveren', 'receivable');
    const warehouse = ((await w.c.get('/api/warehouses')).json().warehouses as { id: string; isDefault: boolean }[]).find((x) => x.isDefault)!;
    const item = (await w.c.post('/api/items', { name: 'Kablo' })).json().item as { id: string };
    const r = await w.c.post(`/api/subcontracts/${w.sc.id}/material-issues`, { date: day(3, 10), warehouseId: warehouse.id, lines: [{ itemId: item.id, quantity: '1', wbsId: w.wbs.id }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('MATERIAL_NOT_ALLOWED');
    const claim = await w.c.post('/api/progress-payments', w.payload('10000', '20', { materialRecoup: '100' }));
    expect(claim.statusCode).toBe(422);
    expect(claim.json().error.code).toBe('MATERIAL_NOT_ALLOWED');
  });

  it('maliyeti sıfır malzeme verilemez (mahsup edilecek bedel oluşmaz)', async () => {
    const w = await world('MalzemeSifir');
    const warehouse = ((await w.c.get('/api/warehouses')).json().warehouses as { id: string; isDefault: boolean }[]).find((x) => x.isDefault)!;
    const item = (await w.c.post('/api/items', { name: 'Bedelsiz' })).json().item as { id: string };
    await w.c.post('/api/stock-documents', { type: 'receipt', docDate: day(3, 1), warehouseId: warehouse.id, lines: [{ itemId: item.id, quantity: '10', unitCost: '0' }] });
    const r = await w.c.post(`/api/subcontracts/${w.sc.id}/material-issues`, { date: day(3, 10), warehouseId: warehouse.id, lines: [{ itemId: item.id, quantity: '2', wbsId: w.wbs.id }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('MATERIAL_ZERO_COST');
    // İşlem geri alındı: stok değişmedi
    expect(((await w.c.get(`/api/items/${item.id}`)).json().stock as { qty: string }).qty).toBe('10.0000');
  });
});
