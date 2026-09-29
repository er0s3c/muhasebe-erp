import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  applyRate,
  dec,
  isoYear,
  sum,
  todayIso,
  toDbAmount,
  toDbRate,
  partyKindFits,
  type PartyControlType,
  type PartyKind,
  type CreateJournalInput,
  type JournalLineInput,
  type MoneyValue,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { accounts, fiscalPeriods, journalEntries, journalLines, parties } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { findRate, requireRate } from '../settings/rates';

/**
 * Otomatik yevmiyede (fatura, stok belgesi) satırın defter para birimi tutarı önceden hesaplanmış
 * olabilir: fişin dengesi satır satır yuvarlamadan etkilenmesin diye. Kullanıcı girişinde kullanılmaz.
 */
export type AutoJournalLine = JournalLineInput & { debitBase?: string; creditBase?: string };

export interface SourceRef {
  type: string;
  id: string;
}

export interface LedgerCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
}

const JOURNAL_NUMBER_KEY = 'JE';

interface PreparedLine {
  accountId: string;
  description: string | null;
  currencyCode: string;
  fxRate: MoneyValue;
  debit: MoneyValue;
  credit: MoneyValue;
  debitBase: MoneyValue;
  creditBase: MoneyValue;
  debitReporting: MoneyValue | null;
  creditReporting: MoneyValue | null;
  partyId: string | null;
  dueDate: string | null;
}

export interface ReportingLine {
  debitBase: MoneyValue;
  creditBase: MoneyValue;
  debitReporting: MoneyValue | null;
  creditReporting: MoneyValue | null;
}

/**
 * Satırlar tek tek yuvarlandığı için raporlama para biriminde borç ve alacak toplamı birkaç
 * kuruş ayrışabilir, oysa defter dengelidir. Fark, fişteki en büyük ters taraf satırına
 * yansıtılarak fiş kendi içinde dengelenir (çok para birimli defterlerde olağan yöntem).
 * Defter tutarları dengesizse (taslak) dokunulmaz.
 */
export function balanceReporting(lines: ReportingLine[]): void {
  if (lines.length === 0) return;
  if (lines.some((l) => l.debitReporting === null || l.creditReporting === null)) return;
  if (!sum(lines.map((l) => l.debitBase)).equals(sum(lines.map((l) => l.creditBase)))) return;

  const diff = sum(lines.map((l) => l.debitReporting!)).minus(sum(lines.map((l) => l.creditReporting!)));
  if (diff.isZero()) return;

  if (diff.gt(0)) {
    // Borç fazla: en büyük alacak satırını artır
    const credits = lines.filter((l) => l.creditBase.gt(0));
    const target = credits.reduce((a, b) => (b.creditReporting!.gt(a.creditReporting!) ? b : a));
    target.creditReporting = target.creditReporting!.plus(diff);
  } else {
    const debits = lines.filter((l) => l.debitBase.gt(0));
    const target = debits.reduce((a, b) => (b.debitReporting!.gt(a.debitReporting!) ? b : a));
    target.debitReporting = target.debitReporting!.plus(diff.abs());
  }
}

