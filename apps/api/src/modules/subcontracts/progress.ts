import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  allocateProportional,
  computeProgress,
  dec,
  isoYear,
  roundMoney,
  todayIso,
  toDbAmount,
  toDbRate,
  type CancelProgressPaymentInput,
  type CreateProgressPaymentInput,
  type GiveAdvanceInput,
  type ReleaseRetentionInput,
  type UpdateProgressPaymentInput,
} from '@erp/shared';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../../db/client';
import {
  companies,
  costCodes,
  progressPaymentDeductions,
  progressPaymentLines,
  progressPayments,
  retentionReleases,
  subcontractAdvances,
  subcontractBoqLines,
  subcontracts,
  taxRates,
  treasuryAccounts,
} from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { requireMappings } from '../ledger/mappings';
import { createJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { postTreasuryTransaction } from '../treasury/posting';
import { cancelRequest, registerApprovalHandler, requestApproval, requestsForDoc, type ApprovalCtx } from '../approvals/service';
import { buildProgressJournal } from './journal';
import { currentRevision, type SubcontractCtx } from './service';

export interface ProgressCtx extends SubcontractCtx {
  baseCurrency: string;
  reportingCurrency: string | null;
}

const ledgerCtx = (c: ProgressCtx): LedgerCtx => ({ companyId: c.companyId, userId: c.userId, baseCurrency: c.baseCurrency, reportingCurrency: c.reportingCurrency });

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function lockPayment(tx: Tx, id: string) {
  const [row] = await tx.select().from(progressPayments).where(eq(progressPayments.id, id)).for('update');
  if (!row) throw notFound('Hakediş');
  return row;
}

async function lockSubcontractRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(subcontracts).where(eq(subcontracts.id, id)).for('update');
  if (!row) throw notFound('Taşeron sözleşmesi');
  return row;
}

// --- Bakiyeler ------------------------------------------------------------------------------------

/** Sözleşme bazında: verilen/mahsup edilen avans, tutulan/iade edilen teminat, kaydedilmiş hakediş brütü. */
export async function getBalances(tx: Tx, subcontractId: string) {
  const r = await tx.execute<Record<string, string>>(sql`
    select
      coalesce((select sum(amount) from subcontract_advances where subcontract_id = ${subcontractId}), 0)::text as "advanceGiven",
      coalesce((select sum(advance) from progress_payments where subcontract_id = ${subcontractId} and status = 'posted'), 0)::text as "advanceRecouped",
      coalesce((select sum(retention) from progress_payments where subcontract_id = ${subcontractId} and status = 'posted'), 0)::text as "retentionHeld",
      coalesce((select sum(amount) from retention_releases where subcontract_id = ${subcontractId}), 0)::text as "retentionReleased",
      coalesce((select sum(gross) from progress_payments where subcontract_id = ${subcontractId} and status = 'posted'), 0)::text as "certifiedGross"`);
  const b = r.rows[0]!;
  return {
    advanceGiven: dec(b.advanceGiven!).toFixed(2),
    advanceRecouped: dec(b.advanceRecouped!).toFixed(2),
    advanceBalance: dec(b.advanceGiven!).minus(b.advanceRecouped!).toFixed(2),
    retentionHeld: dec(b.retentionHeld!).toFixed(2),
    retentionReleased: dec(b.retentionReleased!).toFixed(2),
    retentionBalance: dec(b.retentionHeld!).minus(b.retentionReleased!).toFixed(2),
    certifiedGross: dec(b.certifiedGross!).toFixed(2),
  };
}

// --- Hazırlık (taslak ve gönderme aynı hesabı kullanır) ---------------------------------------------

