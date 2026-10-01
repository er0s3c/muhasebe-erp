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
  installments: readonly { dueDate: string; amount: MoneyValue }[];
}

/**
 * Satış sözleşmesi etkinleşme yevmiyesi (saf): taksit başına alıcı carisine vadeli borç satırı (120) ve toplam tutar
 * için ertelenmiş gelir alacağı (380). Taksit satırları girdi sırasıyla ilk satırlardır (cari kalem eşlemesi buna dayanır).
 * 380'in defter tutarı taksit defter tutarlarının toplamıdır: kur yuvarlaması fişi bozmaz ve teslimde aynen devredilir.
 */
export function buildActivationJournal(i: ActivationInput): { lines: AutoJournalLine[]; totalBase: MoneyValue } {
  const foreign = i.currency !== i.baseCurrency;
  const lines: AutoJournalLine[] = [];
  let total = dec(0);
  let totalBase = dec(0);
  for (const it of i.installments) {
    const base = foreign ? applyRate(it.amount, i.fx) : it.amount;
    total = total.plus(it.amount);
    totalBase = totalBase.plus(base);
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
      description: i.description,
    } as AutoJournalLine);
  }
  lines.push({
    accountId: i.deferredAccountId,
    currency: i.currency,
    ...(foreign ? { fxRate: toDbRate(i.fx) } : {}),
    debit: '0',
    credit: toDbAmount(total),
    debitBase: '0',
    creditBase: toDbAmount(totalBase),
    description: 'Ertelenmiş gelir (teslimde gelire aktarılır)',
  } as AutoJournalLine);
  return { lines, totalBase };
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
