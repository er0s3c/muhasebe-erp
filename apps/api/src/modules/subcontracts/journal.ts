import { applyRate, dec, toDbAmount, toDbRate, type MoneyValue } from '@erp/shared';
import type { AutoJournalLine } from '../ledger/journal';

export interface ProgressJournalInput {
  /** payable: B maliyet + KDV / A teminat, stopaj, avans, cari(320). receivable: aynasıdır (A gelir + KDV / B cari(120), teminat, avans, stopaj). */
  direction?: 'payable' | 'receivable';
  baseCurrency: string;
  currency: string;
  /** Hakediş para biriminden defter para birimine kur (aynı para biriminde 1). */
  fx: MoneyValue;
  partyId: string;
  dueDate: string;
  description: string;
  accounts: {
    /** Maliyet (payable) ya da hakediş geliri (receivable) hesabı. */
    cost: string;
    /** Taşeron carisi (320) ya da işveren carisi (120). */
    payable: string;
    /** İndirilecek (payable) ya da hesaplanan (receivable) KDV. */
    vatInput: string;
    retention: string;
    withholding: string;
    advance: string;
  };
  /** Maliyet satırları (iş kalemi + maliyet kodu bazında); tutar = brüt − orantılı diğer kesinti. */
  costGroups: readonly { projectId: string; wbsId: string; costCodeId: string | null; amount: MoneyValue }[];
  vat: MoneyValue;
  retention: MoneyValue;
  withholding: MoneyValue;
  advance: MoneyValue;
}

/**
 * Hakediş yevmiyesi (saf). Cari satırın defter tutarı, borç taraflarının defter toplamından diğer alacakların
 * defter tutarı düşülerek bulunur: kur yuvarlaması fişi bozmaz.
 *
 * B maliyet (proje/iş kalemi/maliyet kodu etiketli) + B KDV / A teminat + A stopaj + A avans + A taşeron cari (net)
 */
export function buildProgressJournal(i: ProgressJournalInput): { lines: AutoJournalLine[]; netBase: MoneyValue; net: MoneyValue } {
  const foreign = i.currency !== i.baseCurrency;
  const receivable = i.direction === 'receivable';
  // Gövde (maliyet/gelir + KDV) bir tarafta, kesintiler ve cari karşı tarafta
  const bodySide = receivable ? 'credit' : 'debit';
  const otherSide = receivable ? 'debit' : 'credit';
  const out: AutoJournalLine[] = [];
  const push = (side: 'debit' | 'credit', accountId: string, amount: MoneyValue, extra: Partial<AutoJournalLine> = {}, baseOverride?: MoneyValue) => {
    const base = baseOverride ?? (foreign ? applyRate(amount, i.fx) : amount);
    out.push({
      accountId,
      currency: i.currency,
      ...(foreign ? { fxRate: toDbRate(i.fx) } : {}),
      debit: side === 'debit' ? toDbAmount(amount) : '0',
      credit: side === 'credit' ? toDbAmount(amount) : '0',
      debitBase: side === 'debit' ? toDbAmount(base) : '0',
      creditBase: side === 'credit' ? toDbAmount(base) : '0',
      ...extra,
    } as AutoJournalLine);
    return base;
  };

  let debitsDoc = dec(0);
  let debitsBase = dec(0);
  for (const g of i.costGroups) {
    if (g.amount.isZero()) continue;
    debitsDoc = debitsDoc.plus(g.amount);
    debitsBase = debitsBase.plus(
      push(bodySide, i.accounts.cost, g.amount, {
        projectId: g.projectId,
        wbsId: g.wbsId,
        ...(g.costCodeId && !receivable ? { costCodeId: g.costCodeId } : {}),
        description: receivable ? 'İşveren hakedişi' : 'Taşeron hakedişi',
      }),
    );
  }
  if (!i.vat.isZero()) {
    debitsDoc = debitsDoc.plus(i.vat);
    debitsBase = debitsBase.plus(push(bodySide, i.accounts.vatInput, i.vat, { description: receivable ? 'Hesaplanan KDV' : 'İndirilecek KDV' }));
  }

  let otherCreditsDoc = dec(0);
  let otherCreditsBase = dec(0);
  const credit = (accountId: string, amount: MoneyValue, description: string) => {
    if (amount.isZero()) return;
    otherCreditsDoc = otherCreditsDoc.plus(amount);
    otherCreditsBase = otherCreditsBase.plus(push(otherSide, accountId, amount, { description }));
  };
  credit(i.accounts.retention, i.retention, receivable ? 'İşverence tutulan teminat' : 'Tutulan teminat');
  credit(i.accounts.withholding, i.withholding, receivable ? 'İşverence kesilen stopaj' : 'Stopaj');
  credit(i.accounts.advance, i.advance, 'Avans mahsubu');

  const net = debitsDoc.minus(otherCreditsDoc);
  const netBase = debitsBase.minus(otherCreditsBase);
  push(otherSide, i.accounts.payable, net, { partyId: i.partyId, dueDate: i.dueDate, description: i.description }, netBase);
  return { lines: out, netBase, net };
}
