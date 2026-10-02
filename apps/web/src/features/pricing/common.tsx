import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { ComboOption } from '../../components/ui/Combobox';
import { useCQuery } from '../../lib/queries';
import type { ItemListRow, PriceKind, PriceListRow } from '../../lib/types';

/** Fiyat/cari özel fiyat değişince etkilenen sorgular. */
export const PRICING_INVALIDATE = [['price-lists'], ['price-list'], ['price-list-items'], ['party-prices'], ['party-pricing']];

export const usePriceLists = (kind?: PriceKind) =>
  useCQuery<{ lists: PriceListRow[] }>(['price-lists', kind ?? 'all'], `/api/price-lists${kind ? `?kind=${kind}` : ''}`);

/** Fiyat satırında seçilebilen kartlar (mal ve hizmet). */
export function useAllItemOptions(enabled = true) {
  const { data } = useCQuery<{ items: ItemListRow[] }>(['items', 'options', 'pricing'], '/api/items?limit=500&active=true', { enabled });
  const items = useMemo(() => data?.items ?? [], [data]);
  const options: ComboOption[] = useMemo(
    () => items.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}`, keywords: `${i.code} ${i.barcode ?? ''}` })),
    [items],
  );
  return { items, options };
}

export function KindBadge({ kind }: { kind: PriceKind }) {
  const { t } = useTranslation();
  return <Badge tone={kind === 'sales' ? 'brand' : 'neutral'}>{t(`pricing.kinds.${kind}`)}</Badge>;
}

/** "12.500000" -> "12,5" gösterimi için ondalık sondaki sıfırları atar. */
export const trimNum = (v: string | null | undefined) => (v && v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : (v ?? ''));