/** Satırları doğrular; tutarları defter ve raporlama para birimine çevirir. */
async function prepareLines(
  tx: Tx,
  ctx: LedgerCtx,
  entryDate: string,
  lines: readonly AutoJournalLine[],
): Promise<PreparedLine[]> {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const found = await tx.select().from(accounts).where(inArray(accounts.id, accountIds));
  const byId = new Map(found.map((a) => [a.id, a]));

  const partyIds = [...new Set(lines.map((l) => l.partyId).filter((p): p is string => !!p))];
  const partyRows = partyIds.length
    ? await tx.select().from(parties).where(inArray(parties.id, partyIds))
    : [];
  const partyById = new Map(partyRows.map((p) => [p.id, p]));

  const rateCache = new Map<string, MoneyValue>();
  const getRate = async (from: string, to: string) => {
    const key = `${from}>${to}`;
    let r = rateCache.get(key);
    if (!r) {
      r = await requireRate(tx, from, to, entryDate, ctx.baseCurrency);
      rateCache.set(key, r);
    }
    return r;
  };
  // Raporlama tutarı türetilmiş yönetim verisidir: kur yoksa kayıt engellenmez, tutar boş
  // bırakılır ve kur girilince `backfillReporting` ile doldurulur.
  let reportingRate: MoneyValue | null = null;
  if (ctx.reportingCurrency) {
    reportingRate =
      ctx.reportingCurrency === ctx.baseCurrency
        ? dec(1)
        : await findRate(tx, ctx.baseCurrency, ctx.reportingCurrency, entryDate, ctx.baseCurrency);
  }

  const prepared: PreparedLine[] = [];
  for (const [i, line] of lines.entries()) {
    const label = `Satır ${i + 1}`;
    const account = byId.get(line.accountId);
    if (!account) throw unprocessable(`${label}: hesap bulunamadı`, 'ACCOUNT_NOT_FOUND');
    if (!account.isPostable) {
      throw unprocessable(`${label}: ${account.code} hesabına kayıt atılamaz (alt hesabı var)`, 'ACCOUNT_NOT_POSTABLE');
    }
    if (!account.isActive) {
      throw unprocessable(`${label}: ${account.code} hesabı pasif`, 'ACCOUNT_INACTIVE');
    }
    if (account.currencyCode && account.currencyCode !== line.currency) {
      throw unprocessable(
        `${label}: ${account.code} hesabı yalnızca ${account.currencyCode} cinsinden hareket görür`,
        'ACCOUNT_CURRENCY_MISMATCH',
      );
    }

    // Cari kuralları: kontrol hesabında cari zorunlu, diğerlerinde yasak (DB tetikleyicisi de denetler)
    if (account.partyControl) {
      if (!line.partyId) {
        throw unprocessable(`${label}: ${account.code} cari hesabı için cari seçilmeli`, 'PARTY_REQUIRED');
      }
      const party = partyById.get(line.partyId);
      if (!party) throw unprocessable(`${label}: cari bulunamadı`, 'PARTY_NOT_FOUND');
      if (!party.isActive) throw unprocessable(`${label}: ${party.name} carisi pasif`, 'PARTY_INACTIVE');
      if (!partyKindFits(party.kind as PartyKind, account.partyControl as PartyControlType)) {
        throw unprocessable(
          `${label}: ${party.name} carisi bu hesap türüyle uyumlu değil (${account.code})`,
          'PARTY_KIND_MISMATCH',
        );
      }
    } else if (line.partyId) {
      throw unprocessable(`${label}: ${account.code} hesabında cari kullanılamaz`, 'PARTY_NOT_ALLOWED');
    }
    if (line.dueDate && !line.partyId) {
      throw unprocessable(`${label}: vade tarihi yalnızca cari satırlarda kullanılabilir`, 'DUE_DATE_WITHOUT_PARTY');
    }

    const debit = dec(line.debit);
    const credit = dec(line.credit);
    if (debit.decimalPlaces() > 2 || credit.decimalPlaces() > 2) {
      throw unprocessable(`${label}: tutar en çok 2 ondalık basamak içerebilir`, 'AMOUNT_PRECISION');
    }

    let fx: MoneyValue;
    if (line.currency === ctx.baseCurrency) {
      fx = dec(1);
    } else if (line.fxRate) {
      fx = dec(line.fxRate);
      if (fx.lte(0)) throw unprocessable(`${label}: kur sıfırdan büyük olmalı`, 'FX_RATE_INVALID');
    } else {
      fx = await getRate(line.currency, ctx.baseCurrency);
    }

    const debitBase = line.debitBase !== undefined ? dec(line.debitBase) : applyRate(debit, fx);
    const creditBase = line.creditBase !== undefined ? dec(line.creditBase) : applyRate(credit, fx);
    prepared.push({
      accountId: line.accountId,
      description: line.description ?? null,
      currencyCode: line.currency,
      fxRate: fx,
      debit,
      credit,
      debitBase,
      creditBase,
      debitReporting: reportingRate ? applyRate(debitBase, reportingRate) : null,
      creditReporting: reportingRate ? applyRate(creditBase, reportingRate) : null,
      partyId: line.partyId ?? null,
      dueDate: line.dueDate ?? null,
    });
  }
  balanceReporting(prepared);
  return prepared;
}

