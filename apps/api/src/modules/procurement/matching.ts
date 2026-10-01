import { sql } from 'drizzle-orm';
import { dec, evaluateMatch, type MatchFlag, type MoneyValue, type ProcurementSettingsInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { procurementSettings } from '../../db/schema';
import { unprocessable } from '../../http/errors';

export const DEFAULT_SETTINGS: ProcurementSettingsInput = { qtyTolerancePct: '0', priceTolerancePct: '2' };

export async function getProcurementSettings(tx: Tx): Promise<ProcurementSettingsInput> {
  const [row] = await tx.select().from(procurementSettings).limit(1);
  return row ? { qtyTolerancePct: dec(row.qtyTolerancePct).toString(), priceTolerancePct: dec(row.priceTolerancePct).toString() } : DEFAULT_SETTINGS;
}

export async function putProcurementSettings(tx: Tx, companyId: string, input: ProcurementSettingsInput) {
  await tx
    .insert(procurementSettings)
    .values({ companyId, qtyTolerancePct: input.qtyTolerancePct, priceTolerancePct: input.priceTolerancePct })
    .onConflictDoUpdate({ target: procurementSettings.companyId, set: { qtyTolerancePct: input.qtyTolerancePct, priceTolerancePct: input.priceTolerancePct, updatedAt: new Date() } });
  return getProcurementSettings(tx);
}

export interface MatchLineIn {
  lineNo: number;
  poLineId: string | null;
  quantity: string;
  /** KDV hariç, iskontolu satır tutarı (fatura para birimi). */
  net: string | MoneyValue;
}

export interface MatchRow {
  lineNo: number;
  poLineId: string;
  orderCode: string;
  orderLineNo: number;
  description: string;
  orderedQty: string;
  receivedQty: string;
  invoicedBeforeQty: string;
  invoiceQty: string;
  orderPrice: string;
  invoicePrice: string;
  priceDiffPct: string | null;
  flags: MatchFlag[];
}

/**
 * Faturanın sipariş bağlı satırlarını sipariş ve mal kabulle karşılaştırır. "Önceden faturalanan" = bu fatura dışındaki
 * KAYITLI alış faturaları (iptaller sayılmaz). Aynı sipariş satırına bağlı birden çok satır sırayla birikir.
 */
export async function evaluateInvoiceMatch(tx: Tx, lines: readonly MatchLineIn[], exceptInvoiceId: string | null): Promise<MatchRow[]> {
  const linked = lines.filter((l) => l.poLineId);
  if (linked.length === 0) return [];
  const settings = await getProcurementSettings(tx);
  const ids = [...new Set(linked.map((l) => l.poLineId!))];
  const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const info = await tx.execute<{ id: string; code: string; lineNo: number; description: string; quantity: string; unitPrice: string; received: string; invoiced: string }>(sql`
    select l.id, o.code, l.line_no as "lineNo", l.description, l.quantity::text, l.unit_price::text as "unitPrice",
           coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                      where rl.order_line_id = l.id and r.status = 'posted'), 0)::text as received,
           coalesce((select sum(il.quantity) from invoice_lines il join invoices i on i.id = il.invoice_id
                      where il.po_line_id = l.id and i.status = 'posted' and i.id is distinct from ${exceptInvoiceId}::uuid), 0)::text as invoiced
      from purchase_order_lines l join purchase_orders o on o.id = l.order_id
     where l.id in (${idList})`);
  const byId = new Map(info.rows.map((r) => [r.id, r]));
  const running = new Map<string, MoneyValue>();
  return linked.map((l) => {
    const p = byId.get(l.poLineId!);
    if (!p) throw unprocessable(`Satır ${l.lineNo}: sipariş satırı bulunamadı`, 'ORDER_LINE_NOT_FOUND');
    const before = dec(p.invoiced).plus(running.get(p.id) ?? 0);
    running.set(p.id, (running.get(p.id) ?? dec(0)).plus(l.quantity));
    const qty = dec(l.quantity);
    const price = qty.isZero() ? dec(0) : dec(l.net).div(qty);
    const r = evaluateMatch({
      orderedQty: p.quantity,
      receivedQty: p.received,
      invoicedBeforeQty: before,
      invoiceQty: qty,
      orderPrice: p.unitPrice,
      invoicePrice: price,
      qtyTolerancePct: settings.qtyTolerancePct,
      priceTolerancePct: settings.priceTolerancePct,
    });
    return {
      lineNo: l.lineNo,
      poLineId: p.id,
      orderCode: p.code,
      orderLineNo: p.lineNo,
      description: p.description,
      orderedQty: dec(p.quantity).toFixed(4),
      receivedQty: dec(p.received).toFixed(4),
      invoicedBeforeQty: before.toFixed(4),
      invoiceQty: qty.toFixed(4),
      orderPrice: dec(p.unitPrice).toFixed(4),
      invoicePrice: price.toFixed(4),
      priceDiffPct: r.priceDiffPct,
      flags: r.flags,
    };
  });
}

/** Kayıt sırasında: tolerans dışı satır varsa ve gerekçe yoksa reddeder. */
export function assertMatchOrOverride(rows: readonly MatchRow[], overrideReason: string | null) {
  const bad = rows.filter((r) => r.flags.length > 0);
  if (bad.length === 0 || overrideReason) return;
  const label = (f: MatchFlag) => (f === 'over_received' ? 'mal kabulü aşıyor' : f === 'over_ordered' ? 'sipariş miktarını aşıyor' : 'fiyat sapması');
  throw unprocessable(
    `Üçlü eşleştirme tolerans dışı: ${bad.map((r) => `satır ${r.lineNo} (${r.orderCode}) ${r.flags.map(label).join(', ')}`).join('; ')}. Düzeltin ya da yetkili gerekçesiyle geçirin`,
    'THREE_WAY_MISMATCH',
    { rows: bad },
  );
}

/** Sipariş bazında sipariş / mal kabul / fatura özeti (verilmiş ve kapatılmış siparişler). */
export async function orderMatchSummary(tx: Tx) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select o.id, o.code, o.status, o.project_id as "projectId", p.code as "projectCode", o.party_id as "partyId", pa.name as "partyName",
           o.currency_code as "currencyCode",
           sum(round(l.quantity * l.unit_price, 2))::text as "orderedAmount",
           sum(round(least(rc.q, l.quantity) * l.unit_price, 2))::text as "receivedAmount",
           sum(round(iv.q * l.unit_price, 2))::text as "invoicedAtOrderPrice",
           sum(round(greatest(rc.q - iv.q, 0) * l.unit_price, 2))::text as "uninvoicedReceiptAmount",
           coalesce(bool_or(iv.q > l.quantity or iv.q > rc.q), false) as "hasExcess"
      from purchase_orders o
      join projects p on p.id = o.project_id
      join parties pa on pa.id = o.party_id
      join purchase_order_lines l on l.order_id = o.id
      cross join lateral (select coalesce(sum(rl.quantity), 0) as q from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                           where rl.order_line_id = l.id and r.status = 'posted') rc
      cross join lateral (select coalesce(sum(il.quantity), 0) as q from invoice_lines il join invoices i on i.id = il.invoice_id
                           where il.po_line_id = l.id and i.status = 'posted') iv
     where o.status in ('issued', 'closed')
     group by o.id, p.code, pa.name
     order by o.code desc`);
  return { orders: rows.rows };
}

/** Faturaya bağlanabilir sipariş satırları: cariye ait verilmiş/kapatılmış siparişlerin, siparişten fazla faturalanmamış satırları. */
export async function invoiceableOrderLines(tx: Tx, partyId: string, currency: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select l.id as "lineId", o.id as "orderId", o.code as "orderCode", o.issued_at::date::text as "orderDate", o.project_id as "projectId",
           l.line_no as "lineNo", l.item_id as "itemId", l.description, l.unit, l.wbs_id as "wbsId", o.vat_code as "vatCode",
           l.quantity::text as "orderedQty", l.unit_price::text as "unitPrice",
           rc.q::numeric(19,4)::text as "receivedQty", iv.q::numeric(19,4)::text as "invoicedQty"
      from purchase_order_lines l
      join purchase_orders o on o.id = l.order_id
      cross join lateral (select coalesce(sum(rl.quantity), 0) as q from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                           where rl.order_line_id = l.id and r.status = 'posted') rc
      cross join lateral (select coalesce(sum(il.quantity), 0) as q from invoice_lines il join invoices i on i.id = il.invoice_id
                           where il.po_line_id = l.id and i.status = 'posted') iv
     where o.party_id = ${partyId} and o.currency_code = ${currency} and o.status in ('issued', 'closed') and iv.q < l.quantity
     order by o.code desc, l.line_no`);
  return { lines: rows.rows };
}
