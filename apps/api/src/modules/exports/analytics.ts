import {
  formatDateTR,
  ITEM_UNIT_LABELS,
  type ItemUnit,
  type StockAnalyticsQuery,
  type SupplierPerformanceQuery,
} from '@erp/shared';
import type { ReportTable } from '../../files/table';
import { stockAnalytics } from '../inventory/analytics';
import { supplierPerformance } from '../procurement/performance';
import type { BuildCtx } from './builders';

export async function stockAnalyticsTable(
  ctx: BuildCtx,
  q: StockAnalyticsQuery,
): Promise<ReportTable[]> {
  const data = await stockAnalytics(ctx.tx, ctx.company.baseCurrency, q),
    currency = data.baseCurrency;
  return [
    {
      key: 'stok-analizi',
      title: 'ABC, hareketsiz stok ve devir',
      subtitle: `${ctx.company.name} · ${formatDateTR(q.from)} – ${formatDateTR(q.to)} · Hareketsizlik: ${q.inactiveDays} gün · Defter: ${currency}`,
      columns: [
        { key: 'code', label: 'Kod', kind: 'text' },
        { key: 'name', label: 'Ürün', kind: 'text' },
        { key: 'unit', label: 'Birim', kind: 'text' },
        { key: 'abcClass', label: 'ABC sınıfı', kind: 'text' },
        { key: 'salesCost', label: `Net satış maliyeti (${currency})`, kind: 'money', currency },
        { key: 'costSharePct', label: 'Maliyet payı (%)', kind: 'rate' },
        { key: 'cumulativePct', label: 'Birikimli pay (%)', kind: 'rate' },
        { key: 'closingQty', label: 'Dönem sonu miktarı', kind: 'qty' },
        { key: 'openingValue', label: `Dönem başı değeri (${currency})`, kind: 'money', currency },
        { key: 'closingValue', label: `Dönem sonu değeri (${currency})`, kind: 'money', currency },
        { key: 'averageValue', label: `Ortalama değer (${currency})`, kind: 'money', currency },
        { key: 'turnover', label: 'Dönem devir sayısı', kind: 'rate' },
        { key: 'holdingDays', label: 'Ortalama stokta kalma (gün)', kind: 'rate' },
        { key: 'lastMovementDate', label: 'Son miktar hareketi', kind: 'date' },
        { key: 'daysInactive', label: 'Hareketsiz gün', kind: 'int' },
        { key: 'status', label: 'Durum', kind: 'text' },
      ],
      rows: data.rows.map(({ isInactive, ...r }) => ({
        ...r,
        unit: ITEM_UNIT_LABELS[r.unit as ItemUnit] ?? r.unit,
        status: isInactive ? 'Hareketsiz' : '—',
      })),
      totals: {
        salesCost: data.totals.salesCost,
        openingValue: data.totals.openingValue,
        closingValue: data.totals.closingValue,
      },
    },
  ];
}
export async function supplierPerformanceTable(
  ctx: BuildCtx,
  q: SupplierPerformanceQuery,
): Promise<ReportTable[]> {
  const data = await supplierPerformance(ctx.tx, ctx.company.timeZone ?? 'Europe/Nicosia', q);
  return [
    {
      key: 'tedarikci-performansi',
      title: 'Tedarikçi teslim, iade ve fiyat performansı',
      subtitle: `${ctx.company.name} · ${formatDateTR(q.from)} – ${formatDateTR(q.to)} · ${data.timeZone} · Para birimleri ayrı satırlar`,
      columns: [
        { key: 'code', label: 'Cari kodu', kind: 'text' },
        { key: 'name', label: 'Tedarikçi', kind: 'text' },
        { key: 'currency', label: 'Para birimi', kind: 'text' },
        { key: 'orderCount', label: 'Dönemde verilen sipariş', kind: 'int' },
        { key: 'orderedAmount', label: 'Sipariş net tutarı', kind: 'money' },
        { key: 'receivedAmount', label: 'Kabulün sipariş değeri', kind: 'money' },
        { key: 'fulfilmentPct', label: 'Karşılama (%)', kind: 'rate' },
        { key: 'receiptCount', label: 'Dönem kabul adedi', kind: 'int' },
        { key: 'averageLeadDays', label: 'Gözlenen teslim süresi (gün)', kind: 'rate' },
        { key: 'purchaseAmount', label: 'Net alış tutarı', kind: 'money' },
        { key: 'returnAmount', label: 'Net alış iadesi', kind: 'money' },
        { key: 'returnPct', label: 'İade / alış (%)', kind: 'rate' },
        { key: 'priceComparedLines', label: 'Fiyat karşılaştırılan satır', kind: 'int' },
        { key: 'priceExpectedAmount', label: 'Sipariş fiyatıyla tutar', kind: 'money' },
        { key: 'priceActualAmount', label: 'Faturadaki net tutar', kind: 'money' },
        { key: 'priceVariancePct', label: 'Fiyat sapması (%)', kind: 'rate' },
      ],
      rows: data.rows.map((r) => ({ ...r })),
    },
  ];
}
