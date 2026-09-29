import { asc, eq, sql } from 'drizzle-orm';
import {
  EXTERNAL_NO_REQUIRED,
  INVOICE_TYPE_META,
  applyRate,
  dec,
  isoYear,
  roundMoney,
  todayIso,
  toDbAmount,
  toDbRate,
  type CancelInvoiceInput,
  type InvoiceType,
  type MoneyValue,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { invoiceLines, invoices } from '../../db/schema';
import { AppError, notFound, unprocessable } from '../../http/errors';
import { loadItemStates, loadWarehouseQty, lockItems } from '../inventory/balances';
import { insertDocument, loadStockableItems, reverseStockDocument, type StockCtx } from '../inventory/documents';
import { StockPlanner, type DraftRow } from '../inventory/planner';
import { createJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { DeliveryAllocator } from './delivery-link';
import { buildInvoiceJournal, requiredMappingKeys } from './journal';
import {
  assertExternalNoFree,
  getInvoice,
  loadParty,
  prepareLines,
  resolveWarehouse,
  returnedTotals,
  type InvoiceCtx,
  type LineSource,
  type PreparedLine,
} from './service';

const TYPE_LABEL: Record<InvoiceType, string> = {
  sales: 'Satış faturası',
  purchase: 'Alış faturası',
  expense: 'Gider faturası',
  sales_return: 'Satış iade faturası',
  purchase_return: 'Alış iade faturası',
};

const ledgerCtx = (c: InvoiceCtx): LedgerCtx => ({
  companyId: c.companyId,
  userId: c.userId,
  baseCurrency: c.baseCurrency,
  reportingCurrency: c.reportingCurrency,
});
const stockCtx = (c: InvoiceCtx): StockCtx => ({
  companyId: c.companyId,
  userId: c.userId,
  baseCurrency: c.baseCurrency,
  reportingCurrency: c.reportingCurrency,
  allowNegativeStock: c.allowNegativeStock,
});

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Kilitli fatura satırını okur (aynı faturanın çift kaydedilmesini/iptalini sıraya sokar). */
async function lockInvoice(tx: Tx, id: string) {
  const [row] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
  if (!row) throw notFound('Fatura');
  return row;
}

/**
 * Faturayı kaydeder: tek işlemde stok hareketi, yevmiye ve fatura durumu birlikte yazılır.
 * Sıra (kilit sırası ürünler → numaralar): kilitle → yeniden hesapla → stoku planla (saf) →
 * fatura numarası → stok belgesi → yevmiye → fatura. Herhangi bir adım başarısız olursa tümü geri alınır.
 */
export async function postInvoice(tx: Tx, ctx: InvoiceCtx, id: string) {
  const inv = await lockInvoice(tx, id);
  if (inv.status !== 'draft') throw unprocessable('Fatura zaten kaydedilmiş', 'INVOICE_NOT_DRAFT');
  const type = inv.type as InvoiceType;
  const meta = INVOICE_TYPE_META[type];
  const period = await requireOpenPeriod(tx, inv.invoiceDate);
  const party = await loadParty(tx, inv.partyId, type);

  if (EXTERNAL_NO_REQUIRED.includes(type) && !inv.externalNo) {
    throw unprocessable('Tedarikçi fatura numarası gerekli', 'EXTERNAL_NO_REQUIRED');
  }
  if (inv.externalNo) await assertExternalNoFree(tx, inv.partyId, inv.externalNo, inv.id);

  // Satırları yeniden hazırla: fatura tarihi/KDV oranı taslaktan sonra değişmiş olabilir
  const stored = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.lineNo));
  const { lines, totals } = await prepareLines(
    tx,
    type,
    inv.invoiceDate,
    stored.map((l) => ({
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit as LineSource['unit'],
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      vatCode: l.vatCode,
      accountId: l.accountId,
      sourceLineId: l.sourceLineId,
      deliveryLineId: l.deliveryLineId,
    })),
    inv.vatIncluded,
  );
  if (totals.gross.isZero()) throw unprocessable('Fatura tutarı sıfır olamaz', 'INVOICE_TOTAL_ZERO');

  const fx =
    inv.currencyCode === ctx.baseCurrency
      ? dec(1)
      : inv.fxRate
        ? dec(inv.fxRate)
        : await requireRate(tx, inv.currencyCode, ctx.baseCurrency, inv.invoiceDate, ctx.baseCurrency);
  if (fx.lte(0)) throw unprocessable('Kur sıfırdan büyük olmalı', 'FX_RATE_INVALID');

  const netBase = lines.map((l) => applyRate(l.net, fx));
  const vatBase = lines.map((l) => applyRate(l.vat, fx));

  // İade bağı: orijinal faturayı kilitle, kalan miktarı kilit altında yeniden doğrula
  const original = inv.returnOfId ? await lockInvoice(tx, inv.returnOfId) : null;
  if (original && original.status !== 'posted') {
    throw unprocessable('Orijinal fatura artık kaydedilmiş durumda değil', 'RETURN_ORIGINAL_NOT_POSTED');
  }
  const returned = original ? await returnedTotals(tx, original.id, inv.id) : new Map<string, { qty: MoneyValue; cost: MoneyValue }>();
  const sourceById = new Map<string, { quantity: MoneyValue; cost: MoneyValue | null }>();
  if (original) {
    const src = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, original.id));
    for (const s of src) sourceById.set(s.id, { quantity: dec(s.quantity), cost: s.costValue === null ? null : dec(s.costValue) });
  }
  const usedInThis = new Map<string, { qty: MoneyValue; cost: MoneyValue }>();
  const returnValue = (l: PreparedLine): MoneyValue | null => {
    if (!l.sourceLineId) return null;
    const src = sourceById.get(l.sourceLineId)!;
    const prev = returned.get(l.sourceLineId) ?? { qty: dec(0), cost: dec(0) };
    const mine = usedInThis.get(l.sourceLineId) ?? { qty: dec(0), cost: dec(0) };
    const remainingQty = src.quantity.minus(prev.qty).minus(mine.qty);
    const qty = dec(l.quantity);
    if (qty.gt(remainingQty)) {
      throw unprocessable(
        `Satır ${l.lineNo}: iade miktarı (${qty.toFixed(4)}) iade edilebilir kalan miktarı (${remainingQty.toFixed(4)}) aşıyor`,
        'RETURN_QTY_EXCEEDED',
        { lineNo: l.lineNo, remaining: remainingQty.toFixed(4) },
      );
    }
    // Orijinal satır stoksuzsa yalnızca miktar sınırı uygulanır (maliyet yok)
    // Kalan miktarın tamamı iade ediliyorsa kalan maliyetin tamamı gider (kuruş artığı kalmaz)
    const value =
      src.cost === null
        ? null
        : qty.eq(remainingQty)
          ? src.cost.minus(prev.cost).minus(mine.cost)
          : roundMoney(src.cost.times(qty).div(src.quantity));
    usedInThis.set(l.sourceLineId, { qty: mine.qty.plus(qty), cost: mine.cost.plus(value ?? 0) });
    return value;
  };
  // Miktar sınırı tüm bağlı satırlarda (stoklu/stoksuz, satış/alış iadesi) kilit altında denetlenir;
  // her satır için bir kez hesaplanır (aynı orijinal satıra bağlı satırlar birikir).
  const returnValueByLine = new Map<number, MoneyValue | null>();
  if (original) for (const l of lines) if (l.sourceLineId) returnValueByLine.set(l.lineNo, returnValue(l));

  // İrsaliye bağı: irsaliye satırlarını kilitle, bağları yeniden doğrula, paylaşılan değerleri dağıt
  const allocator = await DeliveryAllocator.lock(tx, type, party.id, lines, inv.id);

  // --- Stok (saf planlama; yazma aşağıda) ---
  // İrsaliyeye bağlı satır stok hareketi yapmaz (mal irsaliyede çıktı/girdi). Alışta fatura fiyatı irsaliye
  // değerinden farklıysa fark, elde kalan miktar payı kadar stok maliyetine (`cost_adjust`), kalanı satılan
  // mal maliyetine (621) gider; irsaliyenin eksi bakiye kapanış düzeltmesi de burada 621'e aktarılır.
  const stockLines = lines.filter((l) => l.isStock);
  const directStock = stockLines.filter((l) => !l.deliveryLineId);
  const linkedPurchase = stockLines.filter((l) => l.deliveryLineId && type === 'purchase');
  const planItemIds = [...new Set([...directStock, ...linkedPurchase].map((l) => l.itemId!))];
  let planRows: DraftRow[] = [];
  const costByLine = new Map<number, MoneyValue>();
  const deliveryShare = new Map<number, { value: MoneyValue; adjust: MoneyValue }>();
  let stockAdjust = dec(0);
  let warehouseId: string | null = null;
  if (stockLines.length > 0) {
    const wh = directStock.length > 0 ? await resolveWarehouse(tx, inv.warehouseId, original) : null;
    let planner: StockPlanner | null = null;
    if (planItemIds.length > 0) {
      const plannerItems = await loadStockableItems(tx, planItemIds);
      await lockItems(tx, planItemIds);
      const states = await loadItemStates(tx, planItemIds);
      const whQty = await loadWarehouseQty(tx, planItemIds, wh ? [wh.id] : []);
      planner = new StockPlanner(states, whQty, {
        allowNegative: ctx.allowNegativeStock,
        items: plannerItems,
        warehouseNames: new Map(wh ? [[wh.id, wh.name]] : []),
      });
    }
    const poolUsed = new Map<string, MoneyValue>();
    let reclass = dec(0);
    for (const l of stockLines) {
      const qty = dec(l.quantity);
      const idx = l.lineNo - 1;
      if (l.deliveryLineId) {
        const share = allocator.take(l.lineNo, l.deliveryLineId, qty);
        deliveryShare.set(l.lineNo, { value: share.value, adjust: share.adjust });
        if (type === 'sales') {
          costByLine.set(l.lineNo, share.value);
          continue;
        }
        const p = planner!;
        const invValue = netBase[idx]!;
        const variance = invValue.minus(share.value);
        const onHand = p.state(l.itemId!).qty;
        const pool = onHand.minus(poolUsed.get(l.itemId!) ?? 0);
        const usable = pool.lte(0) ? dec(0) : qty.lt(pool) ? qty : pool;
        poolUsed.set(l.itemId!, (poolUsed.get(l.itemId!) ?? dec(0)).plus(usable));
        const toStock = variance.isZero() ? dec(0) : usable.eq(qty) ? variance : roundMoney(variance.times(usable).div(qty));
        p.adjust(l.lineNo, l.itemId!, share.line.warehouseId, toStock, 'delivery_variance');
        reclass = reclass.plus(share.adjust).minus(variance.minus(toStock));
        costByLine.set(l.lineNo, invValue);
        continue;
      }
      const p = planner!;
      const before = p.rows.length;
      if (type === 'sales' || type === 'purchase_return') {
        p.issue(l.lineNo, l.itemId!, wh!.id, qty);
      } else if (type === 'purchase') {
        p.receipt(l.lineNo, l.itemId!, wh!.id, qty, netBase[idx]!, {
          currencyCode: inv.currencyCode,
          unitCost: l.net.div(qty).toFixed(6),
          fxRate: toDbRate(fx),
        });
      } else {
        // Satış iadesi: bağlıysa orijinal satışın maliyetiyle, değilse güncel referans maliyetle girer
        const value = returnValueByLine.get(l.lineNo) ?? null;
        if (value) p.receipt(l.lineNo, l.itemId!, wh!.id, qty, value);
        else p.surplus(l.lineNo, l.itemId!, wh!.id, qty);
      }
      costByLine.set(
        l.lineNo,
        p.rows.slice(before).filter((r) => r.kind === 'qty').reduce((s, r) => s.plus(r.value.abs()), dec(0)),
      );
    }
    planRows = planner?.rows ?? [];
    warehouseId = wh?.id ?? (planRows.length > 0 ? allocator.info.get(linkedPurchase[0]!.deliveryLineId!)!.warehouseId : null);
    // Yevmiyede envanterden satılan mal maliyetine aktarılacak tutar (eksi: envanter azalır):
    // bu faturanın kendi alışlarındaki eksi bakiye kapanışı + irsaliyeli alışların aktarımları.
    stockAdjust = planRows.filter((r) => r.kind === 'cost_adjust' && !r.tag).reduce((s, r) => s.plus(r.value), dec(0)).plus(reclass);
  }

  // --- Yevmiye satırları ---
  const mapping = await requireMappings(
    tx,
    requiredMappingKeys(type, { hasStock: stockLines.length > 0, hasStockAdjust: !stockAdjust.isZero() }),
  );
  const dueDate = inv.dueDate ?? addDays(inv.invoiceDate, party.paymentTermDays);
  const built = buildInvoiceJournal({
    type,
    baseCurrency: ctx.baseCurrency,
    currency: inv.currencyCode,
    fx,
    partyId: party.id,
    dueDate,
    mapping,
    stockAdjust,
    lines: lines.map((l, i) => ({
      net: l.net,
      vat: l.vat,
      netBase: netBase[i]!,
      vatBase: vatBase[i]!,
      vatRate: l.vatRate,
      accountId: l.accountId,
      isStock: l.isStock,
      costValue: costByLine.get(l.lineNo) ?? dec(0),
    })),
  });

  // --- Yazma: fatura numarası → stok belgesi → yevmiye → satırlar → fatura ---
  const year = isoYear(inv.invoiceDate);
  const seq = await nextNumber(tx, ctx.companyId, `INV:${type}`, year);
  const invoiceNo = formatDocumentNumber(meta.prefix, year, seq);
  const text = `${TYPE_LABEL[type]} ${invoiceNo} — ${party.name}`.slice(0, 300);

  let stockDocumentId: string | null = null;
  if (planRows.length > 0) {
    const doc = await insertDocument(
      tx,
      stockCtx(ctx),
      period.id,
      {
        docDate: inv.invoiceDate,
        type: type === 'sales' || type === 'purchase_return' ? 'issue' : 'receipt',
        warehouseId: warehouseId!,
        description: `${TYPE_LABEL[type]} ${invoiceNo}`,
        sourceType: 'invoice',
        sourceId: inv.id,
      },
      planRows,
    );
    stockDocumentId = doc.id;
  }

  const entry = await createJournalEntry(
    tx,
    ledgerCtx(ctx),
    { entryDate: inv.invoiceDate, description: text, lines: built.lines, post: true },
    { source: { type: 'invoice', id: inv.id } },
  );

  for (const [i, l] of lines.entries()) {
    const stockLine = stored[i]!;
    await tx
      .update(invoiceLines)
      .set({
        unit: l.unit,
        vatCode: l.vatCode,
        vatRate: l.vatRate,
        net: toDbAmount(l.net),
        vat: toDbAmount(l.vat),
        gross: toDbAmount(l.gross),
        netBase: toDbAmount(netBase[i]!),
        vatBase: toDbAmount(vatBase[i]!),
        costValue: l.isStock ? toDbAmount(costByLine.get(l.lineNo) ?? 0) : null,
        deliveryValue: deliveryShare.has(l.lineNo) ? toDbAmount(deliveryShare.get(l.lineNo)!.value) : null,
        deliveryAdjust: deliveryShare.has(l.lineNo) ? toDbAmount(deliveryShare.get(l.lineNo)!.adjust) : null,
      })
      .where(eq(invoiceLines.id, stockLine.id));
  }

  const sumBase = (xs: MoneyValue[]) => xs.reduce((s, x) => s.plus(x), dec(0));
  await tx
    .update(invoices)
    .set({
      status: 'posted',
      invoiceNo,
      dueDate,
      fxRate: toDbRate(fx),
      warehouseId,
      netTotal: toDbAmount(totals.net),
      vatTotal: toDbAmount(totals.vat),
      grossTotal: toDbAmount(totals.gross),
      netTotalBase: toDbAmount(sumBase(netBase)),
      vatTotalBase: toDbAmount(sumBase(vatBase)),
      grossTotalBase: toDbAmount(built.grossBase),
      journalEntryId: entry.id,
      stockDocumentId,
      postedAt: new Date(),
      postedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, id));

  const result = await getInvoice(tx, id);
  return { ...result, warnings: await creditLimitWarning(tx, type, party.id, party.creditLimit) };
}

