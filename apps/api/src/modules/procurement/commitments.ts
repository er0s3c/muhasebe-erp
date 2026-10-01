import { sql } from 'drizzle-orm';
import { dec, roundMoney, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies } from '../../db/schema';
import { findRate } from '../settings/rates';

/**
 * Sipariş taahhüdü (türetilir): verilmiş (kapatılmamış, iptal edilmemiş) siparişlerin kalan miktarı × birim fiyat (KDV hariç),
 * iş kalemi bazında; kabul edilen (asOf'a kadar, iptal edilmeyen) miktar düşer. Sipariş para biriminden defter para birimine
 * asOf kuruyla çevrilir (kabul ya da bağlı alış faturasından büyük olanı düşer: hizmet faturası kabulsüz de taahhüdü kapatır, çift sayım olmaz); kur yoksa sipariş dışarıda kalır ve `missingRate` artar.
 * Not: stoklu malzemede taahhüt kabulle biter; maliyet projeye sarf anında yazılır (aradaki stok depodadır).
 */
export async function loadOrderCommitted(tx: Tx, projectId: string, asOf: string) {
  const [company] = await tx.select({ base: companies.baseCurrency }).from(companies);
  const base = company!.base;
  const rows = await tx.execute<{ wbsId: string; currency: string; remaining: string; orderId: string }>(sql`
    select l.wbs_id as "wbsId", o.currency_code as currency, o.id as "orderId",
           (greatest(l.quantity - greatest(
                       coalesce((select sum(rl.quantity) from po_receipt_lines rl join po_receipts r on r.id = rl.receipt_id
                                  where rl.order_line_id = l.id and r.status = 'posted' and r.receipt_date <= ${asOf}::date), 0),
                       coalesce((select sum(il.quantity) from invoice_lines il join invoices iv on iv.id = il.invoice_id
                                  where il.po_line_id = l.id and iv.status = 'posted' and iv.invoice_date <= ${asOf}::date), 0)), 0)
            * l.unit_price)::numeric(19,2)::text as remaining
      from purchase_order_lines l join purchase_orders o on o.id = l.order_id
     where o.project_id = ${projectId} and o.status = 'issued' and l.wbs_id is not null and o.issued_at::date <= ${asOf}::date`);
  const byWbs = new Map<string, MoneyValue>();
  const rates = new Map<string, MoneyValue | null>();
  const missing = new Set<string>();
  const orders = new Set<string>();
  for (const r of rows.rows) {
    orders.add(r.orderId);
    let rate: MoneyValue | null;
    if (r.currency === base) rate = dec(1);
    else {
      if (!rates.has(r.currency)) rates.set(r.currency, await findRate(tx, r.currency, base, asOf, base));
      rate = rates.get(r.currency) ?? null;
    }
    if (!rate) {
      missing.add(r.orderId);
      continue;
    }
    byWbs.set(r.wbsId, (byWbs.get(r.wbsId) ?? dec(0)).plus(roundMoney(dec(r.remaining).times(rate))));
  }
  return { byWbs, missingRate: missing.size, orders: orders.size };
}
