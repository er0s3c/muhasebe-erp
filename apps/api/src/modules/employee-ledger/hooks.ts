import { eq, inArray } from 'drizzle-orm';
import { ADVANCE_DEDUCTION_ITEM_CODE, advanceDeductionCap, dec, toDbAmount, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../db/client';
import { employeeAdvanceDeductions, employeeAdvanceSettlements, employeeAdvances, employeeLedgerSettings } from '../../db/schema';
import { unprocessable } from '../../http/errors';

/**
 * Bordro onayı/iptali ile personel cari bağlantısı. Bu dosya bordro çalıştırma koduna (payroll/runs.ts) yalnızca şemaya bağlıdır:
 * döngüsel içe aktarma yoktur (personel cari servisi bordro hesaplamasını çağırır, bordro bu kancaları çağırır).
 */

export async function getLedgerSettings(tx: Tx) {
  const [row] = await tx.select().from(employeeLedgerSettings).limit(1);
  return {
    deductionCapPct: row?.deductionCapPct ?? null,
    sourceNote: row?.sourceNote ?? null,
    verifiedBy: row?.verifiedBy ?? null,
    verifiedAt: row?.verifiedAt ?? null,
  };
}

export interface RunLineLite {
  id: string;
  employeeId: string;
  net: string;
}

/**
 * Bordro onayında avans kesintilerini doğrular ve toplamını döndürür: her personelin kesinti planı toplamı bordro satırındaki
 * "avans kesintisi" kalemine eşit olmalı (aksi hâlde yeniden hesaplanmamış demektir); kullanıcı üst sınırı varsa aşılamaz;
 * avansların kalan tutarı yeterli olmalı (avanslar kilitlenir).
 */
export async function validateRunAdvanceDeductions(tx: Tx, runId: string, lines: readonly RunLineLite[], items: readonly { lineId: string; code: string | null; kind: string; amount: string }[]) {
  const rows = await tx.select().from(employeeAdvanceDeductions).where(eq(employeeAdvanceDeductions.runId, runId));
  const planByEmp = new Map<string, MoneyValue>();
  for (const r of rows) planByEmp.set(r.employeeId, (planByEmp.get(r.employeeId) ?? dec(0)).plus(r.amount));
  const settings = await getLedgerSettings(tx);

  let total = dec(0);
  const lineByEmp = new Map(lines.map((l) => [l.employeeId, l]));
  for (const l of lines) {
    const itemAmt = items.filter((i) => i.lineId === l.id && i.kind === 'deduction' && i.code === ADVANCE_DEDUCTION_ITEM_CODE).reduce((s, i) => s.plus(i.amount), dec(0));
    const plan = planByEmp.get(l.employeeId) ?? dec(0);
    if (!itemAmt.eq(plan)) {
      throw unprocessable('Avans kesintisi planı bordro satırıyla tutarsız; Personel cari ekranından kesintiyi yeniden kaydedin', 'ADVANCE_DEDUCTION_MISMATCH', { employeeId: l.employeeId });
    }
    if (plan.gt(0)) {
      const cap = advanceDeductionCap(dec(l.net).plus(plan).toFixed(2), settings.deductionCapPct);
      if (cap && plan.gt(cap)) {
        throw unprocessable(`Avans kesintisi (${plan.toFixed(2)}) kullanıcı üst sınırını (${cap.toFixed(2)}) aşıyor`, 'ADVANCE_DEDUCTION_CAP', { employeeId: l.employeeId });
      }
    }
    total = total.plus(plan);
  }
  for (const empId of planByEmp.keys()) {
    if (!lineByEmp.has(empId)) throw unprocessable('Avans kesintisi olan personel bordroda yok', 'ADVANCE_DEDUCTION_MISMATCH', { employeeId: empId });
  }

  if (rows.length > 0) {
    const ids = [...new Set(rows.map((r) => r.advanceId))].sort();
    const locked = await tx.select().from(employeeAdvances).where(inArray(employeeAdvances.id, ids)).orderBy(employeeAdvances.id).for('update');
    const byId = new Map(locked.map((a) => [a.id, a]));
    for (const r of rows) {
      const a = byId.get(r.advanceId);
      if (!a || (a.status !== 'open' && a.status !== 'partial') || dec(r.amount).gt(dec(a.amount).minus(a.settledAmount))) {
        throw unprocessable(`${a?.number ?? 'Avans'} kalan tutarı kesintiyi karşılamıyor`, 'ADVANCE_DEDUCTION_EXCEEDS', { advanceId: r.advanceId });
      }
    }
  }
  return { total, rows };
}

/** Onaylanan bordronun avans kesintilerini kapama taksitine çevirir (avanslar ayın son gününde kapanır). */
export async function recordRunAdvanceSettlements(tx: Tx, ctx: { companyId: string; userId: string }, runId: string, runNumber: string, date: string) {
  const rows = await tx.select().from(employeeAdvanceDeductions).where(eq(employeeAdvanceDeductions.runId, runId));
  if (rows.length === 0) return;
  await tx.insert(employeeAdvanceSettlements).values(
    rows.map((r) => ({
      companyId: ctx.companyId,
      advanceId: r.advanceId,
      kind: 'payroll',
      amount: toDbAmount(r.amount),
      settledDate: date,
      payrollRunId: runId,
      note: `Bordro ${runNumber} avans kesintisi`,
      createdBy: ctx.userId,
    })),
  );
}

export async function deleteRunAdvanceDeductions(tx: Tx, runId: string) {
  await tx.delete(employeeAdvanceDeductions).where(eq(employeeAdvanceDeductions.runId, runId));
}

/** Avans kesintisi kalemi dışındaki kesinti toplamı ayrıştırması için: bu koddaki kalem toplamı. */
export const advanceItemTotal = (items: readonly { code: string | null; kind: string; amount: string }[]) =>
  items.filter((i) => i.kind === 'deduction' && i.code === ADVANCE_DEDUCTION_ITEM_CODE).reduce((s, i) => s.plus(i.amount), dec(0));

