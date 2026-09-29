import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  INVOICE_TYPE_META,
  calcInvoice,
  dec,
  partyKindFits,
  toDbAmount,
  toDbRate,
  type CreateInvoiceInput,
  type InvoiceLineInput,
  type InvoiceType,
  type ListInvoicesQuery,
  type MoneyValue,
  type PartyKind,
  type UpdateInvoiceInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import { accounts, invoiceLines, invoices, items, parties, taxRates, warehouses } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { requireActiveWarehouse } from '../inventory/warehouses';

export interface InvoiceCtx {
  companyId: string;
  userId: string;
  baseCurrency: string;
  reportingCurrency: string | null;
  allowNegativeStock: boolean;
}

/** Doğrulanmış ve tutarları hesaplanmış fatura satırı. */
export interface PreparedLine {
  lineNo: number;
  itemId: string | null;
  isStock: boolean;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
  /** Fatura tarihinde geçerli oran (yüzde), örn. "16.0000". */
  vatRate: string;
  accountId: string | null;
  sourceLineId: string | null;
  net: MoneyValue;
  vat: MoneyValue;
  gross: MoneyValue;
}

/** Kaydedilmiş satır girdisi (DB'den okunan ya da API'den gelen) — hazırlama ortak kullanır. */
export type LineSource = Pick<
  InvoiceLineInput,
  'itemId' | 'description' | 'quantity' | 'unit' | 'unitPrice' | 'discountPct' | 'vatCode' | 'accountId' | 'sourceLineId'
>;

export async function loadParty(tx: Tx, partyId: string, type: InvoiceType) {
  const [party] = await tx.select().from(parties).where(eq(parties.id, partyId));
  if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  if (!partyKindFits(party.kind as PartyKind, INVOICE_TYPE_META[type].control)) {
    throw unprocessable(
      `${party.name} carisi bu fatura türüyle uyumlu değil (${INVOICE_TYPE_META[type].side === 'sales' ? 'müşteri' : 'tedarikçi'} olmalı)`,
      'PARTY_KIND_MISMATCH',
    );
  }
  return party;
}

