import { applyRate, dec, toDbAmount, toDbRate, type MoneyValue } from '@erp/shared';
import type { AutoJournalLine } from '../ledger/journal';

export interface ActivationInput {
  baseCurrency: string;
  currency: string;
  /** Sözleşme para biriminden defter para birimine kur (aynı para biriminde 1). */
  fx: MoneyValue;
  partyId: string;
  description: string;
  receivableAccountId: string;
  deferredAccountId: string;
  /** Fon/harç satırlarının yükümlülük hesabı (329); fon satırı yoksa gerekmez. */
  feeAccountId?: string;
  installments: readonly { dueDate: string; amount: MoneyValue; fee?: boolean; label?: string | null }[];
}

/**
 * Satış sözleşmesi etkinleşme yevmiyesi (saf): taksit başına alıcı carisine vadeli borç satırı (120) ve toplam tutar
 * için ertelenmiş gelir alacağı (380). Taksit satırları girdi sırasıyla ilk satırlardır (cari kalem eşlemesi buna dayanır).
 * 380'in defter tutarı taksit defter tutarlarının toplamıdır: kur yuvarlaması fişi bozmaz ve teslimde aynen devredilir.
 */
export function buildActivationJournal(i: ActivationInput): { lines: AutoJournalLine[]; totalBase: MoneyValue; feeBase: MoneyValue } {
  const foreign = i.currency !== i.baseCurrency;
  const lines: AutoJournalLine[] = [];
  let total = dec(0);
  let totalBase = dec(0);
  let feeTotal = dec(0);
  let feeBase = dec(0);
  for (const it of i.installments) {
    const base = foreign ? applyRate(it.amount, i.fx) : it.amount;
    if (it.fee) {
      feeTotal = feeTotal.plus(it.amount);
      feeBase = feeBase.plus(base);
    } else {
      total = total.plus(it.amount);
      totalBase = totalBase.plus(base);
    }
    lines.push({
      accountId: i.receivableAccountId,
      currency: i.currency,
      ...(foreign ? { fxRate: toDbRate(i.fx) } : {}),
      debit: toDbAmount(it.amount),
      credit: '0',
      debitBase: toDbAmount(base),
      creditBase: '0',
      partyId: i.partyId,
      dueDate: it.dueDate,
      description: it.fee ? `${i.description} — ${it.label ?? 'Fon/harç'}` : i.description,
    } as AutoJournalLine);
  }
  const credit = (accountId: string, doc: MoneyValue, base: MoneyValue, description: string) =>
    lines.push({
      accountId,
      currency: i.currency,
      ...(foreign ? { fxRate: toDbRate(i.fx) } : {}),
      debit: '0',
      credit: toDbAmount(doc),
      debitBase: '0',
      creditBase: toDbAmount(base),
      description,
    } as AutoJournalLine);
  if (total.gt(0)) credit(i.deferredAccountId, total, totalBase, 'Ertelenmiş gelir (teslimde gelire aktarılır)');
  if (feeTotal.gt(0)) credit(i.feeAccountId!, feeTotal, feeBase, 'Alıcıdan tahsil edilen fon/harç (yükümlülük)');
  return { lines, totalBase, feeBase };
}

export interface HandoverInput {
  baseCurrency: string;
  currency: string;
  fx: MoneyValue;
  price: MoneyValue;
  /** Etkinleşmede 380'e yazılan defter tutarı (tarihsel kur korunur). */
  baseAmount: MoneyValue;
  projectId: string;
  deferredAccountId: string;
  revenueAccountId: string;
  description: string;
}

/** Teslim yevmiyesi (saf): B 380 / A 600 (proje etiketli); defter tutarı etkinleşmedeki tutarla aynıdır. */
export function buildHandoverJournal(i: HandoverInput): AutoJournalLine[] {
  const foreign = i.currency !== i.baseCurrency;
  const common = { currency: i.currency, ...(foreign ? { fxRate: toDbRate(i.fx) } : {}) };
  return [
    { accountId: i.deferredAccountId, ...common, debit: toDbAmount(i.price), credit: '0', debitBase: toDbAmount(i.baseAmount), creditBase: '0', description: i.description },
    { accountId: i.revenueAccountId, ...common, debit: '0', credit: toDbAmount(i.price), debitBase: '0', creditBase: toDbAmount(i.baseAmount), projectId: i.projectId, description: i.description },
  ] as AutoJournalLine[];
}
