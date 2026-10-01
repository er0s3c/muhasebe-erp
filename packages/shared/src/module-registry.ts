import type { Permission } from './permissions';

export const SECTORS = ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'] as const;
export type Sector = (typeof SECTORS)[number];

export type ModuleStatus = 'available' | 'planned';

export interface ModuleDef {
  key: string;
  labelKey: string;
  /** Türkçe ad (hata iletilerinde kullanılır; arayüz `labelKey` çevirisini kullanır). */
  label: string;
  /** 'all' = her sektörde açık (çekirdek). */
  sectors: readonly Sector[] | 'all';
  status: ModuleStatus;
  /** true: kapatılamaz (panel ve ayarlar olmadan şirket yönetilemez); `company_modules` istisnası yok sayılır. */
  locked?: boolean;
  /**
   * Bu modülün çalışması için AÇIK olması gereken diğer modüller (gözlenen servis bağımlılıkları: fatura stok/cari/defter
   * kullanır, kasa-banka defter ve cari kullanır, cari bakiyeleri defter satırlarından türer, stok otomatik yevmiye yazar).
   * Bir modül kapatılırsa ona bağlı modüller de çalışamaz; bağımlı açıkken kapatılamaz.
   */
  requires?: readonly string[];
}

/**
 * Sektörel modül kaydı: tek doğruluk kaynağı. API menüyü ve uç korumasını,
 * web ise modül başına lazy parçaları buna göre belirler.
 * 'planned' modüller henüz hiçbir şirkete açılmaz.
 */
export const MODULES: readonly ModuleDef[] = [
  { key: 'core.dashboard', labelKey: 'modules.dashboard', label: 'Genel bakış', sectors: 'all', status: 'available', locked: true },
  { key: 'core.ledger', labelKey: 'modules.ledger', label: 'Muhasebe', sectors: 'all', status: 'available' },
  { key: 'core.parties', labelKey: 'modules.parties', label: 'Cari hesaplar', sectors: 'all', status: 'available', requires: ['core.ledger'] },
  { key: 'core.inventory', labelKey: 'modules.inventory', label: 'Stok', sectors: 'all', status: 'available', requires: ['core.ledger'] },
  {
    key: 'core.invoices',
    labelKey: 'modules.invoices',
    label: 'Fatura ve irsaliye',
    sectors: 'all',
    status: 'available',
    requires: ['core.ledger', 'core.parties', 'core.inventory'],
  },
  { key: 'core.treasury', labelKey: 'modules.treasury', label: 'Kasa ve banka', sectors: 'all', status: 'available', requires: ['core.ledger', 'core.parties'] },
  { key: 'core.settings', labelKey: 'modules.settings', label: 'Ayarlar', sectors: 'all', status: 'available', locked: true },
  {
    key: 'construction.projects',
    labelKey: 'modules.constructionProjects',
    label: 'Şantiye ve projeler',
    sectors: ['CONSTRUCTION'],
    status: 'available',
    // Maliyet boyutu yevmiye satırlarında taşınır; proje raporu defterden türer
    requires: ['core.ledger'],
  },
  {
    key: 'construction.subcontracts',
    labelKey: 'modules.constructionSubcontracts',
    label: 'Taşeron ve hakediş',
    sectors: ['CONSTRUCTION'],
    status: 'available',
    // Hakediş yevmiye yazar ve taşeron cari hesaba bağlıdır; ödeme kasa/banka modülünden bağımsız yapılır
    // (avans ve ödeme eylemleri kasa/banka kapalıysa çalışmaz, hakediş kaydı etkilenmez)
    requires: ['core.ledger', 'core.parties', 'construction.projects'],
  },
  {
    key: 'construction.procurement',
    labelKey: 'modules.constructionProcurement',
    label: 'Satın alma ve sipariş',
    sectors: ['CONSTRUCTION'],
    status: 'available',
    // Sipariş taahhüt yaratır (proje); teklif ve sipariş tedarikçi carisine bağlıdır
    requires: ['core.parties', 'construction.projects'],
  },
  {
    key: 'construction.realestate',
    labelKey: 'modules.constructionRealestate',
    label: 'Gayrimenkul satışı',
    sectors: ['CONSTRUCTION'],
    status: 'available',
    // Satış yevmiye yazar (alıcı carisi, ertelenmiş gelir, gelir) ve birimler projeye bağlıdır; tahsilat kasa/banka modülünden yapılır
    requires: ['core.ledger', 'core.parties', 'construction.projects'],
  },
  {
    key: 'retail.pos',
    labelKey: 'modules.retailPos',
    label: 'Hızlı satış (POS)',
    sectors: ['RETAIL_MARKET'],
    status: 'planned',
  },
];

