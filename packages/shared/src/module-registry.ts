import type { Permission } from './permissions';

export const SECTORS = ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'] as const;
export type Sector = (typeof SECTORS)[number];

export type ModuleStatus = 'available' | 'planned';

export interface ModuleDef {
  key: string;
  labelKey: string;
  /** 'all' = her sektörde açık (çekirdek). */
  sectors: readonly Sector[] | 'all';
  status: ModuleStatus;
}

/**
 * Sektörel modül kaydı: tek doğruluk kaynağı. API menüyü ve uç korumasını,
 * web ise modül başına lazy parçaları buna göre belirler.
 * 'planned' modüller henüz hiçbir şirkete açılmaz.
 */
export const MODULES: readonly ModuleDef[] = [
  { key: 'core.dashboard', labelKey: 'modules.dashboard', sectors: 'all', status: 'available' },
  { key: 'core.ledger', labelKey: 'modules.ledger', sectors: 'all', status: 'available' },
  { key: 'core.parties', labelKey: 'modules.parties', sectors: 'all', status: 'available' },
  { key: 'core.inventory', labelKey: 'modules.inventory', sectors: 'all', status: 'available' },
  { key: 'core.invoices', labelKey: 'modules.invoices', sectors: 'all', status: 'available' },
  { key: 'core.treasury', labelKey: 'modules.treasury', sectors: 'all', status: 'available' },
  { key: 'core.settings', labelKey: 'modules.settings', sectors: 'all', status: 'available' },
  {
    key: 'construction.projects',
    labelKey: 'modules.constructionProjects',
    sectors: ['CONSTRUCTION'],
    status: 'planned',
  },
  {
    key: 'retail.pos',
    labelKey: 'modules.retailPos',
    sectors: ['RETAIL_MARKET'],
    status: 'planned',
  },
];

export type NavGroupKey = 'overview' | 'parties' | 'invoices' | 'treasury' | 'stock' | 'accounting' | 'reports' | 'settings';

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
    key: 'account-mapping',
    labelKey: 'nav.accountMapping',
    path: '/settings/account-mapping',
    icon: 'link-2',
    group: 'settings',
    module: 'core.settings',
    permission: 'accounts.manage',
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
 * Bir istisna yalnızca kayıtta 'available' olan ve sektöre uyan bir modülü kapatabilir;
 * sektöre uymayan modül istisnayla açılamaz.
 */
export function resolveEnabledModules(
  sector: Sector,
  overrides: readonly ModuleOverride[] = [],
  registry: readonly ModuleDef[] = MODULES,
): Set<string> {
  const enabled = new Set<string>();
  for (const mod of registry) {
    if (isModuleAvailableForSector(mod, sector)) enabled.add(mod.key);
  }
  for (const o of overrides) {
    if (!o.enabled) enabled.delete(o.module);
  }
  return enabled;
}
