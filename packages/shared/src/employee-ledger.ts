import { dec, roundMoney, type MoneyValue } from './money';

/**
 * Personel cari ve avans takibi (Faz X5) saf kuralları. API ve testler aynı fonksiyonları kullanır.
 * Kodda yasal değer YOKTUR: avans kesintisi üst sınırı kullanıcı parametresidir (varsayılan sınırsız, "doğrulanmadı").
 */

/** Bordro kalem kataloğunda avans kesintisine ayrılmış (sistem) kod: elle girilemez, yalnız Personel cari ekranından yönetilir. */
export const ADVANCE_DEDUCTION_ITEM_CODE = 'AVANS_KESINTISI';

export const ADVANCE_STATUSES = ['open', 'partial', 'settled', 'cancelled'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** Kapanan tutardan avans durumu (iptal ayrıdır). Veritabanı tetikleyicisi aynı kuralı uygular. */
export function advanceStatusFor(amount: string, settled: string): Exclude<AdvanceStatus, 'cancelled'> {
  const s = dec(settled);
  if (s.lte(0)) return 'open';
  return s.lt(dec(amount)) ? 'partial' : 'settled';
}

/** Hareket türleri: personel cari ekstresi satırı. */
export const LEDGER_KINDS = ['salary_net', 'salary_payment', 'advance', 'advance_deduction', 'advance_repayment', 'advance_expense'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Alacak (şirket personele borçlanır) mı, borç mu? Bakiye = alacak − borç: pozitif ise şirket personele borçludur. */
export const LEDGER_SIDE: Record<LedgerKind, 'credit' | 'debit'> = {
  salary_net: 'credit',
  salary_payment: 'debit',
  advance: 'debit',
  advance_deduction: 'credit',
  advance_repayment: 'credit',
  advance_expense: 'credit',
};

export interface LedgerRowInput {
  date: string;
  kind: LedgerKind;
  ref: string;
  description: string;
  amount: string;
  sortKey?: string;
}

export interface LedgerStatementLine extends LedgerRowInput {
  debit: string;
  credit: string;
  balance: string;
}

/** Ekstre: açılış bakiyesi + tarih sırasıyla satırlar; yürüyen bakiye (alacak − borç). */
export function buildEmployeeStatement(opening: string, rows: readonly LedgerRowInput[]) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || (a.sortKey ?? a.ref).localeCompare(b.sortKey ?? b.ref) || LEDGER_KINDS.indexOf(a.kind) - LEDGER_KINDS.indexOf(b.kind));
  let running = dec(opening);
  let debit = dec(0);
  let credit = dec(0);
  const lines: LedgerStatementLine[] = sorted.map((r) => {
    const side = LEDGER_SIDE[r.kind];
    const amt = dec(r.amount);
    if (side === 'credit') {
      running = running.plus(amt);
      credit = credit.plus(amt);
    } else {
      running = running.minus(amt);
      debit = debit.plus(amt);
    }
    return { ...r, debit: side === 'debit' ? amt.toFixed(2) : '0.00', credit: side === 'credit' ? amt.toFixed(2) : '0.00', balance: running.toFixed(2) };
  });
  return { opening: dec(opening).toFixed(2), lines, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2) }, closing: running.toFixed(2) };
}

export interface EmployeeBalanceInput {
  salaryNet: string;
  salaryPaid: string;
  advanceGiven: string;
  advanceDeducted: string;
  advanceRepaid: string;
  advanceExpensed?: string;
}

/** Personel bakiyesi özeti. net > 0: şirket personele borçlu; net < 0: personel şirkete borçlu (açık avans). */
export function employeeBalance(i: EmployeeBalanceInput) {
  const credit = dec(i.salaryNet).plus(i.advanceDeducted).plus(i.advanceRepaid).plus(i.advanceExpensed ?? 0);
  const debit = dec(i.salaryPaid).plus(i.advanceGiven);
  const openAdvance = dec(i.advanceGiven).minus(i.advanceDeducted).minus(i.advanceRepaid).minus(i.advanceExpensed ?? 0);
  const unpaidSalary = dec(i.salaryNet).minus(i.salaryPaid);
  return { net: credit.minus(debit).toFixed(2), openAdvance: openAdvance.toFixed(2), unpaidSalary: unpaidSalary.toFixed(2) };
}

/** Avans kesintisi üst sınırı (kullanıcı yüzdesi; boşsa sınır yok): kesinti öncesi net ücretin yüzdesi, kuruşa yuvarlanır. */
export function advanceDeductionCap(netBefore: string, capPct: string | null | undefined): MoneyValue | null {
  if (!capPct || dec(capPct).lte(0)) return null;
  return roundMoney(dec(netBefore).times(capPct).div(100));
}

export interface OutstandingAdvance {
  id: string;
  remaining: string;
}

/** Toplam kesintiyi en eski avanstan başlayarak dağıtır (liste tarih sırasında verilir). Artan tutar varsa `rest` > 0. */
export function allocateDeductionFifo(outstanding: readonly OutstandingAdvance[], total: string) {
  let left = dec(total);
  const parts: { advanceId: string; amount: string }[] = [];
  for (const a of outstanding) {
    if (left.lte(0)) break;
    const take = dec(a.remaining).lt(left) ? dec(a.remaining) : left;
    if (take.lte(0)) continue;
    parts.push({ advanceId: a.id, amount: take.toFixed(2) });
    left = left.minus(take);
  }
  return { parts, rest: left.toFixed(2) };
}
