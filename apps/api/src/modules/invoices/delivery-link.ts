import { sql } from 'drizzle-orm';
import { dec, deliveryTypeForInvoice, roundMoney, type DeliveryNoteType, type InvoiceType, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import { uuidList } from '../inventory/balances';

/** İrsaliye satırı ve başlığından fatura bağı için gereken alanlar. */
export interface DeliveryLineInfo {
  id: string;
  noteId: string;
  noteNo: string | null;
  noteType: DeliveryNoteType;
  noteStatus: string;
  partyId: string;
  warehouseId: string;
  lineNo: number;
  itemId: string;
  quantity: MoneyValue;
  stockValue: MoneyValue;
  adjustValue: MoneyValue;
}

export interface Invoiced {
  qty: MoneyValue;
  value: MoneyValue;
  adjust: MoneyValue;
}

const zero = (): Invoiced => ({ qty: dec(0), value: dec(0), adjust: dec(0) });

/**
 * İrsaliye satırlarına kaydedilmiş (iptal edilmemiş) faturalardan düşen miktar ve değer payları.
 * `exceptInvoiceId`: kaydedilmekte olan fatura kendini saymaz.
 */
export async function invoicedTotals(tx: Tx, lineIds: readonly string[], exceptInvoiceId?: string) {
  const out = new Map<string, Invoiced>();
  if (lineIds.length === 0) return out;
  const rows = await tx.execute<{ delivery_line_id: string; qty: string; value: string; adjust: string }>(sql`
    select l.delivery_line_id, sum(l.quantity) as qty,
           coalesce(sum(l.delivery_value), 0) as value, coalesce(sum(l.delivery_adjust), 0) as adjust
    from invoice_lines l join invoices i on i.id = l.invoice_id
    where i.status = 'posted' and l.delivery_line_id in (${uuidList(lineIds)})
      ${exceptInvoiceId ? sql`and i.id <> ${exceptInvoiceId}` : sql``}
    group by l.delivery_line_id`);
  for (const r of rows.rows) out.set(r.delivery_line_id, { qty: dec(r.qty), value: dec(r.value), adjust: dec(r.adjust) });
  return out;
}

interface InfoRow extends Record<string, unknown> {
  id: string;
  note_id: string;
  note_no: string | null;
  type: DeliveryNoteType;
  status: string;
  party_id: string;
  warehouse_id: string;
  line_no: number;
  item_id: string;
  quantity: string;
  stock_value: string | null;
  adjust_value: string | null;
}

/**
 * İrsaliye satırlarını id sırasıyla kilitler. Fatura oluşturup aynı istekte kaydederken, satırlar yazılmadan ÖNCE
 * çağrılmalıdır: satır eklemek yabancı anahtar denetimiyle `FOR KEY SHARE` kilidi alır; sonradan `FOR UPDATE`'e
 * yükseltmek, aynı satırı kullanan iki eşzamanlı istekte birbirini bekleyen kilitlenmeye yol açar.
 */
export async function lockDeliveryLines(tx: Tx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  await tx.execute(sql`select id from delivery_note_lines where id in (${uuidList(unique)}) order by id for update`);
}

async function loadInfo(tx: Tx, ids: readonly string[], lock: boolean) {
  // Kilit ayrı bir sorguyla alınır: bekleme sırasında biten bir irsaliye iptali (durum değişikliği)
  // bir sonraki sorgunun taze görüntüsünde görünür.
  if (lock) await tx.execute(sql`select id from delivery_note_lines where id in (${uuidList(ids)}) order by id for update`);
  const rows = await tx.execute<InfoRow>(sql`
    select dl.id, dl.note_id, n.note_no, n.type, n.status, n.party_id, n.warehouse_id, dl.line_no, dl.item_id,
           dl.quantity, dl.stock_value, dl.adjust_value
    from delivery_note_lines dl join delivery_notes n on n.id = dl.note_id
    where dl.id in (${uuidList(ids)})
    order by dl.id`);
  return new Map<string, DeliveryLineInfo>(
    rows.rows.map((r) => [
      r.id,
      {
        id: r.id,
        noteId: r.note_id,
        noteNo: r.note_no,
        noteType: r.type,
        noteStatus: r.status,
        partyId: r.party_id,
        warehouseId: r.warehouse_id,
        lineNo: r.line_no,
        itemId: r.item_id,
        quantity: dec(r.quantity),
        stockValue: dec(r.stock_value ?? 0),
        adjustValue: dec(r.adjust_value ?? 0),
      },
    ]),
  );
}

interface LinkLine {
  lineNo: number;
  itemId: string | null;
  quantity: string;
  deliveryLineId: string | null;
}

/** Bağın türe/cariye/karta uygunluğu ve irsaliyenin kaydedilmiş olması. */
function assertLink(l: LinkLine, info: DeliveryLineInfo | undefined, type: InvoiceType, partyId: string): DeliveryLineInfo {
  if (!info) throw unprocessable(`Satır ${l.lineNo}: bağlı irsaliye satırı bulunamadı`, 'DELIVERY_LINE_NOT_FOUND');
  if (info.noteStatus !== 'posted') {
    throw unprocessable(`Satır ${l.lineNo}: ${info.noteNo ?? 'irsaliye'} kaydedilmiş durumda değil`, 'DELIVERY_NOT_POSTED_LINK');
  }
  if (info.noteType !== deliveryTypeForInvoice(type)) {
    throw unprocessable(`Satır ${l.lineNo}: irsaliye türü bu faturayla uyuşmuyor`, 'DELIVERY_TYPE_MISMATCH');
  }
  if (info.partyId !== partyId) {
    throw unprocessable(`Satır ${l.lineNo}: irsaliye başka bir cariye ait`, 'DELIVERY_PARTY_MISMATCH');
  }
  if (info.itemId !== l.itemId) {
    throw unprocessable(`Satır ${l.lineNo}: stok kartı irsaliye satırıyla aynı olmalı`, 'DELIVERY_ITEM_MISMATCH');
  }
  return info;
}

/** Taslakta bağların geçerliliğini ve kalan miktar sınırını denetler (kaydetmede kilit altında yeniden denetlenir). */
export async function checkDeliveryLinks(
  tx: Tx,
  type: InvoiceType,
  partyId: string,
  lines: readonly LinkLine[],
  exceptInvoiceId?: string,
) {
  const linked = lines.filter((l) => l.deliveryLineId);
  if (linked.length === 0) return;
  if (!deliveryTypeForInvoice(type)) {
    throw unprocessable('İrsaliye bağı gider faturasında kullanılamaz', 'DELIVERY_LINK_TYPE');
  }
  const ids = [...new Set(linked.map((l) => l.deliveryLineId!))];
  const info = await loadInfo(tx, ids, false);
  const invoiced = await invoicedTotals(tx, ids, exceptInvoiceId);
  const inThis = new Map<string, MoneyValue>();
  for (const l of linked) {
    const i = assertLink(l, info.get(l.deliveryLineId!), type, partyId);
    const remaining = i.quantity.minus(invoiced.get(i.id)?.qty ?? 0).minus(inThis.get(i.id) ?? 0);
    if (dec(l.quantity).gt(remaining)) {
      throw unprocessable(
        `Satır ${l.lineNo}: faturalanan miktar (${dec(l.quantity).toFixed(4)}) irsaliyede kalan miktarı (${remaining.toFixed(4)}) aşıyor`,
        'DELIVERY_QTY_EXCEEDED',
        { lineNo: l.lineNo, remaining: remaining.toFixed(4) },
      );
    }
    inThis.set(i.id, (inThis.get(i.id) ?? dec(0)).plus(l.quantity));
  }
}

/** İşaretli kalan tutardan büyük (aynı yönde) bir pay verilmez; işaret ters çıkarsa kalan alınır. */
function capSigned(portion: MoneyValue, remaining: MoneyValue): MoneyValue {
  if (remaining.isZero()) return dec(0);
  if (remaining.isPositive()) return portion.isNegative() ? dec(0) : portion.gt(remaining) ? remaining : portion;
  return portion.isPositive() ? dec(0) : portion.lt(remaining) ? remaining : portion;
}

/**
 * Kaydetmede irsaliye satırlarını kilitler (id sırasıyla), bağları yeniden doğrular ve her fatura
 * satırına irsaliye satırının değer/düzeltme payını dağıtır. Son pay kalanın tamamını alır: kuruş artığı kalmaz.
 */
export class DeliveryAllocator {
  private readonly used = new Map<string, Invoiced>();

  private constructor(
    readonly info: Map<string, DeliveryLineInfo>,
    private readonly invoiced: Map<string, Invoiced>,
  ) {}

  static async lock(tx: Tx, type: InvoiceType, partyId: string, lines: readonly LinkLine[], exceptInvoiceId: string) {
    const linked = lines.filter((l) => l.deliveryLineId);
    if (!deliveryTypeForInvoice(type) && linked.length > 0) {
      throw unprocessable('İrsaliye bağı gider faturasında kullanılamaz', 'DELIVERY_LINK_TYPE');
    }
    const ids = [...new Set(linked.map((l) => l.deliveryLineId!))];
    if (ids.length === 0) return new DeliveryAllocator(new Map(), new Map());
    const info = await loadInfo(tx, ids, true);
    for (const l of linked) assertLink(l, info.get(l.deliveryLineId!), type, partyId);
    return new DeliveryAllocator(info, await invoicedTotals(tx, ids, exceptInvoiceId));
  }

  /** Bir fatura satırının (miktar `qty`) irsaliye satırından aldığı değer ve maliyet düzeltmesi payı. */
  take(lineNo: number, deliveryLineId: string, qty: MoneyValue): { value: MoneyValue; adjust: MoneyValue; line: DeliveryLineInfo } {
    const line = this.info.get(deliveryLineId)!;
    const prev = this.invoiced.get(deliveryLineId) ?? zero();
    const mine = this.used.get(deliveryLineId) ?? zero();
    const remainingQty = line.quantity.minus(prev.qty).minus(mine.qty);
    if (qty.gt(remainingQty)) {
      throw unprocessable(
        `Satır ${lineNo}: faturalanan miktar (${qty.toFixed(4)}) irsaliyede kalan miktarı (${remainingQty.toFixed(4)}) aşıyor`,
        'DELIVERY_QTY_EXCEEDED',
        { lineNo, remaining: remainingQty.toFixed(4) },
      );
    }
    const last = qty.eq(remainingQty);
    const remValue = line.stockValue.minus(prev.value).minus(mine.value);
    const remAdjust = line.adjustValue.minus(prev.adjust).minus(mine.adjust);
    const value = last ? remValue : capSigned(roundMoney(line.stockValue.times(qty).div(line.quantity)), remValue);
    const adjust = last ? remAdjust : capSigned(roundMoney(line.adjustValue.times(qty).div(line.quantity)), remAdjust);
    this.used.set(deliveryLineId, { qty: mine.qty.plus(qty), value: mine.value.plus(value), adjust: mine.adjust.plus(adjust) });
    return { value, adjust, line };
  }
}