async function resolveVatRate(tx: Tx, vatCode: string | null | undefined, date: string): Promise<string> {
  if (!vatCode) return '0';
  const rows = await tx.select().from(taxRates).where(eq(taxRates.code, vatCode)).orderBy(desc(taxRates.validFrom));
  const hit = rows.find((r) => r.validFrom <= date && (!r.validTo || r.validTo >= date));
  if (!hit) throw unprocessable(`${vatCode} KDV kodu ${date} tarihinde geçerli değil`, 'VAT_CODE_NOT_FOUND');
  return dec(hit.rate).toFixed(4);
}

type Body = Pick<UpdateProgressPaymentInput, 'periodEnd' | 'vatCode' | 'note' | 'lines' | 'deductions'>;

/** Girdiyi doğrular, önceki kümülatifleri bulur ve tutarları hesaplar (yazmaz). */
async function prepare(tx: Tx, sc: typeof subcontracts.$inferSelect, input: Body) {
  const revision = await currentRevision(tx, sc.id);
  if (!revision) throw unprocessable('Sözleşmenin onaylı revizyonu yok', 'SUBCONTRACT_NO_REVISION');
  const boq = await tx.select().from(subcontractBoqLines).where(eq(subcontractBoqLines.revisionId, revision.id));
  const byKey = new Map(boq.map((l) => [l.lineKey, l]));

  const prevRows = await tx.execute<{ lineKey: string; cum: string }>(sql`
    select p.line_key as "lineKey", max(p.cum_qty)::text as cum
      from progress_payment_lines p join progress_payments pp on pp.id = p.payment_id
     where pp.subcontract_id = ${sc.id} and pp.status = 'posted'
     group by p.line_key`);
  const prevByKey = new Map(prevRows.rows.map((r) => [r.lineKey, dec(r.cum)]));

  const lines = [];
  for (const l of input.lines) {
    const b = byKey.get(l.lineKey);
    if (!b) throw unprocessable('Hakediş satırı sözleşmenin yürürlükteki BOQ\'sunda yok', 'PROGRESS_LINE_UNKNOWN');
    const cum = dec(l.cumulativeQty);
    const prev = prevByKey.get(l.lineKey) ?? dec(0);
    const label = b.itemNo ? `${b.itemNo} ${b.description}` : b.description;
    if (cum.lt(prev)) throw unprocessable(`${label}: kümülatif miktar önceki hakedişten (${prev.toFixed(4)}) az olamaz`, 'PROGRESS_QTY_BELOW_PREVIOUS');
    if (cum.gt(b.quantity)) throw unprocessable(`${label}: kümülatif miktar sözleşme miktarını (${dec(b.quantity).toFixed(4)}) aşamaz`, 'PROGRESS_QTY_OVER_CONTRACT');
    if (cum.eq(prev)) continue; // bu dönem iş yok
    lines.push({ boq: b, prev, cum, thisQty: cum.minus(prev) });
  }
  if (lines.length === 0) throw unprocessable('Bu dönem için ilerleme girilmemiş; en az bir satırda kümülatif miktar artmalı', 'PROGRESS_EMPTY');

  const balances = await getBalances(tx, sc.id);
  const vatRate = await resolveVatRate(tx, input.vatCode, input.periodEnd);
  const calc = computeProgress({
    lines: lines.map((l) => ({ thisQty: l.thisQty.toFixed(4), unitPrice: dec(l.boq.unitPrice).toFixed(4) })),
    vatRate,
    retentionPct: sc.retentionPct,
    advancePct: sc.advanceRecoupPct,
    withholdingPct: sc.withholdingPct,
    advanceBalance: balances.advanceBalance,
    deductions: input.deductions.map((d) => d.amount),
  });
  if (calc.otherDeductions.gt(calc.gross)) throw unprocessable('Diğer kesintiler brüt hakediş tutarını aşamaz', 'PROGRESS_DEDUCTION_TOO_HIGH');
  if (calc.net.isNegative()) throw unprocessable('Net ödenecek tutar negatif olamaz; kesintileri gözden geçirin', 'PROGRESS_NET_NEGATIVE');
  return { lines, calc, vatRate };
}

