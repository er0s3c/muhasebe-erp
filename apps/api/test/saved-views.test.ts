import { describe, expect, it } from 'vitest';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';

/** Öneri 5: kayıtlı görünümler sunucuda; kişisel/ortak görünürlük, yalnız sahibin değiştirmesi, şube ve şirket kapsamı. */
describe('sunucuda kayıtlı görünümler', async () => {
  const { app } = await makeApp();

  async function world(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token, { name: `${name} Ltd.` });
    const owner = client(app, s.token, company.id);
    const viewer = await addMember(app, owner, company.id, 'viewer', `${name.toLowerCase()}-izleyici`);
    return { company, owner, viewer };
  }
  const body = (extra: Record<string, unknown> = {}) => ({ page: 'parties', branchScope: 'all', name: 'Müşteriler', filters: { kind: 'customer', onlyBalance: true }, ...extra });
  const list = async (c: ReturnType<typeof client>, branchScope = 'all') => {
    const res = await c.get(`/api/saved-views?page=parties&branchScope=${branchScope}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().views as { id: string; name: string; shared: boolean; mine: boolean; ownerName: string | null }[];
  };

  it('kişisel görünüm yalnız sahibine, ortak görünüm ekibe görünür; değiştirme ve silme yalnız sahibine açıktır', async () => {
    const w = await world('Gorunum');
    const personal = await w.owner.post('/api/saved-views', body());
    expect(personal.statusCode, personal.body).toBe(201);
    expect(personal.json().view).toMatchObject({ name: 'Müşteriler', shared: false, mine: true, ownerName: null });
    // Salt okunur üye de kendi görünümünü saklayabilir (kişisel veri)
    expect((await w.viewer.client.post('/api/saved-views', body({ name: 'Benimki' }))).statusCode).toBe(201);
    expect((await list(w.viewer.client)).map((v) => v.name)).toEqual(['Benimki']);

    const team = (await w.owner.post('/api/saved-views', body({ name: 'Bakiyeli cariler', shared: true }))).json().view;
    const seen = await list(w.viewer.client);
    expect(seen.find((v) => v.id === team.id)).toMatchObject({ shared: true, mine: false, ownerName: expect.any(String) });
    expect(seen.some((v) => v.id === personal.json().view.id)).toBe(false);

    // Başkasının ortak görünümü değiştirilemez ve silinemez (RLS: bulunamadı)
    expect((await w.viewer.client.patch(`/api/saved-views/${team.id}`, { shared: false })).statusCode).toBe(404);
    expect((await w.viewer.client.delete(`/api/saved-views/${team.id}`)).statusCode).toBe(404);
    // Sahip paylaşımı kaldırınca ekip artık görmez
    expect((await w.owner.patch(`/api/saved-views/${team.id}`, { shared: false })).json().view.shared).toBe(false);
    expect((await list(w.viewer.client)).some((v) => v.id === team.id)).toBe(false);
    expect((await w.owner.delete(`/api/saved-views/${team.id}`)).statusCode).toBe(204);
  });

  it('şube seçimi ve şirket kapsamı ayrıdır', async () => {
    const a = await world('KapsamA');
    const b = await world('KapsamB');
    const shared = (await a.owner.post('/api/saved-views', body({ shared: true }))).json().view;
    expect(await list(a.owner, 'unassigned')).toEqual([]);
    expect((await list(b.owner)).some((v) => v.id === shared.id)).toBe(false);
    expect((await b.owner.delete(`/api/saved-views/${shared.id}`)).statusCode).toBe(404);
  });

  it('ad, ekran, şube kapsamı, filtre biçimi ve adet sınırları denetlenir', async () => {
    const w = await world('Sinir');
    expect((await w.owner.post('/api/saved-views', body({ page: 'Parties!' }))).statusCode).toBe(400);
    expect((await w.owner.post('/api/saved-views', body({ branchScope: 'herkes' }))).statusCode).toBe(400);
    expect((await w.owner.post('/api/saved-views', body({ name: '' }))).statusCode).toBe(400);
    expect((await w.owner.post('/api/saved-views', body({ filters: { kind: { nested: true } } }))).statusCode).toBe(400);
    expect((await w.owner.post('/api/saved-views', body({ filters: { kind: 'x'.repeat(101) } }))).statusCode).toBe(400);
    for (let i = 0; i < 20; i++) expect((await w.owner.post('/api/saved-views', body({ name: `Görünüm ${i}` }))).statusCode).toBe(201);
    const over = await w.owner.post('/api/saved-views', body({ name: 'Fazla' }));
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('SAVED_VIEW_LIMIT');
  });
});
