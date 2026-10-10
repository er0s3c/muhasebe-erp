import { asc, eq, sql } from 'drizzle-orm';
import { enqueueInvoiceWebhook } from '../platform-integrations/events';
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
import { lineSerials } from '../inventory/serials';
import { insertDocument, loadStockableItems, reverseStockDocument, type StockCtx } from '../inventory/documents';
import { StockPlanner, type DraftRow } from '../inventory/planner';
import { createJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { requireItemMappings } from '../inventory/accounting';
import { accruedDeliveryLines, cancelAccruedPurchase, effectiveReturnValue, lockLeatherCosts, recognizeDeliverySale, reverseAllocatedJournalCosts, settleAccruedPurchase, traceStockDocument, unrecognizeDeliverySale } from '../leather/costs';
import { reverseCustomDepositForInvoice } from '../leather/advanced';
import { describeSettlements, entrySettlements } from '../parties/service';
import { nextDocumentNumber } from '../settings/numbering';
import { assertDocumentApproved } from '../approvals/document-gate';
import { invoiceApprovalSnapshot } from '../approvals/source-snapshot';
import { requireOpenPeriod } from '../settings/periods';
import { lookupRate } from '../settings/rates';
import { assertMatchOrOverride, evaluateInvoiceMatch } from '../procurement/matching';
import { checkOrderLinks, lockOrderLines } from '../sales/usage';
import { DeliveryAllocator } from './delivery-link';
import { buildInvoiceJournal, requiredMappingKeys } from './journal';
import {
  assertExternalNoFree,
  getInvoice,
  invoiceTaxTotals,
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
  await lockLeatherCosts(tx, ctx.companyId);
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
      taxRuleId: l.taxRuleId,
      productClass: l.productClass,
      transactionType: l.transactionType as LineSource['transactionType'],
      accountId: l.accountId,
      sourceLineId: l.sourceLineId,
      deliveryLineId: l.deliveryLineId,
      orderLineId: l.poLineId,
      salesOrderLineId: l.salesOrderLineId,
      projectId: l.projectId,
      wbsId: l.wbsId,
    })),
    inv.vatIncluded,
    ctx.companyId,
    party.id,
  );
  if (totals.gross.isZero()) throw unprocessable('Fatura tutarı sıfır olamaz', 'INVOICE_TOTAL_ZERO');

  // Üçlü eşleştirme: sipariş bağlı satırlar kilit altında (id sırasıyla) sipariş ve mal kabulle karşılaştırılır
  const poIds = [...new Set(lines.map((l) => l.orderLineId).filter((v): v is string => !!v))].sort();
  if (poIds.length > 0) {
    for (const pid of poIds) await tx.execute(sql`select 1 from purchase_order_lines where id = ${pid} for update`);
    const rows = await evaluateInvoiceMatch(tx, lines.map((l) => ({ lineNo: l.lineNo, poLineId: l.orderLineId, quantity: l.quantity, net: l.net })), inv.id);
    assertMatchOrOverride(rows, inv.matchOverrideReason);
  }

  const original = inv.returnOfId ? await lockInvoice(tx, inv.returnOfId) : null;
  const savedOriginalFx = original?.fxSnapshot;
  const fxLookup = await lookupRate(tx, inv.currencyCode, ctx.baseCurrency, inv.invoiceDate, ctx.baseCurrency, inv.fxRateType ? { rateType: inv.fxRateType as import('@erp/shared').FxRateType } : { legacyInverse: true });
  const fx = original && savedOriginalFx && original.currencyCode === inv.currencyCode ? dec(original.fxRate!) : inv.currencyCode === ctx.baseCurrency ? dec(1) : inv.fxRate ? dec(inv.fxRate) : fxLookup.rate ? dec(fxLookup.rate) : null;
  if (!fx) throw unprocessable(`${inv.currencyCode}/${ctx.baseCurrency} kuru ${inv.invoiceDate} tarihinde seçilen türde bulunamadı`, 'FX_RATE_MISSING');
  const fxSnapshot: import('@erp/shared').FinancialFxSnapshot = original && savedOriginalFx && original.currencyCode === inv.currencyCode
    ? { ...savedOriginalFx, originalInvoiceId: original.id }
    : inv.fxRate && inv.currencyCode !== ctx.baseCurrency
      ? { ...fxLookup, rate: toDbRate(fx), rateDate: inv.invoiceDate, source: 'Manuel işlem kuru', provider: 'manual', sourceUrl: null, method: 'manual', legs: [], manualReason: inv.fxReason ?? null }
      : fxLookup;
  if (fx.lte(0)) throw unprocessable('Kur sıfırdan büyük olmalı', 'FX_RATE_INVALID');
  const approvalProof = await invoiceApprovalSnapshot(tx, ctx, inv, stored, lines, fx);
  await assertDocumentApproved(tx, 'invoice', id, approvalProof.amount, approvalProof.hash, approvalProof.projectId);

  const netBase = lines.map((l) => applyRate(l.net, fx));
  const vatBase = lines.map((l) => applyRate(l.vat, fx));

  // İade bağı: orijinal faturayı kilitle, kalan miktarı kilit altında yeniden doğrula
  if (original && original.status !== 'posted') {
    throw unprocessable('Orijinal fatura artık kaydedilmiş durumda değil', 'RETURN_ORIGINAL_NOT_POSTED');
  }
  if (original && lines.some(line => line.taxRuleSnapshot) && (original.vatIncluded !== inv.vatIncluded || original.currencyCode !== inv.currencyCode))
    throw unprocessable('Vergi kurallı iade özgün faturanın para birimi ve KDV dahil/hariç seçimini kullanmalı', 'RETURN_TAX_DOCUMENT');
  if (original && lines.some(line => line.taxCalculation)) {
    const sourceTax = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, original.id));
    const previousTax = await tx.execute<{ sourceId: string; qty: string; vatWithheld: string; incomeWithheld: string; stamp: string }>(sql`
      select l.source_line_id as "sourceId", sum(l.quantity)::text as qty,
        coalesce(sum((l.tax_calculation->>'vatWithheld')::numeric),0)::text as "vatWithheld",
        coalesce(sum((l.tax_calculation->>'incomeWithheld')::numeric),0)::text as "incomeWithheld",
        coalesce(sum((l.tax_calculation->>'stamp')::numeric),0)::text as stamp
      from invoice_lines l join invoices i on i.id=l.invoice_id
      where i.return_of_id=${original.id} and i.status='posted' and i.id<>${inv.id} and l.source_line_id is not null
      group by l.source_line_id`);
    const previous = new Map(previousTax.rows.map(row => [row.sourceId, row]));
    const sources = new Map(sourceTax.map(row => [row.id, row]));
    for (const l of lines) {
      if (!l.sourceLineId || !l.taxCalculation) continue;
      const source = sources.get(l.sourceLineId);
      if (!source?.taxCalculation) continue;
      const before = previous.get(l.sourceLineId) ?? { sourceId: l.sourceLineId, qty: '0', vatWithheld: '0', incomeWithheld: '0', stamp: '0' };
      const originalTax = source.taxCalculation;
      const calculation = l.taxCalculation;
      if (dec(l.quantity).eq(dec(source.quantity).minus(before.qty))) {
        calculation.vatWithheld = dec(originalTax.vatWithheld).minus(before.vatWithheld).toFixed(2);
        calculation.incomeWithheld = dec(originalTax.incomeWithheld).minus(before.incomeWithheld).toFixed(2);
        calculation.stamp = dec(originalTax.stamp).minus(before.stamp).toFixed(2);
        calculation.vatPayableToSeller = l.vat.minus(calculation.vatWithheld).toFixed(2);
        calculation.payableToSeller = l.gross.minus(calculation.vatWithheld).minus(calculation.incomeWithheld).toFixed(2);
      }
      previous.set(l.sourceLineId, { sourceId: l.sourceLineId, qty: dec(before.qty).plus(l.quantity).toFixed(4), vatWithheld: toDbAmount(dec(before.vatWithheld).plus(calculation.vatWithheld)), incomeWithheld: toDbAmount(dec(before.incomeWithheld).plus(calculation.incomeWithheld)), stamp: toDbAmount(dec(before.stamp).plus(calculation.stamp)) });
    }
  }
  const returned = original ? await returnedTotals(tx, original.id, inv.id) : new Map<string, { qty: MoneyValue; cost: MoneyValue }>();
  const sourceById = new Map<string, { quantity: MoneyValue; cost: MoneyValue | null; lineNo: number }>();
  if (original) {
    const src = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, original.id));
    for (const s of src) sourceById.set(s.id, { quantity: dec(s.quantity), cost: s.costValue === null ? null : dec(s.costValue), lineNo: s.lineNo });
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
  const originalTargets: Record<number, string> = {};
  if (original && type === 'sales_return') {
    const perTarget = new Map<string, { qty: MoneyValue; value: MoneyValue }>();
    for (const l of lines.filter(l => l.sourceLineId)) {
      const target = `sale:invoice:${original.id}:${sourceById.get(l.sourceLineId!)!.lineNo}`;
      originalTargets[l.lineNo] = target;
      const used = perTarget.get(target) ?? {qty: dec(0), value: dec(0)};
      const cumulative = await effectiveReturnValue(tx, target, used.qty.plus(l.quantity).toFixed(4));
      if (cumulative !== null) {
        returnValueByLine.set(l.lineNo, dec(cumulative).minus(used.value));
        perTarget.set(target, {qty: used.qty.plus(l.quantity), value: dec(cumulative)});
      } else delete originalTargets[l.lineNo];
    }
  }

  // İrsaliye bağı: irsaliye satırlarını kilitle, bağları yeniden doğrula, paylaşılan değerleri dağıt
  const allocator = await DeliveryAllocator.lock(tx, type, party.id, lines, inv.id);
  // Satış siparişi bağı: sipariş satırlarını kilitle, kalan miktarı kilit altında yeniden doğrula
  await lockOrderLines(tx, lines.flatMap((l) => (l.salesOrderLineId ? [l.salesOrderLineId] : [])));
  await checkOrderLinks(
    tx,
    'invoice',
    party.id,
    lines.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, quantity: l.quantity, salesOrderLineId: l.salesOrderLineId, deliveryLineId: l.deliveryLineId })),
    { currency: inv.currencyCode },
  );

  // --- Stok (saf planlama; yazma aşağıda) ---
  // İrsaliyeye bağlı satır stok hareketi yapmaz (mal irsaliyede çıktı/girdi). Alışta fatura fiyatı irsaliye
  // değerinden farklıysa fark, elde kalan miktar payı kadar stok maliyetine (`cost_adjust`), kalanı satılan
  // mal maliyetine (621) gider; irsaliyenin eksi bakiye kapanış düzeltmesi de burada 621'e aktarılır.
  const stockLines = lines.filter((l) => l.isStock);
  const directStock = stockLines.filter((l) => !l.deliveryLineId);
  const accrued = type === 'purchase' ? await accruedDeliveryLines(tx, stockLines.flatMap(l => l.deliveryLineId ? [l.deliveryLineId] : [])) : new Set<string>();
  const linkedPurchase = stockLines.filter((l) => l.deliveryLineId && type === 'purchase' && !accrued.has(l.deliveryLineId));
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
        // Satış, satış iadesi ve alış iadesi: stok hareketi irsaliyede yapılmıştır; maliyet irsaliye satırının payıdır
        if (type !== 'purchase') {
          const recognized = type === 'sales' ? await recognizeDeliverySale(tx, stockCtx(ctx), l.deliveryLineId, inv.id, l.lineNo, l.quantity, inv.invoiceDate) : null;
          costByLine.set(l.lineNo, recognized === null ? share.value : dec(recognized));
          continue;
        }
        if (accrued.has(l.deliveryLineId)) {
          costByLine.set(l.lineNo, netBase[idx]!);
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
  const accruedSettlement = type === 'purchase'
    ? await settleAccruedPurchase(tx, stockCtx(ctx), {invoiceId: inv.id, date: inv.invoiceDate, lines: stockLines.flatMap(l => l.deliveryLineId && accrued.has(l.deliveryLineId) ? [{lineNo:l.lineNo, deliveryLineId:l.deliveryLineId, quantity:l.quantity, netBase:netBase[l.lineNo-1]!.toFixed(2)}] : [])})
    : {journalLines: [], handledLineNos: new Set<number>()};
  const itemMapping = await requireItemMappings(tx, stockLines.map(l => l.itemId!));
  const mapping = await requireMappings(
    tx,
    requiredMappingKeys(type, {
      hasStock: stockLines.length > 0, hasStockAdjust: !stockAdjust.isZero(),
      hasVatWithholding: lines.some(line => dec(line.taxCalculation?.vatWithheld ?? 0).gt(0)),
      hasIncomeWithholding: lines.some(line => dec(line.taxCalculation?.incomeWithheld ?? 0).gt(0)),
      hasStamp: lines.some(line => line.taxRuleSnapshot?.config.stampLiability === 'company' && dec(line.taxCalculation?.stamp ?? 0).gt(0)),
    }),
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
      vatWithheld: dec(l.taxCalculation?.vatWithheld ?? 0),
      vatWithheldBase: applyRate(l.taxCalculation?.vatWithheld ?? '0', fx),
      incomeWithheld: dec(l.taxCalculation?.incomeWithheld ?? 0),
      incomeWithheldBase: applyRate(l.taxCalculation?.incomeWithheld ?? '0', fx),
      stampCompany: dec(l.taxRuleSnapshot?.config.stampLiability === 'company' ? l.taxCalculation?.stamp ?? 0 : 0),
      stampCompanyBase: applyRate(l.taxRuleSnapshot?.config.stampLiability === 'company' ? l.taxCalculation?.stamp ?? '0' : '0', fx),
      accountId: l.accountId,
      isStock: l.isStock,
      ...(l.itemId ? itemMapping.get(l.itemId) : {}),
      accruedPurchase: accruedSettlement.handledLineNos.has(l.lineNo),
      costValue: costByLine.get(l.lineNo) ?? dec(0),
      projectId: l.projectId,
      wbsId: l.wbsId,
    })),
  });
  built.lines.push(...accruedSettlement.journalLines);

  // --- Yazma: fatura numarası → stok belgesi → yevmiye → satırlar → fatura ---
  const year = isoYear(inv.invoiceDate);
  const invoiceNo = await nextDocumentNumber(tx, ctx.companyId, `INV:${type}`, year, meta.prefix);
  const text = `${TYPE_LABEL[type]} ${invoiceNo} — ${party.name}`.slice(0, 300);

  let stockDocumentId: string | null = null;
  const serialMap = await lineSerials(tx, 'invoice', stored.map((l) => l.id));
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
      {
        intent: {
          byLine: new Map(stored.map((l) => [l.lineNo, serialMap.get(l.id) ?? []] as const)),
          partyId: party.id,
          returnKind: type === 'sales_return' ? 'return_in' : type === 'purchase_return' ? 'return_out' : undefined,
        },
      },
    );
    stockDocumentId = doc.id;
    await traceStockDocument(tx, stockCtx(ctx), doc, planRows, {movementKind:type, originalTargets});
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
        taxRuleId: l.taxRuleId,
        taxRuleSnapshot: l.taxRuleSnapshot,
        taxCalculation: l.taxCalculation,
        productClass: l.productClass,
        transactionType: l.transactionType,
        taxTreatment: l.taxTreatment,
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
      fxSnapshot,
      documentMetadata: { company: (await tx.execute<Record<string, unknown>>(sql`select name,tax_number as "taxNumber",tax_office as "taxOffice",jurisdiction,legal_entity_type as "legalEntityType" from companies where id=${ctx.companyId}`)).rows[0], party: { id: party.id, name: party.name, taxNumber: party.taxNumber, taxOffice: party.taxOffice, taxStatus: party.taxStatus, address: party.address }, originalInvoice: original ? { id: original.id, invoiceNo: original.invoiceNo, invoiceDate: original.invoiceDate } : null, capturedAt: new Date().toISOString() },
      warehouseId,
      netTotal: toDbAmount(totals.net),
      vatTotal: toDbAmount(totals.vat),
      grossTotal: toDbAmount(totals.gross),
      taxTotalsSnapshot: invoiceTaxTotals(lines, fx),
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
  await enqueueInvoiceWebhook(tx,id,'invoice.posted');
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
  await lockLeatherCosts(tx, ctx.companyId);
  const inv = await lockInvoice(tx, id);
  if (inv.status === 'cancelled') throw unprocessable('Fatura zaten iptal edilmiş', 'INVOICE_ALREADY_CANCELLED');
  if (inv.status !== 'posted') throw unprocessable('Yalnızca kaydedilmiş fatura iptal edilebilir', 'INVOICE_NOT_POSTED');
  if ((await tx.execute(sql`select id from pos_sales where invoice_id=${id}::uuid limit 1`)).rows.length) throw unprocessable('Mağaza satışının mali kayıtlarını POS iade/değişim akışından düzeltin','POS_INVOICE_PROTECTED');

  const active = await tx.execute<{ invoice_no: string }>(sql`
    select invoice_no from invoices where return_of_id = ${id} and status = 'posted' limit 1`);
  if (active.rows.length > 0) {
    throw unprocessable(`Bu faturaya ${active.rows[0]!.invoice_no} numaralı iade kesilmiş; önce iadeyi iptal edin`, 'INVOICE_HAS_RETURNS');
  }
  // Tahsil edilmiş/ödenmiş (eşleştirilmiş) fatura iptal edilemez: kapatma havada kalır, yaşlandırma defterden ayrışır (ACC-1)
  const settled = await entrySettlements(tx, inv.journalEntryId!);
  if (settled.length > 0) {
    throw unprocessable(
      `Bu fatura kapatılmış: ${describeSettlements(settled)}. Önce tahsilatı/ödemeyi iptal edin (Kasa/Banka > hareket > İptal); çek/senet ya da fesihle kapatıldıysa faturayı iptal etmek yerine iade faturası kesin`,
      'INVOICE_HAS_PAYMENTS',
    );
  }

  const date = input.date ?? todayIso();
  if (date < inv.invoiceDate) {
    throw unprocessable('İptal tarihi fatura tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_INVOICE');
  }
  await requireOpenPeriod(tx, date);

  await reverseCustomDepositForInvoice(tx, stockCtx(ctx), inv.id, date);
  await cancelAccruedPurchase(tx, stockCtx(ctx), inv.id, date);
  await reverseAllocatedJournalCosts(tx, stockCtx(ctx), inv.journalEntryId!, date);
  if (inv.type === 'sales') {
    const linked=(await tx.execute<{line_no:number;delivery_line_id:string;delivery_line_no:number;cost_value:string}>(sql`select l.line_no,l.delivery_line_id,d.line_no as delivery_line_no,l.cost_value from invoice_lines l join delivery_note_lines d on d.id=l.delivery_line_id where l.invoice_id=${id}::uuid`)).rows;
    for(const l of linked) await unrecognizeDeliverySale(tx,stockCtx(ctx),id,l.line_no,l.delivery_line_id,l.delivery_line_no,l.cost_value,date);
  }

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