async function writeBody(tx: Tx, companyId: string, sc: typeof subcontracts.$inferSelect, paymentId: string, input: Body) {
  const { lines, calc, vatRate } = await prepare(tx, sc, input);
  await tx.delete(progressPaymentLines).where(eq(progressPaymentLines.paymentId, paymentId));
  await tx.delete(progressPaymentDeductions).where(eq(progressPaymentDeductions.paymentId, paymentId));
  await tx.insert(progressPaymentLines).values(
    lines.map((l, i) => ({
      companyId,
      paymentId,
      subcontractId: sc.id,
      projectId: sc.projectId,
      lineKey: l.boq.lineKey,
      lineNo: i + 1,
      itemNo: l.boq.itemNo,
      description: l.boq.description,
      unit: l.boq.unit,
      unitPrice: l.boq.unitPrice,
      prevQty: toDbAmount(l.prev),
      cumQty: toDbAmount(l.cum),
      thisQty: toDbAmount(l.thisQty),
      amount: toDbAmount(calc.lineAmounts[i]!),
      wbsId: l.boq.wbsId,
      costCodeId: l.boq.costCodeId,
    })),
  );
  if (input.deductions.length > 0) {
    await tx.insert(progressPaymentDeductions).values(input.deductions.map((d) => ({ companyId, paymentId, description: d.description, amount: toDbAmount(roundMoney(d.amount)) })));
  }
  await tx
    .update(progressPayments)
    .set({
      periodEnd: input.periodEnd,
      vatCode: input.vatCode ?? null,
      vatRate,
      gross: toDbAmount(calc.gross),
      vat: toDbAmount(calc.vat),
      retention: toDbAmount(calc.retention),
      advance: toDbAmount(calc.advance),
      withholding: toDbAmount(calc.withholding),
      otherDeductions: toDbAmount(calc.otherDeductions),
      net: toDbAmount(calc.net),
      note: input.note ?? null,
    })
    .where(eq(progressPayments.id, paymentId));
}

// --- Taslak -----------------------------------------------------------------------------------------

export async function createProgress(tx: Tx, ctx: ProgressCtx, input: CreateProgressPaymentInput) {
  const sc = await lockSubcontractRow(tx, input.subcontractId);
  if (sc.status !== 'active') throw unprocessable('Hakediş yalnızca yürürlükteki sözleşmeye girilir', 'SUBCONTRACT_NOT_ACTIVE');
  const [open] = await tx
    .select({ paymentNo: progressPayments.paymentNo })
    .from(progressPayments)
    .where(and(eq(progressPayments.subcontractId, sc.id), inArray(progressPayments.status, ['draft', 'submitted'])));
  if (open) throw conflict(`Sözleşmede açık bir hakediş var (hakediş ${open.paymentNo}); önce onaylayın, reddedin ya da silin`, 'PROGRESS_OPEN_EXISTS');

  const [last] = await tx.select({ max: sql<number>`coalesce(max(${progressPayments.paymentNo}), 0)::int` }).from(progressPayments).where(eq(progressPayments.subcontractId, sc.id));
  const [row] = await tx
    .insert(progressPayments)
    .values({
      companyId: ctx.companyId,
      subcontractId: sc.id,
      projectId: sc.projectId,
      paymentNo: (last?.max ?? 0) + 1,
      periodEnd: input.periodEnd,
      currencyCode: sc.currencyCode,
      retentionPct: sc.retentionPct,
      advancePct: sc.advanceRecoupPct,
      withholdingPct: sc.withholdingPct,
      createdBy: ctx.userId,
    })
    .returning();
  await writeBody(tx, ctx.companyId, sc, row!.id, input);
  return getProgress(tx, row!.id);
}

export async function updateProgress(tx: Tx, ctx: ProgressCtx, id: string, input: UpdateProgressPaymentInput) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'draft') throw unprocessable('Yalnızca taslak hakediş düzenlenir', 'PROGRESS_NOT_DRAFT');
  const sc = await lockSubcontractRow(tx, p.subcontractId);
  await writeBody(tx, ctx.companyId, sc, id, input);
  return getProgress(tx, id);
}

