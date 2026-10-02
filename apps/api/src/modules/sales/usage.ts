import { sql } from 'drizzle-orm';
import { dec, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { unprocessable } from '../../http/errors';
import { uuidList } from '../inventory/balances';

/**
 * Satış siparişi satırlarının kullanımı (X2): kaydedilmiş (iptal edilmemiş) satış irsaliyelerinden teslim edilen,
 * kaydedilmiş satış faturalarından faturalanan ve bunun irsaliyesiz (stoğu faturada hareket eden) kısmı.
 * Karşılanma durumu yalnızca bu türetimden okunur; sipariş başlığında sayaç tutulmaz.
 */
export interface OrderLineUsage {
  delivered: MoneyValue;
  invoiced: MoneyValue;
  direct: MoneyValue;
}

export const zeroUsage = (): OrderLineUsage => ({ delivered: dec(0), invoiced: dec(0), direct: dec(0) });

export async function orderLineUsage(tx: Tx, lineIds: readonly string[]): Promise<Map<string, OrderLineUsage>> {
  const out = new Map<string, OrderLineUsage>();
  if (lineIds.length === 0) return out;
  const del = await tx.execute<{ id: string; qty: string }>(sql`
    select l.sales_order_line_id as id, sum(l.quantity) as qty
    from delivery_note_lines l join delivery_notes n on n.id = l.note_id and n.status = 'posted'
    where l.sales_order_line_id in (${uuidList(lineIds)})
    group by l.sales_order_line_id`);
  const inv = await tx.execute<{ id: string; qty: string; direct: string }>(sql`
    select l.sales_order_line_id as id, sum(l.quantity) as qty,
           coalesce(sum(l.quantity) filter (where l.delivery_line_id is null), 0) as direct
    from invoice_lines l join invoices i on i.id = l.invoice_id and i.status = 'posted'
    where l.sales_order_line_id in (${uuidList(lineIds)})
    group by l.sales_order_line_id`);
  for (const id of lineIds) out.set(id, zeroUsage());
  for (const r of del.rows) out.get(r.id)!.delivered = dec(r.qty);
  for (const r of inv.rows) {
    const u = out.get(r.id)!;
    u.invoiced = dec(r.qty);
    u.direct = dec(r.direct);
  }
  return out;
}

/** Sipariş satırlarını id sırasıyla kilitler (paralel teslim/faturalama sıraya girer). */
export async function lockOrderLines(tx: Tx, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  await tx.execute(sql`select id from sales_order_lines where id in (${uuidList(unique)}) order by id for update`);
}

interface OrderLineRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  doc_no: string | null;
  kind: string;
  status: string;
  party_id: string;
  currency_code: string;
  item_id: string | null;
  quantity: string;
  is_goods: boolean;
}

export interface OrderLinkLine {
  lineNo: number;
  salesOrderLineId?: string | null;
  itemId?: string | null;
  quantity: string;
  /** Faturada: satır bir irsaliye satırına bağlı mı (irsaliyesiz = stoğu faturada hareket eder). */
  deliveryLineId?: string | null;
}

/**
 * Teslim (`delivery`) ya da fatura (`invoice`) satırlarının sipariş bağını doğrular: onaylı (faturada kapalı da olur) sipariş,
 * aynı cari ve kart, kalan miktar. Aynı sipariş satırını kullanan satırlar birikir. Kaydetmede kilit altında yeniden çağrılır.
 */
export async function checkOrderLinks(
  tx: Tx,
  mode: 'delivery' | 'invoice',
  partyId: string,
  lines: readonly OrderLinkLine[],
  opts: { currency?: string } = {},
): Promise<void> {
  const linked = lines.filter((l) => l.salesOrderLineId);
  if (linked.length === 0) return;
  const ids = [...new Set(linked.map((l) => l.salesOrderLineId!))];
  const rows = await tx.execute<OrderLineRow>(sql`
    select ol.id, ol.order_id, o.doc_no, o.kind, o.status, o.party_id, o.currency_code, ol.item_id, ol.quantity,
           coalesce(it.kind = 'goods', false) as is_goods
    from sales_order_lines ol
    join sales_orders o on o.id = ol.order_id
    left join items it on it.id = ol.item_id
    where ol.id in (${uuidList(ids)})`);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const usage = await orderLineUsage(tx, ids);
  const inThisQty = new Map<string, MoneyValue>();
  for (const l of linked) {
    const label = `Satır ${l.lineNo}`;
    const ol = byId.get(l.salesOrderLineId!);
    if (!ol) throw unprocessable(`${label}: bağlı sipariş satırı bulunamadı`, 'SO_LINE_NOT_FOUND');
    const orderLabel = ol.doc_no ?? 'sipariş';
    if (ol.kind !== 'order') throw unprocessable(`${label}: yalnızca siparişe bağlanabilir (teklife değil)`, 'SO_LINK_KIND');
    const okStatus = mode === 'delivery' ? ol.status === 'confirmed' : ol.status === 'confirmed' || ol.status === 'closed';
    if (!okStatus) {
      throw unprocessable(`${label}: ${orderLabel} ${mode === 'delivery' ? 'onaylı' : 'onaylı ya da kapalı'} durumda değil`, 'SO_NOT_CONFIRMED');
    }
    if (ol.party_id !== partyId) throw unprocessable(`${label}: ${orderLabel} başka bir cariye ait`, 'SO_PARTY_MISMATCH');
    if ((ol.item_id ?? null) !== (l.itemId ?? null)) {
      throw unprocessable(`${label}: stok kartı sipariş satırıyla aynı olmalı`, 'SO_ITEM_MISMATCH');
    }
    if (opts.currency && ol.currency_code !== opts.currency) {
      throw unprocessable(`${label}: fatura para birimi ${orderLabel} siparişinin para biriminden (${ol.currency_code}) farklı`, 'SO_CURRENCY_MISMATCH');
    }
    const u = usage.get(ol.id)!;
    const mine = inThisQty.get(`${mode}|${ol.id}`) ?? dec(0);
    const mineDirect = inThisQty.get(`direct|${ol.id}`) ?? dec(0);
    const ordered = dec(ol.quantity);
    const qty = dec(l.quantity);
    let remaining: MoneyValue;
    if (mode === 'delivery') {
      remaining = ordered.minus(u.delivered).minus(u.direct).minus(mine);
    } else {
      remaining = ordered.minus(u.invoiced).minus(mine);
      if (!l.deliveryLineId && ol.is_goods) {
        const rd = ordered.minus(u.delivered).minus(u.direct).minus(mineDirect);
        if (qty.gt(rd)) {
          throw unprocessable(
            `Satır ${l.lineNo}: sipariş satırının kalan teslim edilebilir miktarı (${rd.toFixed(4)}) aşılıyor; teslim edilen mal irsaliye üzerinden faturalanır`,
            'SO_QTY_EXCEEDED',
            { lineNo: l.lineNo, remaining: rd.toFixed(4) },
          );
        }
        inThisQty.set(`direct|${ol.id}`, mineDirect.plus(qty));
      }
    }
    if (qty.gt(remaining)) {
      throw unprocessable(
        `${label}: ${mode === 'delivery' ? 'teslim' : 'faturalanan'} miktar (${qty.toFixed(4)}) siparişte kalan miktarı (${(remaining.isNegative() ? dec(0) : remaining).toFixed(4)}) aşıyor`,
        'SO_QTY_EXCEEDED',
        { lineNo: l.lineNo, remaining: (remaining.isNegative() ? dec(0) : remaining).toFixed(4) },
      );
    }
    inThisQty.set(`${mode}|${ol.id}`, mine.plus(qty));
  }
}