export type NavGroupKey =
  | 'overview'
  | 'parties'
  | 'invoices'
  | 'treasury'
  | 'stock'
  | 'construction'
  | 'accounting'
  | 'reports'
  | 'settings';

export interface NavItemDef {
  key: string;
  labelKey: string;
  path: string;
  icon: string;
  group: NavGroupKey;
  module: string;
  /** Yoksa modülü açık olan herkes görür. */
  permission?: Permission;
}

export const NAV_GROUPS: readonly { key: NavGroupKey; labelKey: string }[] = [
  { key: 'overview', labelKey: 'nav.groups.overview' },
  { key: 'parties', labelKey: 'nav.groups.parties' },
  { key: 'invoices', labelKey: 'nav.groups.invoices' },
  { key: 'treasury', labelKey: 'nav.groups.treasury' },
  { key: 'stock', labelKey: 'nav.groups.stock' },
  { key: 'construction', labelKey: 'nav.groups.construction' },
  { key: 'accounting', labelKey: 'nav.groups.accounting' },
  { key: 'reports', labelKey: 'nav.groups.reports' },
  { key: 'settings', labelKey: 'nav.groups.settings' },
];

export const NAV_ITEMS: readonly NavItemDef[] = [
  {
    key: 'dashboard',
    labelKey: 'nav.dashboard',
    path: '/',
    icon: 'layout-dashboard',
    group: 'overview',
    module: 'core.dashboard',
  },
  {
    key: 'parties',
    labelKey: 'nav.parties',
    path: '/parties',
    icon: 'contact',
    group: 'parties',
    module: 'core.parties',
    permission: 'parties.read',
  },
  {
    key: 'party-aging',
    labelKey: 'nav.partyAging',
    path: '/parties/aging',
    icon: 'hourglass',
    group: 'parties',
    module: 'core.parties',
    permission: 'parties.read',
  },
  {
    key: 'sales-invoices',
    labelKey: 'nav.salesInvoices',
    path: '/invoices/sales',
    icon: 'receipt',
    group: 'invoices',
    module: 'core.invoices',
    permission: 'invoices.read',
  },
  {
    key: 'purchase-invoices',
    labelKey: 'nav.purchaseInvoices',
    path: '/invoices/purchases',
    icon: 'receipt-text',
    group: 'invoices',
    module: 'core.invoices',
    permission: 'invoices.read',
  },
  {
    key: 'sales-delivery-notes',
    labelKey: 'nav.salesDeliveryNotes',
    path: '/delivery-notes/sales',
    icon: 'truck',
    group: 'invoices',
    module: 'core.invoices',
    permission: 'deliveries.read',
  },
  {
    key: 'purchase-delivery-notes',
    labelKey: 'nav.purchaseDeliveryNotes',
    path: '/delivery-notes/purchases',
    icon: 'package-check',
    group: 'invoices',
    module: 'core.invoices',
    permission: 'deliveries.read',
  },
  {
    key: 'vat-summary',
    labelKey: 'nav.vatSummary',
    path: '/invoices/vat-summary',
    icon: 'percent',
    group: 'invoices',
    module: 'core.invoices',
    permission: 'reports.read',
  },
  {
    key: 'treasury-accounts',
    labelKey: 'nav.treasuryAccounts',
    path: '/treasury/accounts',
    icon: 'wallet',
    group: 'treasury',
    module: 'core.treasury',
    permission: 'treasury.read',
  },
  {
    key: 'treasury-transactions',
    labelKey: 'nav.treasuryTransactions',
    path: '/treasury/transactions',
    icon: 'landmark',
    group: 'treasury',
    module: 'core.treasury',
    permission: 'treasury.read',
  },
  {
    key: 'items',
    labelKey: 'nav.items',
    path: '/inventory/items',
    icon: 'package',
    group: 'stock',
    module: 'core.inventory',
    permission: 'inventory.read',
  },
  {
    key: 'stock-status',
    labelKey: 'nav.stockStatus',
    path: '/inventory/status',
    icon: 'boxes',
    group: 'stock',
    module: 'core.inventory',
    permission: 'inventory.read',
  },
  {
    key: 'stock-movements',
    labelKey: 'nav.stockMovements',
    path: '/inventory/movements',
    icon: 'arrow-left-right',
    group: 'stock',
    module: 'core.inventory',
    permission: 'inventory.read',
  },
  {
    key: 'stock-counts',
    labelKey: 'nav.stockCounts',
    path: '/inventory/counts',
    icon: 'clipboard-check',
    group: 'stock',
    module: 'core.inventory',
    permission: 'inventory.read',
  },
  {
    key: 'warehouses',
    labelKey: 'nav.warehouses',
    path: '/inventory/warehouses',
    icon: 'warehouse',
    group: 'stock',
    module: 'core.inventory',
    permission: 'inventory.read',
  },
  {
    key: 'projects',
    labelKey: 'nav.projects',
    path: '/projects',
    icon: 'hard-hat',
    group: 'construction',
    module: 'construction.projects',
    permission: 'projects.read',
  },
  {
    key: 'purchase-requests',
    labelKey: 'nav.purchaseRequests',
    path: '/purchasing/requests',
    icon: 'clipboard-check',
    group: 'construction',
    module: 'construction.procurement',
    permission: 'procurement.read',
  },
  {
    key: 'rfqs',
    labelKey: 'nav.rfqs',
    path: '/purchasing/rfqs',
    icon: 'scale',
    group: 'construction',
    module: 'construction.procurement',
    permission: 'procurement.read',
  },
  {
    key: 'purchase-orders',
    labelKey: 'nav.purchaseOrders',
    path: '/purchasing/orders',
    icon: 'package-check',
    group: 'construction',
    module: 'construction.procurement',
    permission: 'procurement.read',
  },
  {
    key: 'real-estate-units',
    labelKey: 'nav.realEstateUnits',
    path: '/real-estate/units',
    icon: 'building-2',
    group: 'construction',
    module: 'construction.realestate',
    permission: 'realestate.read',
  },
  {
    key: 'sales-contracts',
    labelKey: 'nav.salesContracts',
    path: '/real-estate/contracts',
    icon: 'file-signature',
    group: 'construction',
    module: 'construction.realestate',
    permission: 'realestate.read',
  },
  {
    key: 'sales-installments',
    labelKey: 'nav.salesInstallments',
    path: '/real-estate/installments',
    icon: 'calendar-days',
    group: 'construction',
    module: 'construction.realestate',
    permission: 'realestate.read',
  },
  {
    key: 'subcontracts',
    labelKey: 'nav.subcontracts',
    path: '/subcontracts',
    icon: 'file-signature',
    group: 'construction',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'employer-contracts',
    labelKey: 'nav.employerContracts',
    path: '/employer-contracts',
    icon: 'file-signature',
    group: 'construction',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'employer-claims',
    labelKey: 'nav.employerClaims',
    path: '/employer-claims',
    icon: 'file-check',
    group: 'construction',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'progress-payments',
    labelKey: 'nav.progressPayments',
    path: '/progress-payments',
    icon: 'file-check',
    group: 'construction',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'approvals',
    labelKey: 'nav.approvals',
    path: '/approvals',
    icon: 'inbox',
    group: 'construction',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'project-profitability',
    labelKey: 'nav.projectProfitability',
    path: '/reports/project-profitability',
    icon: 'trending-up',
    group: 'reports',
    module: 'construction.projects',
    permission: 'projects.read',
  },
  {
    key: 'journal',
    labelKey: 'nav.journal',
    path: '/accounting/journal',
    icon: 'book-open',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'ledger.read',
  },
  {
    key: 'openings',
    labelKey: 'nav.openings',
    path: '/accounting/openings',
    icon: 'upload',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'ledger.post',
  },
  {
    key: 'accounts',
    labelKey: 'nav.accounts',
    path: '/accounting/accounts',
    icon: 'list-tree',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'ledger.read',
  },
  {
    key: 'trial-balance',
    labelKey: 'nav.trialBalance',
    path: '/accounting/trial-balance',
    icon: 'scale',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'reports.read',
  },
  {
    key: 'account-ledger',
    labelKey: 'nav.accountLedger',
    path: '/accounting/account-ledger',
    icon: 'file-text',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'reports.read',
  },
  {
    key: 'report-journal-book',
    labelKey: 'nav.reportJournalBook',
    path: '/reports/journal-book',
    icon: 'book-marked',
    group: 'reports',
    module: 'core.ledger',
    permission: 'reports.read',
  },
  {
    key: 'report-general-ledger',
    labelKey: 'nav.reportGeneralLedger',
    path: '/reports/general-ledger',
    icon: 'library',
    group: 'reports',
    module: 'core.ledger',
    permission: 'reports.read',
  },
  {
    key: 'report-sales',
    labelKey: 'nav.reportSales',
    path: '/reports/sales',
    icon: 'trending-up',
    group: 'reports',
    module: 'core.invoices',
    permission: 'reports.read',
  },
  {
    key: 'report-purchases',
    labelKey: 'nav.reportPurchases',
    path: '/reports/purchases',
    icon: 'shopping-bag',
    group: 'reports',
    module: 'core.invoices',
    permission: 'reports.read',
  },
  {
    key: 'report-item-profit',
    labelKey: 'nav.reportItemProfit',
    path: '/reports/item-profit',
    icon: 'bar-chart',
    group: 'reports',
    module: 'core.invoices',
    permission: 'reports.read',
  },
  {
    key: 'report-fx',
    labelKey: 'nav.reportFx',
    path: '/reports/fx-differences',
    icon: 'repeat',
    group: 'reports',
    module: 'core.treasury',
    permission: 'reports.read',
  },
  {
    key: 'data-export',
    labelKey: 'nav.dataExport',
    path: '/reports/data-export',
    icon: 'download',
    group: 'reports',
    module: 'core.settings',
    permission: 'data.export',
  },
  {
    key: 'company',
    labelKey: 'nav.company',
    path: '/settings/company',
    icon: 'building-2',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'members',
    labelKey: 'nav.members',
    path: '/settings/members',
    icon: 'users',
    group: 'settings',
    module: 'core.settings',
    permission: 'members.manage',
  },
  {
    key: 'currencies',
    labelKey: 'nav.currencies',
    path: '/settings/currencies',
    icon: 'coins',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'tax-rates',
    labelKey: 'nav.taxRates',
    path: '/settings/tax-rates',
    icon: 'percent',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'periods',
    labelKey: 'nav.periods',
    path: '/settings/periods',
    icon: 'calendar-days',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'modules',
    labelKey: 'nav.modules',
    path: '/settings/modules',
    icon: 'puzzle',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'license',
    labelKey: 'nav.license',
    path: '/settings/license',
    icon: 'badge-check',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
  {
    key: 'devices',
    labelKey: 'nav.devices',
    path: '/settings/devices',
    icon: 'monitor-smartphone',
    group: 'settings',
    module: 'core.settings',
    permission: 'members.manage',
  },
  {
    key: 'account-mapping',
    labelKey: 'nav.accountMapping',
    path: '/settings/account-mapping',
    icon: 'link-2',
    group: 'settings',
    module: 'core.settings',
    permission: 'accounts.manage',
  },
  {
    key: 'construction-settings',
    labelKey: 'nav.constructionSettings',
    path: '/settings/construction',
    icon: 'sliders-horizontal',
    group: 'settings',
    module: 'construction.subcontracts',
    permission: 'subcontracts.read',
  },
  {
    key: 'custom-codes',
    labelKey: 'nav.customCodes',
    path: '/settings/custom-codes',
    icon: 'tags',
    group: 'settings',
    module: 'core.settings',
    permission: 'settings.read',
  },
];

export function isModuleAvailableForSector(mod: ModuleDef, sector: Sector): boolean {
  return mod.status === 'available' && (mod.sectors === 'all' || mod.sectors.includes(sector));
}

export interface ModuleOverride {
  module: string;
  enabled: boolean;
}

/**
 * Şirketin açık modülleri: sektör varsayılanları + `company_modules` istisnaları.
 * Bir istisna yalnızca kayıtta 'available' olan, sektöre uyan ve KİLİTLİ olmayan bir modülü kapatabilir;
 * sektöre uymayan modül istisnayla açılamaz. Gereksinimi (`requires`) kapalı olan modül de kapanır (geçişli):
 * bu, ham SQL ile yazılmış tutarsız bir istisna satırına karşı savunmadır.
 */
export function resolveEnabledModules(
  sector: Sector,
  overrides: readonly ModuleOverride[] = [],
  registry: readonly ModuleDef[] = MODULES,
): Set<string> {
  const byKey = new Map(registry.map((m) => [m.key, m]));
  const enabled = new Set<string>();
  for (const mod of registry) {
    if (isModuleAvailableForSector(mod, sector)) enabled.add(mod.key);
  }
  for (const o of overrides) {
    if (!o.enabled && !byKey.get(o.module)?.locked) enabled.delete(o.module);
  }
  // Gereksinimi eksik modülleri düşür (kararlı hale gelene dek)
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of [...enabled]) {
      const missing = (byKey.get(key)?.requires ?? []).some((r) => !enabled.has(r));
      if (missing) {
        enabled.delete(key);
        changed = true;
      }
    }
  }
  return enabled;
}