export async function deleteProgress(tx: Tx, id: string) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'draft') throw unprocessable('Yalnızca taslak hakediş silinir', 'PROGRESS_NOT_DRAFT');
  await tx.delete(progressPayments).where(eq(progressPayments.id, id));
}

// --- Gönderme, onay, kayıt -----------------------------------------------------------------------------

export async function submitProgress(tx: Tx, ctx: ProgressCtx, approvalCtx: ApprovalCtx, id: string) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'draft') throw unprocessable('Yalnızca taslak hakediş onaya gönderilir', 'PROGRESS_NOT_DRAFT');
  const sc = await lockSubcontractRow(tx, p.subcontractId);
  if (sc.status !== 'active') throw unprocessable('Sözleşme yürürlükte değil', 'SUBCONTRACT_NOT_ACTIVE');
  await requireOpenPeriod(tx, p.periodEnd);

  // Gönderme anında yeniden hesapla: avans bakiyesi/KDV oranı taslaktan sonra değişmiş olabilir
  const lines = await tx.select().from(progressPaymentLines).where(eq(progressPaymentLines.paymentId, id)).orderBy(asc(progressPaymentLines.lineNo));
  const deductions = await tx.select().from(progressPaymentDeductions).where(eq(progressPaymentDeductions.paymentId, id));
  await writeBody(tx, ctx.companyId, sc, id, {
    periodEnd: p.periodEnd,
    vatCode: p.vatCode,
    note: p.note,
    lines: lines.map((l) => ({ lineKey: l.lineKey, cumulativeQty: dec(l.cumQty).toFixed(4) })),
    deductions: deductions.map((d) => ({ description: d.description, amount: dec(d.amount).toFixed(2) })),
  });
  const fresh = await lockPayment(tx, id);

  const fx = fresh.currencyCode === ctx.baseCurrency ? dec(1) : await requireRate(tx, fresh.currencyCode, ctx.baseCurrency, fresh.periodEnd, ctx.baseCurrency);
  const grossBase = roundMoney(dec(fresh.gross).times(fx));
  await tx.update(progressPayments).set({ status: 'submitted', submittedAt: new Date(), rejectionNote: null }).where(eq(progressPayments.id, id));
  await requestApproval(tx, approvalCtx, { docType: 'progress_payment', docId: id, projectId: fresh.projectId, amount: grossBase.toFixed(2) });
  return getProgress(tx, id);
}

/** Onaydaki hakedişi geri çeker (taslağa döner). */
export async function withdrawProgress(tx: Tx, approvalCtx: ApprovalCtx, id: string) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'submitted') throw unprocessable('Yalnızca onaydaki hakediş geri çekilir', 'PROGRESS_NOT_SUBMITTED');
  const [pending] = (await requestsForDoc(tx, 'progress_payment', id)).filter((r) => r.status === 'pending');
  if (pending) await cancelRequest(tx, approvalCtx, pending.id);
  await tx.update(progressPayments).set({ status: 'draft', submittedAt: null }).where(eq(progressPayments.id, id));
  return getProgress(tx, id);
}

async function loadLedgerCtx(tx: Tx, companyId: string, userId: string): Promise<ProgressCtx> {
  const [c] = await tx.select({ base: companies.baseCurrency, rep: companies.reportingCurrency }).from(companies).where(eq(companies.id, companyId));
  return { companyId, userId, baseCurrency: c!.base, reportingCurrency: c!.rep };
}

