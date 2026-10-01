import { currencySymbol, formatDateTR, formatMoney, formatTR } from '@erp/shared';

export { currencySymbol, formatDateTR, formatMoney, formatTR };

/** "1234.5" -> "1.234,50" (simgesiz; başlığında para birimi simgesi olan sütunlar için) */
export const money = (value: string | null | undefined, dp = 2) => formatTR(value, dp);

/** "1234.5", "TRY" -> "₺1.234,50" (simge önde; negatifte "-₺1.234,50"). Para birimi gösterilen her yerde kod yerine bunu kullanın. */
export const moneyIn = (value: string | null | undefined, currency: string, dp = 2) => formatMoney(value, currency, dp);

/** Sıfır tutarı soluk göstermek için */
export const isZero = (value: string | null | undefined) => !value || Number(value) === 0;

/** Bakiye (borç − alacak) -> { debit, credit } */
export function splitBalance(net: string): { debit: string; credit: string } {
  const n = Number(net);
  return n >= 0 ? { debit: net, credit: '0' } : { debit: '0', credit: String(Math.abs(n)) };
}

export const monthName = (months: string[], m: number) => months[m - 1] ?? String(m);
