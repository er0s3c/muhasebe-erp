import { dec, toDbAmount, type MoneyValue } from '@erp/shared';
import type { AutoJournalLine } from '../ledger/journal';

export interface PayrollCostGroup {
  projectId: string | null;
  wbsId: string | null;
  costCodeId: string | null;
  gross: MoneyValue;
  employer: MoneyValue;
}

export interface PayrollJournalInput {
  /** Defter para birimi (bordro daima defter para biriminde). */
  currency: string;
  description: string;
  accounts: { labor: string; employer: string; payable: string; social: string; tax: string; other: string; advance?: string };
  groups: readonly PayrollCostGroup[];
  /** Karşı taraf toplamları: ödenecek net, sosyal güvenlik (işçi + işveren), vergi/fon, diğer kesintiler. */
  net: MoneyValue;
  social: MoneyValue;
  tax: MoneyValue;
  other: MoneyValue;
  /** Personel avansından kesilen tutar (X5): personel avansları hesabına alacak; boş/sıfır ise yoktur. */
  advance?: MoneyValue;
}

/**
 * Bordro yevmiyesi (saf). Borç: işçilik gideri (brüt) ve işveren yükü gideri, proje/iş kalemi/maliyet kodu etiketli gruplar
 * hâlinde (etiketsiz saatler etiketsiz satırdadır). Alacak: ödenecek net ücret, sosyal güvenlik, vergi/fon, diğer kesintiler.
 * Borç = Σ brüt + Σ işveren yükü; alacak = Σ net + Σ kesinti + Σ işveren yükü; net = brüt − kesinti olduğundan denkleşir.
 * Denklik burada ayrıca doğrulanır: bozuksa fiş yazılmaz.
 */
export function buildPayrollJournal(i: PayrollJournalInput): AutoJournalLine[] {
  const out: AutoJournalLine[] = [];
  const push = (side: 'debit' | 'credit', accountId: string, amount: MoneyValue, extra: Partial<AutoJournalLine> = {}) => {
    if (amount.isZero()) return;
    out.push({
      accountId,
      currency: i.currency,
      debit: side === 'debit' ? toDbAmount(amount) : '0',
      credit: side === 'credit' ? toDbAmount(amount) : '0',
      debitBase: side === 'debit' ? toDbAmount(amount) : '0',
      creditBase: side === 'credit' ? toDbAmount(amount) : '0',
      ...extra,
    } as AutoJournalLine);
  };
  const tag = (g: PayrollCostGroup) => ({
    ...(g.projectId ? { projectId: g.projectId } : {}),
    ...(g.wbsId ? { wbsId: g.wbsId } : {}),
    ...(g.costCodeId ? { costCodeId: g.costCodeId } : {}),
  });
  let debits = dec(0);
  for (const g of i.groups) {
    debits = debits.plus(g.gross).plus(g.employer);
    push('debit', i.accounts.labor, g.gross, { ...tag(g), description: 'Bordro işçilik gideri' });
    push('debit', i.accounts.employer, g.employer, { ...tag(g), description: 'Bordro işveren yükü' });
  }
  const advance = i.advance ?? dec(0);
  const credits = i.net.plus(i.social).plus(i.tax).plus(i.other).plus(advance);
  if (!debits.eq(credits)) throw new Error(`Bordro yevmiyesi denkleşmiyor (borç ${debits.toFixed(2)}, alacak ${credits.toFixed(2)})`);
  push('credit', i.accounts.payable, i.net, { description: i.description });
  push('credit', i.accounts.social, i.social, { description: 'Ödenecek sosyal güvenlik' });
  push('credit', i.accounts.tax, i.tax, { description: 'Ödenecek vergi ve fonlar' });
  push('credit', i.accounts.other, i.other, { description: 'Diğer bordro kesintileri' });
  push('credit', i.accounts.advance ?? '', advance, { description: 'Personel avansından kesinti' });
  return out;
}
