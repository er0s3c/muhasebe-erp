import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { createLicenseService } from '../src/licensing';

// Depodaki anahtar dosyası boşmuş gibi: denetim açıkken güvenilir satıcı anahtarı yoksa hizmet kurulamamalı (kullanılamaz paket üretilmesin).
vi.mock('../src/licensing/public-keys.json', () => ({ default: { keys: {}, revoked: [] } }));

const baseEnv = {
  DATABASE_URL: 'postgres://erp_app:erp_app@localhost:5432/erp_test',
  JWT_SECRET: 'Zx9kQ2mVb7LpR4nTc8Yw3HaEd6JfUg5Ns1Xo0AiBq',
};

describe('boş satıcı anahtar halkası', () => {
  it('denetim açıkken güvenilir anahtar yoksa hizmet kurulamaz', () => {
    const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'test' });
    expect(() => createLicenseService({ db: {} as never, config: cfg, setup: { enforced: true } })).toThrow(/açık anahtar/);
  });

  it('denetim kapalıyken (geliştirme/test) boş halka sorun çıkarmaz', () => {
    const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'test' });
    expect(createLicenseService({ db: {} as never, config: cfg, setup: { enforced: false } }).enforced).toBe(false);
  });
});
