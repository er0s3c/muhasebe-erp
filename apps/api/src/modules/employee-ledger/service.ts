import { and, asc, eq, sql } from 'drizzle-orm';
import {
  ADVANCE_DEDUCTION_ITEM_CODE,
  advanceDeductionCap,
  dec,
  isoYear,
  monthBounds,
  todayIso,
  toDbAmount,
  type CancelAdvanceInput,
  type CreateAdvanceInput,
  type RepayAdvanceInput,
  type SalaryPaymentInput,
  type SetAdvanceDeductionsInput,
  type UpdateLedgerSettingsInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import {
  employeeAdvanceDeductions,
  employeeAdvanceEvents,
  employeeAdvanceSettlements,
  employeeAdvances,
  employeeLedgerSettings,
  employeeSalaryPayments,
  employees,
  parties,
  payrollAdjustments,
  payrollItems,
  payrollLines,
  payrollRuns,
  projects,
  users,
} from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import type { LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { calculateRun } from '../payroll/runs';
import { generateCode } from '../parties/service';
import { nextDocumentNumber } from '../settings/numbering';
import { getTreasuryAccountRow } from '../treasury/accounts';
import { cancelTreasuryTransaction, postTreasuryTransaction } from '../treasury/posting';
import { getLedgerSettings } from './hooks';
import { logLedgerAccess } from './reports';

type Advance = typeof employeeAdvances.$inferSelect;

async function lockEmployee(tx: Tx, id: string) {
  const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for('update');
  if (!row) throw notFound('Personel');
  return row;
}

async function lockAdvance(tx: Tx, id: string): Promise<Advance> {
  const [row] = await tx
    .select()
    .from(employeeAdvances)
    .where(eq(employeeAdvances.id, id))
    .for('update');
  if (!row) throw notFound('Avans');
  return row;
}

/** Avans ve maaş ödemeleri defter para birimindeki kasa/banka hesabından yapılır (tek para birimi; döviz bilinen sınırdır). */
async function requireBaseTreasury(tx: Tx, ctx: LedgerCtx, accountId: string) {
  const ta = await getTreasuryAccountRow(tx, accountId);
  if (ta.currencyCode !== ctx.baseCurrency) {
    throw unprocessable(
      `Personel avansı ve maaş ödemesi yalnızca ${ctx.baseCurrency} (defter para birimi) hesaplarından yapılır`,
      'EMPLOYEE_LEDGER_CURRENCY',
    );
  }
  return ta;
}

// --- Personel cari (cari aç) ------------------------------------------------------------------------------------------

/**
 * Personel için cari açar (türü 'employee'): yalnızca ad kopyalanır; kimlik, IBAN, ücret gibi hassas alanlar personel kartında kalır.
 * Personel başına tek cari (veritabanında benzersiz); zaten varsa onu döndürür.
 */
export async function openEmployeeParty(tx: Tx, ctx: LedgerCtx, employeeId: string) {
  const emp = await lockEmployee(tx, employeeId);
  if (emp.partyId) {
    const [p] = await tx.select().from(parties).where(eq(parties.id, emp.partyId));
    return { created: false, party: { id: p!.id, code: p!.code, name: p!.name, kind: p!.kind } };
  }
  const code = await generateCode(tx, ctx.companyId);
  const [party] = await tx
    .insert(parties)
    .values({
      companyId: ctx.companyId,
      code,
      name: emp.fullName,
      kind: 'employee',
      currencyCode: ctx.baseCurrency,
      paymentTermDays: 0,
      notes: 'Personel carisi (personel kartından açıldı)',
    })
    .returning();
  await tx
    .update(employees)
    .set({ partyId: party!.id, updatedAt: new Date() })
    .where(eq(employees.id, employeeId));
  return {
    created: true,
    party: { id: party!.id, code: party!.code, name: party!.name, kind: party!.kind },
  };
}

// --- Avans ----------------------------------------------------------------------------------------------------------------

export async function giveAdvance(tx: Tx, ctx: LedgerCtx, input: CreateAdvanceInput) {
  const emp = await lockEmployee(tx, input.employeeId);
  if (emp.status !== 'active')
    throw unprocessable('İşten ayrılmış personele avans verilemez', 'EMPLOYEE_LEFT');
  if (input.date > todayIso())
    throw unprocessable('Avans tarihi gelecekte olamaz', 'ADVANCE_DATE_FUTURE');
  if (input.projectId) {
    const [p] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    if (!p) throw unprocessable('Proje bulunamadı', 'PROJECT_NOT_FOUND');
  }
  await requireBaseTreasury(tx, ctx, input.treasuryAccountId);
  const map = await requireMappings(tx, ['employee_advance']);
  const txn = await postTreasuryTransaction(tx, ctx, {
    type: 'other_payment',
    date: input.date,
    accountId: input.treasuryAccountId,
    amount: input.amount,
    description: `Personel avansı — ${emp.code} ${emp.fullName}: ${input.purpose}`.slice(0, 300),
    glAccountId: map.employee_advance,
    items: [],
  });
  const year = isoYear(input.date);
  const number = await nextDocumentNumber(tx, ctx.companyId, 'EMPLOYEE_ADVANCE', year, 'AVN');
  const [row] = await tx
    .insert(employeeAdvances)
    .values({
      companyId: ctx.companyId,
      number,
      employeeId: emp.id,
      advanceDate: input.date,
      amount: toDbAmount(input.amount),
      purpose: input.purpose,
      projectId: input.projectId ?? null,
      treasuryAccountId: input.treasuryAccountId,
      treasuryTxnId: txn.transaction.id,
      createdBy: ctx.userId,
    })
    .returning();
  return getAdvance(tx, row!.id);
}

export async function getAdvance(tx: Tx, id: string) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select a.id, a.number, a.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName",
           a.advance_date::text as "advanceDate", a.amount::text as amount, a.settled_amount::text as "settledAmount",
           (a.amount - a.settled_amount)::text as "openAmount", a.purpose, a.status, a.project_id as "projectId", p.code as "projectCode",
           a.treasury_account_id as "treasuryAccountId", a.treasury_txn_id as "treasuryTxnId", t.txn_no as "txnNo",
           a.cancel_reason as "cancelReason", a.cancelled_at as "cancelledAt"
      from employee_advances a
      join employees e on e.id = a.employee_id
      join treasury_transactions t on t.id = a.treasury_txn_id
      left join projects p on p.id = a.project_id
     where a.id = ${id}`);
  const advance = res.rows[0];
  if (!advance) throw notFound('Avans');
  const settlements = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.kind, s.expense_entry_id as "expenseEntryId", ex.entry_no as "expenseEntryNo", s.amount::text as amount, s.settled_date::text as "settledDate", s.note, s.reversed_at as "reversedAt", s.reverse_reason as "reverseReason",
           r.number as "runNumber", t.txn_no as "txnNo"
      from employee_advance_settlements s
      left join expense_entries ex on ex.id=s.expense_entry_id
      left join payroll_runs r on r.id = s.payroll_run_id
      left join treasury_transactions t on t.id = s.treasury_txn_id
     where s.advance_id = ${id} order by s.created_at`);
  const events = await tx
    .select({
      fromStatus: employeeAdvanceEvents.fromStatus,
      toStatus: employeeAdvanceEvents.toStatus,
      settledAmount: employeeAdvanceEvents.settledAmount,
      at: employeeAdvanceEvents.createdAt,
      by: users.email,
    })
    .from(employeeAdvanceEvents)
    .leftJoin(users, eq(users.id, employeeAdvanceEvents.createdBy))
    .where(eq(employeeAdvanceEvents.advanceId, id))
    .orderBy(asc(employeeAdvanceEvents.createdAt));
  return { advance, settlements: settlements.rows, events };
}