/** Onay tamamlanınca aynı işlemde: numara + yevmiye + belge durumu. */
export async function postProgress(tx: Tx, ctx: ProgressCtx, id: string) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'submitted') throw unprocessable('Yalnızca onaydaki hakediş kaydedilir', 'PROGRESS_NOT_SUBMITTED');
  const sc = await lockSubcontractRow(tx, p.subcontractId);
  if (sc.status !== 'active') throw unprocessable('Sözleşme yürürlükte değil', 'SUBCONTRACT_NOT_ACTIVE');
  await requireOpenPeriod(tx, p.periodEnd);

  const lines = await tx.select().from(progressPaymentLines).where(eq(progressPaymentLines.paymentId, id)).orderBy(asc(progressPaymentLines.lineNo));
  const fx = p.currencyCode === ctx.baseCurrency ? dec(1) : await requireRate(tx, p.currencyCode, ctx.baseCurrency, p.periodEnd, ctx.baseCurrency);

  const gross = dec(p.gross);
  const other = dec(p.otherDeductions);
  const need = ['subcontract_cost', 'payable'] as ('subcontract_cost' | 'payable' | 'vat_input' | 'retention_payable' | 'withholding_payable' | 'subcontract_advance')[];
  if (!dec(p.vat).isZero()) need.push('vat_input');
  if (!dec(p.retention).isZero()) need.push('retention_payable');
  if (!dec(p.withholding).isZero()) need.push('withholding_payable');
  if (!dec(p.advance).isZero()) need.push('subcontract_advance');
  const acc = await requireMappings(tx, need);

  // Varsayılan maliyet kodu: BOQ satırında yoksa "taşeron" türündeki ilk aktif kod
  const [defaultCode] = await tx.select({ id: costCodes.id }).from(costCodes).where(and(eq(costCodes.kind, 'subcontract'), eq(costCodes.isActive, true))).orderBy(asc(costCodes.code)).limit(1);

  // Maliyet satırları iş kalemi + maliyet kodu bazında; diğer kesinti brütle orantılı dağıtılır (kuruş artığı yok)
  const groups = new Map<string, { wbsId: string; costCodeId: string | null; gross: ReturnType<typeof dec> }>();
  for (const l of lines) {
    const codeId = l.costCodeId ?? defaultCode?.id ?? null;
    const key = `${l.wbsId}|${codeId ?? ''}`;
    const g = groups.get(key) ?? { wbsId: l.wbsId, costCodeId: codeId, gross: dec(0) };
    g.gross = g.gross.plus(l.amount);
    groups.set(key, g);
  }
  const list = [...groups.values()];
  const shares = allocateProportional(other, list.map((g) => g.gross.toFixed(2)));
  const costGroups = list.map((g, i) => ({ projectId: p.projectId, wbsId: g.wbsId, costCodeId: g.costCodeId, amount: g.gross.minus(shares[i]!) }));
  if (costGroups.some((g) => g.amount.isNegative())) throw unprocessable('Kesintiler iş kalemi tutarını aşıyor', 'PROGRESS_DEDUCTION_TOO_HIGH');

  const [party] = await tx.execute<{ name: string }>(sql`select name from parties where id = ${sc.partyId}`).then((r) => r.rows);
  const year = isoYear(p.periodEnd);
  const seq = await nextNumber(tx, ctx.companyId, 'PRG', year);
  const number = formatDocumentNumber('HKD', year, seq);
  const text = `Taşeron hakedişi ${number} — ${party?.name ?? ''} (${sc.code}, hakediş ${p.paymentNo})`.slice(0, 300);

  const built = buildProgressJournal({
    baseCurrency: ctx.baseCurrency,
    currency: p.currencyCode,
    fx,
    partyId: sc.partyId,
    dueDate: addDays(p.periodEnd, sc.paymentDays),
    description: text,
    accounts: {
      cost: acc.subcontract_cost,
      payable: acc.payable,
      vatInput: (acc as Record<string, string>).vat_input ?? '',
      retention: (acc as Record<string, string>).retention_payable ?? '',
      withholding: (acc as Record<string, string>).withholding_payable ?? '',
      advance: (acc as Record<string, string>).subcontract_advance ?? '',
    },
    costGroups,
    vat: dec(p.vat),
    retention: dec(p.retention),
    withholding: dec(p.withholding),
    advance: dec(p.advance),
  });
  if (!built.net.eq(p.net) || !built.net.gt(0)) {
    // Savunma: hesap (computeProgress) ile yevmiye kimliği ayrışırsa kaydetme
    if (!(built.net.isZero() && dec(p.net).isZero())) throw unprocessable('Hakediş net tutarı yevmiyeyle uyuşmuyor', 'PROGRESS_NET_MISMATCH');
  }
  if (gross.lte(0)) throw unprocessable('Brüt hakediş sıfır olamaz', 'PROGRESS_EMPTY');

  const entry = await createJournalEntry(
    tx,
    ledgerCtx(ctx),
    { entryDate: p.periodEnd, description: text, lines: built.lines, post: true },
    { source: { type: 'progress_payment', id } },
  );
  await tx
    .update(progressPayments)
    .set({ status: 'posted', number, entryId: entry.id, fxRate: toDbRate(fx), postedAt: new Date() })
    .where(eq(progressPayments.id, id));
  return getProgress(tx, id);
}

