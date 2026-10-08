import { describe, expect, it } from 'vitest';
import {
  ACCESS_AREAS,
  ACCESS_AREA_KEYS,
  MODULE_AREA,
  ROLE_BOUND_PERMISSIONS,
  areaAccessOf,
  areaOfModule,
  areaOfPermission,
  effectivePermissions,
  exceedsGranter,
  isModuleBlocked,
  permissionOverrideKey,
  permissionsOfArea,
  unclassifiedPermissions,
} from './module-access';
import { MODULES, NAV_ITEMS } from './module-registry';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, type Permission } from './permissions';
import { setModuleAccessSchema } from './schemas/module-access';

describe('izin sınıflandırması', () => {
  it('her izin tam olarak bir alanın okuma/yazma/bağlı listesinde ya da rol-bağlı listede yer alır (yeni izin sınıflandırılmadan eklenemez)', () => {
    const seen = new Map<Permission, string[]>();
    const add = (p: Permission, where: string) => seen.set(p, [...(seen.get(p) ?? []), where]);
    for (const key of ACCESS_AREA_KEYS) {
      const a = ACCESS_AREAS[key] as { read: readonly Permission[]; write: readonly Permission[]; bound?: Partial<Record<Permission, string>> };
      for (const p of a.read) add(p, `${key}.read`);
      for (const p of a.write) add(p, `${key}.write`);
      for (const p of Object.keys(a.bound ?? {}) as Permission[]) add(p, `${key}.bound`);
    }
    for (const p of ROLE_BOUND_PERMISSIONS) add(p, 'role-bound');
    for (const p of PERMISSIONS) expect(seen.get(p), `${p} sınıflandırılmamış: module-access.ts içinde bir alana ya da ROLE_BOUND_PERMISSIONS'a ekleyin`).toHaveLength(1);
    for (const p of seen.keys()) expect(PERMISSIONS, `${p} gerçek bir izin değil`).toContain(p);
    expect(unclassifiedPermissions()).toEqual([]);
  });

  it('her kayıt modülü bir alana (ya da bilerek yönetilmeyen) bağlıdır; alan anahtarları kayıt modülüdür', () => {
    for (const m of MODULES) expect(Object.prototype.hasOwnProperty.call(MODULE_AREA, m.key), `${m.key} MODULE_AREA'da yok`).toBe(true);
    for (const k of Object.keys(MODULE_AREA)) expect(MODULES.some((m) => m.key === k), k).toBe(true);
    for (const key of ACCESS_AREA_KEYS) {
      expect(MODULES.some((m) => m.key === key), key).toBe(true);
      expect(MODULE_AREA[key]).toBe(key);
    }
    expect(areaOfModule('core.dashboard')).toBeNull();
    expect(areaOfModule('core.settings')).toBeNull();
    expect(areaOfModule('treasury.cheques')).toBe('core.treasury');
  });

  it('menü öğesinin izni, modülünün alanındadır (alan yönetilen modülde izin alansız olamaz)', () => {
    for (const n of NAV_ITEMS) {
      const area = areaOfModule(n.module);
      if (!area || !n.permission) continue;
      const permArea = areaOfPermission(n.permission);
      const roleBound = (ROLE_BOUND_PERMISSIONS as readonly string[]).includes(n.permission);
      // Alan dışı izinler (rol-bağlı) ya da başka alanın izni olabilir; ancak aynı modül için kaçak olmasın diye kural: izin ya kendi alanı ya rol-bağlı
      if (!roleBound && permArea !== area) {
        // Raporlar ortak reports.read izniyle çalışır: ledger alanındadır; modül kapısı (MODULE_ACCESS_DENIED) ayrıca engeller.
        expect(permArea, `${n.key} (${n.module}) izni ${n.permission}`).toBe('core.ledger');
        expect(n.permission).toBe('reports.read');
      }
    }
  });

  it('alan listeleri ayrık ve rol-bağlı izinler alan okuma/yazma listelerinde değildir', () => {
    for (const key of ACCESS_AREA_KEYS) {
      const a = ACCESS_AREAS[key] as { read: readonly Permission[]; write: readonly Permission[]; bound?: Partial<Record<Permission, string>> };
      for (const p of Object.keys(a.bound ?? {}) as Permission[]) {
        expect(a.read).not.toContain(p);
        expect(a.write).not.toContain(p);
      }
      for (const p of a.read) expect(p.endsWith('.read') || p === 'hr.payroll', `${key}: ${p} okuma listesinde`).toBe(true);
      for (const p of a.write) expect(a.read).not.toContain(p);
    }
  });
});

const set = (role: (typeof ROLES)[number], o: Record<string, 'none' | 'read' | 'write'>) => effectivePermissions(role, o);

