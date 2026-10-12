import { expect } from 'vitest';
import { execAsOwner } from './helpers';

/**
 * Bir şirketin her işlem dizisinden sonra korunması gereken mali ve fiziksel tutarlılık kuralları (öneri 120).
 * Tablo sahibi rolle okunur (RLS'ten bağımsız); her ihlal kaynağıyla birlikte açıklanır. Yeni akışlar bu listeye kural ekler.
 */
export async function companyInvariantViolations(companyId: string): Promise<string[]> {
  const violations: string[] = [];
  const rows = async (label: string, sql: string) => {
    for (const row of (await execAsOwner(sql, [companyId])).rows) violations.push(`${label}: ${JSON.stringify(row)}`);
  };

  await rows('kayıtlı yevmiye dengesiz (defter para birimi)', `
    select e.id, e.entry_no, sum(l.debit_base)::text as debit, sum(l.credit_base)::text as credit
      from journal_entries e join journal_lines l on l.entry_id = e.id and l.company_id = e.company_id
     where e.company_id = $1 and e.status = 'posted'
     group by e.id, e.entry_no having sum(l.debit_base) <> sum(l.credit_base)`);

  await rows('şirket defteri toplamda dengesiz', `
    select sum(l.debit_base)::text as debit, sum(l.credit_base)::text as credit
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.company_id = l.company_id
     where l.company_id = $1 and e.status = 'posted'
    having coalesce(sum(l.debit_base), 0) <> coalesce(sum(l.credit_base), 0)`);

  await rows('negatif stoğa izin verilmeyen şirkette eksi miktar', `
    select m.item_id, m.warehouse_id, sum(m.qty)::text as qty
      from stock_movements m join companies c on c.id = m.company_id
     where m.company_id = $1 and not c.allow_negative_stock
     group by m.item_id, m.warehouse_id having sum(m.qty) < 0`);

  await rows('miktarı sıfıra inen stokta değer kaldı', `
    select m.item_id, m.warehouse_id, sum(m.value)::text as value
      from stock_movements m
     where m.company_id = $1
     group by m.item_id, m.warehouse_id having sum(m.qty) = 0 and sum(m.value) <> 0`);

  // İptal edilen tahsilat/ödemenin eşleştirmesi silinmez; geçerliliği işlemin durumundan okunur (bkz. parties/service)
  await rows('cari kalem tutarından fazla kapatıldı', `
    select a.charge_line_id, sum(a.amount)::text as allocated, (l.debit + l.credit)::text as line_amount
      from party_allocations a
      join journal_lines l on l.id = a.charge_line_id and l.company_id = a.company_id
      join treasury_transactions t on t.id = a.transaction_id and t.company_id = a.company_id and t.status = 'posted'
     where a.company_id = $1
     group by a.charge_line_id, l.debit, l.credit having sum(a.amount) > l.debit + l.credit`);

  await rows('satış tahsisi sipariş satırını aşıyor', `
    select a.sales_order_line_id, sum(a.quantity)::text as allocated, s.quantity::text as ordered
      from manufacturing_sales_allocations a join sales_order_lines s on s.id = a.sales_order_line_id and s.company_id = a.company_id
     where a.company_id = $1 and a.status = 'active'
     group by a.sales_order_line_id, s.quantity having sum(a.quantity) > s.quantity`);

  await rows('tahsisin karşılanan miktarı tahsisi aşıyor', `
    select id, quantity::text, fulfilled_qty::text from manufacturing_sales_allocations
     where company_id = $1 and fulfilled_qty > quantity`);

  return violations;
}

export async function expectCompanyInvariants(companyId: string, step = '') {
  expect(await companyInvariantViolations(companyId), step ? `değişmez ihlali (${step})` : 'değişmez ihlali').toEqual([]);
}