export type ModuleToggleReason =
  | 'UNKNOWN'
  | 'PLANNED'
  | 'SECTOR_MISMATCH'
  | 'LOCKED'
  | 'REQUIRED_BY'
  | 'MISSING_REQUIREMENT';

export type ModuleToggleCheck = { ok: true } | { ok: false; reason: ModuleToggleReason; modules: string[] };

/**
 * Bir modülü açma/kapatma isteğinin geçerli olup olmadığını denetler (API ve arayüz aynı kuralı kullanır).
 * Zaten istenen durumdaysa sorun yoktur (etkisiz).
 */
export function checkModuleToggle(
  sector: Sector,
  overrides: readonly ModuleOverride[],
  key: string,
  enable: boolean,
  registry: readonly ModuleDef[] = MODULES,
): ModuleToggleCheck {
  const mod = registry.find((m) => m.key === key);
  if (!mod) return { ok: false, reason: 'UNKNOWN', modules: [] };
  if (mod.status === 'planned') return { ok: false, reason: 'PLANNED', modules: [] };
  if (!isModuleAvailableForSector(mod, sector)) return { ok: false, reason: 'SECTOR_MISMATCH', modules: [] };
  if (mod.locked) return { ok: false, reason: 'LOCKED', modules: [] };

  const enabled = resolveEnabledModules(sector, overrides, registry);
  if (enable) {
    const missing = (mod.requires ?? []).filter((r) => !enabled.has(r));
    return missing.length > 0 ? { ok: false, reason: 'MISSING_REQUIREMENT', modules: missing } : { ok: true };
  }
  const dependents = registry.filter((m) => enabled.has(m.key) && m.requires?.includes(key)).map((m) => m.key);
  return dependents.length > 0 ? { ok: false, reason: 'REQUIRED_BY', modules: dependents } : { ok: true };
}

