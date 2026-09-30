import { MATCH_TOLERANCE_DAYS, dec, type MatchSuggestion } from '@erp/shared';
import { foldKey } from '../imports/values';

/** Eşleştirmeye giren ekstre satırı (yalnızca açık satırlar). */
export interface StatementLineInput {
  id: string;
  txnDate: string;
  /** İşaretli tutar (+ giriş, − çıkış). */
  amount: string;
  description: string;
  reference: string | null;
}

/** Eşleşmemiş defter satırı: bağlı muhasebe hesabındaki, kaydedilmiş ve ters çevrilmemiş fişlerden. */
export interface LedgerCandidateInput {
  journalLineId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string;
  /** İşaretli tutar (borç − alacak, hesap para biriminde). */
  amount: string;
  txnId: string | null;
  txnNo: string | null;
  partyName: string | null;
}

const DAY_MS = 86_400_000;

export function dayDiff(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS));
}

const norm = (amount: string) => dec(amount).toFixed(4);

/** Açıklamadaki kelimelerden aday açıklamasıyla örtüşen sayısı (yalnızca eşit puanlı adayları sıralamak için). */
function textScore(text: string, cand: LedgerCandidateInput): number {
  const hay = foldKey(text);
  if (hay === '') return 0;
  const words = `${cand.description} ${cand.partyName ?? ''}`
    .split(/[\s—–\-,.;:/()]+/)
    .map(foldKey)
    .filter((w) => w.length >= 4);
  return new Set(words.filter((w) => hay.includes(w))).size;
}

/**
 * Ekstre satırı → defter satırı önerileri. Tutar ve işaret birebir, tarih farkı ≤ `MATCH_TOLERANCE_DAYS`.
 * Güven: **exact** = tek aday ve o aday yalnızca bu satıra uyuyor (ya da açıklamada yalnızca bir adayın hareket
 * numarası geçiyor); **probable** = birden çok olası eşleşme (tarih yakınlığı ve açıklama benzerliği sıralar).
 * Hiçbir zaman ters çevrilmiş fiş çiftleri aday olmaz: çağıran aday listesini bu kurala göre kurar.
 */
export function suggestMatches(
  lines: readonly StatementLineInput[],
  candidates: readonly LedgerCandidateInput[],
  tolerance: number = MATCH_TOLERANCE_DAYS,
): Map<string, MatchSuggestion[]> {
  const byAmount = new Map<string, LedgerCandidateInput[]>();
  for (const c of candidates) {
    const key = norm(c.amount);
    byAmount.set(key, [...(byAmount.get(key) ?? []), c]);
  }

  // Her satır için adaylar
  const perLine = new Map<string, { cand: LedgerCandidateInput; diff: number }[]>();
  const linesPerCandidate = new Map<string, number>();
  for (const l of lines) {
    const found = (byAmount.get(norm(l.amount)) ?? [])
      .map((cand) => ({ cand, diff: dayDiff(l.txnDate, cand.entryDate) }))
      .filter((x) => x.diff <= tolerance);
    perLine.set(l.id, found);
    for (const { cand } of found) linesPerCandidate.set(cand.journalLineId, (linesPerCandidate.get(cand.journalLineId) ?? 0) + 1);
  }

  const out = new Map<string, MatchSuggestion[]>();
  for (const l of lines) {
    const found = perLine.get(l.id) ?? [];
    if (found.length === 0) {
      out.set(l.id, []);
      continue;
    }
    const text = `${l.description} ${l.reference ?? ''}`;
    const upper = text.toUpperCase();
    const numbered = found.filter(({ cand }) => cand.txnNo !== null && upper.includes(cand.txnNo.toUpperCase()));
    const scored = found
      .map((x) => ({ ...x, score: textScore(text, x.cand) + (numbered.includes(x) ? 100 : 0) }))
      .sort((a, b) => b.score - a.score || a.diff - b.diff || a.cand.entryNo.localeCompare(b.cand.entryNo));

    out.set(
      l.id,
      scored.map(({ cand, diff }, i): MatchSuggestion => {
        const uniquePair = found.length === 1 && linesPerCandidate.get(cand.journalLineId) === 1;
        const byNumber = numbered.length === 1 && numbered[0]!.cand.journalLineId === cand.journalLineId;
        return {
          journalLineId: cand.journalLineId,
          confidence: (uniquePair || byNumber) && i === 0 ? 'exact' : 'probable',
          entryId: cand.entryId,
          entryNo: cand.entryNo,
          entryDate: cand.entryDate,
          description: cand.description,
          txnId: cand.txnId,
          txnNo: cand.txnNo,
          partyName: cand.partyName,
          dayDiff: diff,
        };
      }),
    );
  }
  return out;
}