describe('etkin izin hesabı', () => {
  it('istisna yoksa rol şablonudur', () => {
    for (const r of ROLES) expect([...effectivePermissions(r)].sort()).toEqual([...ROLE_PERMISSIONS[r]].sort());
  });

  it('none alanın tüm okuma/yazma izinlerini kaldırır, diğer alanlara dokunmaz', () => {
    const p = set('accountant', { 'core.invoices': 'none' });
    for (const x of ['invoices.read', 'invoices.manage', 'invoices.post', 'deliveries.read', 'deliveries.post']) expect(p.has(x as Permission), x).toBe(false);
    expect(p.has('treasury.read')).toBe(true);
    expect(p.has('parties.manage')).toBe(true);
  });

  it('read yazma izinlerini kaldırır, okumaları (rolde yoksa bile) ekler', () => {
    const p = set('accountant', { 'core.treasury': 'read' });
    expect(p.has('treasury.read')).toBe(true);
    expect(p.has('treasury.manage')).toBe(false);
    expect(p.has('treasury.post')).toBe(false);
    const s = set('sales', { 'core.treasury': 'read' });
    expect(s.has('treasury.read')).toBe(true);
    expect(s.has('treasury.post')).toBe(false);
  });

  it('write okuma+yazmayı verir (görüntüleyici tek modülde düzenleyici olabilir)', () => {
    const p = set('viewer', { 'core.invoices': 'write' });
    for (const x of ['invoices.read', 'invoices.manage', 'invoices.post', 'deliveries.manage', 'deliveries.post']) expect(p.has(x as Permission), x).toBe(true);
    expect(p.has('treasury.manage')).toBe(false);
  });

  it('role bağlı izinler hiçbir düzeyde verilmez', () => {
    const everything = Object.fromEntries(ACCESS_AREA_KEYS.map((k) => [k, 'write' as const]));
    for (const r of ROLES) {
      const p = effectivePermissions(r, everything);
      for (const b of ['company.manage', 'members.manage', 'settings.manage', 'data.export', 'hr.sensitive', 'privacy.manage', 'ledger.yearend', 'reports.consolidation'] as Permission[]) {
        expect(p.has(b), `${r}: ${b}`).toBe(ROLE_PERMISSIONS[r].includes(b));
      }
    }
    // Görüntüleyiciye personel yazma verilince hassas veri gelmez
    const v = set('viewer', { 'hr.core': 'write', 'hr.payroll': 'write' });
    expect(v.has('hr.manage')).toBe(true);
    expect(v.has('hr.sensitive')).toBe(false);
    expect(v.has('privacy.manage')).toBe(false);
  });

  it('role bağlı izin, alan none ise bastırılır; read ise yazma türü bastırılır, okuma türü korunur', () => {
    expect(set('admin', { 'hr.core': 'none' }).has('hr.sensitive')).toBe(false);
    expect(set('admin', { 'hr.core': 'none' }).has('privacy.manage')).toBe(false);
    expect(set('admin', { 'hr.core': 'read' }).has('hr.sensitive')).toBe(true);
    expect(set('admin', { 'hr.core': 'read' }).has('privacy.manage')).toBe(false);
    expect(set('admin', { 'core.ledger': 'none' }).has('ledger.yearend')).toBe(false);
    expect(set('admin', { 'core.ledger': 'none' }).has('reports.consolidation')).toBe(false);
    expect(set('admin', { 'core.ledger': 'read' }).has('ledger.yearend')).toBe(false);
    expect(set('admin', { 'core.ledger': 'read' }).has('reports.consolidation')).toBe(true);
    // Yönetici hâlâ üye yönetebilir (rol-bağlı, alansız)
    expect(set('admin', { 'core.ledger': 'none', 'hr.core': 'none' }).has('members.manage')).toBe(true);
  });

  it('sahibin erişimi istisnayla kısılamaz', () => {
    const everything = Object.fromEntries(ACCESS_AREA_KEYS.map((k) => [k, 'none' as const]));
    expect([...effectivePermissions('owner', everything)].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('bilinmeyen alan ve geçersiz düzey yok sayılır', () => {
    const p = effectivePermissions('viewer', { 'yok.alan': 'write', 'core.parties': 'bogus' as never, __proto__: 'write' as never });
    expect([...p].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
  });

  it('düzey görünümü ve verme sınırı', () => {
    expect(areaAccessOf(effectivePermissions('viewer'), 'core.invoices')).toEqual({ area: 'core.invoices', level: 'read', partial: false });
    expect(areaAccessOf(effectivePermissions('site_manager'), 'core.invoices')).toMatchObject({ level: 'write', partial: true });
    expect(areaAccessOf(effectivePermissions('viewer'), 'hr.payroll').level).toBe('none');
    const target = effectivePermissions('viewer', { 'core.invoices': 'write' });
    expect(exceedsGranter(effectivePermissions('admin'), target, 'core.invoices')).toEqual([]);
    expect(exceedsGranter(effectivePermissions('sales'), target, 'core.invoices')).toEqual(['invoices.post', 'deliveries.post']);
  });

  it('modül engeli yalnızca sahip dışı ve none için geçerlidir', () => {
    expect(isModuleBlocked({ 'core.treasury': 'none' }, 'viewer', 'treasury.cheques')).toBe(true);
    expect(isModuleBlocked({ 'core.treasury': 'read' }, 'viewer', 'treasury.cheques')).toBe(false);
    expect(isModuleBlocked({ 'core.treasury': 'none' }, 'owner', 'core.treasury')).toBe(false);
    expect(isModuleBlocked({ 'core.treasury': 'none' }, 'viewer', 'core.dashboard')).toBe(false);
  });
});

describe('istek şeması', () => {
  it('geçerli düzeyleri ve default değerini kabul eder, diğerlerini reddeder', () => {
    expect(setModuleAccessSchema.safeParse({ levels: { 'core.invoices': 'read', 'core.parties': 'default' } }).success).toBe(true);
    expect(setModuleAccessSchema.safeParse({ levels: { 'core.invoices': 'admin' } }).success).toBe(false);
    expect(setModuleAccessSchema.safeParse({ levels: {} }).success).toBe(false);
  });
  it('yalnız işlem seçimi kabul edilir; boş istek ve geçersiz seçim reddedilir', () => {
    expect(setModuleAccessSchema.safeParse({ permissions: { 'invoices.post': 'deny' } }).success).toBe(true);
    expect(setModuleAccessSchema.safeParse({ permissions: { 'invoices.manage': 'allow', 'deliveries.post': 'default' }, levels: {} }).success).toBe(true);
    expect(setModuleAccessSchema.safeParse({ permissions: { 'invoices.post': 'write' } }).success).toBe(false);
    expect(setModuleAccessSchema.safeParse({}).success).toBe(false);
  });
});

describe('ayrıntılı işlem izinleri', () => {
  it('fatura düzenleme ile muhasebeleştirme ve irsaliye hakları ayrı kısıtlanır', () => {
    const p = effectivePermissions('viewer', { 'core.invoices': 'write', [permissionOverrideKey('invoices.post')]: 'none', [permissionOverrideKey('deliveries.manage')]: 'none' });
    expect(p.has('invoices.manage')).toBe(true);
    expect(p.has('invoices.post')).toBe(false);
    expect(p.has('deliveries.read')).toBe(true);
    expect(p.has('deliveries.manage')).toBe(false);
  });

  it('sadece seçilen işlem verilir; kapalı alan tüm işlemler için üstün gelir', () => {
    const overrides = { 'core.inventory': 'read', [permissionOverrideKey('inventory.move')]: 'write' } as const;
    const p = effectivePermissions('viewer', overrides);
    expect(p.has('inventory.move')).toBe(true);
    expect(p.has('inventory.manage')).toBe(false);
    expect(effectivePermissions('viewer', { ...overrides, 'core.inventory': 'none' }).has('inventory.move')).toBe(false);
  });

  it('hassas veri, rol onayı ve yıl sonu hakları rol sınırını aşmaz; sahip kısıtlanmaz', () => {
    const overrides = { [permissionOverrideKey('hr.sensitive')]: 'write', [permissionOverrideKey('ledger.yearend')]: 'write', [permissionOverrideKey('manufacturing.production.approve')]: 'write' } as const;
    const viewer = effectivePermissions('viewer', overrides);
    expect(viewer.has('hr.sensitive')).toBe(false);
    expect(viewer.has('ledger.yearend')).toBe(false);
    expect(viewer.has('manufacturing.production.approve')).toBe(false);
    expect(effectivePermissions('admin', { 'core.ledger': 'read', [permissionOverrideKey('ledger.yearend')]: 'write' }).has('ledger.yearend')).toBe(true);
    expect(effectivePermissions('owner', { [permissionOverrideKey('ledger.yearend')]: 'none' }).has('ledger.yearend')).toBe(true);
  });

  it('yönetim çekirdeği ve bilinmeyen işlem anahtarları istisnayla verilemez veya alınamaz', () => {
    const p = effectivePermissions('viewer', { 'permission.members.manage': 'write', 'permission.not.real': 'write', 'permission.invoices.post': 'read' });
    expect([...p].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
    expect(effectivePermissions('admin', { 'permission.members.manage': 'none' }).has('members.manage')).toBe(true);
    for (const area of ACCESS_AREA_KEYS) for (const permission of permissionsOfArea(area)) expect(permissionOverrideKey(permission).length).toBeLessThanOrEqual(60);
  });
});
