import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addMember, client, createCompany, makeApp, registerUser } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  app = (await makeApp()).app;
});

describe('Kişisel arayüz tercihleri', () => {
  it('favori, pano düzeni ve yoğunluğu kullanıcı + şirket kapsamında saklar; başka üye göremez', async () => {
    const owner = await registerUser(app, 'Prefs');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);

    expect((await c.get('/api/me/preferences')).json()).toEqual({ preferences: {} });
    const favorites = [{ path: '/invoices/sales', title: 'Satış faturaları' }, { path: '/parties?type=customer', title: 'Müşteriler' }];
    expect((await c.put('/api/me/preferences/favorites', { value: favorites })).statusCode).toBe(200);
    expect((await c.put('/api/me/preferences/table.density', { value: 'compact' })).statusCode).toBe(200);
    const layout = { version: 1, widgets: [{ id: 'cash', size: 'm' }, { id: 'fx-rates', size: 's' }] };
    expect((await c.put('/api/me/preferences/dashboard.layout', { value: layout })).statusCode).toBe(200);
    // Güncelleme mevcut satırın üzerine yazar
    expect((await c.put('/api/me/preferences/table.density', { value: 'comfortable' })).statusCode).toBe(200);

    expect((await c.get('/api/me/preferences')).json().preferences).toEqual({
      favorites,
      'table.density': 'comfortable',
      'dashboard.layout': layout,
    });

    const member = await addMember(app, c, company.id, 'accountant', 'prefmember');
    expect((await member.client.get('/api/me/preferences')).json()).toEqual({ preferences: {} });

    // Aynı kullanıcının başka şirketi ayrı kapsamdır
    const other = await createCompany(app, owner.token, { name: 'İkinci Şirket' });
    expect((await client(app, owner.token, other.id).get('/api/me/preferences')).json()).toEqual({ preferences: {} });
  });

  it('bilinmeyen anahtarı ve şemaya uymayan değeri reddeder', async () => {
    const owner = await registerUser(app, 'PrefsBad');
    const company = await createCompany(app, owner.token);
    const c = client(app, owner.token, company.id);
    const unknown = await c.put('/api/me/preferences/theme', { value: 'dark' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('PREFERENCE_UNKNOWN');
    const invalid = await c.put('/api/me/preferences/favorites', { value: [{ path: 'https://evil.example', title: 'x' }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('PREFERENCE_INVALID');
    const tooMany = await c.put('/api/me/preferences/favorites', { value: Array.from({ length: 21 }, (_, i) => ({ path: `/p${i}`, title: `P${i}` })) });
    expect(tooMany.statusCode).toBe(400);
    const badDensity = await c.put('/api/me/preferences/table.density', { value: 'tiny' });
    expect(badDensity.statusCode).toBe(400);
  });
});