function toRows(entryId: string, companyId: string, lines: PreparedLine[]) {
  return lines.map((l, i) => ({
    entryId,
    companyId,
    lineNo: i + 1,
    accountId: l.accountId,
    description: l.description,
    currencyCode: l.currencyCode,
    fxRate: toDbRate(l.fxRate),
    debit: toDbAmount(l.debit),
    credit: toDbAmount(l.credit),
    debitBase: toDbAmount(l.debitBase),
    creditBase: toDbAmount(l.creditBase),
    debitReporting: l.debitReporting ? toDbAmount(l.debitReporting) : null,
    creditReporting: l.creditReporting ? toDbAmount(l.creditReporting) : null,
    partyId: l.partyId,
    dueDate: l.dueDate,
  }));
}

export async function createJournalEntry(
  tx: Tx,
  ctx: LedgerCtx,
  input: Omit<CreateJournalInput, 'lines'> & { lines: readonly AutoJournalLine[] },
  opts: { source?: SourceRef } = {},
) {
  const period = await requireOpenPeriod(tx, input.entryDate);
  const lines = await prepareLines(tx, ctx, input.entryDate, input.lines);

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      companyId: ctx.companyId,
      entryDate: input.entryDate,
      periodId: period.id,
      description: input.description,
      sourceType: opts.source?.type ?? null,
      sourceId: opts.source?.id ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(toRows(entry!.id, ctx.companyId, lines));

  if (input.post) await postJournalEntry(tx, ctx, entry!.id);
  return getJournalEntry(tx, entry!.id);
}

export async function updateDraftEntry(
  tx: Tx,
  ctx: LedgerCtx,
  id: string,
  input: Omit<CreateJournalInput, 'post'> & { post?: boolean },
) {
  const [existing] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id));
  if (!existing) throw notFound('Yevmiye');
  if (existing.status !== 'draft') {
    throw unprocessable('Yalnızca taslak yevmiye düzenlenebilir', 'ENTRY_NOT_DRAFT');
  }
  const period = await requireOpenPeriod(tx, input.entryDate);
  const lines = await prepareLines(tx, ctx, input.entryDate, input.lines);

  await tx.delete(journalLines).where(eq(journalLines.entryId, id));
  await tx
    .update(journalEntries)
    .set({
      entryDate: input.entryDate,
      periodId: period.id,
      description: input.description,
      updatedAt: new Date(),
    })
    .where(eq(journalEntries.id, id));
  await tx.insert(journalLines).values(toRows(id, ctx.companyId, lines));

  if (input.post) await postJournalEntry(tx, ctx, id);
  return getJournalEntry(tx, id);
}

export async function deleteDraftEntry(tx: Tx, id: string) {
  const [existing] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id));
  if (!existing) throw notFound('Yevmiye');
  if (existing.status !== 'draft') {
    throw unprocessable('Kaydedilmiş yevmiye silinemez; ters kayıt oluşturun', 'ENTRY_NOT_DRAFT');
  }
  await tx.delete(journalEntries).where(eq(journalEntries.id, id));
}

/**
 * Taslağı kaydeder: boşluksuz numara atar. Denge, dönem ve satır kuralları
 * veritabanı tetikleyicisinde de denetlenir (bkz. journal_entries_guard).
 */
