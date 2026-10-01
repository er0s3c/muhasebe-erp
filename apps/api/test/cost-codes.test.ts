import { describe, expect, it } from 'vitest';
import { accountIds, asDb, client, createCompany, day, execAsOwner, makeApp, registerUser } from './helpers';

describe('maliyet kodu boyutu (B2a)', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    const c = client(app, s.token, company.id);
    const ids = await accountIds(app, s.token, company.id);
    return { s, company, c, ids };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];
  const mkProject = async (c: C) => (await c.post('/api/projects', { name: 'Güneş Sitesi', kind: 'own' })).json().project as { id: string };
  const codes = async (c: C) => (await c.get('/api/cost-codes')).json().costCodes as { id: string; code: string; kind: string; isActive: boolean }[];
  const entry = (c: C, ids: Record<string, string>, amount: string, tag: Record<string, unknown>) =>
    c.post('/api/journal-entries', {
      entryDate: day(3, 10),
      description: 'Şantiye gideri',
      post: true,
      lines: [
        { accountId: ids['770'], currency: 'TRY', debit: amount, ...tag },
        { accountId: ids['500'], currency: 'TRY', credit: amount },
      ],
    });

  it('yeni şirkete varsayılan kodlar tohumlanır ve yönetilir', async () => {
    const { c } = await setup('KodTohum');
    const list = await codes(c);
    expect(list.map((x) => x.code)).toEqual(['EKP', 'GNL', 'ISC', 'MLZ', 'NKL', 'TSR']);
    const created = await c.post('/api/cost-codes', { code: 'SGR', name: 'Sigorta', kind: 'overhead' });
    expect(created.statusCode).toBe(201);
    expect((await c.post('/api/cost-codes', { code: 'sgr', name: 'Yinelenen' })).statusCode).toBe(409);
    const id = created.json().costCode.id;
    expect((await c.patch(`/api/cost-codes/${id}`, { isActive: false })).json().costCode.isActive).toBe(false);
    expect((await c.delete(`/api/cost-codes/${id}`)).statusCode).toBe(204);
  });

  it('yevmiye satırı proje + maliyet koduyla etiketlenir; kodsuz ve projesiz kod reddedilir', async () => {
    const { c, ids } = await setup('KodEtiket');
    const p = await mkProject(c);
    const mlz = (await codes(c)).find((x) => x.code === 'MLZ')!;
    const ok = await entry(c, ids, '100.00', { projectId: p.id, costCodeId: mlz.id });
    expect(ok.statusCode, ok.body).toBe(201);
    const lines = ok.json().entry.lines as { costCode: string | null; projectId: string | null }[];
    expect(lines.find((l) => l.costCode === 'MLZ')?.projectId).toBe(p.id);

    const noProject = await entry(c, ids, '100.00', { costCodeId: mlz.id });
    expect(noProject.statusCode).toBe(400);

    const inactive = await c.post('/api/cost-codes', { code: 'OLD', name: 'Eski' });
    await c.patch(`/api/cost-codes/${inactive.json().costCode.id}`, { isActive: false });
    const res = await entry(c, ids, '100.00', { projectId: p.id, costCodeId: inactive.json().costCode.id });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('COST_CODE_INACTIVE');
  });

  it('ters kayıt maliyet kodunu taşır; kullanılan kod silinemez', async () => {
    const { c, ids } = await setup('KodTers');
    const p = await mkProject(c);
    const cc = (await codes(c)).find((x) => x.code === 'TSR')!;
    const ok = await entry(c, ids, '250.00', { projectId: p.id, costCodeId: cc.id });
    const rev = await c.post(`/api/journal-entries/${ok.json().entry.id}/reverse`, { entryDate: day(3, 10) });
    expect(rev.statusCode).toBe(201);
    expect((rev.json().entry.lines as { costCode: string | null }[]).some((l) => l.costCode === 'TSR')).toBe(true);
    expect((await c.delete(`/api/cost-codes/${cc.id}`)).statusCode).toBe(409);
  });

  it('veritabanı: kaydedilmiş satırın maliyet kodu değişmez, projesiz kod yazılamaz, RLS yalıtır', async () => {
    const a = await setup('KodDbA');
    const b = await setup('KodDbB');
    const p = await mkProject(a.c);
    const list = await codes(a.c);
    const mlz = list.find((x) => x.code === 'MLZ')!;
    const isc = list.find((x) => x.code === 'ISC')!;
    const ok = await entry(a.c, a.ids, '10.00', { projectId: p.id, costCodeId: mlz.id });
    const lineId = (ok.json().entry.lines as { id: string; costCode: string | null }[]).find((l) => l.costCode === 'MLZ')!.id;

    // Sahip rolüyle bile: kaydedilmiş satır değişmez (journal_lines_guard) ve proje olmadan kod olmaz (CHECK)
    await expect(execAsOwner(`update journal_lines set cost_code_id = $1 where id = $2`, [isc.id, lineId])).rejects.toThrow();
    await expect(execAsOwner(`update journal_lines set project_id = null, wbs_id = null where id = $1`, [lineId])).rejects.toThrow();

    // B şirketi A'nın kodlarını görmez (RLS)
    const other = await b.c.get('/api/cost-codes');
    expect((other.json().costCodes as { id: string }[]).some((x) => x.id === mlz.id)).toBe(false);
    await asDb(handle, { companyId: b.company.id }, async (q) => {
      expect((await q(`select count(*)::int as n from cost_codes where id = $1`, [mlz.id])).rows[0].n).toBe(0);
    });
  });
});
