import { eq, sql } from 'drizzle-orm';
import {
  DELIVERY_NOTE_TYPE_META,
  dec,
  isoYear,
  roundMoney,
  todayIso,
  toDbAmount,
  toDbRate,
  type CancelDeliveryNoteInput,
  type DeliveryNoteType,
  type MoneyValue,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { deliveryNoteLines, deliveryNotes } from '../../db/schema';
import { AppError, notFound, unprocessable } from '../../http/errors';
import { loadItemStates, loadWarehouseQty, lockItems } from '../inventory/balances';
import { insertDocument, loadStockableItems, reverseStockDocument, type StockCtx } from '../inventory/documents';
import { StockPlanner } from '../inventory/planner';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { requireActiveWarehouse } from '../inventory/warehouses';
import { assertExternalNoFree, getDeliveryNote, loadParty, orderedLines, type DeliveryCtx } from './service';

const TYPE_LABEL: Record<DeliveryNoteType, string> = {
  sales: 'Satış irsaliyesi',
  purchase: 'Alış irsaliyesi',
};

const stockCtx = (c: DeliveryCtx): StockCtx => ({
  companyId: c.companyId,
  userId: c.userId,
  baseCurrency: c.baseCurrency,
  reportingCurrency: c.reportingCurrency,
  allowNegativeStock: c.allowNegativeStock,
});

/** Kilitli irsaliye satırını okur (aynı irsaliyenin çift kaydedilmesini/iptalini sıraya sokar). */
async function lockNote(tx: Tx, id: string) {
  const [row] = await tx.select().from(deliveryNotes).where(eq(deliveryNotes.id, id)).for('update');
  if (!row) throw notFound('İrsaliye');
  return row;
}

/**
 * İrsaliyeyi kaydeder: stok defterini hareket ettirir (satışta çıkış ortalama maliyetle, alışta giriş).
 * Yevmiye YAZILMAZ: muhasebe kaydı fatura kesilince oluşur; bekleyen irsaliyeler stok mutabakatında
 * açıklanan fark olarak görünür. Kilit sırası: irsaliye → ürünler → numaralar.
 */
export async function postDeliveryNote(tx: Tx, ctx: DeliveryCtx, id: string) {
  const note = await lockNote(tx, id);
  if (note.status !== 'draft') throw unprocessable('İrsaliye zaten kaydedilmiş', 'DELIVERY_NOT_DRAFT');
  const type = note.type as DeliveryNoteType;
  const meta = DELIVERY_NOTE_TYPE_META[type];
  const period = await requireOpenPeriod(tx, note.noteDate);
  const party = await loadParty(tx, note.partyId, type);
  const wh = await requireActiveWarehouse(tx, note.warehouseId, 'Depo');

  if (type === 'purchase' && !note.externalNo) {
    throw unprocessable('Tedarikçi irsaliye numarası gerekli', 'EXTERNAL_NO_REQUIRED');
  }
  if (note.externalNo) await assertExternalNoFree(tx, note.partyId, note.externalNo, note.id);

  const stored = await orderedLines(tx, id);
  if (stored.length === 0) throw unprocessable('İrsaliyede satır yok', 'DELIVERY_NO_LINES');
  const itemIds = [...new Set(stored.map((l) => l.itemId))];
  const plannerItems = await loadStockableItems(tx, itemIds);
  await lockItems(tx, itemIds);
  const states = await loadItemStates(tx, itemIds);
  const whQty = await loadWarehouseQty(tx, itemIds, [wh.id]);
  const planner = new StockPlanner(states, whQty, {
    allowNegative: ctx.allowNegativeStock,
    items: plannerItems,
    warehouseNames: new Map([[wh.id, wh.name]]),
  });

  const rateCache = new Map<string, MoneyValue>();
  const fxByLine = new Map<number, string | null>();
  for (const l of stored) {
    const qty = dec(l.quantity);
    if (!meta.inbound) {
      planner.issue(l.lineNo, l.itemId, wh.id, qty);
      continue;
    }
    if (l.unitCost === null) {
      // Fiyatı bilinmeyen mal kabul: değer 0; fatura gelince fark otomatik düzeltilir
      planner.receipt(l.lineNo, l.itemId, wh.id, qty, dec(0));
      continue;
    }
    const currency = l.currencyCode ?? ctx.baseCurrency;
    let fx: MoneyValue;
    if (currency === ctx.baseCurrency) {
      fx = dec(1);
    } else if (l.fxRate) {
      fx = dec(l.fxRate);
      if (fx.lte(0)) throw unprocessable(`Satır ${l.lineNo}: kur sıfırdan büyük olmalı`, 'FX_RATE_INVALID');
    } else {
      let cached = rateCache.get(currency);
      if (!cached) {
        cached = await requireRate(tx, currency, ctx.baseCurrency, note.noteDate, ctx.baseCurrency);
        rateCache.set(currency, cached);
      }
      fx = cached;
    }
    fxByLine.set(l.lineNo, currency === ctx.baseCurrency ? null : toDbRate(fx));
    const unitCost = dec(l.unitCost);
    // Değer tek seferde yuvarlanır: miktar × birim maliyet × kur
    planner.receipt(l.lineNo, l.itemId, wh.id, qty, roundMoney(qty.times(unitCost).times(fx)), {
      currencyCode: currency,
      unitCost: unitCost.toFixed(6),
      fxRate: toDbRate(fx),
    });
  }

  const year = isoYear(note.noteDate);
  const seq = await nextNumber(tx, ctx.companyId, `DLV:${type}`, year);
  const noteNo = formatDocumentNumber(meta.prefix, year, seq);

  const doc = await insertDocument(
    tx,
    stockCtx(ctx),
    period.id,
    {
      docDate: note.noteDate,
      type: meta.inbound ? 'receipt' : 'issue',
      warehouseId: wh.id,
      description: `${TYPE_LABEL[type]} ${noteNo} — ${party.name}`.slice(0, 300),
      sourceType: 'delivery_note',
      sourceId: note.id,
    },
    planner.rows,
  );

  // Satır başına stok defteri değeri ve eksi bakiye kapanış düzeltmesi (faturalamada pay dağıtımı için)
  for (const l of stored) {
    const rows = planner.rows.filter((r) => r.lineNo === l.lineNo);
    const stockValue = rows.filter((r) => r.kind === 'qty').reduce((s, r) => s.plus(r.value.abs()), dec(0));
    const adjustValue = rows.filter((r) => r.kind === 'cost_adjust').reduce((s, r) => s.plus(r.value), dec(0));
    await tx
      .update(deliveryNoteLines)
      .set({ stockValue: toDbAmount(stockValue), adjustValue: toDbAmount(adjustValue), fxRate: fxByLine.get(l.lineNo) ?? l.fxRate })
      .where(eq(deliveryNoteLines.id, l.id));
  }

  await tx
    .update(deliveryNotes)
    .set({
      status: 'posted',
      noteNo,
      stockDocumentId: doc.id,
      postedAt: new Date(),
      postedBy: ctx.userId,
      updatedAt: new Date(),
    })
    .where(eq(deliveryNotes.id, id));

  return getDeliveryNote(tx, id);
}

/**
 * İrsaliyeyi iptal eder (ters stok belgesi); numara serinin parçası olarak kalır. Faturaya bağlanmış
 * (kaydedilmiş) irsaliye iptal edilemez: önce fatura iptal edilir. Ürünlerde irsaliyeden sonra hareket
 * varsa stok ters çevrilemez.
 */
export async function cancelDeliveryNote(tx: Tx, ctx: DeliveryCtx, id: string, input: CancelDeliveryNoteInput) {
  const note = await lockNote(tx, id);
  if (note.status === 'cancelled') throw unprocessable('İrsaliye zaten iptal edilmiş', 'DELIVERY_ALREADY_CANCELLED');
  if (note.status !== 'posted') throw unprocessable('Yalnızca kaydedilmiş irsaliye iptal edilebilir', 'DELIVERY_NOT_POSTED');

  const date = input.date ?? todayIso();
  if (date < note.noteDate) throw unprocessable('İptal tarihi irsaliye tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_DELIVERY');
  await requireOpenPeriod(tx, date);

  // Faturalama ile aynı satır kilitleri: paralel faturalama biterse iptal engellenir
  await tx.execute(sql`select id from delivery_note_lines where note_id = ${id} order by id for update`);
  const billed = await tx.execute<{ invoice_no: string }>(sql`
    select distinct i.invoice_no
    from invoice_lines il
    join invoices i on i.id = il.invoice_id and i.status = 'posted'
    join delivery_note_lines dl on dl.id = il.delivery_line_id
    where dl.note_id = ${id}
    limit 1`);
  if (billed.rows.length > 0) {
    throw unprocessable(
      `Bu irsaliye ${billed.rows[0]!.invoice_no} numaralı faturaya bağlı; önce faturayı iptal edin`,
      'DELIVERY_INVOICED',
    );
  }

  let cancelStockDocumentId: string;
  try {
    const rev = await reverseStockDocument(
      tx,
      stockCtx(ctx),
      note.stockDocumentId!,
      { docDate: date, description: `İptal: ${note.noteNo}` },
      true,
    );
    cancelStockDocumentId = rev.document.id;
  } catch (e) {
    if (e instanceof AppError && e.code === 'STOCK_DOC_HAS_LATER_MOVEMENTS') {
      throw unprocessable(
        `${e.message.split(' kartında')[0]} kartında bu irsaliyeden sonra stok hareketi var; irsaliye iptal edilemez, düzeltme hareketi girin`,
        'DELIVERY_CANCEL_BLOCKED',
      );
    }
    throw e;
  }

  await tx
    .update(deliveryNotes)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.userId,
      cancelReason: input.reason,
      cancelStockDocumentId,
      updatedAt: new Date(),
    })
    .where(eq(deliveryNotes.id, id));
  return getDeliveryNote(tx, id);
}