export async function postJournalEntry(tx: Tx, ctx: LedgerCtx, id: string) {
  const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id));
  if (!entry) throw notFound('Yevmiye');
  if (entry.status !== 'draft') {
    throw unprocessable('Yevmiye zaten kaydedilmiş', 'ENTRY_ALREADY_POSTED');
  }
  await requireOpenPeriod(tx, entry.entryDate);

  const year = isoYear(entry.entryDate);
  const seq = await nextNumber(tx, ctx.companyId, JOURNAL_NUMBER_KEY, year);
  await tx
    .update(journalEntries)
    .set({
      entryNo: formatDocumentNumber('YV', year, seq),
      status: 'posted',
      postedAt: new Date(),
      postedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(eq(journalEntries.id, id));
  return getJournalEntry(tx, id);
}

/** Ters kayıt: borç/alacak yer değiştirir, orijinal kurlarla; iki kayıt birbirine bağlanır. */
export async function reverseJournalEntry(
  tx: Tx,
  ctx: LedgerCtx,
  id: string,
  opts: { entryDate?: string; description?: string; source?: SourceRef },
) {
  const [original] = await tx.select().from(journalEntries).where(eq(journalEntries.id, id));
  if (!original) throw notFound('Yevmiye');
  if (original.status !== 'posted') {
    throw unprocessable('Yalnızca kaydedilmiş yevmiye ters çevrilebilir', 'ENTRY_NOT_POSTED');
  }
  if (original.reversedById) {
    throw unprocessable('Bu yevmiye zaten ters çevrilmiş', 'ENTRY_ALREADY_REVERSED');
  }
  if (original.reversalOfId) {
    throw unprocessable('Ters kayıt tekrar ters çevrilemez; yeni yevmiye girin', 'ENTRY_IS_REVERSAL');
  }

  const date = opts.entryDate ?? todayIso();
  const period = await requireOpenPeriod(tx, date);
  const originalLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, id))
    .orderBy(asc(journalLines.lineNo));

  const [reversal] = await tx
    .insert(journalEntries)
    .values({
      companyId: ctx.companyId,
      entryDate: date,
      periodId: period.id,
      description: opts.description ?? `Ters kayıt: ${original.entryNo} — ${original.description}`,
      sourceType: opts.source?.type ?? original.sourceType,
      sourceId: opts.source?.id ?? original.sourceId,
      reversalOfId: id,
      createdBy: ctx.userId,
    })
    .returning({ id: journalEntries.id });

  await tx.insert(journalLines).values(
    originalLines.map((l) => ({
      entryId: reversal!.id,
      companyId: ctx.companyId,
      lineNo: l.lineNo,
      accountId: l.accountId,
      description: l.description,
      currencyCode: l.currencyCode,
      fxRate: l.fxRate,
      debit: l.credit,
      credit: l.debit,
      debitBase: l.creditBase,
      creditBase: l.debitBase,
      debitReporting: l.creditReporting,
      creditReporting: l.debitReporting,
      partyId: l.partyId,
      dueDate: l.dueDate,
    })),
  );

  await postJournalEntry(tx, ctx, reversal!.id);
  await tx
    .update(journalEntries)
    .set({ reversedById: reversal!.id, updatedAt: new Date() })
    .where(eq(journalEntries.id, id));
  return getJournalEntry(tx, reversal!.id);
}

