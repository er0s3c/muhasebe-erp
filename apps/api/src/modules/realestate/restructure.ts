import { and, asc, eq, sql } from 'drizzle-orm';
import { dec, roundMoney, todayIso, toDbAmount, toDbRate, type MoneyValue, type RestructureContractInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { journalLines, salesInstallments, salesRestructures, salesWriteoffs } from '../../db/schema';
import { unprocessable } from '../../http/errors';
import { createJournalEntry, type AutoJournalLine } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { openItemsFor } from '../parties/service';
import { requireOpenPeriod } from '../settings/periods';
import { getContract, lockContract, type SalesCtx } from './contracts';

/**
 * Taksit planını yeniden yapılandırma (öneri 92). Tek yevmiye, 120 hesabı içinde:
 *   A 120 (eski ödenmemiş taksit kalanları, kalem bazında kapatılır; defter tutarı açık kalemin kalanıdır)
 *   B 120 (yeni taksitler, yeni vadelerle; defter tutarı aynı toplamın oranıyla dağıtılır)
 * Böylece kur farkı doğmaz, tahsilatlar ve eski satırlar değişmez; eski taksit "yapılandırıldı" olarak işaretlenir.
 * Fon/harç kalemleri yapılandırılmaz.
 */
export async function restructureContract(tx: Tx, ctx: SalesCtx, id: string, input: RestructureContractInput) {
  const c = await lockContract(tx, id);
  if (c.status !== 'active' && c.status !== 'handed_over')
    throw unprocessable('Yalnız etkin ya da teslim edilmiş sözleşmenin taksitleri yeniden yapılandırılır', 'CONTRACT_NOT_LIVE');
  const on = input.date ?? todayIso();
  if (on < c.activatedOn!) throw unprocessable('Yapılandırma tarihi etkinleşmeden önce olamaz', 'RESTRUCTURE_BEFORE_ACTIVATION');
  await requireOpenPeriod(tx, on);
  if (input.installments.some((i) => i.dueDate < on)) throw unprocessable('Yeni taksit vadeleri yapılandırma tarihinden önce olamaz', 'RESTRUCTURE_DUE_BEFORE_DATE');
  if (new Set(input.installments.map((i) => i.dueDate)).size !== input.installments.length)
    throw unprocessable('Yeni taksit vadeleri farklı olmalı', 'RESTRUCTURE_DUPLICATE_DUE');

  const inst = await tx.select().from(salesInstallments).where(eq(salesInstallments.contractId, id)).orderBy(asc(salesInstallments.seq));
  const candidates = inst.filter((i) => i.kind !== 'fee' && i.journalLineId && !i.restructuredIn);
  const lineIds = new Set(candidates.map((i) => i.journalLineId!));
  const open = (await openItemsFor(tx, c.partyId, 'receivable', on)).items.filter((o) => lineIds.has(o.lineId) && dec(o.remaining).gt(0));
  if (open.length === 0) throw unprocessable('Yeniden yapılandırılacak ödenmemiş taksit yok', 'RESTRUCTURE_NOTHING_OPEN');
  const remaining = open.reduce<MoneyValue>((s, o) => s.plus(o.remaining), dec(0));
  const remainingBase = open.reduce<MoneyValue>((s, o) => s.plus(o.remainingBase), dec(0));
  const newTotal = input.installments.reduce<MoneyValue>((s, i) => s.plus(i.amount), dec(0));
  if (!newTotal.eq(remaining))
    throw unprocessable(
      `Yeni taksitlerin toplamı (${newTotal.toFixed(2)}) ödenmemiş kalana (${remaining.toFixed(2)} ${c.currencyCode}) eşit olmalı`,
      'RESTRUCTURE_TOTAL_MISMATCH',
      { remaining: remaining.toFixed(2) },
    );

  const foreign = c.currencyCode !== ctx.baseCurrency;
  const fx = dec(c.activationFx!);
  const { receivable } = await requireMappings(tx, ['receivable']);
  const text = `Taksit yeniden yapılandırma ${c.code}: ${input.reason}`.slice(0, 300);
  const line = (side: 'debit' | 'credit', doc: MoneyValue, base: MoneyValue, extra: Partial<AutoJournalLine>) =>
    ({
      accountId: receivable,
      currency: c.currencyCode,
      ...(foreign ? { fxRate: toDbRate(fx) } : {}),
      debit: side === 'debit' ? toDbAmount(doc) : '0',
      credit: side === 'credit' ? toDbAmount(doc) : '0',
      debitBase: side === 'debit' ? toDbAmount(base) : '0',
      creditBase: side === 'credit' ? toDbAmount(base) : '0',
      partyId: c.partyId,
      ...extra,
    }) as AutoJournalLine;
  const lines: AutoJournalLine[] = open.map((o) => line('credit', dec(o.remaining), dec(o.remainingBase), { description: `${c.code}: yapılandırılan taksit kalanı` }));
  // Yeni taksitlerin defter tutarı: toplam defter kalanı orantılı, son taksit kalanı alır (kur farkı doğmaz)
  let baseLeft = remainingBase;
  input.installments.forEach((n, i) => {
    const base = i === input.installments.length - 1 ? baseLeft : roundMoney(remainingBase.times(n.amount).div(remaining));
    baseLeft = baseLeft.minus(base);
    lines.push(line('debit', dec(n.amount), base, { dueDate: n.dueDate, description: `${c.code}: yeni taksit` }));
  });
  const entry = await createJournalEntry(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency },
    { entryDate: on, description: text, lines, post: true },
    { source: { type: 'sales_restructure', id } },
  );
  const written = await tx
    .select({ id: journalLines.id, credit: journalLines.credit, debit: journalLines.debit })
    .from(journalLines)
    .where(and(eq(journalLines.entryId, entry.id), eq(journalLines.accountId, receivable)))
    .orderBy(asc(journalLines.lineNo));
  const settleLines = written.filter((l) => dec(l.credit).gt(0));
  const newLines = written.filter((l) => dec(l.debit).gt(0));
  if (settleLines.length !== open.length || newLines.length !== input.installments.length)
    throw unprocessable('Yapılandırma satırları kalemlerle eşleşmedi', 'RESTRUCTURE_LINE_MISMATCH');

  const oldPlan = open.map((o) => {
    const i = candidates.find((x) => x.journalLineId === o.lineId)!;
    return { installmentId: i.id, seq: i.seq, dueDate: i.dueDate, amount: dec(i.amount).toFixed(2), remaining: dec(o.remaining).toFixed(2) };
  });
  const [r] = await tx
    .insert(salesRestructures)
    .values({
      companyId: ctx.companyId,
      contractId: id,
      restructureDate: on,
      reason: input.reason,
      oldPlan,
      newPlan: input.installments.map((n) => ({ dueDate: n.dueDate, amount: dec(n.amount).toFixed(2) })),
      amount: toDbAmount(remaining),
      entryId: entry.id,
      createdBy: ctx.userId,
    })
    .returning({ id: salesRestructures.id });
  await tx.insert(salesWriteoffs).values(
    open.map((o, n) => ({
      companyId: ctx.companyId,
      contractId: id,
      partyId: c.partyId,
      chargeLineId: o.lineId,
      settleLineId: settleLines[n]!.id,
      entryId: entry.id,
      amount: toDbAmount(dec(o.remaining)),
      amountBase: toDbAmount(dec(o.remainingBase)),
      restructureId: r!.id,
    })),
  );
  for (const o of open) {
    const i = candidates.find((x) => x.journalLineId === o.lineId)!;
    await tx.update(salesInstallments).set({ restructuredIn: r!.id }).where(eq(salesInstallments.id, i.id));
  }
  const maxSeq = inst.reduce((m, i) => Math.max(m, i.seq), 0);
  await tx.insert(salesInstallments).values(
    input.installments.map((n, k) => ({
      companyId: ctx.companyId,
      contractId: id,
      seq: maxSeq + k + 1,
      kind: 'installment',
      dueDate: n.dueDate,
      amount: toDbAmount(dec(n.amount)),
      journalLineId: newLines[k]!.id,
      restructureId: r!.id,
    })),
  );
  return getContract(tx, id);
}

/** Sözleşmenin yapılandırma geçmişi (eski/yeni plan ve gerekçe). */
export async function contractRestructures(tx: Tx, contractId: string) {
  const rows = await tx.execute<{ id: string; restructure_date: string; reason: string; old_plan: unknown; new_plan: unknown; amount: string; user_name: string | null; created_at: string }>(sql`
    select r.id, r.restructure_date::text, r.reason, r.old_plan, r.new_plan, r.amount::text, u.full_name as user_name, r.created_at::text
      from sales_restructures r left join users u on u.id = r.created_by
     where r.contract_id = ${contractId} order by r.created_at`);
  return rows.rows.map((r) => ({ id: r.id, date: r.restructure_date, reason: r.reason, oldPlan: r.old_plan, newPlan: r.new_plan, amount: dec(r.amount).toFixed(2), userName: r.user_name, createdAt: r.created_at }));
}