// Onay motoru bu belge türünü sonuçlandırınca çalışır (aynı işlem)
registerApprovalHandler('progress_payment', {
  async onResolved(tx, ctx, request, outcome) {
    if (outcome === 'approved') {
      await postProgress(tx, await loadLedgerCtx(tx, ctx.companyId, ctx.userId), request.docId);
      return;
    }
    const note = [...request.steps].reverse().find((s) => s.status === 'rejected')?.note ?? null;
    await tx.update(progressPayments).set({ status: 'draft', submittedAt: null, rejectionNote: note }).where(eq(progressPayments.id, request.docId));
  },
});

// --- İptal ------------------------------------------------------------------------------------------------

export async function cancelProgress(tx: Tx, ctx: ProgressCtx, id: string, input: CancelProgressPaymentInput) {
  const p = await lockPayment(tx, id);
  if (p.status !== 'posted') throw unprocessable('Yalnızca kaydedilmiş hakediş iptal edilir', 'PROGRESS_NOT_POSTED');
  await lockSubcontractRow(tx, p.subcontractId);

  const [later] = await tx.select({ no: progressPayments.paymentNo }).from(progressPayments).where(and(eq(progressPayments.subcontractId, p.subcontractId), eq(progressPayments.status, 'posted'), sql`${progressPayments.paymentNo} > ${p.paymentNo}`));
  if (later) throw unprocessable(`Daha sonraki hakediş (${later.no}) kaydedilmiş; önce onu iptal edin`, 'PROGRESS_LATER_EXISTS');

  const paid = await tx.execute(sql`
    select 1 from party_allocations pa
      join journal_lines jl on jl.id = pa.charge_line_id
      join treasury_transactions t on t.id = pa.transaction_id and t.status = 'posted'
     where jl.entry_id = ${p.entryId} limit 1`);
  if (paid.rows.length > 0) throw unprocessable('Bu hakedişe ödeme eşleştirilmiş; önce ödemeyi iptal edin', 'PROGRESS_HAS_PAYMENTS');

  const bal = await getBalances(tx, p.subcontractId);
  if (dec(bal.retentionReleased).gt(dec(bal.retentionHeld).minus(p.retention))) {
    throw unprocessable('Bu hakedişin teminatı kısmen iade edilmiş; iade tutarı kalan teminatı aşıyor', 'PROGRESS_RETENTION_RELEASED');
  }

  const entryDate = input.entryDate ?? todayIso();
  await reverseJournalEntry(tx, ledgerCtx(ctx), p.entryId!, { entryDate, description: `Hakediş iptali ${p.number}: ${input.reason}`.slice(0, 300), source: { type: 'progress_payment', id } });
  await tx.update(progressPayments).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: input.reason }).where(eq(progressPayments.id, id));
  return getProgress(tx, id);
}

// --- Avans ve teminat iadesi -----------------------------------------------------------------------------------