/** Müşteri kredi limiti aşıldıysa bilgi verir (engellemez). */
async function creditLimitWarning(tx: Tx, type: InvoiceType, partyId: string, limit: string | null) {
  if (type !== 'sales' || limit === null) return { creditLimit: null };
  const r = await tx.execute<{ balance: string }>(sql`
    select coalesce(sum(l.debit_base - l.credit_base), 0) as balance
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    join accounts a on a.id = l.account_id
    where l.party_id = ${partyId} and a.party_control = 'receivable'`);
  const balance = dec(r.rows[0]?.balance ?? 0);
  return balance.gt(limit) ? { creditLimit: { limit: toDbAmount(limit), balance: toDbAmount(balance) } } : { creditLimit: null };
}

/**
 * Faturayı iptal eder (ters kayıt): stok belgesi ve yevmiye ters çevrilir, fatura numarası serinin
 * parçası olarak kalır. Faturadan sonra aynı ürünlerde stok hareketi varsa ya da faturaya iade
 * kesilmişse iptal edilemez; o durumda iade faturası kesilir.
 */
export async function cancelInvoice(tx: Tx, ctx: InvoiceCtx, id: string, input: CancelInvoiceInput) {
  const inv = await lockInvoice(tx, id);
  if (inv.status === 'cancelled') throw unprocessable('Fatura zaten iptal edilmiş', 'INVOICE_ALREADY_CANCELLED');
  if (inv.status !== 'posted') throw unprocessable('Yalnızca kaydedilmiş fatura iptal edilebilir', 'INVOICE_NOT_POSTED');

  const active = await tx.execute<{ invoice_no: string }>(sql`
    select invoice_no from invoices where return_of_id = ${id} and status = 'posted' limit 1`);
  if (active.rows.length > 0) {
    throw unprocessable(`Bu faturaya ${active.rows[0]!.invoice_no} numaralı iade kesilmiş; önce iadeyi iptal edin`, 'INVOICE_HAS_RETURNS');
  }

  const date = input.date ?? todayIso();
  if (date < inv.invoiceDate) {
    throw unprocessable('İptal tarihi fatura tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_INVOICE');
  }
  await requireOpenPeriod(tx, date);

  let cancelStockDocumentId: string | null = null;
  if (inv.stockDocumentId) {
    try {
      const rev = await reverseStockDocument(
        tx,
        stockCtx(ctx),
        inv.stockDocumentId,
        { docDate: date, description: `İptal: ${inv.invoiceNo}` },
        true,
      );
      cancelStockDocumentId = rev.document.id;
    } catch (e) {
      if (e instanceof AppError && e.code === 'STOCK_DOC_HAS_LATER_MOVEMENTS') {
        throw unprocessable(
          `${e.message.split(' kartında')[0]} kartında bu faturadan sonra stok hareketi var; fatura iptal edilemez, iade faturası kesin`,
          'INVOICE_CANCEL_BLOCKED',
        );
      }
      throw e;
    }
  }

  const reversal = await reverseJournalEntry(tx, ledgerCtx(ctx), inv.journalEntryId!, {
    entryDate: date,
    description: `Fatura iptali: ${inv.invoiceNo} — ${input.reason}`.slice(0, 300),
    source: { type: 'invoice', id: inv.id },
  });

  await tx
    .update(invoices)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.userId,
      cancelReason: input.reason,
      cancelJournalEntryId: reversal.id,
      cancelStockDocumentId,
      updatedAt: new Date(),
    })
    .where(eq(invoices.id, id));
  return getInvoice(tx, id);
}