/** Kapanmamış avansı iptal eder: avans önce iptal edilir, ardından ödeme hareketi ters kayıtla iptal edilir (aynı işlemde). */
export async function cancelAdvance(tx: Tx, ctx: LedgerCtx, id: string, input: CancelAdvanceInput) {
  const a = await lockAdvance(tx, id);
  if (a.status === 'cancelled')
    throw unprocessable('Avans zaten iptal edilmiş', 'ADVANCE_CANCELLED');
  if (dec(a.settledAmount).gt(0))
    throw unprocessable(
      'Kısmen ya da tamamen kapanmış avans iptal edilemez; önce kesinti/geri ödemeyi geri alın',
      'ADVANCE_HAS_SETTLEMENTS',
    );
  const planned = await tx
    .select({ id: employeeAdvanceDeductions.id })
    .from(employeeAdvanceDeductions)
    .where(eq(employeeAdvanceDeductions.advanceId, id))
    .limit(1);
  if (planned.length > 0) {
    const [r] = await tx
      .execute<{ n: number }>(
        sql`select count(*)::int as n from employee_advance_deductions d join payroll_runs r on r.id = d.run_id where d.advance_id = ${id} and r.status = 'draft'`,
      )
      .then((x) => x.rows);
    if ((r?.n ?? 0) > 0)
      throw unprocessable(
        'Avans taslak bir bordroda kesinti olarak seçili; önce kesintiyi kaldırın',
        'ADVANCE_IN_DRAFT_RUN',
      );
  }
  await tx
    .update(employeeAdvances)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.userId,
      cancelReason: input.reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(employeeAdvances.id, id));
  await cancelTreasuryTransaction(tx, ctx, a.treasuryTxnId, {
    reason: `Avans iptali ${a.number}: ${input.reason}`.slice(0, 300),
    date: input.date,
  });
  return getAdvance(tx, id);
}

