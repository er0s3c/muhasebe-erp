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

export type NavGroupKey = 'overview' | 'accounting' | 'settings';

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
  { key: 'accounting', labelKey: 'nav.groups.accounting' },
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
    key: 'journal',
    labelKey: 'nav.journal',
    path: '/accounting/journal',
    icon: 'book-open',
    group: 'accounting',
    module: 'core.ledger',
    permission: 'ledger.read',
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