export async function giveAdvance(tx: Tx, ctx: ProgressCtx, subcontractId: string, input: GiveAdvanceInput) {
  const sc = await lockSubcontractRow(tx, subcontractId);
  if (sc.status !== 'active') throw unprocessable('Avans yalnızca yürürlükteki sözleşmeye verilir', 'SUBCONTRACT_NOT_ACTIVE');
  const [account] = await tx.select().from(treasuryAccounts).where(eq(treasuryAccounts.id, input.accountId));
  if (!account) throw unprocessable('Kasa/banka hesabı bulunamadı', 'TREASURY_ACCOUNT_NOT_FOUND');
  if (account.currencyCode !== sc.currencyCode) {
    throw unprocessable(`Avans, sözleşme para biriminde (${sc.currencyCode}) bir kasa/banka hesabından verilir`, 'ADVANCE_CURRENCY_MISMATCH');
  }
  const acc = await requireMappings(tx, ['subcontract_advance']);
  const txn = await postTreasuryTransaction(tx, ledgerCtx(ctx), {
    type: 'other_payment',
    date: input.date,
    accountId: input.accountId,
    amount: input.amount,
    glAccountId: acc.subcontract_advance,
    description: `Taşeron avansı — ${sc.code}${input.note ? `: ${input.note}` : ''}`.slice(0, 300),
    items: [],
  } as never);
  const txnId = (txn as unknown as { transaction?: { id: string }; id?: string }).transaction?.id ?? (txn as unknown as { id: string }).id;
  await tx.insert(subcontractAdvances).values({ companyId: ctx.companyId, subcontractId, advanceDate: input.date, amount: toDbAmount(dec(input.amount)), transactionId: txnId, note: input.note ?? null, createdBy: ctx.userId });
  return getBalances(tx, subcontractId);
}

export async function releaseRetention(tx: Tx, ctx: ProgressCtx, subcontractId: string, input: ReleaseRetentionInput) {
  const sc = await lockSubcontractRow(tx, subcontractId);
  const bal = await getBalances(tx, subcontractId);
  const amount = dec(input.amount);
  if (amount.gt(bal.retentionBalance)) throw unprocessable(`İade tutarı tutulan teminat bakiyesini (${bal.retentionBalance}) aşamaz`, 'RETENTION_OVER_BALANCE');
  await requireOpenPeriod(tx, input.date);
  const acc = await requireMappings(tx, ['retention_payable', 'payable']);
  const fx = sc.currencyCode === ctx.baseCurrency ? dec(1) : await requireRate(tx, sc.currencyCode, ctx.baseCurrency, input.date, ctx.baseCurrency);
  const foreign = sc.currencyCode !== ctx.baseCurrency;
  const base = foreign ? roundMoney(amount.times(fx)) : amount;
  const common = { currency: sc.currencyCode, ...(foreign ? { fxRate: toDbRate(fx) } : {}) };
  const releaseId = randomUUID();
  const entry = await createJournalEntry(
    tx,
    ledgerCtx(ctx),
    {
      entryDate: input.date,
      description: `Teminat iadesi — ${sc.code}${input.note ? `: ${input.note}` : ''}`.slice(0, 300),
      post: true,
      lines: [
        { ...common, accountId: acc.retention_payable, debit: toDbAmount(amount), credit: '0', debitBase: toDbAmount(base), creditBase: '0', description: 'Teminat iadesi' },
        { ...common, accountId: acc.payable, debit: '0', credit: toDbAmount(amount), debitBase: '0', creditBase: toDbAmount(base), partyId: sc.partyId, dueDate: input.date, description: 'Teminat iadesi' },
      ] as never,
    },
    { source: { type: 'retention_release', id: releaseId } },
  );
  await tx.insert(retentionReleases).values({ id: releaseId, companyId: ctx.companyId, subcontractId, releaseDate: input.date, amount: toDbAmount(amount), entryId: entry.id, note: input.note ?? null, createdBy: ctx.userId });
  return getBalances(tx, subcontractId);
}

