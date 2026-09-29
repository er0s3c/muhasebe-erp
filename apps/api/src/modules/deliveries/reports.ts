import { sql } from 'drizzle-orm';
import { dec, sum, toDbAmount, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';

export interface PendingDeliveries {
  /** Faturalanmamış satış irsaliyelerinin stok defterinde yevmiyeye girmemiş maliyeti (eksi: defter stoktan az). */
  sales: string;
  /** Faturalanmamış alış irsaliyelerinin stok defterindeki, henüz yevmiyeye girmemiş değeri (artı). */
  purchases: string;
  /** İkisinin toplamı: stok defteri ile hesaplar arasındaki beklenen fark. */
  total: string;
}

/**
 * İrsaliye stok defterini hemen, yevmiyeyi fatura kesilince etkiler. Bu yüzden `asOf` tarihinde stok değeri ile
 * 150–157 hesaplarının farkının beklenen kısmı: irsaliyelerin değeri (satış eksi, alış artı) eksi bu değerden
 * kaydedilmiş faturalarla yevmiyeye girmiş pay. İptaller iptal tarihine kadar geçerli sayılır.
 */
export async function pendingDeliveries(tx: Tx, asOf: string): Promise<{ raw: PendingDeliveries; total: MoneyValue }> {
  const noted = await tx.execute<{ type: string; value: string }>(sql`
    select n.type, coalesce(sum(coalesce(dl.stock_value, 0) + coalesce(dl.adjust_value, 0)), 0) as value
    from delivery_notes n
    join delivery_note_lines dl on dl.note_id = n.id
    left join stock_documents cd on cd.id = n.cancel_stock_document_id
    where n.status in ('posted', 'cancelled') and n.note_date <= ${asOf}::date
      and (n.status = 'posted' or cd.doc_date > ${asOf}::date)
    group by n.type`);
  const released = await tx.execute<{ type: string; value: string }>(sql`
    select n.type, coalesce(sum(coalesce(il.delivery_value, 0) + coalesce(il.delivery_adjust, 0)), 0) as value
    from invoice_lines il
    join invoices i on i.id = il.invoice_id
    join delivery_note_lines dl on dl.id = il.delivery_line_id
    join delivery_notes n on n.id = dl.note_id
    left join journal_entries cj on cj.id = i.cancel_journal_entry_id
    where i.status in ('posted', 'cancelled') and i.invoice_date <= ${asOf}::date
      and (i.status = 'posted' or cj.entry_date > ${asOf}::date)
    group by n.type`);
  const by = (rows: { type: string; value: string }[], t: string) => dec(rows.find((r) => r.type === t)?.value ?? 0);
  const sales = by(released.rows, 'sales').minus(by(noted.rows, 'sales'));
  const purchases = by(noted.rows, 'purchase').minus(by(released.rows, 'purchase'));
  const total = sum([sales, purchases]);
  return { raw: { sales: toDbAmount(sales), purchases: toDbAmount(purchases), total: toDbAmount(total) }, total };
}
