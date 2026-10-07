import { describe, expect, it } from 'vitest';
import { createCompanySchema } from './schemas/company';
import { createPurchaseOrderSchema, createPurchaseRequestSchema } from './schemas/procurement';
import { LEATHER_ACCESS_PROFILES, areaOfModule, effectivePermissions } from './module-access';
import { MODULES, NAV_ITEMS, resolveEnabledModules } from './module-registry';
import { eligibleNotificationKinds } from './notifications';
import { recordRefSchema } from './workspace';

describe('deri sektörü ve ortak modüller', () => {
  it('yeni kayıt türleri ve teslim bildirimleri kaynak izinlerine bağlıdır', () => {
    for (const kind of ['leather_model', 'leather_piece', 'leather_production', 'leather_subcontract', 'leather_custom_order', 'leather_service', 'pos_sale']) {
      expect(recordRefSchema.safeParse({ kind, id: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    }
    const modules = resolveEnabledModules('LEATHER_FASHION');
    expect(eligibleNotificationKinds(effectivePermissions('operator', { 'sales.pos': 'write' }), modules)).not.toContain('leather_production_due');
    const manager = eligibleNotificationKinds(effectivePermissions('operations_manager'), modules);
    expect(manager).toContain('approval_pending');
    expect(manager).toContain('leather_production_due');
    expect(manager).toContain('leather_subcontract_due');
    expect(manager).toContain('leather_custom_order_due');
    expect(eligibleNotificationKinds(effectivePermissions('operations_manager'), resolveEnabledModules('LEATHER_FASHION', [{ module: 'leather.production', enabled: false }]))).not.toContain('leather_production_due');
  });
  it('şirket kurulumu yeni sektörü kabul eder ve mevcut sektörleri korur', () => {
    expect(createCompanySchema.parse({ name: 'Deri Atölyesi', sector: 'LEATHER_FASHION' }).sector).toBe('LEATHER_FASHION');
    expect(createCompanySchema.parse({ name: 'Şantiye', sector: 'CONSTRUCTION' }).sector).toBe('CONSTRUCTION');
  });

  it('ortak modüller ve deri modülleri açılır; inşaat ve planlı market POS açılmaz', () => {
    const enabled = resolveEnabledModules('LEATHER_FASHION');
    for (const key of ['core.inventory', 'core.invoices', 'core.procurement', 'leather.catalog', 'leather.production', 'sales.pos']) expect(enabled.has(key), key).toBe(true);
    for (const key of ['construction.projects', 'construction.subcontracts', 'construction.procurement', 'retail.pos']) expect(enabled.has(key), key).toBe(false);
    expect(MODULES.filter((m) => m.sectors === 'all').every((m) => enabled.has(m.key))).toBe(true);
  });

  it('satın alma legacy modülü aynı erişim alanını kullanır; sektör menüsü ayrı kapıyla aynı yola gider', () => {
    expect(areaOfModule('construction.procurement')).toBe('core.procurement');
    expect(areaOfModule('core.procurement')).toBe('core.procurement');
    const nav = NAV_ITEMS.filter((n) => resolveEnabledModules('LEATHER_FASHION').has(n.module));
    expect(nav.some((n) => n.path === '/purchasing/orders' && n.module === 'core.procurement')).toBe(true);
    expect(nav.some((n) => n.group === 'construction')).toBe(false);
  });

  it('üretim bağımlılıkları kapanır, diğer mali modüller kullanılabilir kalır', () => {
    const enabled = resolveEnabledModules('LEATHER_FASHION', [{ module: 'leather.materials', enabled: false }]);
    expect(enabled.has('leather.production')).toBe(false);
    expect(enabled.has('leather.subcontracting')).toBe(false);
    expect(enabled.has('leather.quality')).toBe(false);
    expect(enabled.has('core.invoices')).toBe(true);
  });
});

describe('operatör görev profilleri ve rol sınırları', () => {
  it('kasiyer finansal API izinleri kazanmadan POS satışı yapar', () => {
    const profile = LEATHER_ACCESS_PROFILES.find((p) => p.key === 'cashier')!;
    const permissions = effectivePermissions('operator', profile.levels);
    expect(permissions.has('pos.read')).toBe(true);
    expect(permissions.has('pos.sell')).toBe(true);
    for (const permission of ['pos.manage', 'pos.approve', 'invoices.post', 'treasury.post', 'treasury.read'] as const) expect(permissions.has(permission), permission).toBe(false);
  });

  it('write seçimi tasarım/üretim/kalite onayı ya da maliyet verisi vermez', () => {
    const permissions = effectivePermissions('operator', { 'leather.catalog': 'write', 'leather.production': 'write', 'leather.quality': 'write', 'core.procurement': 'write' });
    expect(permissions.has('leather.production.manage')).toBe(true);
    for (const permission of ['leather.catalog.approve', 'leather.production.approve', 'leather.quality.approve', 'leather.costs.read', 'leather.costs.manage', 'procurement.approve'] as const) expect(permissions.has(permission), permission).toBe(false);
  });

  it('operasyon yöneticisi maliyet ve onay taşır; read istisnası yazma ve onayı düşürür', () => {
    const permissions = effectivePermissions('operations_manager', { 'leather.production': 'read', 'sales.pos': 'read' });
    expect(permissions.has('leather.costs.read')).toBe(true);
    for (const permission of ['leather.production.manage', 'leather.production.approve', 'leather.costs.manage', 'pos.sell', 'pos.manage', 'pos.approve'] as const) expect(permissions.has(permission), permission).toBe(false);
  });

  it('genel tedarik girdisi proje olmadan kabul edilir; sektör kuralını API uygular', () => {
    const lines = [{ description: 'Bitkisel tabaklanmış deri', unit: 'm2', quantity: '10' }];
    expect(createPurchaseRequestSchema.parse({ title: 'Deri alımı', lines }).projectId).toBeUndefined();
    expect(createPurchaseOrderSchema.parse({ partyId: '018f0000-0000-7000-8000-000000000001', currencyCode: 'TRY', lines: lines.map((l) => ({ ...l, unitPrice: '200' })) }).projectId).toBeUndefined();
  });
});
