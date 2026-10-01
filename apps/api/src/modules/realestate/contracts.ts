import { and, asc, eq, sql } from 'drizzle-orm';
import {
  dec,
  isoYear,
  planTotals,
  todayIso,
  toDbAmount,
  toDbRate,
  type CreateSalesContractInput,
  type UpdateSalesContractInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { companies, journalLines, parties, realEstateUnits, salesContracts, salesInstallments } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { createJournalEntry, reverseJournalEntry, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { openItemsFor } from '../parties/service';
import { requireOpenPeriod } from '../settings/periods';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireRate } from '../settings/rates';
import { buildActivationJournal, buildHandoverJournal } from './journal';
import type { RealEstateCtx } from './units';

export interface SalesCtx extends RealEstateCtx {
  reportingCurrency: string | null;
}

const ledgerCtx = (c: SalesCtx): LedgerCtx => ({ companyId: c.companyId, userId: c.userId, baseCurrency: c.baseCurrency, reportingCurrency: c.reportingCurrency });

export async function loadSalesCtx(tx: Tx, companyId: string, userId: string): Promise<SalesCtx> {
  const [c] = await tx.select({ base: companies.baseCurrency, rep: companies.reportingCurrency }).from(companies).where(eq(companies.id, companyId));
  return { companyId, userId, baseCurrency: c!.base, reportingCurrency: c!.rep };
}

export async function lockContract(tx: Tx, id: string) {
  const [row] = await tx.select().from(salesContracts).where(eq(salesContracts.id, id)).for('update');
  if (!row) throw notFound('Satış sözleşmesi');
  return row;
}

/** Plan girdisini doğrular ve sıralar: tarih, sonra peşinat önce. Toplam bedele, peşinat satırları peşinata eşit olmalı. */
function normalizePlan(input: { price: string; downPayment: string; installments: CreateSalesContractInput['installments'] }) {
  const rows = [...input.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (a.kind === 'down_payment' ? -1 : 0) - (b.kind === 'down_payment' ? -1 : 0));
  const t = planTotals(rows, input.price);
  if (!t.ok) throw unprocessable(`Taksit toplamı (${t.total}) sözleşme bedeline (${dec(input.price).toFixed(2)}) eşit olmalı`, 'PLAN_TOTAL_MISMATCH');
  const down = rows.filter((r) => r.kind === 'down_payment').reduce((s, r) => s.plus(r.amount), dec(0));
  if (!down.eq(input.downPayment)) throw unprocessable('Peşinat satırlarının toplamı peşinata eşit olmalı', 'PLAN_DOWN_MISMATCH');
  return rows;
}

async function writeInstallments(tx: Tx, companyId: string, contractId: string, rows: ReturnType<typeof normalizePlan>) {
  await tx.delete(salesInstallments).where(eq(salesInstallments.contractId, contractId));
  await tx.insert(salesInstallments).values(rows.map((r, i) => ({ companyId, contractId, seq: i + 1, kind: r.kind, dueDate: r.dueDate, amount: toDbAmount(dec(r.amount)) })));
}

export async function createContract(tx: Tx, ctx: SalesCtx, input: CreateSalesContractInput) {
  const rows = normalizePlan(input);
  const [unit] = await tx.select().from(realEstateUnits).where(eq(realEstateUnits.id, input.unitId)).for('update');
  if (!unit) throw unprocessable('Birim bulunamadı', 'UNIT_NOT_FOUND');
  const year = isoYear(input.contractDate);
  const code = formatDocumentNumber('SSZ', year, await nextNumber(tx, ctx.companyId, 'SALES_CONTRACT', year));
  const [row] = await tx
    .insert(salesContracts)
    .values({
      companyId: ctx.companyId,
      code,
      unitId: unit.id,
      projectId: unit.projectId,
      partyId: input.partyId,
      contractDate: input.contractDate,
      plannedHandover: input.plannedHandover ?? null,
      currencyCode: input.currencyCode,
      price: toDbAmount(dec(input.price)),
      downPayment: toDbAmount(dec(input.downPayment)),
      penaltyNote: input.penaltyNote ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  await writeInstallments(tx, ctx.companyId, row!.id, rows);
  await tx.update(realEstateUnits).set({ status: 'reserved' }).where(eq(realEstateUnits.id, unit.id));
  return getContract(tx, row!.id);
}

export async function updateContract(tx: Tx, ctx: SalesCtx, id: string, input: UpdateSalesContractInput) {
  const c = await lockContract(tx, id);
  if (c.status !== 'draft') throw unprocessable('Yalnızca taslak sözleşme düzenlenir', 'CONTRACT_NOT_DRAFT');
  const rows = normalizePlan(input);
  await tx
    .update(salesContracts)
    .set({
      contractDate: input.contractDate,
      plannedHandover: input.plannedHandover ?? null,
      price: toDbAmount(dec(input.price)),
      downPayment: toDbAmount(dec(input.downPayment)),
      penaltyNote: input.penaltyNote ?? null,
    })
    .where(eq(salesContracts.id, id));
  await writeInstallments(tx, ctx.companyId, id, rows);
  return getContract(tx, id);
}

/** Etkinleştirme: taksit başına vadeli alıcı alacağı (120) + ertelenmiş gelir (380); birim satıldı. */
export async function activateContract(tx: Tx, ctx: SalesCtx, id: string, date?: string) {
  const c = await lockContract(tx, id);
  if (c.status !== 'draft') throw unprocessable('Yalnızca taslak sözleşme etkinleştirilir', 'CONTRACT_NOT_DRAFT');
  const on = date ?? c.contractDate;
  await requireOpenPeriod(tx, on);
  const inst = await tx.select().from(salesInstallments).where(eq(salesInstallments.contractId, id)).orderBy(asc(salesInstallments.seq));
  const t = planTotals(inst, c.price);
  if (inst.length === 0 || !t.ok) throw unprocessable('Taksit toplamı sözleşme bedeline eşit olmalı', 'PLAN_TOTAL_MISMATCH');
  const fx = c.currencyCode === ctx.baseCurrency ? dec(1) : await requireRate(tx, c.currencyCode, ctx.baseCurrency, on, ctx.baseCurrency);
  const acc = await requireMappings(tx, ['receivable', 'deferred_revenue']);
  const [party] = await tx.select({ name: parties.name }).from(parties).where(eq(parties.id, c.partyId));
  const text = `Gayrimenkul satışı ${c.code} — ${party?.name ?? ''}`.slice(0, 300);

  const built = buildActivationJournal({
    baseCurrency: ctx.baseCurrency,
    currency: c.currencyCode,
    fx,
    partyId: c.partyId,
    description: text,
    receivableAccountId: acc.receivable,
    deferredAccountId: acc.deferred_revenue,
    installments: inst.map((i) => ({ dueDate: i.dueDate, amount: dec(i.amount) })),
  });
  const entry = await createJournalEntry(tx, ledgerCtx(ctx), { entryDate: on, description: text, lines: built.lines, post: true }, { source: { type: 'sales_contract', id } });
  // Taksit → cari kalem: ilk n satır taksitlerdir (sıra korunur)
  const lines = await tx.select({ id: journalLines.id }).from(journalLines).where(and(eq(journalLines.entryId, entry.id), eq(journalLines.accountId, acc.receivable))).orderBy(asc(journalLines.lineNo));
  if (lines.length !== inst.length) throw unprocessable('Taksit satırları yevmiyeyle eşleşmedi', 'PLAN_LINE_MISMATCH');
  for (const [n, i] of inst.entries()) await tx.update(salesInstallments).set({ journalLineId: lines[n]!.id }).where(eq(salesInstallments.id, i.id));
  await tx
    .update(salesContracts)
    .set({ status: 'active', activatedOn: on, activationFx: toDbRate(fx), activationEntryId: entry.id })
    .where(eq(salesContracts.id, id));
  await tx.update(realEstateUnits).set({ status: 'sold' }).where(eq(realEstateUnits.id, c.unitId));
  return getContract(tx, id);
}

/** Teslim: ertelenmiş gelir (380) gelire (600) aktarılır; proje etiketli. */
export async function handoverContract(tx: Tx, ctx: SalesCtx, id: string, date?: string) {
  const c = await lockContract(tx, id);
  if (c.status !== 'active') throw unprocessable('Yalnızca etkin sözleşme teslim edilir', 'CONTRACT_NOT_ACTIVE');
  const on = date ?? todayIso();
  if (on < c.activatedOn!) throw unprocessable('Teslim tarihi etkinleşme tarihinden önce olamaz', 'HANDOVER_BEFORE_ACTIVATION');
  await requireOpenPeriod(tx, on);
  const acc = await requireMappings(tx, ['deferred_revenue', 'property_revenue']);
  const [base] = await tx.execute<{ base: string }>(sql`select credit_base::text as base from journal_lines where entry_id = ${c.activationEntryId} and account_id = ${acc.deferred_revenue} limit 1`).then((r) => r.rows);
  if (!base) throw unprocessable('Etkinleşme yevmiyesinde ertelenmiş gelir satırı bulunamadı (hesap eşlemesi değişmiş olabilir)', 'DEFERRED_LINE_MISSING');
  const text = `Teslim: gayrimenkul satış geliri ${c.code}`.slice(0, 300);
  const lines = buildHandoverJournal({
    baseCurrency: ctx.baseCurrency,
    currency: c.currencyCode,
    fx: dec(c.activationFx!),
    price: dec(c.price),
    baseAmount: dec(base.base),
    projectId: c.projectId,
    deferredAccountId: acc.deferred_revenue,
    revenueAccountId: acc.property_revenue,
    description: text,
  });
  const entry = await createJournalEntry(tx, ledgerCtx(ctx), { entryDate: on, description: text, lines, post: true }, { source: { type: 'sales_handover', id } });
  await tx.update(salesContracts).set({ status: 'handed_over', handedOverOn: on, handoverEntryId: entry.id }).where(eq(salesContracts.id, id));
  await tx.update(realEstateUnits).set({ status: 'handed_over' }).where(eq(realEstateUnits.id, c.unitId));
  return getContract(tx, id);
}

/** İptal: taslak ya da tahsilatsız etkin sözleşme; etkinleşme yevmiyesi ters çevrilir, birim yeniden satışa açılır. */
export async function cancelContract(tx: Tx, ctx: SalesCtx, id: string, reason: string) {
  const c = await lockContract(tx, id);
  if (c.status !== 'draft' && c.status !== 'active') throw unprocessable('Bu durumdaki sözleşme iptal edilemez', 'CONTRACT_CANNOT_CANCEL');
  if (c.status === 'active') {
    await requireOpenPeriod(tx, todayIso());
    await reverseJournalEntry(tx, ledgerCtx(ctx), c.activationEntryId!, { entryDate: todayIso(), description: `Satış sözleşmesi iptali ${c.code}: ${reason}`.slice(0, 300), source: { type: 'sales_contract', id } });
  }
  await tx.update(salesContracts).set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason }).where(eq(salesContracts.id, id));
  await tx.update(realEstateUnits).set({ status: 'available' }).where(eq(realEstateUnits.id, c.unitId));
  return getContract(tx, id);
}

// --- Okuma -----------------------------------------------------------------------------------------------

export async function getContract(tx: Tx, id: string) {
  const head = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.code, c.status, c.contract_date::text as "contractDate", c.planned_handover::text as "plannedHandover",
           c.currency_code as "currencyCode", c.price::text as price, c.down_payment::text as "downPayment", c.recognition,
           c.activated_on::text as "activatedOn", c.activation_fx::text as "activationFx", c.handed_over_on::text as "handedOverOn",
           c.terminated_on::text as "terminatedOn", c.cancel_reason as "cancelReason", c.penalty_note as "penaltyNote",
           c.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
           c.unit_id as "unitId", u.block, u.floor, u.unit_no as "unitNo", u.unit_type as "unitType", u.gross_m_2::text as "grossM2",
           c.party_id as "partyId", pa.name as "partyName",
           c.activation_entry_id as "activationEntryId", c.handover_entry_id as "handoverEntryId"
      from sales_contracts c
      join projects p on p.id = c.project_id
      join real_estate_units u on u.id = c.unit_id
      join parties pa on pa.id = c.party_id
     where c.id = ${id}`);
  const contract = head.rows[0];
  if (!contract) throw notFound('Satış sözleşmesi');
  const inst = await tx.select().from(salesInstallments).where(eq(salesInstallments.contractId, id)).orderBy(asc(salesInstallments.seq));

  const today = todayIso();
  let remainingBy = new Map<string, { remaining: string; daysOverdue: number }>();
  if (contract.status === 'active' || contract.status === 'handed_over') {
    const open = await openItemsFor(tx, String(contract.partyId), 'receivable', today);
    remainingBy = new Map(open.items.map((o) => [o.lineId, { remaining: o.remaining, daysOverdue: o.daysOverdue }]));
  }
  const live = contract.status === 'active' || contract.status === 'handed_over';
  const rows = inst.map((i) => {
    const open = i.journalLineId ? remainingBy.get(i.journalLineId) : undefined;
    const remaining = live ? (open ? dec(open.remaining) : dec(0)) : dec(i.amount);
    const paid = live ? dec(i.amount).minus(remaining) : dec(0);
    return {
      id: i.id,
      seq: i.seq,
      kind: i.kind,
      dueDate: i.dueDate,
      amount: dec(i.amount).toFixed(2),
      journalLineId: i.journalLineId,
      paid: paid.toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue: open && open.daysOverdue > 0 ? open.daysOverdue : 0,
    };
  });
  const paidTotal = rows.reduce((s, r) => s.plus(r.paid), dec(0));
  const [termination] = await tx.execute<Record<string, unknown>>(sql`
    select t.termination_date::text as "terminationDate", t.reason, t.collected::text as collected, t.retained::text as retained, t.refund::text as refund,
           t.refund_transaction_id as "refundTransactionId"
      from sales_terminations t where t.contract_id = ${id}`).then((r) => r.rows);
  return {
    contract: {
      ...contract,
      paid: paidTotal.toFixed(2),
      remaining: live ? dec(String(contract.price)).minus(paidTotal).toFixed(2) : dec(String(contract.price)).toFixed(2),
      overdue: rows.filter((r) => r.daysOverdue > 0).reduce((s, r) => s.plus(r.remaining), dec(0)).toFixed(2),
    },
    installments: rows,
    termination: termination ?? null,
  };
}

export async function listContracts(tx: Tx, q: { projectId?: string; partyId?: string; status?: string }) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.code, c.status, c.contract_date::text as "contractDate", c.currency_code as "currencyCode", c.price::text as price,
           p.code as "projectCode", u.block, u.unit_no as "unitNo", pa.name as "partyName",
           (select count(*)::int from sales_installments i where i.contract_id = c.id) as "installmentCount"
      from sales_contracts c
      join projects p on p.id = c.project_id
      join real_estate_units u on u.id = c.unit_id
      join parties pa on pa.id = c.party_id
     where (${q.projectId ?? null}::uuid is null or c.project_id = ${q.projectId ?? null}::uuid)
       and (${q.partyId ?? null}::uuid is null or c.party_id = ${q.partyId ?? null}::uuid)
       and (${q.status ?? null}::text is null or c.status = ${q.status ?? null}::text)
     order by c.code desc`);
  return { contracts: rows.rows };
}