/** Personelden kasa/banka ile geri ödeme: tahsilat (diğer tahsilat, karşı hesap personel avansları) + kapama taksiti. */
export async function repayAdvance(tx: Tx, ctx: LedgerCtx, id: string, input: RepayAdvanceInput) {
  const a = await lockAdvance(tx, id);
  if (a.status !== 'open' && a.status !== 'partial')
    throw unprocessable(
      'Yalnızca açık ya da kısmen kapanmış avansa geri ödeme alınır',
      'ADVANCE_NOT_OPEN',
    );
  if (input.date < a.advanceDate)
    throw unprocessable('Geri ödeme tarihi avans tarihinden önce olamaz', 'ADVANCE_REPAY_DATE');
  if (input.date > todayIso())
    throw unprocessable('Geri ödeme tarihi gelecekte olamaz', 'ADVANCE_DATE_FUTURE');
  const remaining = dec(a.amount).minus(a.settledAmount);
  if (dec(input.amount).gt(remaining))
    throw unprocessable(
      `Geri ödeme kalan avans tutarını (${remaining.toFixed(2)}) aşamaz`,
      'ADVANCE_EXCEEDS_OPEN',
    );
  await requireBaseTreasury(tx, ctx, input.treasuryAccountId);
  const map = await requireMappings(tx, ['employee_advance']);
  const [emp] = await tx
    .select({ code: employees.code, fullName: employees.fullName })
    .from(employees)
    .where(eq(employees.id, a.employeeId));
  const txn = await postTreasuryTransaction(tx, ctx, {
    type: 'other_receipt',
    date: input.date,
    accountId: input.treasuryAccountId,
    amount: input.amount,
    description: `Personel avansı geri ödemesi ${a.number} — ${emp?.code} ${emp?.fullName}`.slice(
      0,
      300,
    ),
    glAccountId: map.employee_advance,
    items: [],
  });
  await tx.insert(employeeAdvanceSettlements).values({
    companyId: ctx.companyId,
    advanceId: id,
    kind: 'repayment',
    amount: toDbAmount(input.amount),
    settledDate: input.date,
    treasuryTxnId: txn.transaction.id,
    note: input.note?.trim() || null,
    createdBy: ctx.userId,
  });
  return getAdvance(tx, id);
}

// --- Net maaş ödemesi ------------------------------------------------------------------------------------------------------

