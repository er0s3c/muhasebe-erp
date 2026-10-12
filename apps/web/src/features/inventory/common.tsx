import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatTR, quantityIssues } from '@erp/shared';
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

/**
 * Miktarın birimiyle tutarlılık uyarısı (öneri 31): kesirli adet, fazla ondalık, üst birime çevrilebilecek miktar ve olağan dışı
 * büyüklük. Kaydı engellemez; miktar alanı `aria-describedby={quantityHintId(...)}` ile bu metne bağlanır.
 */
export function QuantityHint({ id, quantity, unit }: { id: string; quantity: string; unit?: string | null }) {
  const issues = quantityIssues(quantity, unit);
  if (issues.length === 0) return null;
  return <p id={id} role="status" data-testid="quantity-hint" className="flex items-start gap-1.5 pl-1 text-[13px] text-text">
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
    <span>{issues.map((issue) => issue.message).join(' ')}</span>
  </p>;
}
/** Uyarı varsa miktar alanının açıklama kimliği; yoksa undefined. */
export const quantityHintId = (key: string | number, quantity: string, unit?: string | null) =>
  quantityIssues(quantity, unit).length > 0 ? `quantity-hint-${key}` : undefined;

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
