import { useTranslation } from 'react-i18next';
import { dec } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import type { ComboOption } from '../../components/ui/Combobox';
import { useCQuery } from '../../lib/queries';
import type { Account, InvoiceStatus, InvoiceType, PartyListRow, TaxRate } from '../../lib/types';

/** Fatura değişince etkilenen sorgular: stok, cari, yevmiye ve raporlar. */
export const INVOICE_INVALIDATE = [
  ['delivery-notes'],
  ['delivery-note'],
  ['delivery-open-lines'],
  ['delivery-summary'],
  ['sales-doc'],
  ['sales-docs'],
  ['invoices'],
  ['invoice'],
  ['journal'],
  ['journal-entry'],
  ['stock-docs'],
  ['stock-doc'],
  ['items'],
  ['item'],
  ['stock-status'],
  ['inventory-summary'],
  ['parties'],
  ['party'],
  ['party-aging'],
  ['trial-balance'],
  ['account-ledger'],
  ['vat-summary'],
  ['dashboard'],
];

const STATUS_TONE = { draft: 'warning', posted: 'success', cancelled: 'danger' } as const;

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`invoices.status.${status}`)}</Badge>;
}

export function InvoiceTypeBadge({ type }: { type: InvoiceType }) {
  const { t } = useTranslation();
  const tone = type === 'sales_return' || type === 'purchase_return' ? 'brand' : 'neutral';
  return <Badge tone={tone}>{t(`invoices.types.${type}`)}</Badge>;
}

export const useTaxRates = () => useCQuery<{ taxRates: TaxRate[] }>(['tax-rates'], '/api/tax-rates');

/** Kodun fatura tarihinde geçerli oranı (yüzde string); yoksa "0". */
export function vatRateFor(rates: readonly TaxRate[], code: string | null | undefined, date: string): string {
  if (!code) return '0';
  const hit = rates
    .filter((r) => r.code === code && r.validFrom <= date && (!r.validTo || r.validTo >= date))
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  return hit ? dec(hit.rate).toFixed(4) : '0';
}

/** Cari seçici: müşteri/tedarikçi (her ikisi olanlar iki listede de). */
export function usePartyOptions(kind: 'customer' | 'supplier', enabled = true) {
  const qs = new URLSearchParams({ limit: '500', active: 'true', kind });
  const { data } = useCQuery<{ parties: PartyListRow[] }>(['parties', 'options', qs.toString()], `/api/parties?${qs}`, { enabled });
  const parties = data?.parties ?? [];
  const options: ComboOption[] = parties.map((p) => ({ value: p.id, label: p.name, keywords: `${p.code} ${p.taxNumber ?? ''}`, hint: p.code }));
  return { parties, byId: new Map(parties.map((p) => [p.id, p])), options };
}

/** Serbest satırlarda seçilebilen gelir/gider hesapları (cari ve dövizli hesaplar hariç). */
export function useLineAccountOptions(side: 'sales' | 'purchases', enabled = true) {
  const { data } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts', { enabled });
  const usable = (a: Account) => a.isPostable && a.isActive && !a.partyControl && !a.currencyCode;
  // Gelir: 6xx (satışlar, diğer gelirler); gider: 6xx (faaliyet giderleri) ve 7xx (maliyet hesapları)
  const sideOk = (a: Account) => (side === 'sales' ? a.code.startsWith('6') : a.code.startsWith('6') || a.code.startsWith('7'));
  const options: ComboOption[] = (data?.accounts ?? [])
    .filter((a) => usable(a) && sideOk(a))
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code }));
  return options;
}
