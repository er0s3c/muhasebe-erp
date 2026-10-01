import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMember, asDb, client, createCompany, day, execAsOwner, expectDbError, makeApp, orgOf, registerUser } from './helpers';

describe('taşeron sözleşmesi, revizyon ve BOQ (B2b)', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    return { s, company, c, orgId: await orgOf(app, s.token) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];

  const mkProject = async (c: C) => (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
  const mkWbs = async (c: C, projectId: string, code: string, parentId?: string) => {
    const res = await c.post(`/api/projects/${projectId}/wbs`, { code, name: `İş ${code}`, ...(parentId ? { parentId } : {}) });
    return (res.json().wbs as { id: string; code: string }[]).find((w) => w.code === code)!;
  };
  const mkParty = async (c: C, name: string, kind: string) => (await c.post('/api/parties', { name, kind })).json().party as { id: string };
  const costCode = async (c: C, code: string) => ((await c.get('/api/cost-codes')).json().costCodes as { id: string; code: string }[]).find((x) => x.code === code)!;

  async function world(name: string) {
    const x = await setup(name);
    const project = await mkProject(x.c);
    const w1 = await mkWbs(x.c, project.id, '03');
    const w2 = await mkWbs(x.c, project.id, '05');
    const party = await mkParty(x.c, 'XYZ Elektrik Ltd', 'supplier');
    const tsr = await costCode(x.c, 'TSR');
    const create = (body: Record<string, unknown> = {}) =>
      x.c.post('/api/subcontracts', { projectId: project.id, partyId: party.id, title: 'Elektrik tesisatı', currencyCode: 'TRY', paymentDays: 30, ...body });
    const lines = (a = '15000', b = '30') => [
      { itemNo: '1.1', description: 'Kablo çekimi', unit: 'm', quantity: a, unitPrice: '3', wbsId: w1.id, costCodeId: tsr.id },
      { itemNo: '1.2', description: 'Pano kurulumu', unit: 'adet', quantity: b, unitPrice: '500', wbsId: w2.id },
    ];
    return { ...x, project, w1, w2, party, tsr, create, lines };
  }

  it('sözleşme oluşturma, BOQ girişi, ilk onayda yürürlüğe girme ve tutar hesabı', async () => {
    const w = await world('SozlesmeAkis');
    // Parametre anlık görüntüsü: sözleşme açılırken geçerli parametreden kopyalanır
    await w.c.post('/api/construction-params', { kind: 'retention_pct', value: '5', validFrom: day(1, 1) });
    const created = await w.create();
    expect(created.statusCode).toBe(201);
    const sc = created.json().subcontract;
    expect(sc.code).toMatch(/^TSZ-\d{4}$/);
    expect(sc.status).toBe('draft');
    expect(Number(sc.retentionPct)).toBe(5);
    expect(Number(sc.withholdingPct)).toBe(0);
    // Sonradan parametre değişse sözleşme değişmez
    await w.c.post('/api/construction-params', { kind: 'retention_pct', value: '10', validFrom: day(6, 1) });
    expect(Number((await w.c.get(`/api/subcontracts/${sc.id}`)).json().subcontract.retentionPct)).toBe(5);

    const rev1 = (created.json().revisions as { id: string; revisionNo: number; status: string }[])[0]!;
    expect(rev1).toMatchObject({ revisionNo: 1, status: 'draft' });
    expect((await w.c.post(`/api/subcontract-revisions/${rev1.id}/approve`, {})).statusCode).toBe(422); // boş revizyon

    const put = await w.c.put(`/api/subcontract-revisions/${rev1.id}/lines`, { lines: w.lines() });
    expect(put.statusCode).toBe(200);
    expect(put.json().revision.total).toBe('60000.00'); // 15.000×3 + 30×500
    const approved = await w.c.post(`/api/subcontract-revisions/${rev1.id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    const after = (await w.c.get(`/api/subcontracts/${sc.id}`)).json();
    expect(after.subcontract.status).toBe('active');
    expect(after.subcontract.contractAmount).toBe('60000.00');
    expect((await w.c.get('/api/subcontracts')).json().subcontracts[0]).toMatchObject({ code: sc.code, contractAmount: '60000.00' });
    // Etkin sözleşme silinemez
    expect((await w.c.delete(`/api/subcontracts/${sc.id}`)).statusCode).toBe(422);
  });

  it('revizyon: onaylı revizyon değişmez, değişiklik emrinin revizyonu yürürlüğü devralır, lineKey korunur', async () => {
    const w = await world('SozlesmeRev');
    const sc = (await w.create()).json();
    const rev1 = sc.revisions[0].id as string;
    await w.c.put(`/api/subcontract-revisions/${rev1}/lines`, { lines: w.lines() });
    await w.c.post(`/api/subcontract-revisions/${rev1}/approve`, {});

    // Onaylı revizyon düzenlenemez
    const edit = await w.c.put(`/api/subcontract-revisions/${rev1}/lines`, { lines: w.lines('1') });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().error.code).toBe('REVISION_NOT_DRAFT');

    // Yürürlükteki sözleşmede düz revizyon açılamaz: değişiklik emri gerekir
    expect((await w.c.post(`/api/subcontracts/${sc.subcontract.id}/revisions`, { copyFromCurrent: true })).json().error.code).toBe('USE_VARIATION_ORDER');
    const vo = await w.c.post(`/api/subcontracts/${sc.subcontract.id}/variations`, { title: 'Ek kablo', reason: 'design_change' });
    expect(vo.statusCode).toBe(201);
    expect((await w.c.post(`/api/subcontracts/${sc.subcontract.id}/variations`, { title: 'İkinci', reason: 'other' })).json().error.code).toBe('REVISION_DRAFT_EXISTS');
    const r2 = await w.c.get(`/api/subcontract-revisions/${vo.json().variation.revisionId}`);
    const copied = r2.json().lines as { lineKey: string; quantity: string }[];
    expect(copied).toHaveLength(2);
    // Miktarı artır: aynı lineKey ile
    const bumped = copied.map((l, i) => ({ ...w.lines()[i]!, lineKey: l.lineKey, quantity: i === 0 ? '20000' : '30' }));
    await w.c.put(`/api/subcontract-revisions/${r2.json().revision.id}/lines`, { lines: bumped });
    // Uydurma lineKey reddedilir
    const fake = await w.c.put(`/api/subcontract-revisions/${r2.json().revision.id}/lines`, { lines: [{ ...w.lines()[0]!, lineKey: randomUUID() }] });
    expect(fake.json().error.code).toBe('BOQ_LINE_KEY_UNKNOWN');
    await w.c.put(`/api/subcontract-revisions/${r2.json().revision.id}/lines`, { lines: bumped });
    // DE revizyonu doğrudan onaylanamaz; DE onayıyla yürürlüğe girer
    expect((await w.c.post(`/api/subcontract-revisions/${r2.json().revision.id}/approve`, {})).json().error.code).toBe('USE_VARIATION_ORDER');
    const submitted = await w.c.post(`/api/variation-orders/${vo.json().variation.id}/submit`, {});
    expect(submitted.statusCode).toBe(200);
    expect((await w.c.post(`/api/approvals/${submitted.json().approvals[0].id}/decide`, { decision: 'approve' })).statusCode).toBe(200);

    const detail = (await w.c.get(`/api/subcontracts/${sc.subcontract.id}`)).json();
    expect(detail.subcontract.contractAmount).toBe('75000.00'); // 20.000×3 + 30×500
    const byNo = Object.fromEntries((detail.revisions as { revisionNo: number; status: string; isCurrent: boolean; total: string }[]).map((r) => [r.revisionNo, r]));
    expect(byNo[1]).toMatchObject({ status: 'superseded', total: '60000.00', isCurrent: false });
    expect(byNo[2]).toMatchObject({ status: 'approved', total: '75000.00', isCurrent: true });
    // Eski revizyon karşılaştırma için durur
    expect((await w.c.get(`/api/subcontract-revisions/${rev1}`)).json().revision.total).toBe('60000.00');
  });

  it('doğrulamalar: müşteri carisi taşeron olamaz, başka projenin iş kalemi, yaprak olmayan iş kalemi, kapalı proje', async () => {
    const w = await world('SozlesmeDogrula');
    const customer = await mkParty(w.c, 'Müşteri AŞ', 'customer');
    const bad = await w.create({ partyId: customer.id });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('PARTY_KIND_MISMATCH');

    const sc = (await w.create()).json();
    const rev = sc.revisions[0].id as string;
    const other = await mkProject(w.c);
    const foreign = await mkWbs(w.c, other.id, '01');
    const f = await w.c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [{ ...w.lines()[0]!, wbsId: foreign.id }] });
    expect(f.json().error.code).toBe('WBS_NOT_FOUND');
    // 03 altına alt iş açılınca 03 yaprak olmaktan çıkar
    await mkWbs(w.c, w.project.id, '03.01', w.w1.id);
    const parent = await w.c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [w.lines()[0]!] });
    expect(parent.statusCode).toBe(422);
    expect(parent.json().error.code).toBe('PROJECT_RULE_VIOLATION'); // yaprak kuralı proje korumasıdır (ERP09)
    const noQty = await w.c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: [{ ...w.lines()[1]!, quantity: '0' }] });
    expect(noQty.statusCode).toBe(400);

    await w.c.post(`/api/projects/${w.project.id}/status`, { status: 'active' });
    await w.c.post(`/api/projects/${w.project.id}/status`, { status: 'completed' });
    expect((await w.create()).json().error.code).toBe('PROJECT_CLOSED');
  });

  it('yetki ve modül: şantiye sorumlusu sözleşme hazırlar ama revizyonu onaylayamaz; market şirketinde kapalı', async () => {
    const w = await world('SozlesmeYetki');
    const sm = await addMember(app, w.c, w.company.id, 'site_manager');
    const viewer = await addMember(app, w.c, w.company.id, 'viewer');
    const sc = (await sm.client.post('/api/subcontracts', { projectId: w.project.id, partyId: w.party.id, title: 'Mekanik', currencyCode: 'TRY' })).json();
    expect(sc.subcontract.code).toBeTruthy();
    const rev = sc.revisions[0].id as string;
    expect((await sm.client.put(`/api/subcontract-revisions/${rev}/lines`, { lines: w.lines() })).statusCode).toBe(200);
    expect((await sm.client.post(`/api/subcontract-revisions/${rev}/approve`, {})).statusCode).toBe(403);
    expect((await viewer.client.get('/api/subcontracts')).statusCode).toBe(200);
    expect((await viewer.client.post('/api/subcontracts', { projectId: w.project.id, partyId: w.party.id, title: 'X', currencyCode: 'TRY' })).statusCode).toBe(403);
    expect((await w.c.post(`/api/subcontract-revisions/${rev}/approve`, {})).statusCode).toBe(200);

    const market = await registerUser(app, 'SozlesmeMarket');
    const mc = await createCompany(app, market.token, { sector: 'RETAIL_MARKET' });
    expect((await client(app, market.token, mc.id).get('/api/subcontracts')).json().error.code).toBe('MODULE_DISABLED');
  });

  it('veritabanı: onaylı revizyon ve satırı değişmez; sahip rolüyle bile; RLS yalıtır', async () => {
    const a = await world('SozlesmeDbA');
    const b = await world('SozlesmeDbB');
    const sc = (await a.create()).json();
    const rev = sc.revisions[0].id as string;
    await a.c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: a.lines() });
    await a.c.post(`/api/subcontract-revisions/${rev}/approve`, {});

    await asDb(handle, { companyId: a.company.id, orgId: a.orgId }, async (q) => {
      let e = await expectDbError(q, `update subcontract_boq_lines set quantity = 1 where revision_id = $1`, [rev]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `delete from subcontract_boq_lines where revision_id = $1`, [rev]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update subcontract_revisions set title = 'x' where id = $1`, [rev]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `delete from subcontract_revisions where id = $1`, [rev]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update subcontracts set party_id = $2 where id = $1`, [sc.subcontract.id, randomUUID()]);
      expect(e.message).toMatch(/./);
      e = await expectDbError(q, `update subcontracts set retention_pct = 9 where id = $1`, [sc.subcontract.id]);
      expect(e.code).toBe('ERP10');
      e = await expectDbError(q, `update subcontracts set status = 'draft' where id = $1`, [sc.subcontract.id]);
      expect(e.code).toBe('ERP10');
    });
    await expect(execAsOwner(`update subcontract_boq_lines set unit_price = 99 where revision_id = $1`, [rev])).rejects.toThrow(/taslak/);

    // B şirketi A'nın sözleşmesini göremez
    expect((await b.c.get(`/api/subcontracts/${sc.subcontract.id}`)).statusCode).toBe(404);
    expect((await b.c.get('/api/subcontracts')).json().subcontracts).toHaveLength(0);
  });

  it('tamamlama ve fesih yalnızca yürürlükteki sözleşmede; sonrasında düzenleme ve revizyon kapalı', async () => {
    const w = await world('SozlesmeKapanis');
    const sc = (await w.create()).json();
    const rev = sc.revisions[0].id as string;
    expect((await w.c.post(`/api/subcontracts/${sc.subcontract.id}/status`, { status: 'completed' })).statusCode).toBe(422);
    await w.c.put(`/api/subcontract-revisions/${rev}/lines`, { lines: w.lines() });
    await w.c.post(`/api/subcontract-revisions/${rev}/approve`, {});
    const done = await w.c.post(`/api/subcontracts/${sc.subcontract.id}/status`, { status: 'completed' });
    expect(done.json().subcontract.status).toBe('completed');
    expect((await w.c.patch(`/api/subcontracts/${sc.subcontract.id}`, { title: 'Yeni' })).json().error.code).toBe('SUBCONTRACT_CLOSED');
    expect((await w.c.post(`/api/subcontracts/${sc.subcontract.id}/revisions`, {})).json().error.code).toBe('SUBCONTRACT_CLOSED');
  });
});
