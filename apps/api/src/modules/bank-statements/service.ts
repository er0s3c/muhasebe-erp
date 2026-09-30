import { and, eq, sql } from 'drizzle-orm';
import {
  MATCH_TOLERANCE_DAYS,
  createFromLineSchema,
  createTreasuryTransactionSchema,
  dec,
  toDbAmount,
  todayIso,
  type BankLine,
  type BankLineStatus,
  type BankStatementSummary,
  type CreateFromLineInput,
  type LedgerCandidate,
  type ReconciliationData,
  type ReconciliationQuery,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { bankStatementLines, bankStatements } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import type { LedgerCtx } from '../ledger/journal';
import { getTreasuryAccountRow, glBalance, type TreasuryAccountRow } from '../treasury/accounts';
import { postTreasuryTransaction } from '../treasury/posting';
import { suggestMatches, type LedgerCandidateInput } from './matching';

type Line = typeof bankStatementLines.$inferSelect;

const DAY_MS = 86_400_000;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Ekstre yalnızca banka hesabında tutulur. */
export async function requireBankAccount(tx: Tx, id: string): Promise<TreasuryAccountRow> {
  const ta = await getTreasuryAccountRow(tx, id);
  if (ta.kind !== 'bank') throw unprocessable('Banka ekstresi yalnızca banka hesaplarında kullanılır', 'NOT_A_BANK_ACCOUNT');
  return ta;
}

interface CandidateRow extends Record<string, unknown> {
  journal_line_id: string;
  entry_id: string;
  entry_no: string;
  entry_date: string;
  description: string;
  amount: string;
  txn_id: string | null;
  txn_no: string | null;
  party_name: string | null;
}

/**
 * Eşleşmeye aday defter satırları: bağlı muhasebe hesabındaki, kaydedilmiş, ters çevrilmemiş fişlerin (ters kayıt
 * çiftleri hiçbir tarafıyla aday değildir: iptal edilen hareketin hayalet satırı çıkmaz) henüz eşleşmemiş satırları.
 */
export async function ledgerCandidates(tx: Tx, ta: TreasuryAccountRow, from: string, to: string): Promise<LedgerCandidateInput[]> {
  const r = await tx.execute<CandidateRow>(sql`
    select l.id as journal_line_id, e.id as entry_id, e.entry_no, e.entry_date::text as entry_date,
           coalesce(nullif(l.description, ''), e.description) as description,
           (l.debit - l.credit) as amount,
           t.id as txn_id, t.txn_no, p.name as party_name
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
    left join treasury_transactions t on t.journal_entry_id = e.id and t.status = 'posted'
    left join parties p on p.id = t.party_id
    where l.account_id = ${ta.accountId}
      and e.status = 'posted' and e.reversed_by_id is null and e.reversal_of_id is null
      and e.entry_date between ${from}::date and ${to}::date
      and not exists (select 1 from bank_statement_lines b where b.journal_line_id = l.id and b.status = 'matched')
    order by e.entry_date, e.entry_no, l.line_no`);
  return r.rows.map((x) => ({
    journalLineId: x.journal_line_id,
    entryId: x.entry_id,
    entryNo: x.entry_no,
    entryDate: x.entry_date,
    description: x.description,
    amount: toDbAmount(x.amount),
    txnId: x.txn_id,
    txnNo: x.txn_no,
    partyName: x.party_name,
  }));
}

interface LineRow extends Record<string, unknown> {
  id: string;
  statement_id: string;
  line_no: number;
  txn_date: string;
  value_date: string | null;
  description: string;
  reference: string | null;
  amount: string;
  balance: string | null;
  status: BankLineStatus;
  ignore_reason: string | null;
  journal_line_id: string | null;
  transaction_id: string | null;
  m_entry_id: string | null;
  m_entry_no: string | null;
  m_entry_date: string | null;
  m_description: string | null;
  m_txn_no: string | null;
}

/** Ekstre satırları, eşleşmeleri ve (açık satırlar için) önerilerle; aralık dışına 3 gün taşan adaylar da önerilir. */
export async function reconciliation(tx: Tx, accountId: string, q: ReconciliationQuery, today = todayIso()): Promise<ReconciliationData> {
  const ta = await requireBankAccount(tx, accountId);

  const bounds = await tx.execute<{ min: string | null }>(sql`select min(txn_date)::text as min from bank_statement_lines where account_id = ${ta.id}`);
  const from = q.from ?? bounds.rows[0]?.min ?? `${today.slice(0, 4)}-01-01`;
  const to = q.to ?? today;
  if (from > to) throw unprocessable('Başlangıç tarihi bitişten sonra olamaz', 'RANGE_INVALID');

  const stRows = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.file_name as "fileName", s.from_date::text as "fromDate", s.to_date::text as "toDate", s.line_count as "lineCount",
           (select count(*)::int from bank_statement_lines b where b.statement_id = s.id and b.status = 'matched') as "matchedCount",
           s.opening_balance as "openingBalance", s.closing_balance as "closingBalance", s.created_at as "createdAt", s.mapping
    from bank_statements s where s.account_id = ${ta.id}
    order by s.to_date desc, s.created_at desc`);
  const statements = stRows.rows.map((s) => ({
    id: s.id as string,
    fileName: s.fileName as string,
    fromDate: s.fromDate as string,
    toDate: s.toDate as string,
    lineCount: s.lineCount as number,
    matchedCount: s.matchedCount as number,
    openingBalance: (s.openingBalance as string | null) === null ? null : toDbAmount(s.openingBalance as string),
    closingBalance: (s.closingBalance as string | null) === null ? null : toDbAmount(s.closingBalance as string),
    createdAt: new Date(s.createdAt as string).toISOString(),
  })) satisfies BankStatementSummary[];
  const lastMapping = (stRows.rows[0]?.mapping ?? {}) as Record<string, string>;

  const lineRows = await tx.execute<LineRow>(sql`
    select b.id, b.statement_id, b.line_no, b.txn_date::text as txn_date, b.value_date::text as value_date, b.description, b.reference,
           b.amount, b.balance, b.status, b.ignore_reason, b.journal_line_id, b.transaction_id,
           je.id as m_entry_id, je.entry_no as m_entry_no, je.entry_date::text as m_entry_date,
           coalesce(nullif(jl.description, ''), je.description) as m_description, t.txn_no as m_txn_no
    from bank_statement_lines b
    left join journal_lines jl on jl.id = b.journal_line_id
    left join journal_entries je on je.id = jl.entry_id
    left join treasury_transactions t on t.id = b.transaction_id
    where b.account_id = ${ta.id} and b.txn_date between ${from}::date and ${to}::date
    order by b.txn_date, b.statement_id, b.line_no`);

  const candidates = await ledgerCandidates(tx, ta, shift(from, -MATCH_TOLERANCE_DAYS), shift(to, MATCH_TOLERANCE_DAYS));
  const open = lineRows.rows.filter((l) => l.status === 'open');
  const suggestions = suggestMatches(
    open.map((l) => ({ id: l.id, txnDate: l.txn_date, amount: toDbAmount(l.amount), description: l.description, reference: l.reference })),
    candidates,
  );

  const lines: BankLine[] = lineRows.rows.map((l) => ({
    id: l.id,
    statementId: l.statement_id,
    lineNo: l.line_no,
    txnDate: l.txn_date,
    valueDate: l.value_date,
    description: l.description,
    reference: l.reference,
    amount: toDbAmount(l.amount),
    balance: l.balance === null ? null : toDbAmount(l.balance),
    status: l.status,
    ignoreReason: l.ignore_reason,
    journalLineId: l.journal_line_id,
    transactionId: l.transaction_id,
    match: l.m_entry_id ? { entryId: l.m_entry_id, entryNo: l.m_entry_no!, entryDate: l.m_entry_date!, txnNo: l.m_txn_no, description: l.m_description ?? '' } : null,
    suggestions: suggestions.get(l.id) ?? [],
  }));

  const unmatched: LedgerCandidate[] = candidates
    .filter((c) => c.entryDate >= from && c.entryDate <= to)
    .map((c) => ({
      journalLineId: c.journalLineId,
      entryId: c.entryId,
      entryNo: c.entryNo,
      entryDate: c.entryDate,
      description: c.description,
      amount: c.amount,
      txnNo: c.txnNo,
      partyName: c.partyName,
    }));

  // Karşılaştırma tarihi: aralık sonuna kadarki son ekstrenin bitişi (kapanış bakiyesi biliniyorsa)
  const closing = statements.find((s) => s.toDate <= to && s.closingBalance !== null) ?? null;
  const asOf = closing?.toDate ?? to;
  const ledger = await glBalance(tx, ta.accountId, asOf);
  const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), dec(0));
  const openLines = lines.filter((l) => l.status === 'open');

  return {
    account: { id: ta.id, name: ta.name, currencyCode: ta.currencyCode, glAccountId: ta.accountId },
    from,
    to,
    statements,
    lines,
    unmatchedLedger: unmatched,
    summary: {
      statementClosing: closing ? closing.closingBalance : null,
      statementClosingDate: closing ? closing.toDate : null,
      ledgerBalance: toDbAmount(ledger.doc),
      difference: closing ? toDbAmount(dec(closing.closingBalance!).minus(ledger.doc)) : null,
      openLines: openLines.length,
      openAmount: toDbAmount(sum(openLines.map((l) => l.amount))),
      matchedLines: lines.filter((l) => l.status === 'matched').length,
      ignoredLines: lines.filter((l) => l.status === 'ignored').length,
      unmatchedLedgerCount: unmatched.length,
      unmatchedLedgerAmount: toDbAmount(sum(unmatched.map((c) => c.amount))),
    },
    lastMapping,
  };
}

async function lockLine(tx: Tx, id: string): Promise<Line> {
  const [line] = await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, id)).for('update');
  if (!line) throw notFound('Ekstre satırı');
  return line;
}

/** Defter satırının bağlı olduğu kaydedilmiş hareket (varsa): eşleşme hareketle de anılır. */
async function transactionOf(tx: Tx, journalLineId: string): Promise<string | null> {
  const r = await tx.execute<{ id: string }>(sql`
    select t.id from treasury_transactions t
    join journal_lines l on l.entry_id = t.journal_entry_id
    where l.id = ${journalLineId} and t.status = 'posted' limit 1`);
  return r.rows[0]?.id ?? null;
}

export async function matchLine(tx: Tx, ctx: LedgerCtx, lineId: string, journalLineId: string): Promise<Line> {
  const line = await lockLine(tx, lineId);
  if (line.status !== 'open') throw unprocessable('Yalnızca açık ekstre satırı eşleştirilebilir', 'LINE_NOT_OPEN');
  const [taken] = await tx
    .select({ id: bankStatementLines.id })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.journalLineId, journalLineId), eq(bankStatementLines.status, 'matched')));
  if (taken) throw conflict('Bu defter satırı başka bir ekstre satırıyla zaten eşleşmiş', 'LEDGER_LINE_ALREADY_MATCHED');

  const [row] = await tx
    .update(bankStatementLines)
    .set({
      status: 'matched',
      journalLineId,
      transactionId: await transactionOf(tx, journalLineId),
      matchedAt: new Date(),
      matchedBy: ctx.userId,
      ignoreReason: null,
    })
    .where(eq(bankStatementLines.id, lineId))
    .returning();
  return row!;
}

export async function unmatchLine(tx: Tx, lineId: string): Promise<Line> {
  const line = await lockLine(tx, lineId);
  if (line.status !== 'matched') throw unprocessable('Satır eşleşmiş değil', 'LINE_NOT_MATCHED');
  const [row] = await tx
    .update(bankStatementLines)
    .set({ status: 'open', journalLineId: null, transactionId: null, matchedAt: null, matchedBy: null })
    .where(eq(bankStatementLines.id, lineId))
    .returning();
  return row!;
}

export async function ignoreLine(tx: Tx, lineId: string, reason?: string): Promise<Line> {
  const line = await lockLine(tx, lineId);
  if (line.status !== 'open') throw unprocessable('Yalnızca açık ekstre satırı yoksayılabilir', 'LINE_NOT_OPEN');
  const [row] = await tx.update(bankStatementLines).set({ status: 'ignored', ignoreReason: reason ?? null }).where(eq(bankStatementLines.id, lineId)).returning();
  return row!;
}

export async function restoreLine(tx: Tx, lineId: string): Promise<Line> {
  const line = await lockLine(tx, lineId);
  if (line.status !== 'ignored') throw unprocessable('Satır yoksayılmış değil', 'LINE_NOT_IGNORED');
  const [row] = await tx.update(bankStatementLines).set({ status: 'open', ignoreReason: null }).where(eq(bankStatementLines.id, lineId)).returning();
  return row!;
}

/** Yalnızca `exact` önerileri uygular; bir defter satırı en çok bir ekstre satırına verilir. */
export async function autoMatch(tx: Tx, ctx: LedgerCtx, accountId: string, q: ReconciliationQuery, today = todayIso()) {
  const data = await reconciliation(tx, accountId, q, today);
  const used = new Set<string>();
  let matched = 0;
  for (const line of data.lines) {
    if (line.status !== 'open') continue;
    const best = line.suggestions[0];
    if (!best || best.confidence !== 'exact' || used.has(best.journalLineId)) continue;
    await matchLine(tx, ctx, line.id, best.journalLineId);
    used.add(best.journalLineId);
    matched++;
  }
  return { matched, considered: data.lines.filter((l) => l.status === 'open').length };
}

/**
 * Eşleşmeyen satırdan hareket oluşturur: tarih, tutar ve hesap ekstre satırından gelir; yön satırın işaretinden
 * (giriş → tahsilat/diğer tahsilat, çıkış → ödeme/diğer ödeme). Hareket ve eşleşme aynı işlemde yazılır.
 */
export async function createTransactionFromLine(tx: Tx, ctx: LedgerCtx, lineId: string, input: CreateFromLineInput) {
  const line = await lockLine(tx, lineId);
  if (line.status !== 'open') throw unprocessable('Yalnızca açık ekstre satırından hareket oluşturulabilir', 'LINE_NOT_OPEN');
  const amount = dec(line.amount);
  const inbound = amount.gt(0);
  if (inbound !== (input.type === 'receipt' || input.type === 'other_receipt')) {
    throw unprocessable(
      inbound ? 'Ekstre satırı hesaba giriş: tahsilat ya da diğer tahsilat oluşturulabilir' : 'Ekstre satırı hesaptan çıkış: ödeme ya da diğer ödeme oluşturulabilir',
      'LINE_DIRECTION_MISMATCH',
    );
  }
  const ta = await getTreasuryAccountRow(tx, line.accountId);
  const parsed = createTreasuryTransactionSchema.parse({
    type: input.type,
    date: line.txnDate,
    accountId: line.accountId,
    amount: amount.abs().toFixed(2),
    description: (input.description ?? line.description).slice(0, 300) || undefined,
    partyId: input.partyId,
    items: input.items,
    glAccountId: input.glAccountId,
    fxRate: input.fxRate,
  });
  const posted = await postTreasuryTransaction(tx, ctx, parsed);

  // Hareketin banka hesabındaki defter satırı: tutar ve işaret ekstre satırıyla aynı
  const found = await tx.execute<{ id: string }>(sql`
    select l.id from journal_lines l join treasury_transactions t on t.journal_entry_id = l.entry_id
    where t.id = ${posted.transaction.id} and l.account_id = ${ta.accountId} and (l.debit - l.credit) = ${line.amount}::numeric`);
  if (found.rows.length !== 1) {
    throw unprocessable('Hareketin banka satırı ekstre tutarıyla eşleşmedi', 'LINE_AMOUNT_MISMATCH');
  }
  const matched = await matchLine(tx, ctx, lineId, found.rows[0]!.id);
  return { ...posted, line: matched };
}

/** "İçe aktarmayı geri al": hiç eşleşmemiş (açık/yoksayılan) ekstre ve satırları silinir. */
export async function deleteStatement(tx: Tx, id: string) {
  // `FOR UPDATE` gerekmez (erp_app'in ekstre başlığında UPDATE yetkisi yok): eşleşmiş satır silinmeye çalışılırsa veritabanı reddeder
  const [st] = await tx.select().from(bankStatements).where(eq(bankStatements.id, id));
  if (!st) throw notFound('Banka ekstresi');
  const matched = await tx
    .select({ id: bankStatementLines.id })
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.statementId, id), eq(bankStatementLines.status, 'matched')))
    .limit(1);
  if (matched.length > 0) {
    throw unprocessable('Eşleşmiş satırı olan ekstre geri alınamaz; önce eşleşmeleri kaldırın', 'STATEMENT_HAS_MATCHES');
  }
  await tx.delete(bankStatementLines).where(eq(bankStatementLines.statementId, id));
  await tx.delete(bankStatements).where(eq(bankStatements.id, id));
}

export { createFromLineSchema };
