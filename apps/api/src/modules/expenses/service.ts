import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  dec,
  isoYear,
  partyKindFits,
  roundMoney,
  todayIso,
  toDbAmount,
  type CancelExpenseEntryInput,
  type CreateExpenseCardInput,
  type CreateExpenseEntryInput,
  type CurrencyCode,
  type ListExpenseEntriesQuery,
  type MoneyValue,
  type PartyKind,
  type UpdateExpenseCardInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { trContains } from '../../db/search';
import {
  accounts,
  expenseCards,
  expenseEntries,
  parties,
  taxRates,
  employees,
  employeeAdvances,
  employeeAdvanceSettlements,
} from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { resolveVat } from '../invoices/service';
import {
  createJournalEntry,
  reverseJournalEntry,
  type AutoJournalLine,
  type LedgerCtx,
} from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { validateDimensions } from '../projects/dimension';
import { nextDocumentNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { assertCashOk, lockTreasuryAccounts } from '../treasury/accounts';
import { pageSql, paged, type PageQuery } from '../../http/paging';
import { assertFinancialApproved } from '../approvals/document-gate';
import { expenseSnapshot } from '../approvals/financial-snapshot';

const EXPENSE_NUMBER_KEY = 'EXP';
const EXPENSE_PREFIX = 'GDF';

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// --- Gider kartları ----------------------------------------------------------------------------------------------------------

async function validateCard(
  tx: Tx,
  companyId: string,
  c: {
    accountId?: string;
    taxCode?: string | null;
    projectId?: string | null;
    wbsId?: string | null;
    costCodeId?: string | null;
  },
) {
  if (c.accountId) {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, c.accountId));
    if (!a) throw unprocessable('Hesap bulunamadı', 'ACCOUNT_NOT_FOUND');
    if (!a.isPostable || !a.isActive)
      throw unprocessable(`${a.code} hesabına kayıt atılamaz`, 'ACCOUNT_NOT_POSTABLE');
    if (a.type !== 'income' && a.type !== 'expense' && a.type !== 'cost')
      throw unprocessable(
        `${a.code} bir gelir tablosu (gider/maliyet) hesabı değil`,
        'EXPENSE_ACCOUNT_INVALID',
      );
    if (a.partyControl || a.currencyCode)
      throw unprocessable(
        `${a.code} cari kontrol ya da dövizli hesaptır; gider kartı için uygun değil`,
        'EXPENSE_ACCOUNT_INVALID',
      );
  }
  if (c.taxCode) {
    const [t] = await tx
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(eq(taxRates.code, c.taxCode))
      .limit(1);
    if (!t) throw unprocessable(`${c.taxCode} KDV kodu bulunamadı`, 'TAX_CODE_NOT_FOUND');
  }
  await validateDimensions(tx, companyId, [
    { label: 'Gider kartı', projectId: c.projectId, wbsId: c.wbsId, costCodeId: c.costCodeId },
  ]);
}

