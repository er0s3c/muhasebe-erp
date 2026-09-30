import { describe, expect, it } from 'vitest';
import { loadConfig, parseTrustProxy } from '../src/config';

const base = { DATABASE_URL: 'postgres://erp_app:erp_app@localhost:5432/erp_license', LICENSE_DATA_KEY: 'k'.repeat(40) };
const prod = {
  ...base,
  NODE_ENV: 'production',
  LICENSE_SIGNING_KEY_FILE: '/run/keys/signing-key.json',
  LICENSE_SIGNING_KEY_PASSPHRASE: 'p'.repeat(16),
  LICENSE_ADMIN_ORIGIN: 'https://lisans.ornek.com',
};

describe('lisans sunucusu yapılandırması', () => {
  it('TRUST_PROXY: varsayılan false, bayraklar ve vekil adres listesi kabul edilir', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('loopback, uniquelocal')).toEqual(['loopback', 'uniquelocal']);
    expect(loadConfig({ ...base, TRUST_PROXY: 'loopback,uniquelocal' }).TRUST_PROXY).toEqual(['loopback', 'uniquelocal']);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8,172.16.0.0/12' }).TRUST_PROXY).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('sayısal TRUST_PROXY reddedilir: Fastify 5.12 atlama sayısını yok sayar, oran sınırı tek kovaya düşerdi', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: '1' })).toThrow(/Sayısal TRUST_PROXY/);
    expect(() => loadConfig({ ...prod, TRUST_PROXY: '2' })).toThrow(/Sayısal TRUST_PROXY/);
  });

  it('üretimde LICENSE_ADMIN_ORIGIN zorunlu ve https olmalı; geliştirmede gerekmez', () => {
    expect(loadConfig(prod).LICENSE_ADMIN_ORIGIN).toBe('https://lisans.ornek.com');
    const { LICENSE_ADMIN_ORIGIN: _omit, ...withoutOrigin } = prod;
    void _omit;
    expect(() => loadConfig(withoutOrigin)).toThrow(/LICENSE_ADMIN_ORIGIN/);
    expect(() => loadConfig({ ...prod, LICENSE_ADMIN_ORIGIN: 'http://lisans.ornek.com' })).toThrow(/https olmalı/);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).LICENSE_ADMIN_ORIGIN).toBeUndefined();
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).LICENSE_ADMIN_ORIGIN).toBeUndefined();
  });
});