export async function getJournalEntry(tx: Tx, id: string) {
  const [entry] = await tx
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      status: journalEntries.status,
      reversalOfId: journalEntries.reversalOfId,
      reversedById: journalEntries.reversedById,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      postedAt: journalEntries.postedAt,
      createdAt: journalEntries.createdAt,
      periodYear: fiscalPeriods.year,
      periodMonth: fiscalPeriods.month,
    })
    .from(journalEntries)
    .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, journalEntries.periodId))
    .where(eq(journalEntries.id, id));
  if (!entry) throw notFound('Yevmiye');

  const lines = await tx
    .select({
      id: journalLines.id,
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      description: journalLines.description,
      currencyCode: journalLines.currencyCode,
      fxRate: journalLines.fxRate,
      debit: journalLines.debit,
      credit: journalLines.credit,
      debitBase: journalLines.debitBase,
      creditBase: journalLines.creditBase,
      debitReporting: journalLines.debitReporting,
      creditReporting: journalLines.creditReporting,
      partyId: journalLines.partyId,
      partyCode: parties.code,
      partyName: parties.name,
      dueDate: journalLines.dueDate,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(parties, eq(parties.id, journalLines.partyId))
    .where(eq(journalLines.entryId, id))
    .orderBy(asc(journalLines.lineNo));
  return { ...entry, lines };
}

export interface ListEntriesQuery {
  from?: string;
  to?: string;
  status?: 'draft' | 'posted';
  limit: number;
  offset: number;
}

export async function listJournalEntries(tx: Tx, q: ListEntriesQuery) {
  const conditions = [
    q.from ? gte(journalEntries.entryDate, q.from) : undefined,
    q.to ? lte(journalEntries.entryDate, q.to) : undefined,
    q.status ? eq(journalEntries.status, q.status) : undefined,
  ].filter((c) => c !== undefined);

  const rows = await tx
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      status: journalEntries.status,
      reversalOfId: journalEntries.reversalOfId,
      reversedById: journalEntries.reversedById,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      totalBase: sql<string>`coalesce(sum(${journalLines.debitBase}), 0)`,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conditions))
    .groupBy(journalEntries.id)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNo), desc(journalEntries.createdAt))
    .limit(q.limit)
    .offset(q.offset);
  return rows;
}

/**
 * Kur sonradan girildiğinde, raporlama tutarı boş kalmış kaydedilmiş satırları doldurur.
 * Her fiş kendi içinde dengelenir. Defter tutarlarına dokunmaz (veritabanı tetikleyicisi
 * yalnızca boş raporlama sütunlarının doldurulmasına izin verir).
 */
export async function backfillReporting(tx: Tx, ctx: LedgerCtx) {
  if (!ctx.reportingCurrency) {
    throw unprocessable('Şirkette raporlama para birimi tanımlı değil', 'REPORTING_CURRENCY_NOT_SET');
  }
  const pending = await tx.execute<{ id: string; d: string }>(sql`
    select distinct e.id, e.entry_date::text as d
    from journal_entries e join journal_lines l on l.entry_id = e.id
    where e.status = 'posted' and l.debit_reporting is null
    order by 2, 1`);

  const rates = new Map<string, MoneyValue | null>();
  let updated = 0;
  for (const { id, d } of pending.rows) {
    if (!rates.has(d)) {
      rates.set(
        d,
        ctx.reportingCurrency === ctx.baseCurrency
          ? dec(1)
          : await findRate(tx, ctx.baseCurrency, ctx.reportingCurrency, d, ctx.baseCurrency),
      );
    }
    const rate = rates.get(d);
    if (!rate) continue;

    const rows = await tx
      .select({ id: journalLines.id, debitBase: journalLines.debitBase, creditBase: journalLines.creditBase })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, id), isNull(journalLines.debitReporting)));
    const lines = rows.map((r) => ({
      id: r.id,
      debitBase: dec(r.debitBase),
      creditBase: dec(r.creditBase),
      debitReporting: applyRate(r.debitBase, rate) as MoneyValue | null,
      creditReporting: applyRate(r.creditBase, rate) as MoneyValue | null,
    }));
    balanceReporting(lines);
    for (const l of lines) {
      await tx
        .update(journalLines)
        .set({ debitReporting: toDbAmount(l.debitReporting!), creditReporting: toDbAmount(l.creditReporting!) })
        .where(eq(journalLines.id, l.id));
      updated++;
    }
  }

  const remaining = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where e.status = 'posted' and l.debit_reporting is null`);
  return { updated, stillMissing: remaining.rows[0]?.n ?? 0 };
}