/** KDV kodlarını fatura tarihinde geçerli oranlara çözer. */
async function resolveVat(tx: Tx, codes: readonly string[], date: string) {
  const unique = [...new Set(codes)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const rows = await tx
    .select()
    .from(taxRates)
    .where(inArray(taxRates.code, unique))
    .orderBy(sql`${taxRates.validFrom} desc`);
  for (const r of rows) {
    if (r.validFrom <= date && (!r.validTo || r.validTo >= date) && !out.has(r.code)) out.set(r.code, dec(r.rate).toFixed(4));
  }
  return out;
}

/**
 * Satırları doğrular ve tutarlarını hesaplar. Taslak kaydında ve kaydetme anında aynı kod çalışır:
 * kaydetmede tarih/oran değişmiş olabileceğinden hesap yeniden yapılır.
 */
export async function prepareLines(
  tx: Tx,
  type: InvoiceType,
  invoiceDate: string,
  lines: readonly LineSource[],
  vatIncluded: boolean,
) {
  const meta = INVOICE_TYPE_META[type];
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const itemRows = itemIds.length ? await tx.select().from(items).where(inArray(items.id, itemIds)) : [];
  const itemById = new Map(itemRows.map((r) => [r.id, r]));

  const vatCodes = lines.map((l) => l.vatCode).filter((v): v is string => !!v);
  const rates = await resolveVat(tx, vatCodes, invoiceDate);

  const accountIds = [...new Set(lines.map((l) => l.accountId).filter((v): v is string => !!v))];
  const accRows = accountIds.length ? await tx.select().from(accounts).where(inArray(accounts.id, accountIds)) : [];
  const accById = new Map(accRows.map((a) => [a.id, a]));

  const prepared: Omit<PreparedLine, 'net' | 'vat' | 'gross'>[] = lines.map((l, i) => {
    const label = `Satır ${i + 1}`;
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (l.itemId && !item) throw unprocessable(`${label}: stok kartı bulunamadı`, 'ITEM_NOT_FOUND');
    if (item && !item.isActive) throw unprocessable(`${label}: ${item.code} ${item.name} kartı pasif`, 'ITEM_INACTIVE');
    const isStock = item?.kind === 'goods';
    if (isStock && !meta.stock) {
      throw unprocessable(`${label}: gider faturasında stoklu mal kartı kullanılamaz; alış faturası girin`, 'EXPENSE_STOCK_ITEM');
    }
    if (l.vatCode && !rates.has(l.vatCode)) {
      throw unprocessable(`${label}: ${l.vatCode} KDV kodu ${invoiceDate} tarihinde geçerli değil`, 'VAT_CODE_INVALID');
    }
    if (l.accountId) {
      const a = accById.get(l.accountId);
      if (!a) throw unprocessable(`${label}: hesap bulunamadı`, 'ACCOUNT_NOT_FOUND');
      if (!a.isPostable || !a.isActive || a.partyControl || a.currencyCode) {
        throw unprocessable(`${label}: ${a.code} hesabı fatura satırında kullanılamaz`, 'ACCOUNT_NOT_ALLOWED');
      }
      if (isStock && meta.side === 'purchases') {
        throw unprocessable(`${label}: stoklu alış satırında hesap seçilemez; stok hesabı eşlemeden gelir`, 'ACCOUNT_NOT_ALLOWED');
      }
    }
    return {
      lineNo: i + 1,
      itemId: l.itemId ?? null,
      isStock,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit ?? item?.unit ?? null,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct ?? '0',
      vatCode: l.vatCode ?? null,
      vatRate: l.vatCode ? rates.get(l.vatCode)! : '0.0000',
      accountId: l.accountId ?? null,
      sourceLineId: l.sourceLineId ?? null,
    };
  });

  const totals = calcInvoice(
    prepared.map((p) => ({ quantity: p.quantity, unitPrice: p.unitPrice, discountPct: p.discountPct, vatRate: p.vatRate })),
    vatIncluded,
  );
  const withAmounts: PreparedLine[] = prepared.map((p, i) => ({ ...p, ...totals.lines[i]! }));
  return { lines: withAmounts, totals };
}

/** İade faturası: orijinal fatura ve satır bağlarını doğrular. */
async function checkReturnLink(
  tx: Tx,
  type: InvoiceType,
  partyId: string,
  returnOfId: string | null | undefined,
  lines: readonly PreparedLine[],
) {
  const meta = INVOICE_TYPE_META[type];
  if (!returnOfId) return null;
  const [orig] = await tx.select().from(invoices).where(eq(invoices.id, returnOfId));
  if (!orig) throw unprocessable('Orijinal fatura bulunamadı', 'RETURN_ORIGINAL_NOT_FOUND');
  if (orig.status !== 'posted') throw unprocessable('Orijinal fatura kaydedilmiş olmalı', 'RETURN_ORIGINAL_NOT_POSTED');
  if (orig.type !== meta.returnOf) {
    throw unprocessable('Orijinal fatura türü bu iade ile uyuşmuyor', 'RETURN_ORIGINAL_TYPE');
  }
  if (orig.partyId !== partyId) throw unprocessable('İade, orijinal faturanın carisine kesilmeli', 'RETURN_PARTY_MISMATCH');

  const linked = lines.filter((l) => l.sourceLineId);
  if (linked.length > 0) {
    const src = await tx
      .select({ id: invoiceLines.id, itemId: invoiceLines.itemId })
      .from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, returnOfId), inArray(invoiceLines.id, linked.map((l) => l.sourceLineId!))));
    const byId = new Map(src.map((s) => [s.id, s]));
    for (const l of linked) {
      const s = byId.get(l.sourceLineId!);
      if (!s) throw unprocessable(`Satır ${l.lineNo}: bağlı satır orijinal faturada yok`, 'RETURN_LINE_NOT_FOUND');
      if ((s.itemId ?? null) !== l.itemId) {
        throw unprocessable(`Satır ${l.lineNo}: iade satırının kartı orijinal satırla aynı olmalı`, 'RETURN_ITEM_MISMATCH');
      }
    }
  }
  return orig;
}

/**
 * Bir faturanın satırlarından iade edilen miktar ve maliyet toplamları (kaydedilmiş, iptal edilmemiş iadeler).
 * `exceptInvoiceId`: kaydedilmekte olan iade kendini saymaz.
 */
export async function returnedTotals(tx: Tx, originalId: string, exceptInvoiceId?: string) {
  const rows = await tx.execute<{ source_line_id: string; qty: string; cost: string | null }>(sql`
    select l.source_line_id, sum(l.quantity) as qty, sum(l.cost_value) as cost
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.return_of_id = ${originalId} and i.status = 'posted' and l.source_line_id is not null
      ${exceptInvoiceId ? sql`and i.id <> ${exceptInvoiceId}` : sql``}
    group by l.source_line_id`);
  return new Map(rows.rows.map((r) => [r.source_line_id, { qty: dec(r.qty), cost: dec(r.cost ?? 0) }]));
}

