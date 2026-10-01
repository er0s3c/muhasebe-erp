import { sql } from 'drizzle-orm';
import { PROJECT_REVENUE_PREFIXES, applyRate, dec, roundMoney, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { TR } from '../../db/search';
import { findRate } from '../settings/rates';
import { projectCostReport } from './reports';

const REVENUE_RE = `^(${PROJECT_REVENUE_PREFIXES.join('|')})`;

export interface ProfitabilityRow {
  id: string;
  code: string;
  name: string;
  kind: 'own' | 'contract';
  status: string;
  /** Sözleşmeli gelir: işveren sözleşmesi (contract) ya da etkin/teslim satış sözleşmeleri (own), defter para biriminde. */
  contractedRevenue: string;
  /** Satılmamış birimlerin liste fiyatı değeri (yalnızca own; bilgi). */
  unsoldValue: string;
  /** Kayıtlı (tanınmış) gelir ve gerçekleşen maliyet. */
  revenue: string;
  actual: string;
  committed: string;
  eac: string;
  /** Bekleyen değişiklik emirleri (bilgi): maliyet (taşeron) ve gelir (işveren) farkı; tahmine girmez. */
  pendingVariationCost: string;
  pendingVariationRevenue: string;
  /** Sözleşmeli gelir − EAC; EAC yoksa (bütçe/ilerleme yok) gerçekleşen maliyet kullanılır. */
  projectedProfit: string;
  /** Tanınmış gelir − gerçekleşen maliyet. */
  recognizedProfit: string;
  marginPct: string | null;
  /** Yönetim (raporlama) para birimi karşılıkları; raporlama para birimi/kur yoksa null. */
  reporting: { contractedRevenue: string; revenue: string; actual: string; eac: string; projectedProfit: string; recognizedProfit: string } | null;
  missingRate: number;
}

/**
 * Proje kârlılığı: gelir − maliyet, defter ve yönetim (raporlama) para biriminde. Tanınmış gelir/maliyet defter satırlarının
 * tarihsel raporlama tutarından; sözleşmeli gelir ve EAC bugünkü kurla çevrilir. Kur yoksa raporlama sütunu null ve `missingRate` > 0.
 */
export async function projectProfitability(tx: Tx, asOf: string, base: string, reporting: string | null) {
  const list = await tx.execute<{ id: string }>(sql`select id from projects where status <> 'cancelled' order by code collate ${TR}`);
  const repRate: MoneyValue | null = reporting && reporting !== base ? await findRate(tx, base, reporting, asOf, base) : reporting === base ? dec(1) : null;
  const rows: ProfitabilityRow[] = [];

  for (const { id } of list.rows) {
    const r = await projectCostReport(tx, id, asOf);
    let missing = 0;
    const toBase = async (amount: MoneyValue, cur: string) => {
      if (cur === base) return amount;
      const rate = await findRate(tx, cur, base, asOf, base);
      if (!rate) { missing++; return dec(0); }
      return applyRate(amount, rate);
    };

    // Sözleşmeli gelir
    let contracted = dec(0);
    let unsold = dec(0);
    if (r.project.kind === 'contract') {
      const emp = await tx.execute<{ cur: string; amount: string }>(sql`
        select s.currency_code as cur,
               coalesce((select sum(round(l.quantity * l.unit_price, 2)) from subcontract_boq_lines l
                          where l.revision_id = (select c.id from subcontract_revisions c where c.subcontract_id = s.id and c.status = 'approved' order by c.revision_no desc limit 1)), 0)::text as amount
          from subcontracts s where s.project_id = ${id} and s.direction = 'receivable' and s.status in ('active','completed')`);
      for (const e of emp.rows) contracted = contracted.plus(await toBase(dec(e.amount), e.cur));
    } else {
      const sold = await tx.execute<{ base: string }>(sql`
        select coalesce(sum(round(price * activation_fx, 2)), 0)::text as base from sales_contracts
         where project_id = ${id} and status in ('active','handed_over')`);
      contracted = dec(sold.rows[0]?.base ?? 0);
      const free = await tx.execute<{ cur: string; amount: string }>(sql`
        select list_currency as cur, sum(list_price)::text as amount from real_estate_units
         where project_id = ${id} and status in ('available','reserved') and list_price is not null group by list_currency`);
      for (const f of free.rows) unsold = unsold.plus(await toBase(dec(f.amount), f.cur));
    }

    // Tanınmış gelir ve maliyet: raporlama tutarı defter satırlarından (tarihsel)
    const rep = await tx.execute<{ revenue: string | null; cost: string | null }>(sql`
      select sum(jl.credit_reporting - jl.debit_reporting) filter (where a.code ~ ${REVENUE_RE})::text as revenue,
             sum(jl.debit_reporting - jl.credit_reporting) filter (where a.code !~ ${REVENUE_RE})::text as cost
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
        join accounts a on a.id = jl.account_id
       where jl.project_id = ${id} and je.status = 'posted' and je.entry_date <= ${asOf}::date`);

    const revenue = dec(r.totals.revenue);
    const actual = dec(r.totals.actual);
    const eacRaw = dec(r.totals.eac);
    const eac = eacRaw.gt(0) ? eacRaw : actual;
    const projected = contracted.minus(eac);
    const recognized = revenue.minus(actual);
    const rr = (v: MoneyValue) => (repRate ? roundMoney(applyRate(v, repRate, 4)).toFixed(2) : null);
    const hasRep = !!repRate && !!reporting;
    const repRevenue = rep.rows[0]?.revenue != null ? dec(rep.rows[0].revenue) : hasRep ? dec(rr(revenue) ?? 0) : null;
    const repActual = rep.rows[0]?.cost != null ? dec(rep.rows[0].cost) : hasRep ? dec(rr(actual) ?? 0) : null;
    rows.push({
      id,
      code: r.project.code,
      name: r.project.name,
      kind: r.project.kind as 'own' | 'contract',
      status: r.project.status,
      contractedRevenue: contracted.toFixed(2),
      unsoldValue: unsold.toFixed(2),
      revenue: revenue.toFixed(2),
      actual: actual.toFixed(2),
      committed: r.totals.committed,
      eac: eac.toFixed(2),
      pendingVariationCost: r.pendingVariations.cost,
      pendingVariationRevenue: r.pendingVariations.revenue,
      projectedProfit: projected.toFixed(2),
      recognizedProfit: recognized.toFixed(2),
      marginPct: contracted.gt(0) ? projected.div(contracted).times(100).toDecimalPlaces(1).toFixed(1) : null,
      reporting:
        hasRep && repRevenue && repActual
          ? {
              contractedRevenue: rr(contracted)!,
              revenue: roundMoney(repRevenue).toFixed(2),
              actual: roundMoney(repActual).toFixed(2),
              eac: rr(eac)!,
              projectedProfit: rr(projected)!,
              recognizedProfit: roundMoney(repRevenue.minus(repActual)).toFixed(2),
            }
          : null,
      missingRate: missing + r.commitments.missingRate + r.pendingVariations.missingRate,
    });
  }

  const sum = (f: (r: ProfitabilityRow) => string) => rows.reduce((s, r) => s.plus(f(r)), dec(0));
  const sumRep = (f: (r: NonNullable<ProfitabilityRow['reporting']>) => string) => (rows.every((r) => r.reporting) && rows.length ? rows.reduce((s, r) => s.plus(f(r.reporting!)), dec(0)).toFixed(2) : null);
  const contracted = sum((r) => r.contractedRevenue);
  const projected = sum((r) => r.projectedProfit);
  return {
    asOf,
    baseCurrency: base,
    reportingCurrency: reporting,
    reportingRate: repRate ? repRate.toFixed(8) : null,
    rows,
    totals: {
      contractedRevenue: contracted.toFixed(2),
      unsoldValue: sum((r) => r.unsoldValue).toFixed(2),
      revenue: sum((r) => r.revenue).toFixed(2),
      actual: sum((r) => r.actual).toFixed(2),
      eac: sum((r) => r.eac).toFixed(2),
      pendingVariationCost: sum((r) => r.pendingVariationCost).toFixed(2),
      pendingVariationRevenue: sum((r) => r.pendingVariationRevenue).toFixed(2),
      projectedProfit: projected.toFixed(2),
      recognizedProfit: sum((r) => r.recognizedProfit).toFixed(2),
      marginPct: contracted.gt(0) ? projected.div(contracted).times(100).toDecimalPlaces(1).toFixed(1) : null,
      reporting: rows.length && rows.every((r) => r.reporting)
        ? {
            contractedRevenue: sumRep((r) => r.contractedRevenue)!,
            revenue: sumRep((r) => r.revenue)!,
            actual: sumRep((r) => r.actual)!,
            eac: sumRep((r) => r.eac)!,
            projectedProfit: sumRep((r) => r.projectedProfit)!,
            recognizedProfit: sumRep((r) => r.recognizedProfit)!,
          }
        : null,
    },
    missingRate: rows.reduce((s, r) => s + r.missingRate, 0),
  };
}
