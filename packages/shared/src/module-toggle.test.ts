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
    expect(check('invoices.orders', false)).toEqual({ ok: true });
    expect(check('core.invoices', false, off('invoices.orders', 'sales.pricelists', 'inventory.imports'))).toEqual({ ok: true });
    expect(check('treasury.cheques', false)).toEqual({ ok: true });
    expect(check('treasury.guarantees', false)).toEqual({ ok: true });
    expect(check('treasury.expenses', false)).toEqual({ ok: true });
    expect(check('inventory.imports', false)).toEqual({ ok: true });
    expect(check('core.invoices', true, off('core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.imports'))).toEqual({ ok: true });
  });

  it('bağımlısı açık modül kapatılamaz ve hangi modüllerin engellediği söylenir', () => {
    expect(check('core.inventory', false)).toEqual({ ok: false, reason: 'REQUIRED_BY', modules: ['core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports'] });
    const parties = check('core.parties', false);
    expect(parties).toMatchObject({ ok: false, reason: 'REQUIRED_BY' });
    expect(parties.ok === false && parties.modules.sort()).toEqual(['core.invoices', 'core.treasury', 'treasury.expenses']);
    // Bağımlılar önce kapatılırsa sıra serbest
    expect(check('core.inventory', false, off('core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports'))).toEqual({ ok: true });
    expect(check('core.ledger', false, off('core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports', 'treasury.expenses', 'core.treasury', 'core.parties', 'core.inventory', 'hr.payroll'))).toEqual({ ok: true });
  });

  it('sosyal güvenlik çıktıları bordroya bağlıdır: bordro, bağımlısı açıkken kapatılamaz; bordro kapalıyken sosyal güvenlik açılamaz', () => {
    expect(check('hr.payroll', false)).toEqual({ ok: false, reason: 'REQUIRED_BY', modules: ['hr.socialsecurity'] });
    expect(check('hr.payroll', false, off('hr.socialsecurity'))).toEqual({ ok: true });
    expect(check('hr.socialsecurity', true, off('hr.socialsecurity', 'hr.payroll'))).toMatchObject({ ok: false });
  });

  it('yabancı işçi takibi personel modülüne bağlıdır', () => {
    expect(check('hr.core', false, off('hr.payroll', 'hr.socialsecurity'))).toEqual({ ok: false, reason: 'REQUIRED_BY', modules: ['hr.foreign'] });
    expect(check('hr.core', false, off('hr.payroll', 'hr.socialsecurity', 'hr.foreign'))).toEqual({ ok: true });
    expect(check('hr.foreign', true, off('hr.foreign', 'hr.core'))).toMatchObject({ ok: false });
  });

  it('kasa/banka, çek/senet ve teminat mektubu modülleri açıkken kapatılamaz; bunlar kapalıyken serbest', () => {
    const blocked = check('core.treasury', false);
    expect(blocked.ok === false && blocked.modules.sort()).toEqual(['treasury.cheques', 'treasury.expenses', 'treasury.guarantees']);
    expect(check('core.treasury', false, off('treasury.cheques', 'treasury.guarantees', 'treasury.expenses'))).toEqual({ ok: true });
    expect(check('treasury.cheques', true, off('core.treasury', 'treasury.cheques'))).toMatchObject({ ok: false });
  });

  it('satış teklif/sipariş modülü fatura ve stoğa bağlıdır: ikisi açıkken fatura kapatılamaz, kapalıyken sipariş açılamaz', () => {
    expect(check('core.invoices', false)).toEqual({ ok: false, reason: 'REQUIRED_BY', modules: ['invoices.orders', 'sales.pricelists', 'inventory.imports'] });
    expect(check('invoices.orders', true, off('invoices.orders', 'core.invoices'))).toMatchObject({ ok: false, reason: 'MISSING_REQUIREMENT', modules: ['core.invoices'] });
    expect(check('invoices.orders', true, off('invoices.orders'))).toEqual({ ok: true });
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
    expect(by['core.inventory']).toMatchObject({ enabled: true, override: null, dependents: ['core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports'] });
    expect(by['core.inventory']!.blocked).toEqual({ reason: 'REQUIRED_BY', modules: ['core.invoices', 'invoices.orders', 'sales.pricelists', 'inventory.serials', 'inventory.imports'] });
    expect(by['core.settings']).toMatchObject({ locked: true, blocked: { reason: 'LOCKED', modules: [] } });
    expect(by['construction.projects']).toMatchObject({ enabled: true, sectorDefault: true, blocked: { reason: 'REQUIRED_BY', modules: ['construction.subcontracts', 'construction.procurement', 'construction.realestate'] } });
    expect(by['construction.subcontracts']).toMatchObject({ enabled: true, sectorDefault: true, blocked: null });
    expect(by['retail.pos']).toMatchObject({ enabled: false, sectorDefault: false, blocked: { reason: 'PLANNED' } });
    expect(list).toHaveLength(MODULES.length);
  });
});
