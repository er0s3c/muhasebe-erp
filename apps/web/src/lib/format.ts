import { formatDateTR, formatTR } from '@erp/shared';

export { formatDateTR, formatTR };

const SYMBOLS: Record<string, string> = { TRY: '₺', GBP: '£', EUR: '€', USD: '$' };
export const currencySymbol = (code: string) => SYMBOLS[code] ?? code;

/** "1234.5" -> "1.234,50" */
export const money = (value: string | null | undefined, dp = 2) => formatTR(value, dp);

/** Sıfır tutarı soluk göstermek için */
export const isZero = (value: string | null | undefined) => !value || Number(value) === 0;

/** Bakiye (borç − alacak) -> { debit, credit } */
export function splitBalance(net: string): { debit: string; credit: string } {
  const n = Number(net);
  return n >= 0 ? { debit: net, credit: '0' } : { debit: '0', credit: String(Math.abs(n)) };
}

export const monthName = (months: string[], m: number) => months[m - 1] ?? String(m);
