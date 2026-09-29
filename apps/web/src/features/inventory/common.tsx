import { useTranslation } from 'react-i18next';
import { formatTR } from '@erp/shared';
import { Badge } from '../../components/ui/Badge';
import type { ComboOption } from '../../components/ui/Combobox';
import { useCQuery } from '../../lib/queries';
import type { CategoryRow, ItemListRow, StockDocType, WarehouseRow } from '../../lib/types';

/** Miktar: en çok 4 ondalık, sondaki gereksiz sıfırlar atılır (12,5 / 3). */
export const qtyText = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '' : formatTR(v, 4).replace(/,?0+$/, ''));

/** Birim kodu -> kısa etiket (adet, kg, m²…) */
export function useUnitLabel() {
  const { t } = useTranslation();
  return (unit: string) => t(`inventory.units.${unit}` as never, { defaultValue: unit });
}

const DOC_TONES = { opening: 'neutral', receipt: 'success', issue: 'warning', waste: 'danger', transfer: 'brand', count: 'neutral' } as const;

export function DocTypeBadge({ type }: { type: StockDocType }) {
  const { t } = useTranslation();
  return <Badge tone={DOC_TONES[type]}>{t(`inventory.docTypes.${type}`)}</Badge>;
}

export const useWarehouses = () => useCQuery<{ warehouses: WarehouseRow[] }>(['warehouses'], '/api/warehouses');
export const useCategories = () => useCQuery<{ categories: CategoryRow[] }>(['item-categories'], '/api/item-categories');

/**
 * Hareket ve sayım formlarındaki kart seçici için stoklu (mal) kartlar. `warehouseId` verilirse
 * `onHand` o depodaki miktardır.
 */
export function useItemOptions(enabled: boolean, warehouseId?: string) {
  const qs = new URLSearchParams({ limit: '500', active: 'true', kind: 'goods' });
  if (warehouseId) qs.set('warehouseId', warehouseId);
  const { data } = useCQuery<{ items: ItemListRow[] }>(['items', 'options', qs.toString()], `/api/items?${qs}`, { enabled });
  const unitLabel = useUnitLabel();
  const items = data?.items ?? [];
  const options: ComboOption[] = items.map((i) => ({
    value: i.id,
    label: `${i.code} — ${i.name}`,
    keywords: `${i.code} ${i.barcode ?? ''}`,
    hint: `${qtyText(i.onHand) || '0'} ${unitLabel(i.unit)}`,
  }));
  return { items, byId: new Map(items.map((i) => [i.id, i])), options };
}

/** Sorgu geçersiz kılma anahtarları: stok hareketi her şeyi (kart, rapor, özet, sayım) etkiler. */
export const STOCK_INVALIDATE = [['items'], ['item'], ['stock-docs'], ['stock-doc'], ['stock-status'], ['inventory-summary'], ['stock-counts'], ['stock-count'], ['warehouses']];
