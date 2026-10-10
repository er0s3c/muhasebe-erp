import type { NavigationData } from '../../lib/queries';

type SourceGroups = NavigationData['groups'];
export type DisplayNavItem = SourceGroups[number]['items'][number] & { label?: string };
export interface DisplayNavGroup {
  key: string;
  label: string;
  icon: string;
  items: DisplayNavItem[];
}

const GROUPS = [
  ['overview', 'Çalışma alanı', 'layout-dashboard'],
  ['parties', 'Cari hesaplar', 'contact'],
  ['sales', 'Satış', 'shopping-cart'],
  ['invoices', 'Faturalar ve irsaliyeler', 'receipt'],
  ['procurement', 'Satın alma', 'clipboard-list'],
  ['treasury', 'Kasa ve banka', 'wallet'],
  ['stock', 'Stok ve depo', 'warehouse'],
  ['construction', 'Projeler ve inşaat', 'hard-hat'],
  ['manufacturing', 'Üretim', 'factory'],
  ['leather', 'Deri üretimi', 'scissors'],
  ['directory', 'Rehber ve ajanda', 'book-user'],
  ['hr', 'İnsan kaynakları', 'users'],
  ['accounting', 'Muhasebe', 'book-open'],
  ['reports', 'Raporlar', 'bar-chart'],
  ['settings', 'Ayarlar', 'settings'],
] as const;

const TARGETS: Record<string, string> = {
  'sales-quotes': 'sales', 'sales-orders': 'sales', 'price-lists': 'sales',
  'party-prices': 'sales', campaigns: 'sales', 'sales-pos': 'sales', 'sales.logistics': 'sales',
  'purchase-requests': 'procurement', rfqs: 'procurement', 'purchase-orders': 'procurement',
  'order-matching': 'procurement', 'construction-replenishment': 'procurement',
  'inventory.wms': 'stock',
  'supplier-performance': 'reports', 'construction-supplier-performance': 'reports',
  'stock-analytics': 'reports', 'vat-summary': 'reports', 'expense-reports': 'reports',
  'trial-balance': 'reports', 'account-ledger': 'reports',
  'core.integrations': 'settings', 'data-export': 'settings', 'file-exchange': 'settings',
  'activity-report': 'settings',
};

const LABELS: Record<string, string> = {
  'core.integrations': 'Kanal bağlantıları', 'platform-integrations': 'API ve webhook',
};

/**
 * Aynı konuyu bölen menü öğeleri tek "merkez" sayfada sekme olur. Sunucu izinleri değişmez: kaynak öğelerden en az biri
 * kullanıcıya görünüyorsa birleşik öğe görünür; merkez sayfa yalnız izinli sekmeleri gösterir.
 */
export const NAV_MERGES: ReadonlyArray<{ key: string; label: string; path: string; group: string; from: readonly string[] }> = [
  { key: 'hr-settings', label: 'İK ve bordro ayarları', path: '/hr/settings', group: 'hr', from: ['payroll-settings', 'social-settings', 'foreign-settings'] },
  { key: 'cash-planning', label: 'Nakit planlama', path: '/treasury/cash-planning', group: 'treasury', from: ['cash-forecast', 'cash-scenarios'] },
  { key: 'integrations', label: 'Entegrasyonlar', path: '/settings/integrations', group: 'settings', from: ['core.integrations', 'platform-integrations'] },
  { key: 'data-transfer', label: 'Veri aktarımı', path: '/settings/data-transfer', group: 'settings', from: ['file-exchange', 'data-export'] },
  { key: 'expenses', label: 'Giderler', path: '/treasury/expenses', group: 'treasury', from: ['expense-entries', 'expense-cards'] },
];
const MERGE_OF = new Map(NAV_MERGES.flatMap(m => m.from.map(key => [key, m] as const)));
const ORDER: Record<string, readonly string[]> = {
  overview: ['/', '/workspace', '/workspace/documents', '/notifications'],
  sales: ['/sales/quotes', '/sales/orders', '/price-lists', '/party-prices', '/sales/campaigns', '/pos', '/logistics'],
  procurement: ['/purchasing/requests', '/purchasing/rfqs', '/purchasing/orders', '/purchasing/matching', '/purchasing/replenishment'],
};

/** Query key order does not create a second destination; distinct query values do. */
export function navigationDestination(path: string): string {
  const url = new URL(path, 'https://ada.invalid');
  url.searchParams.sort();
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Presentation only: server-provided permissions, module filtering and links stay authoritative. */
export function buildDisplayNavigation(source: SourceGroups = []): DisplayNavGroup[] {
  const targets = new Map<string, DisplayNavItem[]>();
  const seen = new Set<string>();
  for (const group of source) {
    for (const source of group.items) {
      const merge = MERGE_OF.get(source.key);
      const item: DisplayNavItem = merge ? { ...source, key: merge.key, path: merge.path, label: merge.label } : source;
      const destination = navigationDestination(item.path);
      if (seen.has(destination)) continue;
      seen.add(destination);
      const key = merge?.group ?? TARGETS[item.key] ?? group.key;
      const items = targets.get(key) ?? [];
      items.push({ ...item, ...(LABELS[item.key] ? { label: LABELS[item.key] } : {}) });
      targets.set(key, items);
    }
  }
  const groups: DisplayNavGroup[] = GROUPS.map(([key, label, icon]) => {
    const order = ORDER[key] ?? [];
    const rank = (item: DisplayNavItem) => {
      const index = order.indexOf(item.path);
      return index < 0 ? order.length : index;
    };
    return { key, label, icon, items: (targets.get(key) ?? []).sort((a, b) => rank(a) - rank(b)) };
  }).filter(group => group.items.length > 0);
  // A future server group remains reachable before the client learns its new display category.
  for (const group of source) {
    if (!GROUPS.some(([key]) => key === group.key) && targets.has(group.key) && !groups.some(g => g.key === group.key)) {
      groups.push({ key: group.key, label: group.labelKey, icon: 'files', items: targets.get(group.key)! });
    }
  }
  return groups;
}

/** Pick only the most specific destination (e.g. /leather/models over /leather). */
export function findActiveNavigation(groups: DisplayNavGroup[], pathname: string, search: string, defaultOperationKind: 'collection' | 'site_report' = 'collection') {
  const current = new URLSearchParams(search);
  // Keep direct links aligned with OperationsPage's sector-specific default.
  if (pathname === '/workspace/operations' && !current.get('kind')) current.set('kind', defaultOperationKind);
  let match: { group: DisplayNavGroup; item: DisplayNavItem } | undefined;
  let score = -1;
  for (const group of groups) {
    for (const item of group.items) {
      const url = new URL(item.path, 'https://ada.invalid');
      if (![...url.searchParams].every(([key, value]) => current.get(key) === value)) continue;
      const exact = pathname === url.pathname;
      if (!exact && (url.pathname === '/' || url.pathname === '/workspace' || !pathname.startsWith(`${url.pathname}/`))) continue;
      const specificity = url.pathname.length + [...url.searchParams].length * 1000;
      if (specificity > score) { match = { group, item }; score = specificity; }
    }
  }
  return match;
}

export function isPosFocusPath(pathname: string) {
  return pathname === '/pos';
}
