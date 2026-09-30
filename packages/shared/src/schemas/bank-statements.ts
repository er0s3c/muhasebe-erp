import { z } from 'zod';
import { isoDate, rateString, uuid } from './common';
import { treasuryItemSchema } from './treasury';

export const BANK_LINE_STATUSES = ['open', 'matched', 'ignored'] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUSES)[number];

/** Eşleştirme önerisinde ekstre satırı ile defter satırı arasındaki en büyük tarih farkı (gün). Sabittir, ayar değildir. */
export const MATCH_TOLERANCE_DAYS = 3;

/**
 * Öneri güveni: `exact` = tutar ve işaret birebir, tarih toleransı içinde, tek aday ve o aday yalnızca bu satıra uyuyor
 * (ya da açıklamada hareket numarası geçiyor); `probable` = birden çok olası aday.
 */
export const MATCH_CONFIDENCES = ['exact', 'probable'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];

export const reconciliationQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;

export const matchLineSchema = z.object({ journalLineId: uuid });
export type MatchLineInput = z.infer<typeof matchLineSchema>;

export const ignoreLineSchema = z.object({ reason: z.string().trim().max(200).optional() });
export type IgnoreLineInput = z.infer<typeof ignoreLineSchema>;

/** Eşleşmeyen ekstre satırından hareket oluşturma: tarih, tutar ve hesap satırdan gelir; yön satırın işaretinden. */
export const createFromLineSchema = z.object({
  type: z.enum(['receipt', 'payment', 'other_receipt', 'other_payment']),
  description: z.string().trim().max(300).optional(),
  partyId: uuid.optional(),
  items: z.array(treasuryItemSchema).max(100).default([]),
  glAccountId: uuid.optional(),
  fxRate: rateString.optional(),
});
export type CreateFromLineInput = z.infer<typeof createFromLineSchema>;

export interface BankStatementSummary {
  id: string;
  fileName: string;
  fromDate: string;
  toDate: string;
  lineCount: number;
  matchedCount: number;
  openingBalance: string | null;
  closingBalance: string | null;
  createdAt: string;
}

export interface MatchSuggestion {
  journalLineId: string;
  confidence: MatchConfidence;
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  txnId: string | null;
  txnNo: string | null;
  partyName: string | null;
  /** Ekstre satırı ile tarih farkı (gün, mutlak). */
  dayDiff: number;
}

export interface BankLine {
  id: string;
  statementId: string;
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  amount: string;
  balance: string | null;
  status: BankLineStatus;
  ignoreReason: string | null;
  journalLineId: string | null;
  transactionId: string | null;
  /** Eşleşmişse bağlı fiş/hareket bilgisi. */
  match: { entryId: string; entryNo: string; entryDate: string; txnNo: string | null; description: string } | null;
  /** Açık satırlar için öneriler (en iyi ilk). */
  suggestions: MatchSuggestion[];
}

export interface LedgerCandidate {
  journalLineId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  amount: string;
  txnNo: string | null;
  partyName: string | null;
}

export interface ReconciliationData {
  account: { id: string; name: string; currencyCode: string; glAccountId: string };
  from: string;
  to: string;
  statements: BankStatementSummary[];
  lines: BankLine[];
  /** Aralıktaki, hiçbir ekstre satırıyla eşleşmemiş defter satırları. */
  unmatchedLedger: LedgerCandidate[];
  summary: {
    /** Aralığın sonuna kadarki son ekstrenin kapanış bakiyesi (bilinmiyorsa null). */
    statementClosing: string | null;
    statementClosingDate: string | null;
    /** Bağlı muhasebe hesabının `to` tarihindeki bakiyesi (hesap para biriminde). */
    ledgerBalance: string;
    /** Ekstre kapanışı − defter bakiyesi (kapanış bilinmiyorsa null). */
    difference: string | null;
    openLines: number;
    openAmount: string;
    matchedLines: number;
    ignoredLines: number;
    unmatchedLedgerCount: number;
    unmatchedLedgerAmount: string;
  };
  /** Son içe aktarmada kullanılan sütun eşlemesi (alan → sütun başlığı); sonraki içe aktarmada hazır gelir. */
  lastMapping: Record<string, string>;
}
