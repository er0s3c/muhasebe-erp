import { expect, test } from '@playwright/test';

// Gerçek lisans sunucusuna karşı, üretim paketinde (E2E_TARGET=bundle): etkinleştirilmiş kurulum, sahip görünümü, gerçek kalp atışı.
test.skip(process.env.E2E_TARGET !== 'bundle', 'Üretim paketi modunda çalışır');

test('lisans: etkin kurulum, sahip ayrıntıları ve gerçek lisans sunucusuyla yenileme', async ({ request }) => {
  const pub = await (await request.get('/api/public-config')).json();
  expect(pub.license).toMatchObject({ enforced: true, state: 'active' });

  const email = `lisans-${Date.now()}@example.com`;
  const reg = await request.post('/api/auth/register', {
    data: { email, password: 'Sifre-12345-xyz', fullName: 'Lisans Sahibi', organizationName: 'Lisans Ltd.' },
  });
  expect(reg.status()).toBe(201);
  const token = (await reg.json()).accessToken as string;
  const auth = { authorization: `Bearer ${token}` };
  const company = await request.post('/api/companies', { headers: auth, data: { name: 'Lisans Market', sector: 'RETAIL_MARKET' } });
  expect(company.status()).toBe(201);

  const info = await (await request.get('/api/license', { headers: auth })).json();
  expect(info).toMatchObject({ state: 'active', isOwner: true, fingerprintStrength: expect.stringMatching(/strong|weak/) });
  expect(info.license.sectors).toEqual(expect.arrayContaining(['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE']));
  expect(info.usage.companies).toBeGreaterThanOrEqual(1);

  const refreshed = await request.post('/api/license/refresh', { headers: auth });
  expect(refreshed.status()).toBe(200);
  const after = await refreshed.json();
  expect(after.state).toBe('active');
  expect(Date.parse(after.lastSuccessAt)).toBeGreaterThanOrEqual(Date.parse(info.lastSuccessAt));
});