export async function listExpenseCards(tx: Tx, opts: { all?: boolean } = {}, page?: PageQuery) {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.code, c.name, c.account_id as "accountId", a.code as "accountCode", a.name as "accountName", c.tax_code as "taxCode",
           c.withholding_rate::text as "withholdingRate", c.project_id as "projectId", p.code as "projectCode", c.wbs_id as "wbsId",
           c.cost_code_id as "costCodeId", cc.code as "costCodeCode", c.notes, c.is_active as "isActive",
           (select count(*)::int from expense_entries e where e.card_id = c.id and e.status = 'posted') as "entryCount"
      from expense_cards c
      join accounts a on a.id = c.account_id
      left join projects p on p.id = c.project_id
      left join cost_codes cc on cc.id = c.cost_code_id
     ${opts.all ? sql`` : sql`where c.is_active`}
     order by c.code ${pageSql(page)}`);
  const pg = paged(rows.rows, page);
  return { cards: pg.rows, truncated: pg.truncated };
}

export async function createExpenseCard(tx: Tx, companyId: string, input: CreateExpenseCardInput) {
  await validateCard(tx, companyId, input);
  const [row] = await tx
    .insert(expenseCards)
    .values({
      companyId,
      code: input.code.toUpperCase(),
      name: input.name,
      accountId: input.accountId,
      taxCode: input.taxCode || null,
      withholdingRate: input.withholdingRate ?? null,
      projectId: input.projectId ?? null,
      wbsId: input.wbsId ?? null,
      costCodeId: input.costCodeId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

export async function updateExpenseCard(
  tx: Tx,
  companyId: string,
  id: string,
  input: UpdateExpenseCardInput,
) {
  const [cur] = await tx.select().from(expenseCards).where(eq(expenseCards.id, id));
  if (!cur) throw notFound('Gider kartı');
  const next = {
    accountId: input.accountId ?? cur.accountId,
    taxCode: input.taxCode === undefined ? cur.taxCode : input.taxCode || null,
    projectId: input.projectId === undefined ? cur.projectId : input.projectId,
    wbsId: input.wbsId === undefined ? cur.wbsId : input.wbsId,
    costCodeId: input.costCodeId === undefined ? cur.costCodeId : input.costCodeId,
  };
  // Proje değişip iş kalemi/maliyet kodu gönderilmediyse eskileri taşımaz
  if (input.projectId !== undefined && input.projectId !== cur.projectId) {
    if (input.wbsId === undefined) next.wbsId = null;
    if (input.costCodeId === undefined) next.costCodeId = null;
  }
  await validateCard(tx, companyId, {
    accountId: input.accountId ? next.accountId : undefined,
    taxCode: next.taxCode,
    projectId: next.projectId,
    wbsId: next.wbsId,
    costCodeId: next.costCodeId,
  });
  const [row] = await tx
    .update(expenseCards)
    .set({
      ...(input.code !== undefined ? { code: input.code.toUpperCase() } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      accountId: next.accountId,
      taxCode: next.taxCode,
      ...(input.withholdingRate !== undefined ? { withholdingRate: input.withholdingRate } : {}),
      projectId: next.projectId,
      wbsId: next.wbsId,
      costCodeId: next.costCodeId,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    })
    .where(eq(expenseCards.id, id))
    .returning();
  return row!;
}

export async function deleteExpenseCard(tx: Tx, id: string) {
  const res = await tx
    .delete(expenseCards)
    .where(eq(expenseCards.id, id))
    .returning({ id: expenseCards.id });
  if (res.length === 0) throw notFound('Gider kartı');
}

// --- Gider fişi ----------------------------------------------------------------------------------------------------------------

/** KDV, stopaj ve brüt/ödenecek tutarlar (saf; kullanıcının girdiği oranlar üzerinde aritmetik). */
export function computeExpenseAmounts(
  net: MoneyValue,
  vatRate: MoneyValue,
  withholdingRate: MoneyValue,
) {
  const vat = roundMoney(net.times(vatRate).div(100));
  const withholding = roundMoney(net.times(withholdingRate).div(100));
  const gross = net.plus(vat);
  return { vat, withholding, gross, payable: gross.minus(withholding) };
}

export async function createExpenseEntry(tx: Tx, ctx: LedgerCtx, input: CreateExpenseEntryInput) {
  const [card] = await tx.select().from(expenseCards).where(eq(expenseCards.id, input.cardId)).for('update');
  if (!card) throw notFound('Gider kartı');
  if (!card.isActive)
    throw unprocessable(`${card.code} gider kartı pasif`, 'EXPENSE_CARD_INACTIVE');
  const approvalProof = await expenseSnapshot(tx, ctx, input);
  await assertFinancialApproved(tx, 'expense', ctx.approvalRequestId, approvalProof.amount, approvalProof.hash, approvalProof.projectId);
  const date = input.entryDate;
  if (input.paymentKind === 'employee' && date > todayIso())
    throw unprocessable('Personel masraf tarihi gelecekte olamaz', 'EMPLOYEE_EXPENSE_FUTURE');
  await requireOpenPeriod(tx, date);

  const net = dec(input.net);
  if (net.decimalPlaces() > 2)
    throw unprocessable('Tutar en çok 2 ondalık basamak içerebilir', 'AMOUNT_PRECISION');

  // KDV: kodun gider tarihindeki oranı; kod gönderilmezse kartın varsayılanı, null ise KDV yok
  const taxCode = input.taxCode === undefined ? card.taxCode : input.taxCode || null;
  let vatRate = dec(0);
  if (taxCode) {
    const rate = (await resolveVat(tx, [taxCode], date)).get(taxCode);
    if (rate === undefined)
      throw unprocessable(
        `${taxCode} KDV kodunun ${date} tarihinde geçerli oranı yok`,
        'EXPENSE_TAX_RATE_MISSING',
      );
    vatRate = dec(rate);
  }
  const withholdingRate = dec(
    input.withholdingRate === undefined
      ? (card.withholdingRate ?? 0)
      : (input.withholdingRate ?? 0),
  );
  const amounts = computeExpenseAmounts(net, vatRate, withholdingRate);
  if (amounts.payable.isNegative())
    throw unprocessable('Stopaj brüt tutarı aşamaz', 'EXPENSE_WITHHOLDING_EXCEEDS');

  // Proje boyutu: gönderilmezse kartın varsayılanı; proje gönderilirse iş kalemi/maliyet kodu da gönderilene göre
  const dims =
    input.projectId !== undefined
      ? {
          projectId: input.projectId ?? null,
          wbsId: input.wbsId ?? null,
          costCodeId: input.costCodeId ?? null,
        }
      : {
          projectId: card.projectId,
          wbsId: input.wbsId !== undefined ? (input.wbsId ?? null) : card.wbsId,
          costCodeId: input.costCodeId !== undefined ? (input.costCodeId ?? null) : card.costCodeId,
        };

  // Cari ve ödeme kaynağı
  let party: typeof parties.$inferSelect | null = null;
  if (input.partyId) {
    [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId)).for('update');
    if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
    if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
    if (input.paymentKind === 'party' && !partyKindFits(party.kind as PartyKind, 'payable')) {
      throw unprocessable(
        `${party.name} tedarikçi değil; cari ödemede tedarikçi seçilmeli`,
        'PARTY_KIND_MISMATCH',
      );
    }
  }
  let glAccountId: string | null = null;
  let advanceApplied = dec(0);
  if (input.paymentKind === 'employee') {
    const [employee] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, input.employeeId!))
      .for('update');
    if (!employee) throw notFound('Personel');
    if (input.advanceId) {
      const [advance] = await tx
        .select()
        .from(employeeAdvances)
        .where(eq(employeeAdvances.id, input.advanceId))
        .for('update');
      if (!advance || advance.employeeId !== employee.id)
        throw unprocessable('Avans seçilen personele ait değil', 'EXPENSE_ADVANCE_EMPLOYEE');
      if (!['open', 'partial'].includes(advance.status))
        throw unprocessable('Seçilen avans açık değil', 'EXPENSE_ADVANCE_CLOSED');
      if (date < advance.advanceDate)
        throw unprocessable('Masraf tarihi avans tarihinden önce olamaz', 'EXPENSE_ADVANCE_DATE');
      advanceApplied = dec(advance.amount).minus(advance.settledAmount);
      if (advanceApplied.gt(amounts.payable)) advanceApplied = amounts.payable;
    }
  }
  const treasuryPayment = amounts.payable.minus(advanceApplied);
  if (
    input.paymentKind === 'treasury' ||
    (input.paymentKind === 'employee' && treasuryPayment.gt(0))
  ) {
    if (!input.treasuryAccountId)
      throw unprocessable(
        'Avansı aşan masrafın iadesi için kasa/banka seçin',
        'EXPENSE_REIMBURSEMENT_ACCOUNT',
      );
    const locked = await lockTreasuryAccounts(tx, [input.treasuryAccountId!]);
    const ta = locked.get(input.treasuryAccountId!)!;
    if (!ta.isActive) throw unprocessable(`${ta.name} hesabı pasif`, 'TREASURY_ACCOUNT_INACTIVE');
    if (ta.currencyCode !== ctx.baseCurrency) {
      throw unprocessable(
        `Gider fişi yalnızca ${ctx.baseCurrency} cinsinden kasa/banka hesabından ödenebilir`,
        'EXPENSE_TREASURY_CURRENCY',
      );
    }
    await assertCashOk(tx, ta, date, treasuryPayment);
    glAccountId = ta.accountId;
  }

  const keys = [
    ...(advanceApplied.gt(0) ? (['employee_advance'] as const) : []),
    ...(input.paymentKind === 'party' && amounts.payable.gt(0) ? (['payable'] as const) : []),
    ...(amounts.vat.gt(0) ? (['vat_input'] as const) : []),
    ...(amounts.withholding.gt(0) ? (['withholding_payable'] as const) : []),
  ];
  const map = await requireMappings(tx, keys);

  const id = uuidv7();
  const year = isoYear(date);
  const entryNo = await nextDocumentNumber(tx, ctx.companyId, EXPENSE_NUMBER_KEY, year, EXPENSE_PREFIX);
  const text = `Gider ${entryNo} — ${card.name}: ${input.description}`.slice(0, 300);
  const line = (
    accountId: string,
    side: 'debit' | 'credit',
    amount: MoneyValue,
    extra: Partial<AutoJournalLine> = {},
  ): AutoJournalLine => ({
    accountId,
    currency: ctx.baseCurrency as CurrencyCode,
    debit: side === 'debit' ? toDbAmount(amount) : '0',
    credit: side === 'credit' ? toDbAmount(amount) : '0',
    description: input.description.slice(0, 200),
    ...extra,
  });
  const lines: AutoJournalLine[] = [
    line(card.accountId, 'debit', net, {
      ...(dims.projectId ? { projectId: dims.projectId } : {}),
      ...(dims.wbsId ? { wbsId: dims.wbsId } : {}),
      ...(dims.costCodeId ? { costCodeId: dims.costCodeId } : {}),
    }),
  ];
  if (amounts.vat.gt(0)) lines.push(line(map.vat_input!, 'debit', amounts.vat));
  if (amounts.payable.gt(0)) {
    if (input.paymentKind === 'employee') {
      if (advanceApplied.gt(0)) lines.push(line(map.employee_advance!, 'credit', advanceApplied));
      if (treasuryPayment.gt(0)) lines.push(line(glAccountId!, 'credit', treasuryPayment));
    } else if (input.paymentKind === 'treasury')
      lines.push(line(glAccountId!, 'credit', amounts.payable));
    else
      lines.push(
        line(map.payable!, 'credit', amounts.payable, {
          partyId: party!.id,
          dueDate: input.dueDate ?? addDays(date, party!.paymentTermDays),
        }),
      );
  }
  if (amounts.withholding.gt(0))
    lines.push(line(map.withholding_payable!, 'credit', amounts.withholding));

  const entry = await createJournalEntry(
    tx,
    ctx,
    { entryDate: date, description: text, lines, post: true },
    { source: { type: 'expense_entry', id } },
  );
  await tx.insert(expenseEntries).values({
    id,
    companyId: ctx.companyId,
    entryNo,
    entryDate: date,
    cardId: card.id,
    description: input.description,
    partyId: party?.id ?? null,
    paymentKind: input.paymentKind,
    employeeId: input.paymentKind === 'employee' ? input.employeeId! : null,
    advanceId: input.paymentKind === 'employee' ? (input.advanceId ?? null) : null,
    advanceAppliedAmount: advanceApplied.toFixed(2),
    treasuryAccountId:
      input.paymentKind === 'treasury' ||
      (input.paymentKind === 'employee' && treasuryPayment.gt(0))
        ? input.treasuryAccountId!
        : null,
    dueDate:
      input.paymentKind === 'party'
        ? (input.dueDate ?? addDays(date, party!.paymentTermDays))
        : null,
    net: toDbAmount(net),
    vatCode: taxCode,
    vatRate: vatRate.toFixed(4),
    vat: toDbAmount(amounts.vat),
    withholdingRate: withholdingRate.toFixed(4),
    withholding: toDbAmount(amounts.withholding),
    gross: toDbAmount(amounts.gross),
    payable: toDbAmount(amounts.payable),
    documentRef: input.documentRef ?? null,
    projectId: dims.projectId,
    wbsId: dims.wbsId,
    costCodeId: dims.costCodeId,
    journalEntryId: entry.id,
    createdBy: ctx.userId,
  });
  if (advanceApplied.gt(0))
    await tx
      .insert(employeeAdvanceSettlements)
      .values({
        companyId: ctx.companyId,
        advanceId: input.advanceId!,
        kind: 'expense',
        expenseEntryId: id,
        settledDate: date,
        amount: advanceApplied.toFixed(2),
        note: input.description,
        createdBy: ctx.userId,
      });
  return getExpenseEntry(tx, id);
}

export async function cancelExpenseEntry(
  tx: Tx,
  ctx: LedgerCtx,
  id: string,
  input: CancelExpenseEntryInput,
) {
  const [e] = await tx.select().from(expenseEntries).where(eq(expenseEntries.id, id)).for('update');
  if (!e) throw notFound('Gider fişi');
  if (e.status === 'cancelled')
    throw unprocessable('Gider fişi zaten iptal edilmiş', 'EXPENSE_ALREADY_CANCELLED');
  const date = input.date ?? todayIso();
  if (date < e.entryDate)
    throw unprocessable('İptal tarihi fiş tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_ENTRY');
  await requireOpenPeriod(tx, date);
  const reversal = await reverseJournalEntry(tx, ctx, e.journalEntryId, {
    entryDate: date,
    description: `Gider iptali: ${e.entryNo} — ${input.reason}`.slice(0, 300),
    source: { type: 'expense_entry', id },
  });
  await tx
    .update(expenseEntries)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.userId,
      cancelReason: input.reason,
      cancelJournalEntryId: reversal.id,
    })
    .where(eq(expenseEntries.id, id));
  return getExpenseEntry(tx, id);
}

const ENTRY_SELECT = sql`
  select e.id, e.entry_no as "entryNo", e.entry_date::text as "entryDate", e.status, e.description,
         e.employee_id as "employeeId",e.advance_id as "advanceId",e.advance_applied_amount::text as "advanceAppliedAmount",emp.full_name as "employeeName",adv.number as "advanceNumber",
         e.card_id as "cardId", c.code as "cardCode", c.name as "cardName", a.code as "accountCode",
         e.party_id as "partyId", p.name as "partyName", e.payment_kind as "paymentKind",
         e.treasury_account_id as "treasuryAccountId", ta.name as "treasuryAccountName", e.due_date::text as "dueDate",
         e.net::text as net, e.vat_code as "vatCode", e.vat_rate::text as "vatRate", e.vat::text as vat,
         e.withholding_rate::text as "withholdingRate", e.withholding::text as withholding, e.gross::text as gross, e.payable::text as payable,
         e.document_ref as "documentRef", e.project_id as "projectId", pr.code as "projectCode", e.wbs_id as "wbsId", e.cost_code_id as "costCodeId",
         e.journal_entry_id as "journalEntryId", je.entry_no as "journalEntryNo", e.cancel_journal_entry_id as "cancelJournalEntryId",
         e.cancelled_at as "cancelledAt", e.cancel_reason as "cancelReason", e.created_at as "createdAt"
    from expense_entries e
    join expense_cards c on c.id = e.card_id
    join accounts a on a.id = c.account_id
    left join parties p on p.id = e.party_id
    left join treasury_accounts ta on ta.id = e.treasury_account_id
    left join employees emp on emp.id=e.employee_id
    left join employee_advances adv on adv.id=e.advance_id
    left join projects pr on pr.id = e.project_id
    left join journal_entries je on je.id = e.journal_entry_id`;

export async function getExpenseEntry(tx: Tx, id: string) {
  const rows = await tx.execute<Record<string, unknown>>(sql`${ENTRY_SELECT} where e.id = ${id}`);
  if (!rows.rows[0]) throw notFound('Gider fişi');
  return rows.rows[0];
}

export function expenseEntryConds(
  q: Pick<
    ListExpenseEntriesQuery,
    'from' | 'to' | 'cardId' | 'partyId' | 'projectId' | 'status' | 'q'
  >,
) {
  const conds = [];
  if (q.from) conds.push(sql`e.entry_date >= ${q.from}::date`);
  if (q.to) conds.push(sql`e.entry_date <= ${q.to}::date`);
  if (q.cardId) conds.push(sql`e.card_id = ${q.cardId}::uuid`);
  if (q.partyId) conds.push(sql`e.party_id = ${q.partyId}::uuid`);
  if (q.projectId) conds.push(sql`e.project_id = ${q.projectId}::uuid`);
  if (q.status) conds.push(sql`e.status = ${q.status}`);
  if (q.q)
    conds.push(
      trContains(
        [
          'e.entry_no',
          'e.description',
          "coalesce(e.document_ref, '')",
          'c.name',
          "coalesce(p.name, '')",
        ],
        q.q,
      ),
    );
  return conds;
}

export async function listExpenseEntries(tx: Tx, q: ListExpenseEntriesQuery) {
  const conds = expenseEntryConds(q);
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const rows = await tx.execute<Record<string, unknown>>(
    sql`${ENTRY_SELECT} ${where} order by e.entry_date desc, e.entry_no desc limit ${q.limit} offset ${q.offset}`,
  );
  const total = await tx.execute<{ n: number; net: string; gross: string }>(sql`
    select count(*)::int as n, coalesce(sum(e.net) filter (where e.status = 'posted'), 0)::text as net, coalesce(sum(e.gross) filter (where e.status = 'posted'), 0)::text as gross
      from expense_entries e join expense_cards c on c.id = e.card_id left join parties p on p.id = e.party_id ${where}`);
  return {
    entries: rows.rows,
    total: total.rows[0]?.n ?? 0,
    totals: { net: total.rows[0]?.net ?? '0', gross: total.rows[0]?.gross ?? '0' },
  };
}
