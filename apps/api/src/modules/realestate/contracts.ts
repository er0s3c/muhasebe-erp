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
  // Fon/harç satırları bedele sayılmaz
  const priced = rows.filter((r) => r.kind !== 'fee');
  const t = planTotals(priced, input.price);
  if (!t.ok) throw unprocessable(`Taksit toplamı (${t.total}) sözleşme bedeline (${dec(input.price).toFixed(2)}) eşit olmalı`, 'PLAN_TOTAL_MISMATCH');
  const down = rows.filter((r) => r.kind === 'down_payment').reduce((s, r) => s.plus(r.amount), dec(0));
  if (!down.eq(input.downPayment)) throw unprocessable('Peşinat satırlarının toplamı peşinata eşit olmalı', 'PLAN_DOWN_MISMATCH');
  for (const r of rows) if (r.kind === 'fee' && !(r.label ?? '').trim()) throw unprocessable('Fon/harç satırı için ad gerekli', 'FEE_LABEL_REQUIRED');
  return rows;
}

async function writeInstallments(tx: Tx, companyId: string, contractId: string, rows: ReturnType<typeof normalizePlan>) {
  await tx.delete(salesInstallments).where(eq(salesInstallments.contractId, contractId));
  await tx.insert(salesInstallments).values(rows.map((r, i) => ({ companyId, contractId, seq: i + 1, kind: r.kind, dueDate: r.dueDate, amount: toDbAmount(dec(r.amount)), feeScheduleId: r.kind === 'fee' ? (r.feeScheduleId ?? null) : null, label: r.kind === 'fee' ? (r.label ?? '').trim() : null })));
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
  const t = planTotals(inst.filter((i) => i.kind !== 'fee'), c.price);
  if (inst.length === 0 || !t.ok) throw unprocessable('Taksit toplamı sözleşme bedeline eşit olmalı', 'PLAN_TOTAL_MISMATCH');
  const fx = c.currencyCode === ctx.baseCurrency ? dec(1) : await requireRate(tx, c.currencyCode, ctx.baseCurrency, on, ctx.baseCurrency);
  const hasFees = inst.some((i) => i.kind === 'fee');
  const acc = await requireMappings(tx, ['receivable', 'deferred_revenue', ...(hasFees ? (['fee_payable'] as const) : [])]);
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
    feeAccountId: hasFees ? acc.fee_payable : undefined,
    installments: inst.map((i) => ({ dueDate: i.dueDate, amount: dec(i.amount), fee: i.kind === 'fee', label: i.label })),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ContractHead = Record<string, any>;

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
  // Feshedilmiş sözleşmede ödenmemiş kısım kasasız kapatılmıştır
  const writtenOff = new Map<string, string>();
  if (contract.status === 'terminated') {
    for (const w of (await tx.execute<{ id: string; amount: string }>(sql`select charge_line_id as id, sum(amount)::text as amount from sales_writeoffs where contract_id = ${id} group by charge_line_id`)).rows) writtenOff.set(w.id, w.amount);
  }
  const rows = inst.map((i) => {
    const raw = i.journalLineId ? remainingBy.get(i.journalLineId) : undefined;
    const open = raw && dec(raw.remaining).gt(0) ? raw : undefined;
    const off = i.journalLineId ? writtenOff.get(i.journalLineId) : undefined;
    const closed = contract.status === 'terminated';
    const remaining = closed ? dec(0) : live ? (open ? dec(open.remaining) : dec(0)) : dec(i.amount);
    const paid = closed ? dec(i.amount).minus(off ?? 0) : live ? dec(i.amount).minus(remaining) : dec(0);
    return {
      id: i.id,
      seq: i.seq,
      kind: i.kind,
      label: i.label,
      feeScheduleId: i.feeScheduleId,
      dueDate: i.dueDate,
      amount: dec(i.amount).toFixed(2),
      journalLineId: i.journalLineId,
      paid: paid.toFixed(2),
      remaining: remaining.toFixed(2),
      daysOverdue: open && open.daysOverdue > 0 ? open.daysOverdue : 0,
    };
  });
  const priced = rows.filter((r) => r.kind !== 'fee');
  const fees = rows.filter((r) => r.kind === 'fee');
  const paidTotal = priced.reduce((s, r) => s.plus(r.paid), dec(0));
  const feesTotal = fees.reduce((s, r) => s.plus(r.amount), dec(0));
  const feesPaid = fees.reduce((s, r) => s.plus(r.paid), dec(0));
  const [termination] = await tx.execute<Record<string, unknown>>(sql`
    select t.termination_date::text as "terminationDate", t.reason, t.collected::text as collected, t.retained::text as retained, t.refund::text as refund,
           t.refund_account_id as "refundAccountId"
      from sales_terminations t where t.contract_id = ${id}`).then((r) => r.rows);
  return {
    contract: Object.assign({}, contract as ContractHead, {
      paid: paidTotal.toFixed(2),
      remaining: contract.status === 'terminated' ? '0.00' : live ? dec(String(contract.price)).minus(paidTotal).toFixed(2) : dec(String(contract.price)).toFixed(2),
      overdue: rows.filter((r) => r.daysOverdue > 0).reduce((sum, r) => sum.plus(r.remaining), dec(0)).toFixed(2),
      feesTotal: feesTotal.toFixed(2),
      feesPaid: feesPaid.toFixed(2),
      feesRemaining: contract.status === 'terminated' ? '0.00' : feesTotal.minus(feesPaid).toFixed(2),
    }),
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

/**
 * Tahsil edilecek taksitler (etkin ve teslim edilmiş sözleşmeler): açık kalem hesabından kalan tutar ve gecikme günü.
 * Vadesine göre sıralı; `overdueOnly` yalnızca gecikenleri verir.
 */
export async function listInstallments(tx: Tx, q: { asOf?: string; projectId?: string; overdueOnly?: boolean }) {
  const asOf = q.asOf ?? todayIso();
  const rows = await tx.execute<{ id: string; contract_id: string; code: string; party_id: string; party_name: string; project_code: string; block: string; unit_no: string; currency_code: string; seq: number; kind: string; due_date: string; amount: string; journal_line_id: string }>(sql`
    select i.id, c.id as contract_id, c.code, c.party_id, pa.name as party_name, p.code as project_code, u.block, u.unit_no, c.currency_code,
           i.seq, i.kind, i.due_date::text, i.amount::text, i.journal_line_id
      from sales_installments i
      join sales_contracts c on c.id = i.contract_id and c.status in ('active','handed_over')
      join projects p on p.id = c.project_id
      join real_estate_units u on u.id = c.unit_id
      join parties pa on pa.id = c.party_id
     where i.journal_line_id is not null
       and (${q.projectId ?? null}::uuid is null or c.project_id = ${q.projectId ?? null}::uuid)
     order by i.due_date, c.code, i.seq`);
  const byParty = new Map<string, Map<string, { remaining: string; daysOverdue: number }>>();
  for (const partyId of new Set(rows.rows.map((r) => r.party_id))) {
    const open = await openItemsFor(tx, partyId, 'receivable', asOf);
    byParty.set(partyId, new Map(open.items.map((o) => [o.lineId, { remaining: o.remaining, daysOverdue: o.daysOverdue }])));
  }
  const out = [];
  for (const r of rows.rows) {
    const o = byParty.get(r.party_id)?.get(r.journal_line_id);
    if (!o || dec(o.remaining).lte(0)) continue; // tamamen tahsil edilmiş (kur yuvarlaması artığı kalem sayılmaz)
    const daysOverdue = o.daysOverdue > 0 ? o.daysOverdue : 0;
    if (q.overdueOnly && daysOverdue === 0) continue;
    out.push({
      id: r.id,
      contractId: r.contract_id,
      contractCode: r.code,
      partyName: r.party_name,
      projectCode: r.project_code,
      block: r.block,
      unitNo: r.unit_no,
      currencyCode: r.currency_code,
      seq: r.seq,
      kind: r.kind,
      dueDate: r.due_date,
      amount: dec(r.amount).toFixed(2),
      remaining: o.remaining,
      daysOverdue,
    });
  }
  return { asOf, installments: out };
}

/** Proje satış özeti: birim durumları, satılan alan, para birimi bazında sözleşme/tahsil/kalan/geciken tutar. */
export async function salesSummary(tx: Tx, projectId: string) {
  const units = await tx.execute<{ status: string; n: number; m2: string | null }>(sql`
    select status, count(*)::int as n, sum(gross_m_2)::text as m2 from real_estate_units where project_id = ${projectId} group by status`);
  const byStatus: Record<string, { count: number; grossM2: string }> = {};
  for (const s of ['available', 'reserved', 'sold', 'handed_over']) byStatus[s] = { count: 0, grossM2: '0.00' };
  for (const r of units.rows) byStatus[r.status] = { count: r.n, grossM2: dec(r.m2 ?? 0).toFixed(2) };
  const contracts = await tx.execute<{ currency_code: string; price: string; n: number }>(sql`
    select currency_code, sum(price)::text as price, count(*)::int as n from sales_contracts
     where project_id = ${projectId} and status in ('active','handed_over') group by currency_code order by currency_code`);
  const { installments } = await listInstallments(tx, { projectId });
  const cur = new Map<string, { price: string; contracts: number; remaining: ReturnType<typeof dec>; overdue: ReturnType<typeof dec> }>();
  for (const c of contracts.rows) cur.set(c.currency_code, { price: dec(c.price).toFixed(2), contracts: c.n, remaining: dec(0), overdue: dec(0) });
  for (const i of installments) {
    const e = cur.get(i.currencyCode);
    if (!e || i.kind === 'fee') continue;
    e.remaining = e.remaining.plus(i.remaining);
    if (i.daysOverdue > 0) e.overdue = e.overdue.plus(i.remaining);
  }
  return {
    units: byStatus,
    byCurrency: [...cur.entries()].map(([currencyCode, e]) => ({
      currencyCode,
      contracts: e.contracts,
      price: e.price,
      remaining: e.remaining.toFixed(2),
      collected: dec(e.price).minus(e.remaining).toFixed(2),
      overdue: e.overdue.toFixed(2),
    })),
  };
}