// --- Okuma ----------------------------------------------------------------------------------------------------------

export async function getProgress(tx: Tx, id: string) {
  const r = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.subcontract_id as "subcontractId", s.code as "subcontractCode", s.title as "subcontractTitle",
           p.project_id as "projectId", pr.code as "projectCode", pa.id as "partyId", pa.name as "partyName",
           p.payment_no as "paymentNo", p.number, p.period_end::text as "periodEnd", p.status, p.currency_code as "currencyCode",
           p.fx_rate::text as "fxRate", p.vat_code as "vatCode", p.vat_rate::text as "vatRate",
           p.retention_pct::text as "retentionPct", p.advance_pct::text as "advancePct", p.withholding_pct::text as "withholdingPct",
           round(p.gross, 2)::text as gross, round(p.vat, 2)::text as vat, round(p.retention, 2)::text as retention, round(p.advance, 2)::text as advance,
           round(p.withholding, 2)::text as withholding, round(p.other_deductions, 2)::text as "otherDeductions", round(p.net, 2)::text as net,
           p.note, p.rejection_note as "rejectionNote", p.entry_id as "entryId",
           p.submitted_at as "submittedAt", p.posted_at as "postedAt", p.cancelled_at as "cancelledAt", p.cancel_reason as "cancelReason",
           p.created_at as "createdAt"
      from progress_payments p
      join subcontracts s on s.id = p.subcontract_id
      join projects pr on pr.id = p.project_id
      join parties pa on pa.id = s.party_id
     where p.id = ${id}`);
  const payment = r.rows[0];
  if (!payment) throw notFound('Hakediş');
  const lines = await tx.execute<Record<string, unknown>>(sql`
    select l.id, l.line_key as "lineKey", l.line_no as "lineNo", l.item_no as "itemNo", l.description, l.unit,
           l.unit_price::text as "unitPrice", l.prev_qty::text as "prevQty", l.cum_qty::text as "cumQty", l.this_qty::text as "thisQty",
           round(l.amount, 2)::text as amount, l.wbs_id as "wbsId", w.code as "wbsCode", l.cost_code_id as "costCodeId", c.code as "costCode"
      from progress_payment_lines l join project_wbs w on w.id = l.wbs_id left join cost_codes c on c.id = l.cost_code_id
     where l.payment_id = ${id} order by l.line_no`);
  const deductionRows = await tx.select({ id: progressPaymentDeductions.id, description: progressPaymentDeductions.description, amount: progressPaymentDeductions.amount }).from(progressPaymentDeductions).where(eq(progressPaymentDeductions.paymentId, id));
  const deductions = deductionRows.map((d) => ({ ...d, amount: dec(d.amount).toFixed(2) }));
  const approvals = await requestsForDoc(tx, 'progress_payment', id);
  return { payment, lines: lines.rows, deductions, approvals };
}

export async function listProgress(tx: Tx, q: { subcontractId?: string; projectId?: string; status?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.number, p.payment_no as "paymentNo", p.status, p.period_end::text as "periodEnd",
           p.subcontract_id as "subcontractId", s.code as "subcontractCode", pa.name as "partyName",
           p.project_id as "projectId", pr.code as "projectCode", p.currency_code as "currencyCode",
           round(p.gross, 2)::text as gross, round(p.net, 2)::text as net
      from progress_payments p
      join subcontracts s on s.id = p.subcontract_id
      join projects pr on pr.id = p.project_id
      join parties pa on pa.id = s.party_id
     where (${q.subcontractId ?? null}::uuid is null or p.subcontract_id = ${q.subcontractId ?? null}::uuid)
       and (${q.projectId ?? null}::uuid is null or p.project_id = ${q.projectId ?? null}::uuid)
       and (${q.status ?? null}::text is null or p.status = ${q.status ?? null}::text)
     order by p.created_at desc`);
  return { payments: rows.rows };
}
