import { sql } from 'drizzle-orm';
import { toDbAmount, type VatSummaryQuery } from '@erp/shared';
import type { Tx } from '../../db/client';

/** İç kontrol raporu; resmî beyanname yerine geçmez. Defter para biriminde ve iade işaretleriyle. */
export async function documentTaxReport(tx: Tx, query: VatSummaryQuery) {
  const rows = await tx.execute<{ jurisdiction: string | null; treatment: string; exemptionCode: string | null; ruleVersion: string | null; salesNet: string; purchaseNet: string; vat: string; vatWithheld: string; incomeWithheld: string; stamp: string }>(sql`
    select i.legal_profile_snapshot->>'jurisdiction' as jurisdiction,
      coalesce(l.tax_treatment,'legacy_manual') as treatment,
      l.tax_rule_snapshot->'config'->>'exemptionCode' as "exemptionCode",
      l.tax_rule_snapshot->>'version' as "ruleVersion",
      coalesce(sum((case when i.type='sales_return' then -1 else 1 end)*l.net_base) filter(where i.type in ('sales','sales_return')),0)::text as "salesNet",
      coalesce(sum((case when i.type='purchase_return' then -1 else 1 end)*l.net_base) filter(where i.type in ('purchase','expense','purchase_return')),0)::text as "purchaseNet",
      coalesce(sum((case when i.type in ('sales_return','purchase_return') then -1 else 1 end)*l.vat_base),0)::text as vat,
      coalesce(sum((case when i.type in ('sales_return','purchase_return') then -1 else 1 end)*round((l.tax_calculation->>'vatWithheld')::numeric*i.fx_rate,2)),0)::text as "vatWithheld",
      coalesce(sum((case when i.type in ('sales_return','purchase_return') then -1 else 1 end)*round((l.tax_calculation->>'incomeWithheld')::numeric*i.fx_rate,2)),0)::text as "incomeWithheld",
      coalesce(sum((case when i.type in ('sales_return','purchase_return') then -1 else 1 end)*round((l.tax_calculation->>'stamp')::numeric*i.fx_rate,2)),0)::text as stamp
    from invoice_lines l join invoices i on i.id=l.invoice_id
    where i.status='posted' and i.invoice_date between ${query.from}::date and ${query.to}::date
    group by i.legal_profile_snapshot->>'jurisdiction',l.tax_treatment,l.tax_rule_snapshot->'config'->>'exemptionCode',l.tax_rule_snapshot->>'version'
    order by jurisdiction nulls last,treatment,"exemptionCode","ruleVersion"`);
  return { from: query.from, to: query.to, rows: rows.rows.map(row => ({ ...row, salesNet: toDbAmount(row.salesNet), purchaseNet: toDbAmount(row.purchaseNet), vat: toDbAmount(row.vat), vatWithheld: toDbAmount(row.vatWithheld), incomeWithheld: toDbAmount(row.incomeWithheld), stamp: toDbAmount(row.stamp) })) };
}
