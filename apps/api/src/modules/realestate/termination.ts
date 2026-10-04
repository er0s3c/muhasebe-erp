import { and, asc, eq, sql } from 'drizzle-orm';
import { applyRate, dec, todayIso, toDbAmount, toDbRate, type MoneyValue, type TerminateContractInput } from '@erp/shared';
import type { Tx } from '../../db/client';
import { journalLines, realEstateUnits, salesContracts, salesInstallments, salesTerminations, salesWriteoffs } from '../../db/schema';
import { unprocessable } from '../../http/errors';
import { createJournalEntry, type AutoJournalLine } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { openItemsFor } from '../parties/service';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { assertCashOk, lockTreasuryAccounts } from '../treasury/accounts';
import { releaseCost } from '../treasury/posting';
import { getContract, lockContract, type SalesCtx } from './contracts';

const amountLine = (accountId: string, side: 'debit' | 'credit', doc: MoneyValue, base: MoneyValue, currency: string, fx: MoneyValue, foreign: boolean, extra: Partial<AutoJournalLine> = {}) =>
  ({
    accountId,
    currency,
    ...(foreign ? { fxRate: toDbRate(fx) } : {}),
    debit: side === 'debit' ? toDbAmount(doc) : '0',
    credit: side === 'credit' ? toDbAmount(doc) : '0',
    debitBase: side === 'debit' ? toDbAmount(base) : '0',
    creditBase: side === 'credit' ? toDbAmount(base) : '0',
    ...extra,
  }) as AutoJournalLine;

/**
 * Teslim öncesi fesih + iade. Tek yevmiye:
 *   B 380 (sözleşme bedeli, etkinleşmedeki defter tutarı)
 *   A 120 (ödenmemiş taksit kalemleri, kalem bazında kapatılır) + A 679 (kesinti, proje etiketli) + A kasa/banka (iade)
 *   ± kambiyo (tahsilat günü kurundan fesih günü kuruna fark)
 * Tahsil edilen tutar = kesinti + iade. İade, seçilen kasa/banka hesabından yevmiyeyle ödenir (hesap para birimi:
 * sözleşme ya da defter para birimi).
 */