/** Taslakta da iade miktarı sınırını denetler (kaydetmede kilit altında yeniden denetlenir). */
async function checkReturnQuantities(tx: Tx, originalId: string, lines: readonly PreparedLine[], exceptInvoiceId?: string) {
  const linked = lines.filter((l) => l.sourceLineId);
  if (linked.length === 0) return;
  const src = await tx
    .select({ id: invoiceLines.id, quantity: invoiceLines.quantity })
    .from(invoiceLines)
    .where(inArray(invoiceLines.id, linked.map((l) => l.sourceLineId!)));
  const origQty = new Map(src.map((s) => [s.id, dec(s.quantity)]));
  const returned = await returnedTotals(tx, originalId, exceptInvoiceId);
  const inThis = new Map<string, MoneyValue>();
  for (const l of linked) {
    const used = (returned.get(l.sourceLineId!)?.qty ?? dec(0)).plus(inThis.get(l.sourceLineId!) ?? 0);
    const remaining = origQty.get(l.sourceLineId!)!.minus(used);
    if (dec(l.quantity).gt(remaining)) {
      throw unprocessable(
        `Satır ${l.lineNo}: iade miktarı (${dec(l.quantity).toFixed(4)}) iade edilebilir kalan miktarı (${remaining.toFixed(4)}) aşıyor`,
        'RETURN_QTY_EXCEEDED',
        { lineNo: l.lineNo, remaining: remaining.toFixed(4) },
      );
    }
    inThis.set(l.sourceLineId!, (inThis.get(l.sourceLineId!) ?? dec(0)).plus(l.quantity));
  }
}

async function defaultWarehouseId(tx: Tx): Promise<string> {
  const [w] = await tx.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isDefault, true));
  if (!w) throw unprocessable('Varsayılan depo tanımlı değil', 'WAREHOUSE_REQUIRED');
  return w.id;
}

/** Stoklu satır varsa kullanılacak depo: başlıktaki, yoksa orijinal faturanınki, yoksa varsayılan. */
export async function resolveWarehouse(tx: Tx, requested: string | null | undefined, original?: { warehouseId: string | null } | null) {
  return requireActiveWarehouse(tx, requested ?? original?.warehouseId ?? (await defaultWarehouseId(tx)), 'Depo');
}

type DraftInput = Omit<CreateInvoiceInput, 'type' | 'post'> | Omit<UpdateInvoiceInput, 'post'>;

async function writeDraft(tx: Tx, ctx: InvoiceCtx, type: InvoiceType, input: DraftInput, id?: string) {
  const party = await loadParty(tx, input.partyId, type);
  const currency = input.currency ?? party.currencyCode;
  const { lines, totals } = await prepareLines(tx, type, input.invoiceDate, input.lines, input.vatIncluded);
  const original = await checkReturnLink(tx, type, party.id, input.returnOfId, lines);
  if (original) await checkReturnQuantities(tx, original.id, lines, id);

  const stockLines = lines.some((l) => l.isStock);
  if (input.warehouseId) await requireActiveWarehouse(tx, input.warehouseId, 'Depo');

  const header = {
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate ?? null,
    externalNo: input.externalNo ?? null,
    partyId: party.id,
    currencyCode: currency,
    fxRate: currency === ctx.baseCurrency ? null : input.fxRate ? toDbRate(input.fxRate) : null,
    vatIncluded: input.vatIncluded,
    warehouseId: stockLines ? (input.warehouseId ?? original?.warehouseId ?? null) : null,
    returnOfId: original?.id ?? null,
    description: input.description ?? null,
    netTotal: toDbAmount(totals.net),
    vatTotal: toDbAmount(totals.vat),
    grossTotal: toDbAmount(totals.gross),
    updatedAt: new Date(),
  };

  let invoiceId = id;
  if (invoiceId) {
    await tx.update(invoices).set(header).where(eq(invoices.id, invoiceId));
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  } else {
    const [row] = await tx
      .insert(invoices)
      .values({ ...header, companyId: ctx.companyId, type, createdBy: ctx.userId })
      .returning({ id: invoices.id });
    invoiceId = row!.id;
  }
  await tx.insert(invoiceLines).values(
    lines.map((l) => ({
      companyId: ctx.companyId,
      invoiceId: invoiceId!,
      lineNo: l.lineNo,
      itemId: l.itemId,
      description: l.description,
      quantity: dec(l.quantity).toFixed(4),
      unit: l.unit,
      unitPrice: dec(l.unitPrice).toFixed(6),
      discountPct: dec(l.discountPct).toFixed(4),
      vatCode: l.vatCode,
      vatRate: l.vatRate,
      net: toDbAmount(l.net),
      vat: toDbAmount(l.vat),
      gross: toDbAmount(l.gross),
      accountId: l.accountId,
      sourceLineId: l.sourceLineId,
    })),
  );
  return invoiceId;
}

