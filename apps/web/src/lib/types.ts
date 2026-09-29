/** API yanıt tipleri (sunucu Drizzle satırlarının JSON hâli). Tutarlar her zaman string. */

export interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'cost' | 'memo';
  parentId: string | null;
  isPostable: boolean;
  currencyCode: string | null;
  isActive: boolean;
}

export interface Period {
  id: string;
  year: number;
  month: number;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
}

export interface Rate {
  id: string;
  rateDate: string;
  currencyCode: string;
  quoteCode: string;
  buy: string;
  sell: string;
  source: string;
}

export interface TaxRate {
  id: string;
  code: string;
  name: string;
  rate: string;
  validFrom: string;
  validTo: string | null;
  sourceNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface CustomCode {
  id: string;
  scope: 'account' | 'transaction' | 'party' | 'item';
  code: string;
  name: string;
  isActive: boolean;
}

export interface Member {
  userId: string;
  email: string;
  fullName: string;
  isActive: boolean;
  role: string;
}

export interface JournalListItem {
  id: string;
  entryNo: string | null;
  entryDate: string;
  description: string;
  status: 'draft' | 'posted';
  reversalOfId: string | null;
  reversedById: string | null;
  totalBase: string;
}

export interface JournalLine {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  currencyCode: string;
  fxRate: string;
  debit: string;
  credit: string;
  debitBase: string;
  creditBase: string;
  debitReporting: string | null;
  creditReporting: string | null;
}

export interface JournalEntry extends Omit<JournalListItem, 'totalBase'> {
  postedAt: string | null;
  createdAt: string;
  periodYear: number;
  periodMonth: number;
  lines: JournalLine[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  parentId: string | null;
  isPostable: boolean;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

export interface TrialBalanceData {
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRow[];
  totals: { debit: string; credit: string; difference: string };
  missingReportingLines: number;
}

export interface AccountLedgerData {
  account: { id: string; code: string; name: string };
  from: string;
  to: string;
  opening: string;
  lines: {
    entryId: string;
    entryNo: string;
    entryDate: string;
    accountCode: string;
    description: string;
    currencyCode: string;
    fxRate: string;
    debit: string;
    credit: string;
    debitBase: string;
    creditBase: string;
    balance: string;
  }[];
  totals: { debitBase: string; creditBase: string };
  closing: string;
}

/** Modül anahtarı -> çeviri anahtarı */
export const MODULE_LABEL_KEYS = {
  'core.dashboard': 'modules.dashboard',
  'core.ledger': 'modules.ledger',
  'core.settings': 'modules.settings',
  'construction.projects': 'modules.constructionProjects',
  'retail.pos': 'modules.retailPos',
} as const;
