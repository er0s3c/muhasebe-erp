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

test('cihaz koltukları: kayıtlı tarayıcı, yönetici listesi, yeniden adlandırma ve kaldırınca oturumun kapanması', async ({ request }) => {
  const email = `cihaz-${Date.now()}@example.com`;
  const reg = await request.post('/api/auth/register', {
    data: { email, password: 'Sifre-12345-xyz', fullName: 'Cihaz Sahibi', organizationName: 'Cihaz Ltd.' },
  });
  expect(reg.status()).toBe(201);
  const token = (await reg.json()).accessToken as string;
  const auth = { authorization: `Bearer ${token}` };
  expect((await request.post('/api/companies', { headers: auth, data: { name: 'Cihaz Market', sector: 'RETAIL_MARKET' } })).status()).toBe(201);

  const list = await (await request.get('/api/devices', { headers: auth })).json();
  expect(list.enforced).toBe(true);
  const mine = list.devices.find((d: { current: boolean }) => d.current);
  expect(mine).toMatchObject({ status: 'active', lastUser: { email } });

  expect((await request.patch(`/api/devices/${mine.id}`, { headers: auth, data: { name: 'E2E tarayıcısı' } })).status()).toBe(200);
  const renamed = await (await request.get('/api/devices', { headers: auth })).json();
  expect(renamed.devices.find((d: { id: string }) => d.id === mine.id).name).toBe('E2E tarayıcısı');

  // kendi cihazını kaldıran oturum kapanır (belirteç ve yenileme); yeniden giriş yeni bir cihaz olarak kaydolur
  expect((await request.delete(`/api/devices/${mine.id}`, { headers: auth })).status()).toBe(200);
  const dead = await request.get('/api/me', { headers: auth });
  expect(dead.status()).toBe(401);
  expect((await dead.json()).error.code).toBe('DEVICE_REVOKED');
  const login = await request.post('/api/auth/login', { data: { email, password: 'Sifre-12345-xyz' } });
  expect(login.status()).toBe(200);
  const again = await (await request.get('/api/devices', { headers: { authorization: `Bearer ${(await login.json()).accessToken}` } })).json();
  const current = again.devices.find((d: { current: boolean }) => d.current);
  expect(current.id).not.toBe(mine.id);
});
