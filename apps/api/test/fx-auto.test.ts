import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client';
import { autoImportCompany, type FxAutoOptions } from '../src/modules/settings/fx-scheduler';
import { client, createCompany, makeApp, orgOf, registerUser } from './helpers';

const trXml = readFileSync(new URL('./fixtures/tcmb-2026-09-29.xml', import.meta.url), 'utf8');
let app: FastifyInstance;
let db: Db;
beforeAll(async () => {
  const made = await makeApp();
  app = made.app;
  db = made.handle.db;
});

const fetcher = vi.fn(async () => trXml);
const opts = (now: string, overrides: Partial<FxAutoOptions> = {}): FxAutoOptions => ({
  fetcher,
  after: { tcmb: '15:45', kktcmb: '10:30' },
  now: new Date(now),
  ...overrides,
});

async function setup(enable = true) {
  const user = await registerUser(app, 'FxAuto');
  const company = await createCompany(app, user.token, { jurisdiction: 'TR', baseCurrency: 'TRY' });
  const c = client(app, user.token, company.id);
  if (enable) expect((await c.put('/api/exchange-rates/auto', { enabled: true })).statusCode).toBe(200);
  return { c, target: { companyId: company.id, orgId: await orgOf(app, user.token) } };
}

describe('Otomatik resmî kur çekimi', () => {
  it('yayın saatinden sonra bir kez çeker, sonra tekrar indirmez', async () => {
    const { c, target } = await setup();
    fetcher.mockClear();
    // 29.09.2026 Salı 16:00 (Europe/Istanbul = UTC+3)
    expect(await autoImportCompany(db, target, opts('2026-09-29T13:00:00Z'))).toBe('imported');
    expect(await autoImportCompany(db, target, opts('2026-09-29T13:30:00Z'))).toBe('up-to-date');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const rates = (await c.get('/api/exchange-rates')).json().rates as { currencyCode: string; provider: string }[];
    expect(rates.find(r => r.currencyCode === 'GBP')).toMatchObject({ provider: 'tcmb' });
    const status = (await c.get('/api/exchange-rates/auto')).json();
    expect(status).toMatchObject({ enabled: true, provider: 'tcmb', lastError: null, lastImport: { date: '2026-09-29' } });
    expect(status.enabledByName).toContain('FxAuto');
  });

  it('yayın saatinden önce, hafta sonu ve bülten henüz bugüne ait değilken yazmaz', async () => {
    const { target } = await setup();
    fetcher.mockClear();
    expect(await autoImportCompany(db, target, opts('2026-09-29T10:00:00Z'))).toBe('not-due'); // 13:00 İstanbul
    expect(await autoImportCompany(db, target, opts('2026-09-27T14:00:00Z'))).toBe('not-due'); // Pazar
    expect(fetcher).not.toHaveBeenCalled();
    // 30.09 için kaynak hâlâ 29.09 bültenini döndürüyor: bugüne yazılmaz
    expect(await autoImportCompany(db, target, opts('2026-09-30T13:00:00Z'))).toBe('not-due');
  });

  it('kapalı şirkete dokunmaz; kaynak hatasını kaydeder ve ayar ekranında gösterir', async () => {
    const off = await setup(false);
    expect(await autoImportCompany(db, off.target, opts('2026-09-29T13:00:00Z'))).toBe('disabled');

    const { c, target } = await setup();
    const failing = vi.fn(async () => {
      throw new Error('TCMB erişilemiyor');
    });
    expect(await autoImportCompany(db, target, opts('2026-09-29T13:00:00Z', { fetcher: failing }))).toBe('error');
    const status = (await c.get('/api/exchange-rates/auto')).json();
    expect(status.lastError).toContain('TCMB erişilemiyor');
    // Kapatınca hata ve kullanıcı temizlenir
    const disabled = (await c.put('/api/exchange-rates/auto', { enabled: false })).json();
    expect(disabled).toMatchObject({ enabled: false, lastError: null, enabledByName: null });
  });

});
