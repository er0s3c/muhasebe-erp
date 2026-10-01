import { describe, expect, it } from 'vitest';
import {
  MODULES,
  checkModuleToggle,
  describeModules,
  resolveEnabledModules,
  type ModuleDef,
  type ModuleOverride,
} from './module-registry';

const off = (...modules: string[]): ModuleOverride[] => modules.map((module) => ({ module, enabled: false }));

describe('modül kaydı bütünlüğü', () => {
  it('requires yalnızca var olan, kilitsiz ve farklı modülleri gösterir; döngü yoktur', () => {
    const byKey = new Map(MODULES.map((m) => [m.key, m]));
    for (const m of MODULES) {
      for (const r of m.requires ?? []) {
        expect(byKey.has(r), `${m.key} -> ${r} var mı`).toBe(true);
        expect(r).not.toBe(m.key);
        // Kilitli modül zaten hep açık olduğundan gereksinim olarak yazılmaz
        expect(byKey.get(r)!.locked ?? false, `${m.key} -> kilitli ${r}`).toBe(false);
      }
    }
    // Döngü denetimi: derinlemesine gezinti
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (k: string) => {
      if (done.has(k)) return;
      expect(visiting.has(k), `döngü: ${k}`).toBe(false);
      visiting.add(k);
      for (const r of byKey.get(k)?.requires ?? []) visit(r);
      visiting.delete(k);
      done.add(k);
    };
    for (const m of MODULES) visit(m.key);
  });

  it('panel ve ayarlar kilitli', () => {
    expect(MODULES.find((m) => m.key === 'core.dashboard')!.locked).toBe(true);
    expect(MODULES.find((m) => m.key === 'core.settings')!.locked).toBe(true);
  });
});

describe('resolveEnabledModules: gereksinim kapanışı', () => {
  it('muhasebe kapatılırsa ona bağlı tüm modüller kapanır (ham SQL ile yazılmış istisnaya karşı savunma)', () => {
    const enabled = resolveEnabledModules('CONSTRUCTION', off('core.ledger'));
    for (const k of ['core.ledger', 'core.parties', 'core.inventory', 'core.invoices', 'core.treasury', 'construction.projects']) expect(enabled.has(k), k).toBe(false);
    expect(enabled.has('core.settings')).toBe(true);
    expect(enabled.has('core.dashboard')).toBe(true);
  });

  it('stok kapatılırsa fatura da kapanır; kasa/banka ve cari açık kalır', () => {
    const enabled = resolveEnabledModules('COMMERCE', off('core.inventory'));
    expect(enabled.has('core.invoices')).toBe(false);
    expect(enabled.has('core.treasury')).toBe(true);
    expect(enabled.has('core.parties')).toBe(true);
  });
});

describe('checkModuleToggle', () => {
  const check = (key: string, enable: boolean, overrides: ModuleOverride[] = [], sector: 'CONSTRUCTION' | 'COMMERCE' | 'RETAIL_MARKET' = 'COMMERCE') =>
    checkModuleToggle(sector, overrides, key, enable);

  it('yaprak modüller (fatura, kasa/banka) serbestçe kapanıp açılır', () => {
    expect(check('core.invoices', false)).toEqual({ ok: true });
    expect(check('core.treasury', false)).toEqual({ ok: true });
    expect(check('core.invoices', true, off('core.invoices'))).toEqual({ ok: true });
  });

  it('bağımlısı açık modül kapatılamaz ve hangi modüllerin engellediği söylenir', () => {
    expect(check('core.inventory', false)).toEqual({ ok: false, reason: 'REQUIRED_BY', modules: ['core.invoices'] });
    const parties = check('core.parties', false);
    expect(parties).toMatchObject({ ok: false, reason: 'REQUIRED_BY' });
    expect(parties.ok === false && parties.modules.sort()).toEqual(['core.invoices', 'core.treasury']);
    // Bağımlılar önce kapatılırsa sıra serbest
    expect(check('core.inventory', false, off('core.invoices'))).toEqual({ ok: true });
    expect(check('core.ledger', false, off('core.invoices', 'core.treasury', 'core.parties', 'core.inventory'))).toEqual({ ok: true });
  });

  it('gereksinimi kapalı modül açılamaz', () => {
    expect(check('core.invoices', true, off('core.invoices', 'core.inventory'))).toEqual({
      ok: false,
      reason: 'MISSING_REQUIREMENT',
      modules: ['core.inventory'],
    });
  });

  it('kilitli, planlı, sektöre uymayan ve bilinmeyen modül reddedilir', () => {
    expect(check('core.settings', false)).toMatchObject({ ok: false, reason: 'LOCKED' });
    expect(check('core.dashboard', false)).toMatchObject({ ok: false, reason: 'LOCKED' });
    expect(check('retail.pos', true)).toMatchObject({ ok: false, reason: 'PLANNED' });
    const registry: ModuleDef[] = MODULES.map((m) => ({ ...m, status: 'available' as const }));
    expect(checkModuleToggle('COMMERCE', [], 'retail.pos', true, registry)).toMatchObject({ ok: false, reason: 'SECTOR_MISMATCH' });
    expect(check('x.y', true)).toMatchObject({ ok: false, reason: 'UNKNOWN' });
  });
});

describe('describeModules', () => {
  it('her modül için durum, bağımlılar ve engel nedeni döner', () => {
    const list = describeModules('CONSTRUCTION', off('core.treasury'));
    const by = Object.fromEntries(list.map((d) => [d.key, d]));
    expect(by['core.treasury']).toMatchObject({ enabled: false, override: false, sectorDefault: true, blocked: null });
    expect(by['core.inventory']).toMatchObject({ enabled: true, override: null, dependents: ['core.invoices'] });
    expect(by['core.inventory']!.blocked).toEqual({ reason: 'REQUIRED_BY', modules: ['core.invoices'] });
    expect(by['core.settings']).toMatchObject({ locked: true, blocked: { reason: 'LOCKED', modules: [] } });
    expect(by['construction.projects']).toMatchObject({ enabled: true, sectorDefault: true, blocked: { reason: 'REQUIRED_BY', modules: ['construction.subcontracts', 'construction.procurement'] } });
    expect(by['construction.subcontracts']).toMatchObject({ enabled: true, sectorDefault: true, blocked: null });
    expect(by['retail.pos']).toMatchObject({ enabled: false, sectorDefault: false, blocked: { reason: 'PLANNED' } });
    expect(list).toHaveLength(MODULES.length);
  });
});