export interface ModuleDescription {
  key: string;
  labelKey: string;
  label: string;
  status: ModuleStatus;
  /** Sektörün varsayılanında açık mı (planlı/sektöre uymayan modül false). */
  sectorDefault: boolean;
  /** `company_modules` istisnası: false = kapatılmış, null = istisna yok. */
  override: false | null;
  enabled: boolean;
  locked: boolean;
  requires: string[];
  /** Şu anda AÇIK olup bu modüle bağlı olanlar (varsa kapatılamaz). */
  dependents: string[];
  /** Kapatma/açma engeli (yoksa null). */
  blocked: { reason: ModuleToggleReason; modules: string[] } | null;
}

/** Ayarlar > Modüller ekranı için her modülün durumu ve neden değiştirilemeyeceği. */
export function describeModules(
  sector: Sector,
  overrides: readonly ModuleOverride[],
  registry: readonly ModuleDef[] = MODULES,
): ModuleDescription[] {
  const enabled = resolveEnabledModules(sector, overrides, registry);
  return registry.map((m) => {
    const isEnabled = enabled.has(m.key);
    const check = checkModuleToggle(sector, overrides, m.key, !isEnabled, registry);
    return {
      key: m.key,
      labelKey: m.labelKey,
      label: m.label,
      status: m.status,
      sectorDefault: isModuleAvailableForSector(m, sector),
      override: overrides.some((o) => o.module === m.key && !o.enabled) ? false : null,
      enabled: isEnabled,
      locked: m.locked ?? false,
      requires: [...(m.requires ?? [])],
      dependents: registry.filter((d) => enabled.has(d.key) && d.requires?.includes(m.key)).map((d) => d.key),
      blocked: check.ok ? null : { reason: check.reason, modules: check.modules },
    };
  });
}