/** Personelin ödenecek net ücret bakiyesi (onaylı bordro net ücreti − maaş ödemeleri). */
async function unpaidSalary(tx: Tx, employeeId: string, runId?: string | null) {
  const res = await tx.execute<{ net: string; paid: string }>(sql`
    select coalesce((select sum(l.net) from payroll_lines l join payroll_runs r on r.id = l.run_id
                      where l.employee_id = ${employeeId} and r.status in ('approved','paid') ${runId ? sql`and r.id = ${runId}` : sql``}), 0)::text as net,
           coalesce((select sum(p.amount) from employee_salary_payments p join treasury_transactions t on t.id = p.treasury_txn_id
                      where p.employee_id = ${employeeId} and t.status = 'posted' ${runId ? sql`and p.payroll_run_id = ${runId}` : sql``}), 0)::text as paid`);
  const r = res.rows[0]!;
  return dec(r.net).minus(r.paid);
}

/**
 * Net maaş ödemesi: kasa/banka çıkışı (diğer ödeme; karşı hesap "ödenecek net ücret") + personel cari bağlantısı. Ödeme, personelin
 * ödenmemiş net ücretini aşamaz (fazlası için avans verilir). Bordro "ödendi" işareti ayrıca el ile kalır (D3 takip işareti).
 */
export async function paySalary(tx: Tx, ctx: LedgerCtx, input: SalaryPaymentInput) {
  const emp = await lockEmployee(tx, input.employeeId);
  if (input.date > todayIso())
    throw unprocessable('Ödeme tarihi gelecekte olamaz', 'SALARY_PAY_DATE_FUTURE');
  const open = await unpaidSalary(tx, emp.id, input.payrollRunId);
  if (dec(input.amount).gt(open)) {
    throw unprocessable(
      `Ödeme, ödenmemiş net ücreti (${open.isNegative() ? '0.00' : open.toFixed(2)}) aşamaz; fazlası için avans verin`,
      'SALARY_PAYMENT_EXCEEDS',
    );
  }
  await requireBaseTreasury(tx, ctx, input.treasuryAccountId);
  const map = await requireMappings(tx, ['payroll_payable']);
  let runNo = '';
  if (input.payrollRunId) {
    const [r] = await tx
      .select({ number: payrollRuns.number })
      .from(payrollRuns)
      .where(eq(payrollRuns.id, input.payrollRunId));
    runNo = r ? ` (${r.number})` : '';
  }
  const txn = await postTreasuryTransaction(tx, ctx, {
    type: 'other_payment',
    date: input.date,
    accountId: input.treasuryAccountId,
    amount: input.amount,
    description: `Net maaş ödemesi — ${emp.code} ${emp.fullName}${runNo}`.slice(0, 300),
    glAccountId: map.payroll_payable,
    items: [],
  });
  const [row] = await tx
    .insert(employeeSalaryPayments)
    .values({
      companyId: ctx.companyId,
      employeeId: emp.id,
      payrollRunId: input.payrollRunId ?? null,
      treasuryTxnId: txn.transaction.id,
      payDate: input.date,
      amount: toDbAmount(input.amount),
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning();
  return { payment: row!, txnNo: txn.transaction.txnNo };
}

export async function listSalaryPayments(tx: Tx, q: { employeeId?: string }) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", p.pay_date::text as "payDate",
           p.amount::text as amount, p.note, t.txn_no as "txnNo", t.id as "txnId", t.status as "txnStatus", r.number as "runNumber"
      from employee_salary_payments p
      join employees e on e.id = p.employee_id
      join treasury_transactions t on t.id = p.treasury_txn_id
      left join payroll_runs r on r.id = p.payroll_run_id
     where (${q.employeeId ?? null}::uuid is null or p.employee_id = ${q.employeeId ?? null}::uuid)
     order by p.pay_date desc, t.txn_no desc limit 500`);
  await logLedgerAccess(
    tx,
    res.rows.map((r) => r.employeeId as string),
    'Maaş ödemeleri görüntüleme',
  );
  return { payments: res.rows };
}

// --- Bordro avans kesintisi ---------------------------------------------------------------------------------------------

async function ensureAdvanceItem(tx: Tx, companyId: string) {
  const [cur] = await tx
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.code, ADVANCE_DEDUCTION_ITEM_CODE));
  if (cur) {
    if (cur.kind !== 'deduction')
      throw unprocessable(
        `${ADVANCE_DEDUCTION_ITEM_CODE} kodlu bordro kalemi kesinti türünde olmalı`,
        'PAYROLL_ITEM_RESERVED',
      );
    if (!cur.isActive)
      await tx.update(payrollItems).set({ isActive: true }).where(eq(payrollItems.id, cur.id));
    return cur.id;
  }
  const [row] = await tx
    .insert(payrollItems)
    .values({
      companyId,
      code: ADVANCE_DEDUCTION_ITEM_CODE,
      name: 'Personel avansı kesintisi',
      kind: 'deduction',
      liability: 'other',
    })
    .returning({ id: payrollItems.id });
  return row!.id;
}

/** Bir personelin kesinti bekleyen (açık/kısmen kapanmış) avansları, tarih sırasıyla. */
export async function outstandingAdvances(tx: Tx, q: { employeeId?: string }) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select a.id, a.number, a.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", a.advance_date::text as "advanceDate",
           a.amount::text as amount, a.settled_amount::text as "settledAmount", (a.amount - a.settled_amount)::text as remaining, a.purpose, a.status
      from employee_advances a join employees e on e.id = a.employee_id
     where a.status in ('open','partial') and (${q.employeeId ?? null}::uuid is null or a.employee_id = ${q.employeeId ?? null}::uuid)
     order by a.advance_date, a.number`);
  await logLedgerAccess(
    tx,
    res.rows.map((r) => r.employeeId as string),
    'Açık avans listesi görüntüleme',
  );
  return { advances: res.rows, settings: await getLedgerSettings(tx) };
}

