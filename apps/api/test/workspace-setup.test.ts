import { describe, expect, it } from 'vitest';
import { client, createCompany, makeApp, registerUser } from './helpers';

/** Öneri 1: kurulum listesi sektör paketinin ilk kaydını da içerir; başka sektörün adımı görünmez. */
describe('sektöre göre kurulum adımları', async () => {
  const { app } = await makeApp();
  const keys = async (sector: string) => {
    const s = await registerUser(app, `Kurulum${sector.slice(0, 4)}`);
    const company = await createCompany(app, s.token, { sector });
    const r = await client(app, s.token, company.id).get('/api/workspace/setup');
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().steps as { key: string; done: boolean }[]).map((x) => x.key);
  };
  it('inşaatta proje, üretimde reçete ve kaynak, ticarette yalnız ortak adımlar', async () => {
    expect(await keys('CONSTRUCTION')).toContain('project');
    const manufacturing = await keys('MANUFACTURING_WHOLESALE');
    expect(manufacturing).toEqual(expect.arrayContaining(['catalog', 'resource']));
    const commerce = await keys('COMMERCE');
    expect(commerce).toEqual(expect.arrayContaining(['bank', 'customer']));
    expect(commerce).not.toContain('project');
    expect(commerce).not.toContain('catalog');
  });
});
