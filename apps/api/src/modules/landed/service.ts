import { eq, inArray, sql } from 'drizzle-orm';
import {
  AllocationError,
  IMPORT_FILE_STATUS_LABELS,
  LANDED_COST_KIND_LABELS,
  allocateAmount,
  dec,
  isoYear,
  landedUnitCost,
  splitStockCogs,
  todayIso,
  toBaseAmount,
  toDbAmount,
  toDbRate,
  type AccountMappingKey,
  type AllocLine,
  type CancelImportInput,
  type CurrencyCode,
  type ImportFileStatus,
  type LandedMethod,
  type ListImportFilesQuery,
  type ListImportSourcesQuery,
  type AllocateImportInput,
  type MoneyValue,
  type SaveImportFileInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import {
  accounts,
  importAllocations,
  importCostLines,
  importFileEvents,
  importFileLines,
  importFiles,
  parties,
} from '../../db/schema';
import { AppError, notFound, unprocessable } from '../../http/errors';
import { loadItemStates, lockItems } from '../inventory/balances';
import { insertDocument, reverseStockDocument, type StockCtx } from '../inventory/documents';
import { StockPlanner } from '../inventory/planner';
import { createJournalEntry, reverseJournalEntry, type AutoJournalLine, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { applyAcquisitionDelta, lockLeatherCosts, reverseAcquisitionDelta } from '../leather/costs';
import { nextDocumentNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';

export interface ImportCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
  allowNegativeStock: boolean;
}

const IMPORT_NUMBER_KEY = 'IMP';
const IMPORT_PREFIX = 'ITH';

const stockCtx = (c: ImportCtx): StockCtx => ({
  companyId: c.companyId,
  userId: c.userId,
  baseCurrency: c.baseCurrency,
  reportingCurrency: c.reportingCurrency,
  allowNegativeStock: c.allowNegativeStock,
});
const ledgerCtx = (c: ImportCtx): LedgerCtx => ({
  companyId: c.companyId,
  userId: c.userId,
  baseCurrency: c.baseCurrency,
  reportingCurrency: c.reportingCurrency,
});

// --- Kaynak satırlar ---------------------------------------------------------------------------------------------------

export interface SourceLine extends Record<string, unknown> {
  kind: 'invoice' | 'delivery';
  sourceLineId: string;
  docNo: string;
  docDate: string;
  partyId: string;
  partyName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  warehouseId: string | null;
  quantity: string;
  /** Şirket para biriminde stok defteri değeri. */
  value: string;
  /** Başka bir aktif ithalat dosyasında kullanılıyor mu (kod). */
  usedIn: string | null;
}

/**
 * Aday kaynak satırlar: kayıtlı alış faturasının stoklu (irsaliyesiz) satırları ve kayıtlı alış irsaliyesi satırları.
 * Değer, stok defterindeki giriş değeridir (faturada `stock_movements`, irsaliyede `stock_value`).
 */
function sourceSql(extra: ReturnType<typeof sql>) {
  return sql`
    select * from (
      select 'invoice'::text as kind, il.id as "sourceLineId", i.invoice_no as "docNo", i.invoice_date::text as "docDate",
             i.party_id as "partyId", p.name as "partyName", it.id as "itemId", it.code as "itemCode", it.name as "itemName", it.unit,
             (select m.warehouse_id from stock_movements m where m.document_id = i.stock_document_id and m.line_no = il.line_no and m.kind = 'qty' limit 1) as "warehouseId",
             il.quantity::text as quantity,
             coalesce((select sum(m.value) from stock_movements m where m.document_id = i.stock_document_id and m.line_no = il.line_no and m.kind = 'qty'), 0)::text as value,
             (select f.code from import_file_lines x join import_files f on f.id = x.import_file_id where x.invoice_line_id = il.id and x.is_active limit 1) as "usedIn"
        from invoice_lines il
        join invoices i on i.id = il.invoice_id
        join parties p on p.id = i.party_id
        join items it on it.id = il.item_id
       where i.type = 'purchase' and i.status = 'posted' and il.delivery_line_id is null and it.kind = 'goods'
      union all
      select 'delivery'::text, dl.id, n.note_no, n.note_date::text, n.party_id, p.name, it.id, it.code, it.name, it.unit,
             n.warehouse_id, dl.quantity::text, coalesce(dl.stock_value, 0)::text,
             (select f.code from import_file_lines x join import_files f on f.id = x.import_file_id where x.delivery_line_id = dl.id and x.is_active limit 1)
        from delivery_note_lines dl
        join delivery_notes n on n.id = dl.note_id
        join parties p on p.id = n.party_id
        join items it on it.id = dl.item_id
       where n.type = 'purchase' and n.status = 'posted'
    ) s ${extra}`;
}

export async function listSources(tx: Tx, q: ListImportSourcesQuery) {
  const conds = [sql`s."usedIn" is null`];
  if (q.kind) conds.push(sql`s.kind = ${q.kind}`);
  if (q.partyId) conds.push(sql`s."partyId" = ${q.partyId}::uuid`);
  if (q.from) conds.push(sql`s."docDate" >= ${q.from}`);
  if (q.to) conds.push(sql`s."docDate" <= ${q.to}`);
  if (q.q) conds.push(trContains(['s."docNo"', 's."partyName"', 's."itemCode"', 's."itemName"'], q.q));
  const rows = await tx.execute<SourceLine>(
    sql`${sourceSql(sql`where ${sql.join(conds, sql` and `)} order by s."docDate" desc, s."docNo" desc, s."itemCode" limit ${q.limit}`)}`,
  );
  return { sources: rows.rows };
}

async function loadSources(tx: Tx, refs: readonly { sourceKind: 'invoice' | 'delivery'; sourceLineId: string }[]): Promise<Map<string, SourceLine>> {
  const out = new Map<string, SourceLine>();
  if (refs.length === 0) return out;
  const ids = sql.join(refs.map((r) => sql`${r.sourceLineId}::uuid`), sql`, `);
  const rows = await tx.execute<SourceLine>(sql`${sourceSql(sql`where s."sourceLineId" in (${ids})`)}`);
  for (const r of rows.rows) out.set(`${r.kind}:${r.sourceLineId}`, r);
  return out;
}

// --- Kaydet (taslak) -----------------------------------------------------------------------------------------------------

async function addEvent(tx: Tx, ctx: ImportCtx, fileId: string, action: string, from: ImportFileStatus | null, to: ImportFileStatus, note?: string | null) {
  await tx.insert(importFileEvents).values({ companyId: ctx.companyId, importFileId: fileId, action, fromStatus: from, toStatus: to, note: note ?? null, createdBy: ctx.userId });
}

async function lockFile(tx: Tx, id: string) {
  const [row] = await tx.select().from(importFiles).where(eq(importFiles.id, id)).for('update');
  if (!row) throw notFound('İthalat dosyası');
  return row;
}

/** Ödenen cari ve bağlı fatura/hesap doğrulaması (kullanıcıya anlaşılır hata; asıl koruma tetikleyicidir). */
async function validateCostLines(tx: Tx, input: SaveImportFileInput) {
  const partyIds = [...new Set(input.costLines.map((c) => c.partyId).filter((v): v is string => !!v))];
  if (partyIds.length > 0) {
    const rows = await tx.select({ id: parties.id, isActive: parties.isActive, name: parties.name }).from(parties).where(inArray(parties.id, partyIds));
    if (rows.length !== partyIds.length) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
    const passive = rows.find((r) => !r.isActive);
    if (passive) throw unprocessable(`${passive.name} carisi pasif`, 'PARTY_INACTIVE');
  }
  const accountIds = [...new Set(input.costLines.map((c) => c.creditAccountId).filter((v): v is string => !!v))];
  if (accountIds.length > 0) {
    const rows = await tx.select().from(accounts).where(inArray(accounts.id, accountIds));
    for (const id of accountIds) {
      const a = rows.find((r) => r.id === id);
      if (!a) throw unprocessable('Alacak hesabı bulunamadı', 'ACCOUNT_NOT_FOUND');
      if (!a.isPostable || !a.isActive) throw unprocessable(`${a.code} hesabına kayıt atılamaz`, 'ACCOUNT_NOT_POSTABLE');
      if (a.partyControl || a.currencyCode) {
        throw unprocessable(`${a.code} cari kontrol ya da dövizli hesaptır; ithalat maliyeti aktarımı için uygun değil`, 'IMPORT_ACCOUNT_INVALID');
      }
    }
  }
}

/** Taslağı oluşturur (id yok) ya da yerinde günceller (satırlar bütünüyle değiştirilir). */
export async function saveImportFile(tx: Tx, ctx: ImportCtx, id: string | null, input: SaveImportFileInput) {
  let fileId = id;
  if (id) {
    const file = await lockFile(tx, id);
    if (file.status !== 'draft') throw unprocessable('Yalnızca taslak ithalat dosyası değiştirilebilir', 'IMPORT_NOT_DRAFT');
    await tx
      .update(importFiles)
      .set({
        name: input.name,
        reference: input.reference ?? null,
        description: input.description ?? null,
        method: input.method,
        fileDate: input.fileDate,
        updatedAt: new Date(),
      })
      .where(eq(importFiles.id, id));
    await tx.delete(importCostLines).where(eq(importCostLines.importFileId, id));
    await tx.delete(importFileLines).where(eq(importFileLines.importFileId, id));
  } else {
    const year = isoYear(input.fileDate);
    const code = await nextDocumentNumber(tx, ctx.companyId, IMPORT_NUMBER_KEY, year, IMPORT_PREFIX);
    const [row] = await tx
      .insert(importFiles)
      .values({
        companyId: ctx.companyId,
        code,
        name: input.name,
        reference: input.reference ?? null,
        description: input.description ?? null,
        method: input.method,
        fileDate: input.fileDate,
        createdBy: ctx.userId,
      })
      .returning({ id: importFiles.id });
    fileId = row!.id;
    await addEvent(tx, ctx, fileId, 'created', null, 'draft');
  }

  // Mal satırları: kaynak anlık görüntüsü
  const sources = await loadSources(tx, input.lines);
  const lineRows = input.lines.map((l, i) => {
    const s = sources.get(`${l.sourceKind}:${l.sourceLineId}`);
    if (!s) throw unprocessable(`Satır ${i + 1}: kaynak satır bulunamadı ya da kayıtlı alış belgesi değil`, 'IMPORT_SOURCE_INVALID');
    if (s.usedIn) throw unprocessable(`Satır ${i + 1}: ${s.docNo} / ${s.itemCode} satırı ${s.usedIn} dosyasında kullanılıyor`, 'IMPORT_SOURCE_IN_USE');
    if (!s.warehouseId) throw unprocessable(`Satır ${i + 1}: kaynak belgenin deposu bulunamadı`, 'IMPORT_SOURCE_INVALID');
    return {
      companyId: ctx.companyId,
      importFileId: fileId!,
      lineNo: i + 1,
      sourceKind: l.sourceKind,
      invoiceLineId: l.sourceKind === 'invoice' ? l.sourceLineId : null,
      deliveryLineId: l.sourceKind === 'delivery' ? l.sourceLineId : null,
      itemId: s.itemId,
      warehouseId: s.warehouseId,
      sourceDocNo: s.docNo,
      sourceDate: s.docDate,
      quantity: s.quantity,
      valueBase: s.value,
      weight: l.weight ?? null,
    };
  });
  if (lineRows.length > 0) await tx.insert(importFileLines).values(lineRows);

  // Maliyet kalemleri: yabancı para kuru (verilen ya da dosya tarihindeki kayıtlı kur), şirket para birimi karşılığı
  await validateCostLines(tx, input);
  const costRows = [];
  for (const [i, c] of input.costLines.entries()) {
    const currency = c.currencyCode ?? ctx.baseCurrency;
    let fx: MoneyValue | null = null;
    if (currency !== ctx.baseCurrency) {
      fx = c.fxRate ? dec(c.fxRate) : await requireRate(tx, currency, ctx.baseCurrency, input.fileDate, ctx.baseCurrency);
      if (fx.lte(0)) throw unprocessable(`Maliyet kalemi ${i + 1}: kur sıfırdan büyük olmalı`, 'FX_RATE_INVALID');
    }
    const base = toBaseAmount(c.amount, fx ? fx.toString() : null);
    if (base.lte(0)) throw unprocessable(`Maliyet kalemi ${i + 1}: şirket para birimi karşılığı sıfır`, 'IMPORT_COST_ZERO');
    costRows.push({
      companyId: ctx.companyId,
      importFileId: fileId!,
      lineNo: i + 1,
      kind: c.kind,
      description: c.description,
      partyId: c.partyId ?? null,
      invoiceId: c.invoiceId ?? null,
      currencyCode: currency,
      amount: toDbAmount(c.amount),
      fxRate: fx ? toDbRate(fx) : null,
      amountBase: toDbAmount(base),
      method: c.method ?? input.method,
      creditAccountId: c.creditAccountId ?? null,
      reference: c.reference ?? null,
    });
  }
  if (costRows.length > 0) await tx.insert(importCostLines).values(costRows);

  if (id) await addEvent(tx, ctx, fileId!, 'saved', 'draft', 'draft');
  return getImportFile(tx, fileId!);
}

// --- Dağıt / taslağa dön -------------------------------------------------------------------------------------------------

export async function allocateImportFile(tx: Tx, ctx: ImportCtx, id: string, input: AllocateImportInput) {
  const file = await lockFile(tx, id);
  if (file.status !== 'draft') throw unprocessable('Yalnızca taslak dosya dağıtılabilir', 'IMPORT_NOT_DRAFT');
  const lines = await tx.select().from(importFileLines).where(eq(importFileLines.importFileId, id)).orderBy(importFileLines.lineNo);
  const costs = await tx.select().from(importCostLines).where(eq(importCostLines.importFileId, id)).orderBy(importCostLines.lineNo);
  if (lines.length === 0) throw unprocessable('Dosyada mal satırı yok', 'IMPORT_NO_LINES');
  if (costs.length === 0) throw unprocessable('Dosyada maliyet kalemi yok', 'IMPORT_NO_COSTS');
  await assertSourcesPosted(tx, lines);

  const allocLines: AllocLine[] = lines.map((l) => ({ key: String(l.lineNo), quantity: l.quantity, value: l.valueBase, weight: l.weight }));
  const rows: (typeof importAllocations.$inferInsert)[] = [];
  for (const c of costs) {
    let amounts: MoneyValue[];
    try {
      amounts = allocateAmount(c.amountBase, c.method as LandedMethod, allocLines, input.manual?.[String(c.lineNo)]);
    } catch (e) {
      if (e instanceof AllocationError) throw unprocessable(`Maliyet kalemi ${c.lineNo} (${c.description}): ${e.message}`, `IMPORT_${e.code}`);
      throw e;
    }
    lines.forEach((l, i) => rows.push({ companyId: ctx.companyId, importFileId: id, costLineId: c.id, fileLineId: l.id, amount: toDbAmount(amounts[i]!) }));
  }
  await tx.insert(importAllocations).values(rows);
  await addEvent(tx, ctx, id, 'allocated', 'draft', 'allocated');
  await tx.update(importFiles).set({ status: 'allocated', allocatedAt: new Date(), updatedAt: new Date() }).where(eq(importFiles.id, id));
  return getImportFile(tx, id);
}

export async function reopenImportFile(tx: Tx, ctx: ImportCtx, id: string) {
  const file = await lockFile(tx, id);
  if (file.status !== 'allocated') throw unprocessable('Yalnızca dağıtılmış dosya taslağa döndürülebilir', 'IMPORT_NOT_ALLOCATED');
  await tx.delete(importAllocations).where(eq(importAllocations.importFileId, id));
  await addEvent(tx, ctx, id, 'reopened', 'allocated', 'draft');
  await tx.update(importFiles).set({ status: 'draft', allocatedAt: null, updatedAt: new Date() }).where(eq(importFiles.id, id));
  return getImportFile(tx, id);
}

/** Kaynak belgeler hâlâ kayıtlı mı (iptal edilmişse dosya ilerleyemez). */
async function assertSourcesPosted(tx: Tx, lines: readonly (typeof importFileLines.$inferSelect)[]) {
  const inv = lines.filter((l) => l.invoiceLineId).map((l) => l.invoiceLineId!);
  const del = lines.filter((l) => l.deliveryLineId).map((l) => l.deliveryLineId!);
  const list = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  if (inv.length > 0) {
    const bad = await tx.execute<{ no: string }>(sql`
      select i.invoice_no as no from invoice_lines il join invoices i on i.id = il.invoice_id
       where il.id in (${list(inv)}) and i.status <> 'posted' limit 1`);
    if (bad.rows[0]) throw unprocessable(`${bad.rows[0].no} numaralı fatura artık kayıtlı değil; satırı dosyadan çıkarın`, 'IMPORT_SOURCE_CANCELLED');
  }
  if (del.length > 0) {
    const bad = await tx.execute<{ no: string }>(sql`
      select n.note_no as no from delivery_note_lines dl join delivery_notes n on n.id = dl.note_id
       where dl.id in (${list(del)}) and n.status <> 'posted' limit 1`);
    if (bad.rows[0]) throw unprocessable(`${bad.rows[0].no} numaralı irsaliye artık kayıtlı değil; satırı dosyadan çıkarın`, 'IMPORT_SOURCE_CANCELLED');
  }
}

// --- Muhasebeleştir ------------------------------------------------------------------------------------------------------

/**
 * Dağıtılmış dosyayı kaydeder: her mal satırının payı, kartın eldeki miktarı kadarı stok maliyetine (cost_adjust: miktar
 * değişmez, envanter değeri artar), artık stokta olmayan miktarın payı satılan mal maliyetine (621) gider.
 * Yevmiye: B stok / B satılan mal maliyeti / A (her maliyet kaleminin alacak hesabı ya da eşlemedeki aktarım hesabı).
 * Kilit sırası: dosya → ürünler → numaralar.
 */
export async function postImportFile(tx: Tx, ctx: ImportCtx, id: string, input: { date?: string }) {
  await lockLeatherCosts(tx, ctx.companyId);
  const file = await lockFile(tx, id);
  if (file.status !== 'allocated') throw unprocessable('Yalnızca dağıtılmış dosya muhasebeleştirilebilir', 'IMPORT_NOT_ALLOCATED');
  const date = input.date ?? todayIso();
  const period = await requireOpenPeriod(tx, date);

  const lines = await tx.select().from(importFileLines).where(eq(importFileLines.importFileId, id)).orderBy(importFileLines.lineNo);
  const costs = await tx.select().from(importCostLines).where(eq(importCostLines.importFileId, id)).orderBy(importCostLines.lineNo);
  const allocs = await tx.select().from(importAllocations).where(eq(importAllocations.importFileId, id));
  const latestSource = lines.reduce((m, l) => (l.sourceDate > m ? l.sourceDate : m), '');
  if (date < latestSource) throw unprocessable(`Kayıt tarihi kaynak belgelerin tarihinden (${latestSource}) önce olamaz`, 'IMPORT_DATE_BEFORE_SOURCE');
  await assertSourcesPosted(tx, lines);

  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  await lockItems(tx, itemIds);
  const states = await loadItemStates(tx, itemIds);
  const planner = new StockPlanner(states, new Map(), { allowNegative: true, items: new Map(), warehouseNames: new Map() });

  const perLine = new Map<string, MoneyValue>();
  for (const a of allocs) perLine.set(a.fileLineId, (perLine.get(a.fileLineId) ?? dec(0)).plus(a.amount));
  const poolUsed = new Map<string, MoneyValue>();
  let toStockTotal = dec(0);
  let toCogsTotal = dec(0);
  const split = new Map<string, { stocked: MoneyValue; cogs: MoneyValue }>();
  const traced = new Set<string>();
  const tracedLines: AutoJournalLine[] = [];
  for (const l of lines) {
    const allocated = perLine.get(l.id) ?? dec(0);
    const adjustment = allocated.isZero() ? null : await applyAcquisitionDelta(tx, stockCtx(ctx), {sourceKind:l.sourceKind as 'invoice'|'delivery',sourceLineId:(l.invoiceLineId??l.deliveryLineId)!,amount:allocated.toFixed(2),date,sourceKey:`import:${id}:${l.lineNo}`});
    if (adjustment) {
      traced.add(l.id);tracedLines.push(...adjustment.lines);
      const stocked=adjustment.destinations.filter(d=>d.target.startsWith('stock:')).reduce((s,d)=>s.plus(d.amount),dec(0));
      split.set(l.id,{stocked,cogs:allocated.minus(stocked)});
      continue;
    }
    const onHand = planner.state(l.itemId).qty.minus(poolUsed.get(l.itemId) ?? 0);
    const part = splitStockCogs(allocated, dec(l.quantity), onHand);
    poolUsed.set(l.itemId, (poolUsed.get(l.itemId) ?? dec(0)).plus(part.usable));
    split.set(l.id, { stocked: part.toStock, cogs: part.toCogs });
    toStockTotal = toStockTotal.plus(part.toStock);
    toCogsTotal = toCogsTotal.plus(part.toCogs);
  }
  // Havuz paylaşımı yalnızca payı bölmek içindir; durum ilerletme planlayıcıyla (cost_adjust) yapılır
  for (const l of lines) {
    if (traced.has(l.id)) continue;
    const s = split.get(l.id)!;
    planner.adjust(l.lineNo, l.itemId, l.warehouseId, s.stocked);
  }

  // Yevmiye
  const keys: AccountMappingKey[] = [];
  if (toStockTotal.gt(0)) keys.push('stock');
  if (toCogsTotal.gt(0)) keys.push('cogs');
  if (costs.some((c) => !c.creditAccountId)) keys.push('import_cost_clearing');
  const acc: Partial<Record<AccountMappingKey, string>> = await requireMappings(tx, keys);
  const credits = new Map<string, MoneyValue>();
  for (const c of costs) {
    const accountId = c.creditAccountId ?? acc.import_cost_clearing!;
    credits.set(accountId, (credits.get(accountId) ?? dec(0)).plus(c.amountBase));
  }
  const text = `İthalat maliyet dağıtımı ${file.code} — ${file.name}`.slice(0, 300);
  const jl = (accountId: string, side: 'debit' | 'credit', amount: MoneyValue, description: string): AutoJournalLine => ({
    accountId,
    currency: ctx.baseCurrency as CurrencyCode,
    debit: side === 'debit' ? toDbAmount(amount) : '0',
    credit: side === 'credit' ? toDbAmount(amount) : '0',
    description,
  });
  const jlines: AutoJournalLine[] = [...tracedLines];
  if (toStockTotal.gt(0)) jlines.push(jl(acc.stock!, 'debit', toStockTotal, 'Stok maliyetine eklenen ithalat gideri'));
  if (toCogsTotal.gt(0)) jlines.push(jl(acc.cogs!, 'debit', toCogsTotal, 'Satılmış mala düşen ithalat gideri'));
  for (const [accountId, amount] of credits) jlines.push(jl(accountId, 'credit', amount, 'İthalat maliyeti aktarımı'));
  const entry = await createJournalEntry(
    tx,
    ledgerCtx(ctx),
    { entryDate: date, description: text, lines: jlines, post: true },
    { source: { type: 'import_file', id } },
  );

  // Stok defteri: yalnızca değer artışı (miktar değişmez)
  let stockDocumentId: string | null = null;
  if (planner.rows.length > 0) {
    const doc = await insertDocument(
      tx,
      stockCtx(ctx),
      period.id,
      {
        docDate: date,
        type: 'receipt',
        warehouseId: planner.rows[0]!.warehouseId,
        description: `İthalat maliyeti ${file.code}`.slice(0, 300),
        sourceType: 'import_file',
        sourceId: id,
      },
      planner.rows,
    );
    stockDocumentId = doc.id;
  }
  for (const l of lines) {
    const s = split.get(l.id)!;
    await tx.update(importFileLines).set({ stockedAmount: toDbAmount(s.stocked), cogsAmount: toDbAmount(s.cogs) }).where(eq(importFileLines.id, l.id));
  }

  await addEvent(tx, ctx, id, 'posted', 'allocated', 'posted');
  await tx
    .update(importFiles)
    .set({ status: 'posted', postDate: date, postedAt: new Date(), postedBy: ctx.userId, stockDocumentId, journalEntryId: entry.id, updatedAt: new Date() })
    .where(eq(importFiles.id, id));
  return getImportFile(tx, id);
}

// --- İptal ---------------------------------------------------------------------------------------------------------------

export async function cancelImportFile(tx: Tx, ctx: ImportCtx, id: string, input: CancelImportInput) {
  await lockLeatherCosts(tx, ctx.companyId);
  const file = await lockFile(tx, id);
  if (file.status === 'cancelled') throw unprocessable('Dosya zaten iptal edilmiş', 'IMPORT_ALREADY_CANCELLED');
  const patch: Partial<typeof importFiles.$inferInsert> = { status: 'cancelled', cancelledAt: new Date(), cancelledBy: ctx.userId, cancelReason: input.reason, updatedAt: new Date() };

  if (file.status === 'posted') {
    const date = input.date ?? todayIso();
    if (file.postDate && date < file.postDate) throw unprocessable('İptal tarihi kayıt tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_POST');
    await requireOpenPeriod(tx, date);
    const tracedSources=await tx.select().from(importFileLines).where(eq(importFileLines.importFileId,id));
    for(const l of tracedSources) await reverseAcquisitionDelta(tx,stockCtx(ctx),{sourceKind:l.sourceKind as 'invoice'|'delivery',sourceLineId:(l.invoiceLineId??l.deliveryLineId)!,amount:'0',date,sourceKey:`cancel-import:${id}:${l.lineNo}`,originalSourceKey:`import:${id}:${l.lineNo}`});
    if (file.stockDocumentId) {
      try {
        const rev = await reverseStockDocument(tx, stockCtx(ctx), file.stockDocumentId, { docDate: date, description: `İptal: ${file.code}` }, true);
        patch.cancelStockDocumentId = rev.document.id;
      } catch (e) {
        if (e instanceof AppError && e.code === 'STOCK_DOC_HAS_LATER_MOVEMENTS') {
          throw unprocessable(
            `${e.message.split(' kartında')[0]} kartında bu ithalat dosyasından sonra stok hareketi var; dosya iptal edilemez, düzeltme için elle stok/yevmiye kaydı girin`,
            'IMPORT_CANCEL_BLOCKED',
          );
        }
        throw e;
      }
    }
    const rev = await reverseJournalEntry(tx, ledgerCtx(ctx), file.journalEntryId!, {
      entryDate: date,
      description: `İptal: ${file.code} — ${input.reason}`.slice(0, 300),
      source: { type: 'import_file', id },
    });
    patch.cancelJournalEntryId = rev.id;
  }

  await addEvent(tx, ctx, id, 'cancelled', file.status as ImportFileStatus, 'cancelled', input.reason);
  await tx.update(importFiles).set(patch).where(eq(importFiles.id, id));
  // Kaynak satırlar serbest kalır (başka dosyada kullanılabilir)
  await tx.update(importFileLines).set({ isActive: false }).where(eq(importFileLines.importFileId, id));
  return getImportFile(tx, id);
}

// --- Okuma ---------------------------------------------------------------------------------------------------------------

export async function listImportFiles(tx: Tx, q: ListImportFilesQuery) {
  const conds = [];
  if (q.status) conds.push(sql`f.status = ${q.status}`);
  if (q.from) conds.push(sql`f.file_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`f.file_date <= ${q.to}::date`);
  if (q.q) conds.push(trContains(['f.code', 'f.name', "coalesce(f.reference, '')"], q.q));
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select f.id, f.code, f.name, f.reference, f.status, f.file_date::text as "fileDate", f.post_date::text as "postDate",
           (select count(*)::int from import_file_lines l where l.import_file_id = f.id) as "lineCount",
           (select coalesce(sum(l.value_base), 0) from import_file_lines l where l.import_file_id = f.id)::text as "goodsValue",
           (select coalesce(sum(c.amount_base), 0) from import_cost_lines c where c.import_file_id = f.id)::text as "costTotal"
      from import_files f ${where}
     order by f.file_date desc, f.code desc
     limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from import_files f ${where}`);
  return { files: rows.rows, total: total.rows[0]?.n ?? 0 };
}

interface CostLineView extends Record<string, unknown> {
  id: string;
  lineNo: number;
  kind: string;
  description: string;
  partyId: string | null;
  partyName: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  currencyCode: string;
  amount: string;
  fxRate: string | null;
  amountBase: string;
  method: string;
  creditAccountId: string | null;
  creditAccountCode: string | null;
  reference: string | null;
}

interface FileLineView extends Record<string, unknown> {
  id: string;
  lineNo: number;
  sourceKind: string;
  sourceLineId: string;
  sourceDocNo: string;
  sourceDate: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  warehouseName: string;
  quantity: string;
  valueBase: string;
  weight: string | null;
  allocated: string;
  stockedAmount: string | null;
  cogsAmount: string | null;
}

export async function getImportFile(tx: Tx, id: string) {
  const [file] = await tx.select().from(importFiles).where(eq(importFiles.id, id));
  if (!file) throw notFound('İthalat dosyası');

  const lines = await tx.execute<FileLineView>(sql`
    select l.id, l.line_no as "lineNo", l.source_kind as "sourceKind", coalesce(l.invoice_line_id, l.delivery_line_id) as "sourceLineId",
           l.source_doc_no as "sourceDocNo", l.source_date::text as "sourceDate", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.unit,
           w.name as "warehouseName", l.quantity::text as quantity, l.value_base::text as "valueBase", l.weight::text as weight,
           coalesce((select sum(a.amount) from import_allocations a where a.file_line_id = l.id), 0)::text as allocated,
           l.stocked_amount::text as "stockedAmount", l.cogs_amount::text as "cogsAmount"
      from import_file_lines l
      join items i on i.id = l.item_id
      join warehouses w on w.id = l.warehouse_id
     where l.import_file_id = ${id}
     order by l.line_no`);
  const costs = await tx.execute<CostLineView>(sql`
    select c.id, c.line_no as "lineNo", c.kind, c.description, c.party_id as "partyId", p.name as "partyName", c.invoice_id as "invoiceId", inv.invoice_no as "invoiceNo",
           c.currency_code as "currencyCode", c.amount::text as amount, c.fx_rate::text as "fxRate", c.amount_base::text as "amountBase", c.method,
           c.credit_account_id as "creditAccountId", a.code as "creditAccountCode", c.reference
      from import_cost_lines c
      left join parties p on p.id = c.party_id
      left join invoices inv on inv.id = c.invoice_id
      left join accounts a on a.id = c.credit_account_id
     where c.import_file_id = ${id}
     order by c.line_no`);
  const allocs = await tx.execute<{ costLineId: string; fileLineId: string; amount: string }>(sql`
    select cost_line_id as "costLineId", file_line_id as "fileLineId", amount::text as amount from import_allocations where import_file_id = ${id}`);
  const events = await tx.execute<Record<string, unknown>>(sql`
    select e.action, e.from_status as "fromStatus", e.to_status as "toStatus", e.note, e.created_at as "createdAt", u.full_name as "userName"
      from import_file_events e left join users u on u.id = e.created_by
     where e.import_file_id = ${id} order by e.created_at, e.id`);

  const goods = lines.rows.reduce((s, l) => s.plus(l.valueBase), dec(0));
  const costTotal = costs.rows.reduce((s, c) => s.plus(c.amountBase), dec(0));
  const ref = await tx.execute<{ je: string | null; cje: string | null; sd: string | null; csd: string | null }>(sql`
    select (select entry_no from journal_entries where id = ${file.journalEntryId}) as je,
           (select entry_no from journal_entries where id = ${file.cancelJournalEntryId}) as cje,
           (select doc_no from stock_documents where id = ${file.stockDocumentId}) as sd,
           (select doc_no from stock_documents where id = ${file.cancelStockDocumentId}) as csd`);
  return {
    file: {
      ...file,
      statusLabel: IMPORT_FILE_STATUS_LABELS[file.status as ImportFileStatus],
      journalEntryNo: ref.rows[0]?.je ?? null,
      cancelJournalEntryNo: ref.rows[0]?.cje ?? null,
      stockDocumentNo: ref.rows[0]?.sd ?? null,
      cancelStockDocumentNo: ref.rows[0]?.csd ?? null,
    },
    lines: lines.rows,
    costLines: costs.rows.map((c) => ({ ...c, kindLabel: LANDED_COST_KIND_LABELS[c.kind as keyof typeof LANDED_COST_KIND_LABELS] })),
    allocations: allocs.rows,
    events: events.rows,
    totals: { goodsValue: toDbAmount(goods), costTotal: toDbAmount(costTotal), landedValue: toDbAmount(goods.plus(costTotal)) },
  };
}

// --- Rapor: dosya ve kart bazında maliyet ------------------------------------------------------------------------------------

/** Bir dosyanın landed cost raporu: satır, kart ve maliyet türü bazında; birim maliyet öncesi/sonrası. */
export async function importFileReport(tx: Tx, id: string) {
  const d = await getImportFile(tx, id);
  const costByKind = new Map<string, MoneyValue>();
  for (const c of d.costLines) costByKind.set(c.kind, (costByKind.get(c.kind) ?? dec(0)).plus(c.amountBase));

  const byLine = d.lines.map((l) => {
    const u = landedUnitCost(l.quantity, l.valueBase, l.allocated);
    return {
      lineNo: l.lineNo,
      sourceDocNo: l.sourceDocNo,
      itemId: l.itemId,
      itemCode: l.itemCode,
      itemName: l.itemName,
      unit: l.unit,
      quantity: l.quantity,
      weight: l.weight,
      goodsValue: l.valueBase,
      allocated: l.allocated,
      landedValue: toDbAmount(dec(l.valueBase).plus(l.allocated)),
      unitBefore: u.before ? u.before.toFixed(4) : null,
      unitAfter: u.after ? u.after.toFixed(4) : null,
      uplift: dec(l.valueBase).gt(0) ? dec(l.allocated).div(l.valueBase).times(100).toFixed(2) : null,
      stockedAmount: l.stockedAmount,
      cogsAmount: l.cogsAmount,
    };
  });
  const items = new Map<string, { itemId: string; itemCode: string; itemName: string; unit: string; quantity: MoneyValue; goodsValue: MoneyValue; allocated: MoneyValue }>();
  for (const l of byLine) {
    const cur = items.get(l.itemId) ?? { itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, unit: l.unit, quantity: dec(0), goodsValue: dec(0), allocated: dec(0) };
    cur.quantity = cur.quantity.plus(l.quantity);
    cur.goodsValue = cur.goodsValue.plus(l.goodsValue);
    cur.allocated = cur.allocated.plus(l.allocated);
    items.set(l.itemId, cur);
  }
  const byItem = [...items.values()].map((i) => {
    const u = landedUnitCost(i.quantity.toString(), i.goodsValue.toString(), i.allocated.toString());
    return {
      itemId: i.itemId,
      itemCode: i.itemCode,
      itemName: i.itemName,
      unit: i.unit,
      quantity: toDbAmount(i.quantity),
      goodsValue: toDbAmount(i.goodsValue),
      allocated: toDbAmount(i.allocated),
      landedValue: toDbAmount(i.goodsValue.plus(i.allocated)),
      unitBefore: u.before ? u.before.toFixed(4) : null,
      unitAfter: u.after ? u.after.toFixed(4) : null,
    };
  });
  const allocatedTotal = byLine.reduce((s, l) => s.plus(l.allocated), dec(0));
  return {
    file: { id: d.file.id, code: d.file.code, name: d.file.name, reference: d.file.reference, status: d.file.status, statusLabel: d.file.statusLabel, fileDate: d.file.fileDate, postDate: d.file.postDate },
    byLine,
    byItem,
    byCost: [...costByKind.entries()].map(([kind, amount]) => ({ kind, kindLabel: LANDED_COST_KIND_LABELS[kind as keyof typeof LANDED_COST_KIND_LABELS], amount: toDbAmount(amount) })),
    totals: { ...d.totals, allocated: toDbAmount(allocatedTotal) },
  };
}

/** Dosyalar arası kart bazında rapor: muhasebeleşmiş dosyalar (tarih aralığında), ek maliyetin birim maliyete etkisi. */
export async function importLandedByItem(tx: Tx, q: { from?: string; to?: string; itemId?: string }) {
  const conds = [sql`f.status = 'posted'`];
  if (q.from) conds.push(sql`f.post_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`f.post_date <= ${q.to}::date`);
  if (q.itemId) conds.push(sql`l.item_id = ${q.itemId}::uuid`);
  const rows = await tx.execute<{ itemId: string; itemCode: string; itemName: string; unit: string; fileCount: number; quantity: string; goodsValue: string; allocated: string; stocked: string; cogs: string }>(sql`
    select i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.unit,
           count(distinct f.id)::int as "fileCount", sum(l.quantity)::text as quantity, sum(l.value_base)::text as "goodsValue",
           sum(coalesce(a.amount, 0))::text as allocated, sum(coalesce(l.stocked_amount, 0))::text as stocked, sum(coalesce(l.cogs_amount, 0))::text as cogs
      from import_file_lines l
      join import_files f on f.id = l.import_file_id
      join items i on i.id = l.item_id
      left join lateral (select sum(x.amount) as amount from import_allocations x where x.file_line_id = l.id) a on true
     where ${sql.join(conds, sql` and `)}
     group by i.id, i.code, i.name, i.unit
     order by i.code`);
  const items = rows.rows.map((r) => {
    const u = landedUnitCost(r.quantity, r.goodsValue, r.allocated);
    return { ...r, unitBefore: u.before ? u.before.toFixed(4) : null, unitAfter: u.after ? u.after.toFixed(4) : null };
  });
  return { items };
}
