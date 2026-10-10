import { useCQuery, useNavigation } from '../../lib/queries';
import type { AgingReport, DeliverySummary, InventorySummary, InvoiceSummary, JournalListItem, TreasurySummary } from '../../lib/types';

export type SummarySection = 'treasury' | 'aging' | 'invoices' | 'salesTrend' | 'deliveries' | 'inventory' | 'ledger' | 'balance' | 'rates';
type AgingTotals = AgingReport['totals'];

export interface DashboardSummary {
  today: string;
  baseCurrency: string;
  errors: SummarySection[];
  sections: Partial<{
    treasury: TreasurySummary;
    aging: { receivable: AgingTotals; payable: AgingTotals };
    invoices: InvoiceSummary;
    salesTrend: { month: string; sales: string; purchases: string }[];
    deliveries: DeliverySummary;
    inventory: InventorySummary;
    ledger: { postedThisYear: number; drafts: number; recent: (JournalListItem & { totalBase: string })[] };
    balance: { difference: string; balanced: boolean };
    rates: { currency: string; rate: string | null; rateDate: string | null; source: string | null }[];
  }>;
}

/** Sunucudaki kapıların aynısı: menüde görünmeyen bölüm istenmez (sunucu yine de ayrıca denetler). */
export function useSectionAccess() {
  const { data } = useNavigation();
  const on = (m: string) => data?.modules.includes(m) ?? false;
  const can = (p: string) => data?.permissions.includes(p) ?? false;
  const access: Record<SummarySection, boolean> = {
    treasury: on('core.treasury') && can('treasury.read'),
    aging: on('core.parties') && can('parties.read'),
    invoices: on('core.invoices') && can('invoices.read'),
    salesTrend: on('core.invoices') && can('invoices.read'),
    deliveries: on('core.invoices') && can('deliveries.read'),
    inventory: on('core.inventory') && can('inventory.read'),
    ledger: on('core.ledger') && can('ledger.read'),
    balance: on('core.ledger') && can('reports.read'),
    rates: true,
  };
  return { ready: !!data, access, can };
}

/** Panodaki tüm göstergeler tek istekle gelir; yalnız ekrandaki widget'ların bölümleri hesaplatılır. */
export function useDashboardSummary(sections: SummarySection[], enabled: boolean) {
  const key = [...new Set(sections)].sort();
  return useCQuery<DashboardSummary>(['dashboard', 'summary', key.join(',')], enabled && key.length ? `/api/dashboard/summary?sections=${key.join(',')}` : null, {
    staleTime: 30_000,
  });
}