export async function createInvoiceDraft(tx: Tx, ctx: InvoiceCtx, input: CreateInvoiceInput) {
  return writeDraft(tx, ctx, input.type, input);
}

async function getDraftRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id));
  if (!row) throw notFound('Fatura');
  if (row.status !== 'draft') throw unprocessable('Yalnızca taslak fatura düzenlenebilir', 'INVOICE_NOT_DRAFT');
  return row;
}

export async function updateInvoiceDraft(tx: Tx, ctx: InvoiceCtx, id: string, input: UpdateInvoiceInput) {
  const row = await getDraftRow(tx, id);
  await writeDraft(tx, ctx, row.type as InvoiceType, input, id);
  return id;
}

export async function deleteInvoiceDraft(tx: Tx, id: string) {
  await getDraftRow(tx, id);
  await tx.delete(invoices).where(eq(invoices.id, id));
}

interface HeadRow extends Record<string, unknown> {
  id: string;
  type: InvoiceType;
  status: string;
  invoiceNo: string | null;
  externalNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  currencyCode: string;
  fxRate: string | null;
  vatIncluded: boolean;
  warehouseId: string | null;
  warehouseName: string | null;
  returnOfId: string | null;
  returnOfNo: string | null;
  description: string | null;
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  netTotalBase: string | null;
  vatTotalBase: string | null;
  grossTotalBase: string | null;
  journalEntryId: string | null;
  journalEntryNo: string | null;
  stockDocumentId: string | null;
  stockDocumentNo: string | null;
  postedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNo: string | null;
  cancelStockDocumentId: string | null;
  createdAt: Date;
}

interface LineRowOut extends Record<string, unknown> {
  id: string;
  lineNo: number;
  itemId: string | null;
  itemCode: string | null;
  itemKind: string | null;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountPct: string;
  vatCode: string | null;
  vatRate: string;
  net: string;
  vat: string;
  gross: string;
  accountId: string | null;
  accountCode: string | null;
  sourceLineId: string | null;
  netBase: string | null;
  vatBase: string | null;
  costValue: string | null;
}

