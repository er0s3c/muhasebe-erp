import { useMemo } from 'react';
import type { ComboOption } from '../../components/ui/Combobox';
import { useCQuery } from '../../lib/queries';
import type { ExpenseCard } from '../../lib/types';
import { TREASURY_INVALIDATE } from '../treasury/common';

/** Gider fişi/kartı değişince etkilenen sorgular: gider listeleri, kasa/banka bakiyeleri, cari, yevmiye ve raporlar. */
export const EXPENSE_INVALIDATE = [['expense-cards'], ['expense-entries'], ['expense-report'], ...TREASURY_INVALIDATE, ['projects'], ['reports']];

export const useExpenseCards = (all = false) =>
  useCQuery<{ cards: ExpenseCard[] }>(['expense-cards', all ? 'all' : 'active'], `/api/expense-cards${all ? '?all=true' : ''}`);

export function useExpenseCardOptions() {
  const { data } = useExpenseCards();
  const cards = useMemo(() => data?.cards ?? [], [data]);
  const options: ComboOption[] = useMemo(() => cards.map((c) => ({ value: c.id, label: `${c.code} — ${c.name}`, keywords: `${c.accountCode}`, hint: c.accountCode })), [cards]);
  return { cards, byId: useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]), options };
}
