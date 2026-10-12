import { NAV_ITEMS } from '@erp/shared';
import type { HelpData, NavHelpEntry } from './helpTypes';

// Navigation is the route source of truth, including query-specific screens.
// İlk kayıt kazanır: aynı yolu paylaşan ikiz menü öğelerinden (genel/inşaat satın alma) birincisi seçilir.
const PATH_TO_HELP_KEY = new Map<string, string>();
for (const item of NAV_ITEMS) if (!PATH_TO_HELP_KEY.has(item.path)) PATH_TO_HELP_KEY.set(item.path, item.key);

/**
 * Menüde bulunmayan detay/editör ekranları. Liste yolları önce tam eşleşmeyle yakalandığı için
 * desenler yalnız `:id`, `new` gibi kayıt yollarına düşer.
 */
const DETAIL_HELP: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/parties\/[^/]+$/, 'party-detail'],
  [/^\/invoices\/[^/]+$/, 'invoice-editor'],
  [/^\/delivery-notes\/[^/]+$/, 'delivery-note-editor'],
  [/^\/sales\/docs\/[^/]+$/, 'sales-doc'],
  [/^\/price-lists\/[^/]+$/, 'price-list-detail'],
  [/^\/inventory\/items\/[^/]+$/, 'item-detail'],
  [/^\/inventory\/counts\/[^/]+$/, 'count-editor'],
  [/^\/inventory\/imports\/[^/]+$/, 'import-files'],
  [/^\/purchasing\/requests\/[^/]+$/, 'purchase-request-editor'],
  [/^\/purchasing\/rfqs\/[^/]+$/, 'rfq-detail'],
  [/^\/purchasing\/orders\/[^/]+$/, 'purchase-order-editor'],
  [/^\/projects\/[^/]+$/, 'project-detail'],
  [/^\/real-estate\/contracts\/[^/]+$/, 'sales-contract-detail'],
  [/^\/subcontracts\/[^/]+$/, 'subcontract-detail'],
  [/^\/progress-payments\/[^/]+$/, 'progress-editor'],
  [/^\/variation-orders\/[^/]+$/, 'variation-detail'],
  [/^\/treasury\/accounts\/[^/]+$/, 'treasury-account-detail'],
  [/^\/hr\/employees\/[^/]+$/, 'employee-detail'],
  [/^\/hr\/employee-ledger\/[^/]+$/, 'employee-statement'],
  [/^\/hr\/payroll\/[^/]+\/slip\/[^/]+$/, 'payroll-slip'],
  [/^\/hr\/payroll\/[^/]+$/, 'payroll-run'],
  [/^\/hr\/social-security\/[^/]+$/, 'social-declaration'],
  [/^\/directory\/contacts\/[^/]+$/, 'directory-contacts'],
  [/^\/directory\/organizations\/[^/]+$/, 'directory-orgs'],
];

/** Sayfanın rehber anahtarı veri indirilmeden bulunur (tetik düğmesinin etiketi ve önceden yükleme için). */
export function routeHelpKey(pathname: string, search = ''): string | null {
  const full = search ? `${pathname}${search}` : pathname;
  const exact = PATH_TO_HELP_KEY.get(full) ?? PATH_TO_HELP_KEY.get(pathname);
  if (exact) return exact;
  for (const [pattern, key] of DETAIL_HELP) if (pattern.test(pathname)) return key;
  return null;
}

/** Yolu en uzun önekle kapsayan menü grubunun anahtarı; rehberi olmayan ekran grubun genel rehberine düşer. */
function routeGroupKey(pathname: string): string | null {
  let best: { length: number; group: string } | null = null;
  for (const item of NAV_ITEMS) {
    const base = item.path.split('?')[0]!;
    if (base === '/' || !(pathname === base || pathname.startsWith(`${base}/`))) continue;
    if (!best || base.length > best.length) best = { length: base.length, group: item.group };
  }
  if (best) return best.group;
  // Menüde olmayan alt ekran (ör. /inventory/yeni-ekran): aynı ilk yol parçasını paylaşan menü öğesinin grubu
  const segment = pathname.split('/')[1];
  return (segment && NAV_ITEMS.find(item => item.path.split('?')[0]!.split('/')[1] === segment)?.group) || null;
}

export function normalizeHelpText(text: string): string {
  return text
    .toLocaleLowerCase('tr-TR')
    .replace(/i̇/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

export interface HelpQuery {
  pathname: string;
  search?: string;
  title?: string;
  description?: string;
  helpKey?: string;
  help?: NavHelpEntry | null;
}

/**
 * Sıra: açık `help` → açık `helpKey` → tam yol/detay deseni → başlığın birebir eşi → grup rehberi → genel metin.
 * Eski "içerir" eşleşmesi kaldırıldı: kısa başlıklar (ör. "Hesaplar") ilgisiz bir modülün rehberini açıyordu.
 */
export function resolveHelpEntry(data: HelpData, query: HelpQuery): NavHelpEntry {
  const { NAV_ITEM_HELP, NAV_GROUP_HELP } = data;
  if (query.help) return query.help;
  if (query.helpKey) {
    const direct = NAV_ITEM_HELP[query.helpKey] ?? NAV_GROUP_HELP[query.helpKey];
    if (direct) return direct;
  }
  const key = routeHelpKey(query.pathname, query.search);
  if (key && NAV_ITEM_HELP[key]) return NAV_ITEM_HELP[key];
  if (query.title) {
    const norm = normalizeHelpText(query.title);
    const byTitle = Object.values(NAV_ITEM_HELP).find(entry => normalizeHelpText(entry.title) === norm);
    if (byTitle) return byTitle;
  }
  const group = routeGroupKey(query.pathname);
  if (group && NAV_GROUP_HELP[group]) {
    const groupHelp = NAV_GROUP_HELP[group];
    return query.title ? { ...groupHelp, title: query.title, description: query.description || groupHelp.description } : groupHelp;
  }
  const safeTitle = query.title || 'Modül Bilgisi';
  return {
    title: safeTitle,
    description:
      query.description ||
      `${safeTitle} ekranı işletmenizin ilgili kayıtlarını ve süreçlerini yönetmenizi sağlar.`,
    example: 'Bu ekrandaki kayıt ve işlem ayrıntılarını inceleyin. Kullanılabilen işlemler şirketinizin modüllerine ve yetkilerinize göre değişir.',
  };
}