export async function listRunDeductions(tx: Tx, runId: string) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select d.id, d.employee_id as "employeeId", e.code as "employeeCode", e.full_name as "employeeName", d.advance_id as "advanceId",
           a.number as "advanceNumber", d.amount::text as amount, (a.amount - a.settled_amount)::text as "advanceRemaining"
      from employee_advance_deductions d
      join employees e on e.id = d.employee_id
      join employee_advances a on a.id = d.advance_id
     where d.run_id = ${runId} order by e.code, a.advance_date`);
  await logLedgerAccess(
    tx,
    res.rows.map((r) => r.employeeId as string),
    'Bordro avans kesintileri görüntüleme',
  );
  return { deductions: res.rows, settings: await getLedgerSettings(tx) };
}

/**
 * Taslak bordroda bir personelin avans kesintisini belirler (boş liste kaldırır): plan satırları + bordro "avans kesintisi" kalemi
 * yazılır, bordro yeniden hesaplanır. Üst sınır (kullanıcı parametresi, varsayılan yok) kesinti öncesi net ücrete uygulanır.
 * Onayda kesinti avansa taksit olur, bordro iptalinde veritabanı taksiti geri alır.
 */
export async function setRunAdvanceDeductions(
  tx: Tx,
  ctx: LedgerCtx,
  runId: string,
  input: SetAdvanceDeductionsInput,
) {
  const [run] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).for('update');
  if (!run) throw notFound('Bordro');
  if (run.status !== 'draft')
    throw unprocessable('Avans kesintisi yalnızca taslak bordroda belirlenir', 'PAYROLL_NOT_DRAFT');
  const emp = await lockEmployee(tx, input.employeeId);
  const { end } = monthBounds(run.month);

  await tx
    .delete(employeeAdvanceDeductions)
    .where(
      and(
        eq(employeeAdvanceDeductions.runId, runId),
        eq(employeeAdvanceDeductions.employeeId, emp.id),
      ),
    );
  let total = dec(0);
  const seen = new Set<string>();
  for (const d of input.deductions) {
    if (seen.has(d.advanceId))
      throw unprocessable('Aynı avans iki kez seçilemez', 'ADVANCE_DUPLICATE');
    seen.add(d.advanceId);
    const a = await lockAdvance(tx, d.advanceId);
    if (a.employeeId !== emp.id)
      throw unprocessable('Avans bu personele ait değil', 'ADVANCE_EMPLOYEE_MISMATCH');
    if (a.status !== 'open' && a.status !== 'partial')
      throw unprocessable(
        `${a.number} kesinti için uygun değil (durum: ${a.status})`,
        'ADVANCE_NOT_OPEN',
      );
    if (a.advanceDate > end)
      throw unprocessable(
        `${a.number} bordro ayından sonra verilmiş; kesilemez`,
        'ADVANCE_AFTER_PERIOD',
      );
    if (dec(d.amount).gt(dec(a.amount).minus(a.settledAmount)))
      throw unprocessable(
        `${a.number}: kesinti kalan avans tutarını aşıyor`,
        'ADVANCE_EXCEEDS_OPEN',
      );
    await tx
      .insert(employeeAdvanceDeductions)
      .values({
        companyId: ctx.companyId,
        runId,
        advanceId: a.id,
        employeeId: emp.id,
        amount: toDbAmount(d.amount),
        createdBy: ctx.userId,
      });
    total = total.plus(d.amount);
  }

  const itemId = await ensureAdvanceItem(tx, ctx.companyId);
  if (total.gt(0)) {
    await tx
      .insert(payrollAdjustments)
      .values({
        companyId: ctx.companyId,
        runId,
        employeeId: emp.id,
        itemId,
        amount: toDbAmount(total),
        note: 'Personel avansı kesintisi',
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [
          payrollAdjustments.runId,
          payrollAdjustments.employeeId,
          payrollAdjustments.itemId,
        ],
        set: { amount: toDbAmount(total) },
      });
  } else {
    await tx
      .delete(payrollAdjustments)
      .where(
        and(
          eq(payrollAdjustments.runId, runId),
          eq(payrollAdjustments.employeeId, emp.id),
          eq(payrollAdjustments.itemId, itemId),
        ),
      );
  }
  await calculateRun(tx, ctx, runId);

  if (total.gt(0)) {
    const settings = await getLedgerSettings(tx);
    const [line] = await tx
      .select({ net: payrollLines.net })
      .from(payrollLines)
      .where(and(eq(payrollLines.runId, runId), eq(payrollLines.employeeId, emp.id)));
    if (!line)
      throw unprocessable(
        'Personel bu bordroda yok (ücret şartı ya da puantaj eksik)',
        'PAYROLL_LINE_MISSING',
      );
    const cap = advanceDeductionCap(dec(line.net).plus(total).toFixed(2), settings.deductionCapPct);
    if (cap && total.gt(cap)) {
      throw unprocessable(
        `Avans kesintisi (${total.toFixed(2)}) kullanıcı üst sınırını (${cap.toFixed(2)}) aşıyor`,
        'ADVANCE_DEDUCTION_CAP',
      );
    }
    if (dec(line.net).isNegative())
      throw unprocessable('Kesinti sonrası net ücret negatif olamaz', 'PAYROLL_NEGATIVE_NET');
  }
  return listRunDeductions(tx, runId);
}

// --- Ayarlar --------------------------------------------------------------------------------------------------------------

export async function updateLedgerSettings(
  tx: Tx,
  ctx: LedgerCtx,
  input: UpdateLedgerSettingsInput,
) {
  const values = {
    deductionCapPct: input.deductionCapPct,
    sourceNote: input.sourceNote?.trim() || null,
    verifiedBy: null,
    verifiedAt: null,
    updatedBy: ctx.userId,
    updatedAt: new Date(),
  };
  await tx
    .insert(employeeLedgerSettings)
    .values({ companyId: ctx.companyId, ...values })
    .onConflictDoUpdate({ target: employeeLedgerSettings.companyId, set: values });
  return getLedgerSettings(tx);
}

export async function verifyLedgerSettings(tx: Tx, ctx: LedgerCtx, note?: string) {
  const [u] = await tx.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
  const rows = await tx
    .update(employeeLedgerSettings)
    .set({
      verifiedBy: u?.email ?? ctx.userId,
      verifiedAt: new Date(),
      ...(note ? { sourceNote: note } : {}),
    })
    .returning({ id: employeeLedgerSettings.id });
  if (rows.length === 0)
    throw unprocessable('Doğrulanacak bir üst sınır tanımı yok', 'LEDGER_SETTINGS_EMPTY');
  return getLedgerSettings(tx);
}