export async function getInvoice(tx: Tx, id: string) {
  const head = await tx.execute<HeadRow>(sql`
    select i.id, i.type, i.status, i.invoice_no as "invoiceNo", i.external_no as "externalNo",
           i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate",
           i.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           i.currency_code as "currencyCode", i.fx_rate as "fxRate", i.vat_included as "vatIncluded",
           i.warehouse_id as "warehouseId", w.name as "warehouseName",
           i.return_of_id as "returnOfId", ro.invoice_no as "returnOfNo", i.description,
           i.net_total as "netTotal", i.vat_total as "vatTotal", i.gross_total as "grossTotal",
           i.net_total_base as "netTotalBase", i.vat_total_base as "vatTotalBase", i.gross_total_base as "grossTotalBase",
           i.journal_entry_id as "journalEntryId", je.entry_no as "journalEntryNo",
           i.stock_document_id as "stockDocumentId", sd.doc_no as "stockDocumentNo",
           i.posted_at as "postedAt", i.cancelled_at as "cancelledAt", i.cancel_reason as "cancelReason",
           i.cancel_journal_entry_id as "cancelJournalEntryId", cje.entry_no as "cancelJournalEntryNo",
           i.cancel_stock_document_id as "cancelStockDocumentId", i.created_at as "createdAt"
    from invoices i
    join parties p on p.id = i.party_id
    left join warehouses w on w.id = i.warehouse_id
    left join invoices ro on ro.id = i.return_of_id
    left join journal_entries je on je.id = i.journal_entry_id
    left join stock_documents sd on sd.id = i.stock_document_id
    left join journal_entries cje on cje.id = i.cancel_journal_entry_id
    where i.id = ${id}`);
  const invoice = head.rows[0];
  if (!invoice) throw notFound('Fatura');

  const lines = await tx.execute<LineRowOut>(sql`
    select l.id, l.line_no as "lineNo", l.item_id as "itemId", it.code as "itemCode", it.kind as "itemKind",
           l.description, l.quantity, l.unit, l.unit_price as "unitPrice", l.discount_pct as "discountPct",
           l.vat_code as "vatCode", l.vat_rate as "vatRate", l.net, l.vat, l.gross,
           l.account_id as "accountId", a.code as "accountCode", l.source_line_id as "sourceLineId",
           l.net_base as "netBase", l.vat_base as "vatBase", l.cost_value as "costValue"
    from invoice_lines l
    left join items it on it.id = l.item_id
    left join accounts a on a.id = l.account_id
    where l.invoice_id = ${id}
    order by l.line_no`);

  // Satış/alış faturasında satır başına iade edilen ve iade edilebilir kalan miktar
  const meta = INVOICE_TYPE_META[invoice.type];
  const canReturn = !meta.isReturn && invoice.status === 'posted' && invoice.type !== 'expense';
  const returned = canReturn ? await returnedTotals(tx, id) : new Map<string, { qty: MoneyValue; cost: MoneyValue }>();
  const returns = await tx
    .select({ id: invoices.id, invoiceNo: invoices.invoiceNo, status: invoices.status, type: invoices.type })
    .from(invoices)
    .where(eq(invoices.returnOfId, id))
    .orderBy(asc(invoices.createdAt));

  return {
    invoice,
    lines: lines.rows.map((l) => {
      const r = returned.get(l.id);
      return {
        ...l,
        returnedQty: canReturn ? toDbAmount(r?.qty ?? 0) : null,
        returnableQty: canReturn ? toDbAmount(dec(l.quantity).minus(r?.qty ?? 0)) : null,
      };
    }),
    returns,
  };
}

export async function listInvoices(tx: Tx, q: ListInvoicesQuery) {
  const conds: SQL[] = [];
  if (q.side) conds.push(sql`i.type in (${sql.join(sideTypes(q.side).map((t) => sql`${t}`), sql`, `)})`);
  if (q.type) conds.push(sql`i.type = ${q.type}`);
  if (q.status) conds.push(sql`i.status = ${q.status}`);
  if (q.partyId) conds.push(sql`i.party_id = ${q.partyId}`);
  if (q.from) conds.push(sql`i.invoice_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`i.invoice_date <= ${q.to}::date`);
  if (q.query) conds.push(trContains(["coalesce(i.invoice_no, '')", "coalesce(i.external_no, '')", 'p.name', 'p.code'], q.query));
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select i.id, i.type, i.status, i.invoice_no as "invoiceNo", i.external_no as "externalNo",
           i.invoice_date::text as "invoiceDate", i.due_date::text as "dueDate",
           i.party_id as "partyId", p.code as "partyCode", p.name as "partyName",
           i.currency_code as "currencyCode", i.net_total as "netTotal", i.vat_total as "vatTotal",
           i.gross_total as "grossTotal", i.gross_total_base as "grossTotalBase",
           i.return_of_id as "returnOfId", i.description
    from invoices i join parties p on p.id = i.party_id
    ${where}
    order by i.invoice_date desc, i.invoice_no desc nulls first, i.created_at desc
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n from invoices i join parties p on p.id = i.party_id ${where}`);
  return { invoices: rows.rows, total: total.rows[0]?.n ?? 0 };
}

const sideTypes = (side: 'sales' | 'purchases'): InvoiceType[] =>
  (Object.keys(INVOICE_TYPE_META) as InvoiceType[]).filter((t) => INVOICE_TYPE_META[t].side === side);

/** Aynı tedarikçiden aynı fatura numarası daha önce işlenmiş mi? */
export async function assertExternalNoFree(tx: Tx, partyId: string, externalNo: string, exceptId: string) {
  const [dup] = await tx
    .select({ id: invoices.id, invoiceNo: invoices.invoiceNo })
    .from(invoices)
    .where(and(eq(invoices.partyId, partyId), eq(invoices.externalNo, externalNo), sql`${invoices.status} <> 'draft'`, sql`${invoices.id} <> ${exceptId}`));
  if (dup) {
    throw conflict(`Bu cariden ${externalNo} numaralı fatura zaten işlenmiş (${dup.invoiceNo})`, 'EXTERNAL_NO_TAKEN');
  }
}

