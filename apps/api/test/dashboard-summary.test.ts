import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = (await makeApp()).app;
});

describe('Pano özeti (tek istek)', () => {
  it('yetkili bölümleri tek yanıtta döndürür; sayılar ve 6 aylık seri sunucuda hesaplanır', async () => {
    const owner = await registerUser(app, 'Dash');
    const company = await createCompany(app, owner.token, { sector: 'COMMERCE', jurisdiction: 'TR', baseCurrency: 'TRY' });
    const c = client(app, owner.token, company.id);
    const res = await c.get('/api/dashboard/summary');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.errors).toEqual([]);
    expect(body.baseCurrency).toBe('TRY');
    expect(Object.keys(body.sections).sort()).toEqual(
      ['aging', 'balance', 'deliveries', 'inventory', 'invoices', 'ledger', 'rates', 'salesTrend', 'treasury'].sort(),
    );
    expect(body.sections.salesTrend).toHaveLength(6);
    expect(body.sections.salesTrend[5].month).toBe(body.today.slice(0, 7));
    expect(body.sections.ledger).toMatchObject({ postedThisYear: 0, drafts: 0, recent: [] });
    expect(body.sections.balance).toMatchObject({ balanced: true });
    expect(body.sections.rates.map((r: { currency: string }) => r.currency)).not.toContain('TRY');
  });

  it('istenen bölümlerle sınırlanır ve yetkisiz bölümleri döndürmez', async () => {
    const owner = await registerUser(app, 'DashScope');
    const company = await createCompany(app, owner.token, { sector: 'COMMERCE', jurisdiction: 'TR', baseCurrency: 'TRY' });
    const c = client(app, owner.token, company.id);
    const only = (await c.get('/api/dashboard/summary?sections=invoices,rates,unknown')).json();
    expect(Object.keys(only.sections).sort()).toEqual(['invoices', 'rates']);

    const viewer = await addMember(app, c, company.id, 'viewer', 'dashviewer');
    const viewerBody = (await viewer.client.get('/api/dashboard/summary')).json();
    // Görüntüleyici rolünün izni olmayan bölüm (ör. yevmiye taslakları) hiç dönmez; hata da sayılmaz
    expect(viewerBody.errors).toEqual([]);
    for (const key of Object.keys(viewerBody.sections)) expect(['treasury', 'aging', 'invoices', 'salesTrend', 'deliveries', 'inventory', 'ledger', 'balance', 'rates']).toContain(key);
  });
});
