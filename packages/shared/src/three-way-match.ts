import { dec, type MoneyValue } from './money';

/** Üçlü eşleştirme (sipariş – mal kabul – fatura) bayrakları. */
export const MATCH_FLAGS = ['over_received', 'over_ordered', 'price_variance'] as const;
export type MatchFlag = (typeof MATCH_FLAGS)[number];

export interface MatchInput {
  orderedQty: string | MoneyValue;
  /** Bu siparişe karşı kaydedilmiş (iptal edilmeyen) mal kabul miktarı. */
  receivedQty: string | MoneyValue;
  /** Bu faturadan ÖNCE aynı sipariş satırına kaydedilmiş faturaların miktarı. */
  invoicedBeforeQty: string | MoneyValue;
  invoiceQty: string | MoneyValue;
  /** Siparişin KDV hariç birim fiyatı. */
  orderPrice: string | MoneyValue;
  /** Faturanın KDV hariç, iskontolu birim fiyatı. */
  invoicePrice: string | MoneyValue;
  qtyTolerancePct: string | MoneyValue;
  priceTolerancePct: string | MoneyValue;
}

export interface MatchResult {
  flags: MatchFlag[];
  /** Fatura birim fiyatının sipariş fiyatından yüzde sapması (işaretli); sipariş fiyatı 0 ise null. */
  priceDiffPct: string | null;
  /** Mal kabulü aşan miktar (≥ 0); tolerans dahil değildir. */
  overReceivedQty: string;
  overOrderedQty: string;
}

/**
 * Üç yönlü karşılaştırma. Miktar toleransı sipariş miktarının yüzdesidir:
 * - `over_ordered`: toplam faturalanan > sipariş + tolerans
 * - `over_received`: toplam faturalanan > mal kabul + tolerans (henüz teslim alınmamış mal/hizmet faturalanıyor)
 * - `price_variance`: |fatura − sipariş fiyatı| > sipariş fiyatının fiyat toleransı kadarı (sipariş fiyatı 0 ise her pozitif fiyat)
 */
export function evaluateMatch(i: MatchInput): MatchResult {
  const ordered = dec(i.orderedQty);
  const total = dec(i.invoicedBeforeQty).plus(i.invoiceQty);
  const qtyTol = ordered.times(i.qtyTolerancePct).div(100);
  const overOrdered = total.minus(ordered);
  const overReceived = total.minus(i.receivedQty);
  const flags: MatchFlag[] = [];
  if (overReceived.gt(qtyTol)) flags.push('over_received');
  if (overOrdered.gt(qtyTol)) flags.push('over_ordered');

  const op = dec(i.orderPrice);
  const ip = dec(i.invoicePrice);
  let priceDiffPct: string | null = null;
  if (op.isZero()) {
    if (ip.gt(0)) flags.push('price_variance');
  } else {
    const diff = ip.minus(op).div(op).times(100);
    priceDiffPct = diff.toFixed(2);
    if (diff.abs().gt(dec(i.priceTolerancePct))) flags.push('price_variance');
  }
  return {
    flags,
    priceDiffPct,
    overReceivedQty: dec(0).plus(overReceived.gt(0) ? overReceived : 0).toFixed(4),
    overOrderedQty: dec(0).plus(overOrdered.gt(0) ? overOrdered : 0).toFixed(4),
  };
}
