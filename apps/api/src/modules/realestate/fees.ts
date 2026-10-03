import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { applyRate, computeFeeAmount, dec, todayIso, type CreateFeeScheduleInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { feeSchedules } from '../../db/schema';
import { notFound } from '../../http/errors';
import { findRate } from '../settings/rates';

export async function listFeeSchedules(tx: Tx, q: { side?: string; date?: string }) {
  const where = [q.side ? eq(feeSchedules.side, q.side) : undefined, q.date ? lte(feeSchedules.validFrom, q.date) : undefined, q.date ? or(isNull(feeSchedules.validTo), gte(feeSchedules.validTo, q.date)) : undefined].filter((x) => x !== undefined);
  const rows = await tx.select().from(feeSchedules).where(where.length ? and(...where) : undefined).orderBy(asc(feeSchedules.code), desc(feeSchedules.validFrom));
  // Tarih verilmişse her kod için geçerli olan en son başlangıçlı kayıt
  if (q.date) {
    const seen = new Set<string>();
    return { feeSchedules: rows.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true))) };
  }
  return { feeSchedules: rows };
}

export async function createFeeSchedule(tx: Tx, companyId: string, input: CreateFeeScheduleInput) {
  const [row] = await tx
    .insert(feeSchedules)
    .values({
      companyId,
      code: input.code,
      name: input.name,
      side: input.side,
      basis: input.basis,
      amount: input.amount,
      currencyCode: input.basis === 'pct_of_price' ? null : (input.currencyCode ?? null),
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      sourceNote: input.sourceNote ?? null,
    })
    .returning();
  return row!;
}

export async function verifyFeeSchedule(tx: Tx, id: string, verifiedBy: string, sourceNote?: string) {
  const [row] = await tx.update(feeSchedules).set({ verifiedBy, verifiedAt: new Date(), ...(sourceNote ? { sourceNote } : {}) }).where(eq(feeSchedules.id, id)).returning();
  if (!row) throw notFound('Fon/harç tarifesi');
  return row;
}

export async function deleteFeeSchedule(tx: Tx, id: string) {
  const rows = await tx.delete(feeSchedules).where(eq(feeSchedules.id, id)).returning({ id: feeSchedules.id });
  if (rows.length === 0) throw notFound('Fon/harç tarifesi');
}

/**
 * Projenin ödeyeceği fon/harç tahmini: tarihte geçerli `project` tarifeleri × projenin birim sayısı / brüt m² / sözleşmeli
 * satış bedeli; bütçeye karşılık gerçekleşen "fon ve harç" maliyet kodu harcamasıyla karşılaştırılır (defter para birimi).
 */
export async function feeEstimate(tx: Tx, projectId: string, asOf: string, base: string) {
  const [project] = await tx.execute<{ id: string }>(sql`select id from projects where id = ${projectId}`).then((r) => r.rows);
  if (!project) throw notFound('Proje');
  const [stats] = await tx.execute<{ units: number; m2: string }>(sql`select count(*)::int as units, coalesce(sum(gross_m_2), 0)::text as m2 from real_estate_units where project_id = ${projectId}`).then((r) => r.rows);
  const [sold] = await tx.execute<{ base: string }>(sql`select coalesce(sum(round(price * activation_fx, 2)), 0)::text as base from sales_contracts where project_id = ${projectId} and status in ('active','handed_over')`).then((r) => r.rows);
  const schedules = (await listFeeSchedules(tx, { side: 'project', date: asOf })).feeSchedules;
  let missing = 0;
  const rows = [];
  let total = dec(0);
  for (const s of schedules) {
    let amountBase: ReturnType<typeof dec>;
    let basisValue: string;
    if (s.basis === 'pct_of_price') {
      amountBase = dec(sold?.base ?? 0).times(s.amount).div(100);
      basisValue = dec(sold?.base ?? 0).toFixed(2);
    } else {
      const raw = dec(computeFeeAmount({ basis: s.basis as 'per_unit' | 'per_m2' | 'fixed', amount: s.amount }, { grossM2: '1' })); // birim tutar
      const qty = s.basis === 'per_unit' ? dec(stats?.units ?? 0) : s.basis === 'per_m2' ? dec(stats?.m2 ?? 0) : dec(1);
      basisValue = qty.toFixed(2);
      const doc = raw.times(qty);
      if (s.currencyCode && s.currencyCode !== base) {
        const rate = await findRate(tx, s.currencyCode, base, asOf, base);
        if (!rate) { missing++; amountBase = dec(0); } else amountBase = applyRate(doc, rate);
      } else amountBase = doc;
    }
    amountBase = amountBase.toDecimalPlaces(2);
    total = total.plus(amountBase);
    rows.push({ id: s.id, code: s.code, name: s.name, basis: s.basis, rate: s.amount, currencyCode: s.currencyCode, basisValue, estimate: amountBase.toFixed(2), verified: !!s.verifiedAt });
  }
  const [actual] = await tx.execute<{ actual: string }>(sql`
    select coalesce(sum(jl.debit_base - jl.credit_base), 0)::text as actual
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted' and je.entry_date <= ${asOf}::date
      join cost_codes cc on cc.id = jl.cost_code_id and cc.kind = 'fee'
     where jl.project_id = ${projectId}`).then((r) => r.rows);
  return {
    asOf,
    baseCurrency: base,
    units: stats?.units ?? 0,
    grossM2: dec(stats?.m2 ?? 0).toFixed(2),
    rows,
    estimate: total.toFixed(2),
    actual: dec(actual?.actual ?? 0).toFixed(2),
    remaining: total.minus(actual?.actual ?? 0).toFixed(2),
    missingRate: missing,
    asOfDefault: todayIso(),
  };
}
