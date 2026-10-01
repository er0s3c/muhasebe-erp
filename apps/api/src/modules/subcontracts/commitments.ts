import { sql } from 'drizzle-orm';
import { dec, roundMoney, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies } from '../../db/schema';
import { findRate } from '../settings/rates';

export interface CommittedResult {
  /** İş kalemi (yaprak) → kalan taahhüt (defter para birimi). */
  byWbs: Map<string, MoneyValue>;
  /** Kuru bulunamadığı için hesaba katılamayan sözleşme sayısı (tutar eksik olabilir). */
  missingRate: number;
  /** Yürürlükteki taşeron sözleşme sayısı. */
  contracts: number;
}

/**
 * Kalan taahhüt (yalnızca yürürlükteki sözleşmeler): yürürlükteki revizyonun BOQ tutarı − kaydedilmiş hakedişlerdeki
 * brüt (asOf tarihine kadar). İptal edilmiş hakediş sayılmaz. Hakediş para biriminden defter para birimine asOf
 * tarihindeki kurla çevrilir; kur yoksa o sözleşme hesaba katılmaz ve `missingRate` artar (sessiz yanlış değer yok).
 * Türetilir, depolanmaz: gerçekleşen maliyet gibi tek kaynaktan beslenir.
 */
export async function loadCommitted(tx: Tx, projectId: string, asOf: string): Promise<CommittedResult> {
  const [company] = await tx.select({ base: companies.baseCurrency }).from(companies);
  const base = company!.base;
  const rows = await tx.execute<{ wbsId: string; currency: string; remaining: string; subcontractId: string }>(sql`
    with cur as (
      select distinct on (r.subcontract_id) r.id, r.subcontract_id
        from subcontract_revisions r where r.status = 'approved'
       order by r.subcontract_id, r.revision_no desc
    )
    select l.wbs_id as "wbsId", s.currency_code as currency, s.id as "subcontractId",
           greatest(
             round(l.quantity * l.unit_price, 2)
             - coalesce((select sum(pl.amount)
                           from progress_payment_lines pl join progress_payments pp on pp.id = pl.payment_id
                          where pp.subcontract_id = l.subcontract_id and pp.status = 'posted'
                            and pp.period_end <= ${asOf}::date and pl.line_key = l.line_key), 0),
             0)::text as remaining
      from cur
      join subcontract_boq_lines l on l.revision_id = cur.id
      join subcontracts s on s.id = l.subcontract_id
     where s.project_id = ${projectId} and s.status = 'active'`);

  const byWbs = new Map<string, MoneyValue>();
  const rateByCurrency = new Map<string, MoneyValue | null>();
  const missing = new Set<string>();
  const contracts = new Set<string>();
  for (const r of rows.rows) {
    contracts.add(r.subcontractId);
    let rate: MoneyValue | null;
    if (r.currency === base) rate = dec(1);
    else {
      if (!rateByCurrency.has(r.currency)) rateByCurrency.set(r.currency, await findRate(tx, r.currency, base, asOf, base));
      rate = rateByCurrency.get(r.currency) ?? null;
    }
    if (!rate) {
      missing.add(r.subcontractId);
      continue;
    }
    byWbs.set(r.wbsId, (byWbs.get(r.wbsId) ?? dec(0)).plus(roundMoney(dec(r.remaining).times(rate))));
  }
  return { byWbs, missingRate: missing.size, contracts: contracts.size };
}