export async function terminateContract(tx: Tx, ctx: SalesCtx, id: string, input: TerminateContractInput) {
  const c = await lockContract(tx, id);
  if (c.status !== 'active') throw unprocessable('Yalnızca etkin sözleşme feshedilir (teslimden sonra fesih desteklenmez)', 'CONTRACT_NOT_ACTIVE');
  const on = input.date ?? todayIso();
  if (on < c.activatedOn!) throw unprocessable('Fesih tarihi etkinleşme tarihinden önce olamaz', 'TERMINATION_BEFORE_ACTIVATION');
  await requireOpenPeriod(tx, on);

  const foreign = c.currencyCode !== ctx.baseCurrency;
  const fx = foreign ? await requireRate(tx, c.currencyCode, ctx.baseCurrency, on, ctx.baseCurrency) : dec(1);
  const price = dec(c.price);

  // Ödenmemiş kalemler (açık kalem hesabı: tahsilat eşleştirmeleri düşülmüş)
  const inst = await tx.select().from(salesInstallments).where(eq(salesInstallments.contractId, id)).orderBy(asc(salesInstallments.seq));
  const lineIds = new Set(inst.map((i) => i.journalLineId!).filter(Boolean));
  const open = (await openItemsFor(tx, c.partyId, 'receivable', on)).items.filter((o) => lineIds.has(o.lineId));
  const remainingOf = new Map(open.map((o) => [o.lineId, dec(o.remaining)]));
  let collectedPrice = dec(0);
  let collectedFees = dec(0);
  let feesTotal = dec(0);
  for (const i of inst) {
    const paidI = dec(i.amount).minus(remainingOf.get(i.journalLineId!) ?? 0);
    if (i.kind === 'fee') {
      feesTotal = feesTotal.plus(i.amount);
      collectedFees = collectedFees.plus(paidI);
    } else collectedPrice = collectedPrice.plus(paidI);
  }
  const collected = collectedPrice.plus(collectedFees);
  const retained = dec(input.retained);
  if (retained.gt(collectedPrice)) throw unprocessable(`Kesinti (${retained.toFixed(2)}) tahsil edilen sözleşme bedelini (${collectedPrice.toFixed(2)}) aşamaz`, 'TERMINATION_RETAIN_TOO_HIGH');
  // İade: bedelden kesinti sonrası kalan + tahsil edilen fon/harçların tamamı
  const refund = collectedPrice.minus(retained).plus(collectedFees);
  if (refund.gt(0) && !input.refundAccountId) throw unprocessable('İade için kasa/banka hesabı seçin', 'REFUND_ACCOUNT_REQUIRED');

  const map = await requireMappings(tx, ['deferred_revenue', 'receivable', ...(retained.gt(0) ? (['termination_income'] as const) : []), ...(feesTotal.gt(0) ? (['fee_payable'] as const) : [])]);
  const [base380] = await tx.execute<{ base: string }>(sql`select credit_base::text as base from journal_lines where entry_id = ${c.activationEntryId} and account_id = ${map.deferred_revenue} limit 1`).then((r) => r.rows);
  if (!base380) throw unprocessable('Etkinleşme yevmiyesinde ertelenmiş gelir satırı bulunamadı (hesap eşlemesi değişmiş olabilir)', 'DEFERRED_LINE_MISSING');
  const baseFee = feesTotal.gt(0)
    ? (await tx.execute<{ base: string }>(sql`select credit_base::text as base from journal_lines where entry_id = ${c.activationEntryId} and account_id = ${map.fee_payable} limit 1`).then((r) => r.rows[0]))
    : undefined;
  if (feesTotal.gt(0) && !baseFee) throw unprocessable('Etkinleşme yevmiyesinde fon/harç yükümlülük satırı bulunamadı (hesap eşlemesi değişmiş olabilir)', 'FEE_LINE_MISSING');
  const debitBase = dec(base380.base).plus(baseFee?.base ?? 0);

  // Belge tutarı tamamen kapanmış ama kur farkından küçük bir defter kalıntısı kalmış kalem için satır açılmaz (borç/alacak
  // sıfır olamaz); kalıntı aşağıdaki kambiyo satırına düşer.
  const closing = open.filter((o) => dec(o.remaining).gt(0));
  const lines: AutoJournalLine[] = [amountLine(map.deferred_revenue, 'debit', price, dec(base380.base), c.currencyCode, dec(c.activationFx!), foreign, { description: `Fesih ${c.code}: ertelenmiş gelir iptali` })];
  if (feesTotal.gt(0)) lines.push(amountLine(map.fee_payable, 'debit', feesTotal, dec(baseFee!.base), c.currencyCode, dec(c.activationFx!), foreign, { description: `Fesih ${c.code}: fon/harç yükümlülüğü iptali` }));
  let creditsBase = dec(0);
  for (const o of closing) {
    creditsBase = creditsBase.plus(o.remainingBase);
    lines.push(amountLine(map.receivable, 'credit', dec(o.remaining), dec(o.remainingBase), c.currencyCode, dec(c.activationFx!), foreign, { partyId: c.partyId, description: `Fesih ${c.code}: ödenmemiş taksit kapatma` }));
  }
  if (retained.gt(0)) {
    const rb = foreign ? applyRate(retained, fx) : retained;
    creditsBase = creditsBase.plus(rb);
    lines.push(amountLine(map.termination_income, 'credit', retained, rb, c.currencyCode, fx, foreign, { projectId: c.projectId, description: `Fesih ${c.code}: kesinti geliri` }));
  }
  if (refund.gt(0)) {
    const ta = (await lockTreasuryAccounts(tx, [input.refundAccountId!])).get(input.refundAccountId!)!;
    if (!ta.isActive) throw unprocessable(`${ta.name} hesabı pasif`, 'TREASURY_ACCOUNT_INACTIVE');
    if (ta.currencyCode !== ctx.baseCurrency && ta.currencyCode !== c.currencyCode) {
      throw unprocessable('İade hesabı sözleşme ya da defter para biriminde olmalı', 'REFUND_ACCOUNT_CURRENCY');
    }
    const asBase = ta.currencyCode === ctx.baseCurrency;
    const doc = asBase && foreign ? applyRate(refund, fx) : refund;
    await assertCashOk(tx, ta, on, doc);
    const baseOut = asBase ? doc : await releaseCost(tx, ctx, ta, doc, on);
    creditsBase = creditsBase.plus(baseOut);
    lines.push(amountLine(ta.accountId, 'credit', doc, baseOut, ta.currencyCode, asBase ? dec(1) : fx, ta.currencyCode !== ctx.baseCurrency, { description: `Fesih ${c.code}: alıcıya iade` }));
  }
  // Kambiyo: tahsilat/etkinleşme kurundan fesih kuruna fark
  const diff = debitBase.minus(creditsBase);
  if (!diff.isZero()) {
    const fxMap = await requireMappings(tx, [diff.gt(0) ? 'fx_gain' : 'fx_loss'] as const);
    const acct = Object.values(fxMap)[0]!;
    lines.push(amountLine(acct, diff.gt(0) ? 'credit' : 'debit', diff.abs(), diff.abs(), ctx.baseCurrency, dec(1), false, { description: `Fesih ${c.code}: kur farkı` }));
  }

  const text = `Satış sözleşmesi feshi ${c.code}: ${input.reason}`.slice(0, 300);
  const entry = await createJournalEntry(tx, { companyId: ctx.companyId, userId: ctx.userId, baseCurrency: ctx.baseCurrency, reportingCurrency: ctx.reportingCurrency }, { entryDate: on, description: text, lines, post: true }, { source: { type: 'sales_termination', id } });

  // Kasasız kapatma kayıtları: kapatan satırlar fesih yevmiyesinin 120 satırlarıdır (aynı sırada)
  const settle = await tx.select({ id: journalLines.id }).from(journalLines).where(and(eq(journalLines.entryId, entry.id), eq(journalLines.accountId, map.receivable))).orderBy(asc(journalLines.lineNo));
  if (settle.length !== closing.length) throw unprocessable('Fesih satırları kalemlerle eşleşmedi', 'TERMINATION_LINE_MISMATCH');
  if (closing.length > 0) {
    await tx.insert(salesWriteoffs).values(
      closing.map((o, n) => ({
        companyId: ctx.companyId,
        contractId: id,
        partyId: c.partyId,
        chargeLineId: o.lineId,
        settleLineId: settle[n]!.id,
        entryId: entry.id,
        amount: toDbAmount(dec(o.remaining)),
        amountBase: toDbAmount(dec(o.remainingBase)),
      })),
    );
  }
  await tx.insert(salesTerminations).values({
    companyId: ctx.companyId,
    contractId: id,
    terminationDate: on,
    reason: input.reason,
    collected: toDbAmount(collected),
    retained: toDbAmount(retained),
    refund: toDbAmount(refund),
    entryId: entry.id,
    refundAccountId: refund.gt(0) ? input.refundAccountId! : null,
    createdBy: ctx.userId,
  });
  await tx.update(salesContracts).set({ status: 'terminated', terminatedOn: on }).where(eq(salesContracts.id, id));
  await tx.update(realEstateUnits).set({ status: 'available' }).where(eq(realEstateUnits.id, c.unitId));
  return getContract(tx, id);
}
