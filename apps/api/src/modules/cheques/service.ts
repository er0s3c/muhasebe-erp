import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  CHEQUE_INITIAL_STATUS,
  chequeTransition,
  dec,
  isoYear,
  partyKindFits,
  sum,
  todayIso,
  toDbAmount,
  toDbRate,
  applyRate,
  type AccountMappingKey,
  type ChequeActionInput,
  type ChequeListQuery,
  type CreateChequeInput,
  type MoneyValue,
  type PartyControlType,
  type PartyKind,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { chequeAllocations, chequeBatches, chequeEvents, cheques, parties } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { uuidList } from '../inventory/balances';
import { createJournalEntry, type AutoJournalLine, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { assertAllocatable, openItemsFor } from '../parties/service';
import { nextDocumentNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { lockTreasuryAccounts, type TreasuryAccountRow } from '../treasury/accounts';
import { buildExchangeJournal,buildSettlementJournal, planSettlement, type SettleItemInput } from '../treasury/journal';
import { requireRate } from '../settings/rates';
import { trContains } from '../../db/search';
import { pageSql, paged, type PageQuery } from '../../http/paging';

/**
 * Çek/senet yaşam döngüsü: belge para birimi, sabit kayıt değeri ve tahsil/ödeme kur farkı.
 * Kayıt, tahsilat/ödeme gibi cariyi kapatır: alınan çek B portföy / A 120, verilen çek B 320 / A 103 (ya da senet hesapları).
 * Sonraki her durum değişikliği YENİ bir yevmiyedir (ters kayıt yok): karşılıksız/iade/ciro iadesi cariye yeni bir açık kalem yazar.
 * Hesap eşlemeleri doğrulanmamış varsayılanlardır (LEGAL-NOTES).
 */

const DOC_LABEL = { cheque: 'Çek', note: 'Senet' } as const;
export const ACTION_LABEL: Record<string, string> = {
  deposit: 'Tahsile verme',
  collect: 'Tahsil',
  bounce: 'Karşılıksız',
  return: 'İade',
  endorse: 'Ciro',
  unendorse: 'Ciro iadesi',
  pay: 'Ödeme',
  cancel: 'İptal',
};
const BATCH_PREFIX = 'CTK';

type ChequeRow = typeof cheques.$inferSelect;

/** Belge tutarı ve defter karşılığı ayrı korunur. */
function line(ctx: LedgerCtx, side: 'debit' | 'credit', accountId: string, amount: MoneyValue, extra: Partial<AutoJournalLine> = {},currency=ctx.baseCurrency,base:MoneyValue=amount): AutoJournalLine {
  const a = toDbAmount(amount);
  return {
    accountId,
    currency: currency as AutoJournalLine['currency'],
    ...(currency!==ctx.baseCurrency?{fxRate:toDbRate(base.div(amount))}:{}),
    debit: side === 'debit' ? a : '0',
    credit: side === 'credit' ? a : '0',
    debitBase: side === 'debit' ? toDbAmount(base) : '0',
    creditBase: side === 'credit' ? toDbAmount(base) : '0',
    ...extra,
  };
}

function docKey(direction: string, docType: string): AccountMappingKey {
  if (direction === 'received') return docType === 'cheque' ? 'cheque_portfolio' : 'note_portfolio';
  return docType === 'cheque' ? 'cheque_issued' : 'note_payable';
}

function requireBankAccount(currency: string, ta: TreasuryAccountRow) {
  if (ta.kind !== 'bank') throw unprocessable('Çek/senet işlemi için banka hesabı seçilmeli (kasa değil)', 'CHEQUE_BANK_KIND');
  if (!ta.isActive) throw unprocessable(`${ta.name} hesabı pasif`, 'TREASURY_ACCOUNT_INACTIVE');
  if (ta.currencyCode !== currency) {
    throw unprocessable(`${ta.name} hesabı ${ta.currencyCode} cinsindendir; ${currency} banka hesabı seçin.`, 'CHEQUE_BANK_CURRENCY');
  }
}

// --- Okuma -----------------------------------------------------------------------------------------------------

const COLS = sql`c.id, c.direction, c.doc_type as "docType", c.doc_no as "docNo", c.bank_name as "bankName", c.branch,
  c.party_id as "partyId", p.code as "partyCode", p.name as "partyName", c.amount::text as amount, c.currency_code as "currencyCode",
  c.amount_base::text as "amountBase",c.fx_rate::text as "fxRate",c.issue_date::text as "issueDate", c.due_date::text as "dueDate", c.status, c.holder_party_id as "holderPartyId", hp.name as "holderName",
  c.bank_account_id as "bankAccountId", ta.name as "bankAccountName", c.description, c.entry_id as "entryId", je.entry_no as "entryNo",
  (select max(e.event_date)::text from cheque_events e where e.cheque_id = c.id) as "lastEventDate"`;
const FROM = sql`from cheques c
  join parties p on p.id = c.party_id and p.company_id = c.company_id
  left join parties hp on hp.id = c.holder_party_id and hp.company_id = c.company_id
  left join treasury_accounts ta on ta.id = c.bank_account_id and ta.company_id = c.company_id
  join journal_entries je on je.id = c.entry_id`;

export type ChequeView = {
  id: string;
  direction: 'received' | 'issued';
  docType: 'cheque' | 'note';
  docNo: string;
  bankName: string;
  branch: string | null;
  partyId: string;
  partyCode: string;
  partyName: string;
  amount: string;
  currencyCode: string;
  amountBase: string;
  fxRate: string|null;
  issueDate: string;
  dueDate: string;
  status: string;
  holderPartyId: string | null;
  holderName: string | null;
  bankAccountId: string | null;
  bankAccountName: string | null;
  description: string | null;
  entryId: string;
  entryNo: string | null;
  lastEventDate: string | null;
};

export const OPEN_SQL = sql`((c.direction = 'received' and c.status in ('portfolio','in_collection')) or (c.direction = 'issued' and c.status = 'issued'))`;

export async function listCheques(tx: Tx, q: Omit<ChequeListQuery, 'limit' | 'offset'>, page?: PageQuery) {
  const res = await tx.execute<ChequeView>(sql`
    select ${COLS} ${FROM}
     where true
       ${q.direction ? sql`and c.direction = ${q.direction}` : sql``}
       ${q.docType ? sql`and c.doc_type = ${q.docType}` : sql``}
       ${q.status === 'open' ? sql`and ${OPEN_SQL}` : q.status ? sql`and c.status = ${q.status}` : sql``}
       ${q.partyId ? sql`and (c.party_id = ${q.partyId} or c.holder_party_id = ${q.partyId})` : sql``}
       ${q.bankAccountId ? sql`and c.bank_account_id = ${q.bankAccountId}` : sql``}
       ${q.dueFrom ? sql`and c.due_date >= ${q.dueFrom}::date` : sql``}
       ${q.dueTo ? sql`and c.due_date <= ${q.dueTo}::date` : sql``}
       ${q.q ? sql`and ${trContains(['c.doc_no', 'c.bank_name', 'p.name'], q.q)}` : sql``}
     order by c.due_date, c.doc_no ${pageSql(page)}`);
  const pg = paged(res.rows, page);
  const summary = await tx.execute<{ direction: string; status: string; count: number; amount: string }>(sql`
    select c.direction, c.status, count(*)::int as count, sum(c.amount_base)::numeric(19,2)::text as amount
      from cheques c group by c.direction, c.status order by c.direction, c.status`);
  return { cheques: pg.rows, truncated: pg.truncated, summary: summary.rows, asOf: todayIso() };
}

export async function getCheque(tx: Tx, id: string) {
  const res = await tx.execute<ChequeView>(sql`select ${COLS} ${FROM} where c.id = ${id}`);
  const cheque = res.rows[0];
  if (!cheque) throw notFound('Çek/senet');
  const events = await tx.execute<Record<string, unknown>>(sql`
    select ev.id, ev.from_status as "fromStatus", ev.to_status as "toStatus", ev.event_date::text as "eventDate", ev.note,
           b.batch_no as "batchNo", b.action, je.entry_no as "entryNo", ev.entry_id as "entryId", p.name as "partyName", ta.name as "bankAccountName",
           ev.created_at as "createdAt"
      from cheque_events ev
      left join cheque_batches b on b.id = ev.batch_id and b.company_id = ev.company_id
      join journal_entries je on je.id = ev.entry_id
      left join parties p on p.id = ev.party_id and p.company_id = ev.company_id
      left join treasury_accounts ta on ta.id = ev.bank_account_id and ta.company_id = ev.company_id
     where ev.cheque_id = ${id} order by ev.created_at, ev.id`);
  return { cheque, events: events.rows };
}

// --- Kayıt -------------------------------------------------------------------------------------------------------

/** Çek/senedi kaydeder: tek işlemde yevmiye (cari kalemlerini kapatır, kalanı avans), belge, kayıt olayı, eşleştirmeler. */
export async function createCheque(tx: Tx, ctx: LedgerCtx, input: CreateChequeInput) {
  const date = input.registerDate ?? todayIso();
  await requireOpenPeriod(tx, date);
  const received = input.direction === 'received';
  const control: PartyControlType = received ? 'receivable' : 'payable';
  const amount = dec(input.amount);
  const currency=input.currency??ctx.baseCurrency;
  const rate=currency===ctx.baseCurrency?dec(1):input.fxRate?dec(input.fxRate):await requireRate(tx,currency,ctx.baseCurrency,date,ctx.baseCurrency);

  const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId)).for('update');
  if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
  if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
  if (!partyKindFits(party.kind as PartyKind, control)) {
    throw unprocessable(
      `${party.name} carisi bu belge türüyle uyumlu değil (${received ? 'alınan çek/senet için müşteri' : 'verilen çek/senet için tedarikçi'} olmalı)`,
      'PARTY_KIND_MISMATCH',
    );
  }
  const bankName = input.bankName.trim();
  const [dup] = await tx
    .select({ id: cheques.id })
    .from(cheques)
    .where(and(eq(cheques.direction, input.direction), eq(cheques.docType, input.docType), eq(cheques.bankName, bankName), eq(cheques.docNo, input.docNo.trim())));
  if (dup) throw conflict(`${DOC_LABEL[input.docType]} ${input.docNo.trim()} (${bankName || 'banka belirtilmemiş'}) zaten kayıtlı`, 'CHEQUE_DUPLICATE');

  const open = new Map<string, Awaited<ReturnType<typeof openItemsFor>>['items'][number]>();
  if (input.items.length > 0) {
    await tx.execute(sql`select id from journal_lines where id in (${uuidList(input.items.map((i) => i.lineId))}) order by id for update`);
    for (const it of (await openItemsFor(tx, party.id, control, date)).items) open.set(it.lineId, it);
  }
  const items: SettleItemInput[] = input.items.map((it, n) => {
    const o = open.get(it.lineId);
    if (!o) throw unprocessable(`Kalem ${n + 1}: açık kalem bulunamadı ya da tümüyle kapanmış`, 'ITEM_NOT_OPEN', { lineId: it.lineId });
    return { lineId: it.lineId, currency: o.currencyCode, remainingDoc: dec(o.remaining), remainingBase: dec(o.remainingBase), amount: dec(it.amount), settleAmount: dec(it.settleAmount) };
  });
  await assertAllocatable(tx, control, input.items);
  const plan = planSettlement({ kind: received ? 'receipt' : 'payment', amount, rate, currency, items });
  const key = docKey(input.direction, input.docType);
  const fxKeys: AccountMappingKey[] = [...(plan.fxGain.gt(0) ? (['fx_gain'] as const) : []), ...(plan.fxLoss.gt(0) ? (['fx_loss'] as const) : [])];
  const map = await requireMappings(tx, [key, control, ...fxKeys] as AccountMappingKey[]);

  const id = uuidv7();
  const text = `${received ? 'Alınan' : 'Verilen'} ${DOC_LABEL[input.docType].toLowerCase()} ${input.docNo.trim()} — ${party.name}`.slice(0, 300);
  const built = buildSettlementJournal({
    baseCurrency: ctx.baseCurrency,
    plan,
    items: items.map((it) => ({ ...it, description: text })),
    treasury: { accountId: map[key], currency, amount, rate },
    partyId: party.id,
    controlAccountId: map[control],
    fxGainAccountId: (map as Record<string, string>).fx_gain,
    fxLossAccountId: (map as Record<string, string>).fx_loss,
    text,
  });
  const entry = await createJournalEntry(
    tx,
    ctx,
    { entryDate: date, description: input.description ? `${text} — ${input.description}`.slice(0, 300) : text, lines: built.lines, post: true },
    { source: { type: 'cheque', id } },
  );

  await tx.insert(cheques).values({
    id,
    companyId: ctx.companyId,
    direction: input.direction,
    docType: input.docType,
    docNo: input.docNo.trim(),
    bankName,
    branch: input.branch?.trim() || null,
    partyId: party.id,
    amount: toDbAmount(amount),
    currencyCode: currency,
    amountBase:toDbAmount(plan.treasuryBase),fxRate:currency===ctx.baseCurrency?null:toDbRate(rate),
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    status: CHEQUE_INITIAL_STATUS[input.direction],
    entryId: entry.id,
    description: input.description?.trim() || null,
    createdBy: ctx.userId,
  });
  const eventId = uuidv7();
  await tx.insert(chequeEvents).values({
    id: eventId,
    companyId: ctx.companyId,
    chequeId: id,
    fromStatus: null,
    toStatus: CHEQUE_INITIAL_STATUS[input.direction],
    eventDate: date,
    entryId: entry.id,
    createdBy: ctx.userId,
  });
  await insertAllocations(tx, ctx, { chequeId: id, eventId, partyId: party.id, control, entryId: entry.id, items, plan, itemLineIndex: built.itemLineIndex });
  return getCheque(tx, id);
}

async function insertAllocations(
  tx: Tx,
  ctx: LedgerCtx,
  a: { chequeId: string; eventId: string; partyId: string; control: PartyControlType; entryId: string; items: SettleItemInput[]; plan: ReturnType<typeof planSettlement>; itemLineIndex: number[] },
) {
  if (a.items.length === 0) return;
  const lineRows = await tx.execute<{ id: string; line_no: number }>(sql`select id, line_no from journal_lines where entry_id = ${a.entryId}`);
  const idByNo = new Map(lineRows.rows.map((r) => [Number(r.line_no), r.id]));
  await tx.insert(chequeAllocations).values(
    a.items.map((it, n) => ({
      companyId: ctx.companyId,
      chequeId: a.chequeId,
      eventId: a.eventId,
      partyId: a.partyId,
      control: a.control,
      chargeLineId: it.lineId,
      settleLineId: idByNo.get(a.itemLineIndex[n]! + 1)!,
      amount: toDbAmount(it.amount),
      amountBase: toDbAmount(a.plan.parts[n]!.carry),
      settleAmount: toDbAmount(it.settleAmount),
    })),
  );
}

export async function updateCheque(tx: Tx, id: string, input: { branch?: string | null; description?: string | null }) {
  const set: Partial<typeof cheques.$inferInsert> = { updatedAt: new Date() };
  if (input.branch !== undefined) set.branch = input.branch?.trim() || null;
  if (input.description !== undefined) set.description = input.description?.trim() || null;
  const rows = await tx.update(cheques).set(set).where(eq(cheques.id, id)).returning({ id: cheques.id });
  if (rows.length === 0) throw notFound('Çek/senet');
  return getCheque(tx, id);
}

// --- Durum eylemleri / takas -----------------------------------------------------------------------------------------

/**
 * Bir ya da birçok belgeye aynı eylemi uygular (takas = toplu tahsile verme/tahsil/ödeme): tek toplu işlem, tek yevmiye;
 * banka tarafı toplu tek satırdır (banka ekstresinde tek kalem olarak eşleşir). Tüm belgeler aynı yönde ve eylemin önceki durumunda olmalı.
 * Kilit sırası: banka hesabı → cari → belgeler (id sırasıyla) → cari kalemleri → toplu işlem numarası → yevmiye numarası.
 */
export async function runChequeAction(tx: Tx, ctx: LedgerCtx, input: ChequeActionInput) {
  const date = input.date;
  await requireOpenPeriod(tx, date);
  const ids = [...new Set(input.chequeIds)];

  // Belgeleri (kilitsiz) okuyup banka hesabını belirle; sonra kilit sırasıyla yeniden oku
  const pre = await tx.select().from(cheques).where(inArray(cheques.id, ids));
  if (pre.length !== ids.length) throw notFound('Çek/senet');
  const direction = pre[0]!.direction as 'received' | 'issued';
  const currency=pre[0]!.currencyCode;
  if(pre.some(c=>c.currencyCode!==currency))throw unprocessable('Takas işlemi için aynı para birimindeki belgeleri seçin.','CHEQUE_MIXED_CURRENCY');
  if (pre.some((c) => c.direction !== direction)) throw unprocessable('Alınan ve verilen belgeler aynı işlemde yapılamaz', 'CHEQUE_MIXED_DIRECTION');
  const tr = chequeTransition(direction, input.action);
  if (!tr) throw unprocessable(`${direction === 'received' ? 'Alınan' : 'Verilen'} belgeler için "${ACTION_LABEL[input.action]}" eylemi yoktur`, 'CHEQUE_ACTION_INVALID');

  let bankId: string | null = input.bankAccountId ?? null;
  if (input.action === 'collect') {
    const banks = new Set(pre.map((c) => c.bankAccountId));
    if (banks.size !== 1 || [...banks][0] === null) {
      throw unprocessable('Tahsil edilecek belgeler aynı banka hesabına tahsile verilmiş olmalı (takas işlemini hesap hesap yapın)', 'CHEQUE_BANK_MISMATCH');
    }
    bankId = [...banks][0]!;
  }
  let bank: TreasuryAccountRow | null = null;
  if (bankId) {
    bank = (await lockTreasuryAccounts(tx, [bankId])).get(bankId)!;
    requireBankAccount(currency, bank);
  }

  let endorsee: typeof parties.$inferSelect | null = null;
  if (input.action === 'endorse') {
    [endorsee] = await tx.select().from(parties).where(eq(parties.id, input.partyId!)).for('update');
    if (!endorsee) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
    if (!endorsee.isActive) throw unprocessable(`${endorsee.name} carisi pasif`, 'PARTY_INACTIVE');
    if (!partyKindFits(endorsee.kind as PartyKind, 'payable')) throw unprocessable(`${endorsee.name} carisi tedarikçi olmalı`, 'PARTY_KIND_MISMATCH');
  }

  const rows: ChequeRow[] = await tx.select().from(cheques).where(inArray(cheques.id, ids)).orderBy(cheques.id).for('update');
  for (const c of rows) {
    if (c.status !== tr.from) {
      throw unprocessable(`${DOC_LABEL[c.docType as 'cheque' | 'note']} ${c.docNo}: "${ACTION_LABEL[input.action]}" için durum uygun değil`, 'CHEQUE_STATUS_INVALID', { chequeId: c.id, status: c.status });
    }
    if (input.action === 'endorse' && c.partyId === endorsee!.id) throw unprocessable('Belge, keşidecisine ciro edilemez; iade işlemi kullanın', 'CHEQUE_ENDORSE_SELF');
  }
  const lastEvents = await tx.execute<{ cheque_id: string; d: string }>(sql`
    select cheque_id, max(event_date)::text as d from cheque_events where cheque_id in (${uuidList(ids)}) group by cheque_id`);
  for (const e of lastEvents.rows) {
    if (date < e.d) {
      const c = rows.find((r) => r.id === e.cheque_id)!;
      throw unprocessable(`${DOC_LABEL[c.docType as 'cheque' | 'note']} ${c.docNo}: işlem tarihi önceki işlem tarihinden (${e.d}) önce olamaz`, 'CHEQUE_DATE_BEFORE_EVENT');
    }
  }

  const total = sum(rows.map((c) => c.amount));
  const totalBase=sum(rows.map(c=>c.amountBase));
  const carryingRate=totalBase.div(total);
  const bankRate=input.action==='collect'||input.action==='pay'?(currency===ctx.baseCurrency?dec(1):input.fxRate?dec(input.fxRate):await requireRate(tx,currency,ctx.baseCurrency,date,ctx.baseCurrency)):carryingRate;
  const bankBase=applyRate(total,bankRate);
  const year = isoYear(date);
  const text = (c?: ChequeRow) => (c ? `${ACTION_LABEL[input.action]}: ${DOC_LABEL[c.docType as 'cheque' | 'note']} ${c.docNo}` : `${ACTION_LABEL[input.action]}`);

  // Gerekli hesap eşlemeleri
  const keys = new Set<AccountMappingKey>();
  if((input.action==='collect'||input.action==='pay')&&!bankBase.eq(totalBase)){keys.add('fx_gain');keys.add('fx_loss');}
  const usesDocAccount = !(input.action === 'collect' || (input.action === 'bounce' && direction === 'received'));
  if (usesDocAccount) for (const c of rows) keys.add(docKey(direction, c.docType));
  if (input.action === 'deposit' || input.action === 'collect' || (input.action === 'bounce' && direction === 'received')) keys.add('docs_in_collection');
  if (input.action === 'return' || (input.action === 'bounce' && direction === 'received')) keys.add('receivable');
  if (input.action === 'endorse' || input.action === 'unendorse' || input.action === 'cancel' || (input.action === 'bounce' && direction === 'issued')) keys.add('payable');

  // Endorse: kalem eşleştirmesi (ödeme türü) için tedarikçi açık kalemleri
  let settleItems: SettleItemInput[] = [];
  let plan: ReturnType<typeof planSettlement> | null = null;
  if (input.action === 'endorse') {
    const open = new Map<string, Awaited<ReturnType<typeof openItemsFor>>['items'][number]>();
    if (input.items.length > 0) {
      await tx.execute(sql`select id from journal_lines where id in (${uuidList(input.items.map((i) => i.lineId))}) order by id for update`);
      for (const it of (await openItemsFor(tx, endorsee!.id, 'payable', date)).items) open.set(it.lineId, it);
    }
    settleItems = input.items.map((it, n) => {
      const o = open.get(it.lineId);
      if (!o) throw unprocessable(`Kalem ${n + 1}: açık kalem bulunamadı ya da tümüyle kapanmış`, 'ITEM_NOT_OPEN', { lineId: it.lineId });
      return { lineId: it.lineId, currency: o.currencyCode, remainingDoc: dec(o.remaining), remainingBase: dec(o.remainingBase), amount: dec(it.amount), settleAmount: dec(it.settleAmount) };
    });
    const used = settleItems.reduce((s, i) => s.plus(i.settleAmount), dec(0));
    if (used.gt(total)) throw unprocessable('Kalemlere ayrılan tutar belge toplamını aşıyor', 'ALLOCATION_EXCEEDS_AMOUNT');
    await assertAllocatable(tx, 'payable', input.items);
    plan = planSettlement({ kind: 'payment', amount: total, rate: carryingRate, currency, items: settleItems });
    const delta=totalBase.minus(plan.treasuryBase);
    if(delta.gt(0))plan.fxLoss=plan.fxLoss.plus(delta);else plan.fxGain=plan.fxGain.plus(delta.abs());
    plan.treasuryBase=totalBase;
    if (plan.fxGain.gt(0)) keys.add('fx_gain');
    if (plan.fxLoss.gt(0)) keys.add('fx_loss');
  }
  const map = (await requireMappings(tx, [...keys])) as Record<string, string>;
  const acct = (c: ChequeRow) => map[docKey(direction, c.docType)]!;

  const batchId = uuidv7();
  const batchNo = await nextDocumentNumber(tx, ctx.companyId, 'CHQB', year, BATCH_PREFIX);
  const heading = `${ACTION_LABEL[input.action]} ${batchNo}${rows.length === 1 ? ` — ${DOC_LABEL[rows[0]!.docType as 'cheque' | 'note']} ${rows[0]!.docNo}` : ` — ${rows.length} belge`}`.slice(0, 300);
  const desc = input.note ? `${heading} — ${input.note}`.slice(0, 300) : heading;

  // Hesap bazında toplanan (cari olmayan) tutarlar
  const byAccount = (rs: ChequeRow[]) => {
    const m = new Map<string, {amount:MoneyValue;base:MoneyValue}>();
    for (const c of rs) {const prior=m.get(acct(c))??{amount:dec(0),base:dec(0)};m.set(acct(c),{amount:prior.amount.plus(c.amount),base:prior.base.plus(c.amountBase)});}
    return m;
  };
  const accountLines = (side: 'debit' | 'credit', rs: ChequeRow[], description: string) =>
    [...byAccount(rs)].map(([accountId, amt]) => line(ctx, side, accountId, amt.amount, { description },currency,amt.base));
  const partyLines = (rs: ChequeRow[], side: 'debit' | 'credit', accountId: string, partyOf: (c: ChequeRow) => string) =>
    rs.map((c) => line(ctx, side, accountId, dec(c.amount), { partyId: partyOf(c), dueDate: date, description: text(c).slice(0, 300) },currency,dec(c.amountBase)));

  let lines: AutoJournalLine[] = [];
  let itemLineIndex: number[] = [];
  switch (input.action) {
    case 'deposit':
      lines = [line(ctx, 'debit', map.docs_in_collection!, total, { description: heading },currency,totalBase), ...accountLines('credit', rows, heading)];
      break;
    case 'collect':
      lines = buildExchangeJournal({baseCurrency:ctx.baseCurrency,from:{accountId:map.docs_in_collection!,currency,amount:total,baseValue:totalBase},to:{accountId:bank!.accountId,currency,amount:total,baseValue:bankBase},fxGainAccountId:map.fx_gain,fxLossAccountId:map.fx_loss,text:heading});
      break;
    case 'bounce':
      lines =
        direction === 'received'
          ? [...partyLines(rows, 'debit', map.receivable!, (c) => c.partyId), line(ctx, 'credit', map.docs_in_collection!, total, { description: heading },currency,totalBase)]
          : [...accountLines('debit', rows, heading), ...partyLines(rows, 'credit', map.payable!, (c) => c.partyId)];
      break;
    case 'return':
      lines = [...partyLines(rows, 'debit', map.receivable!, (c) => c.partyId), ...accountLines('credit', rows, heading)];
      break;
    case 'unendorse':
      lines = [...accountLines('debit', rows, heading), ...partyLines(rows, 'credit', map.payable!, (c) => c.holderPartyId!)];
      break;
    case 'pay':
      {const j=buildExchangeJournal({baseCurrency:ctx.baseCurrency,from:{accountId:bank!.accountId,currency,amount:total,baseValue:bankBase},to:{accountId:acct(rows[0]!),currency,amount:total,baseValue:totalBase},fxGainAccountId:map.fx_gain,fxLossAccountId:map.fx_loss,text:heading});lines=[...accountLines('debit',rows,heading),j[0]!,...j.slice(2)];}
      break;
    case 'cancel':
      lines = [...accountLines('debit', rows, heading), ...partyLines(rows, 'credit', map.payable!, (c) => c.partyId)];
      break;
    case 'endorse': {
      // Ödeme kalıbı: cari borçlanır (kalemler + avans), portföy hesapları alacaklanır (belge türüne göre bölünür)
      const j = buildSettlementJournal({
        baseCurrency: ctx.baseCurrency,
        plan: plan!,
        items: settleItems.map((it) => ({ ...it, description: heading })),
        treasury: { accountId: acct(rows[0]!), currency, amount: total, rate: carryingRate },
        partyId: endorsee!.id,
        controlAccountId: map.payable!,
        fxGainAccountId: map.fx_gain,
        fxLossAccountId: map.fx_loss,
        text: heading,
      });
      const split = accountLines('credit', rows, heading);
      // Birinci satır (tek hesaplı portföy satırı) hesap bazlı satırlarla değişir; kalan satır numaraları kayar
      lines = [...split, ...j.lines.slice(1)];
      itemLineIndex = j.itemLineIndex.map((i) => i - 1 + split.length);
      break;
    }
  }

  const entry = await createJournalEntry(tx, ctx, { entryDate: date, description: desc, lines, post: true }, { source: { type: 'cheque_batch', id: batchId } });

  await tx.insert(chequeBatches).values({
    id: batchId,
    companyId: ctx.companyId,
    batchNo,
    action: input.action,
    eventDate: date,
    bankAccountId: bank?.id ?? null,
    partyId: endorsee?.id ?? null,
    total: toDbAmount(total),
    totalBase:toDbAmount(totalBase),currencyCode:currency,
    docCount: rows.length,
    entryId: entry.id,
    note: input.note?.trim() || null,
    createdBy: ctx.userId,
  });

  let firstEventId = '';
  for (const c of rows) {
    const eventId = uuidv7();
    if (!firstEventId) firstEventId = eventId;
    await tx.insert(chequeEvents).values({
      id: eventId,
      companyId: ctx.companyId,
      chequeId: c.id,
      fromStatus: tr.from,
      toStatus: tr.to,
      eventDate: date,
      batchId,
      entryId: entry.id,
      partyId: input.action === 'endorse' ? endorsee!.id : input.action === 'unendorse' ? c.holderPartyId : null,
      bankAccountId: bank?.id ?? null,
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    });
    await tx
      .update(cheques)
      .set({
        status: tr.to,
        holderPartyId: input.action === 'endorse' ? endorsee!.id : null,
        ...(input.action === 'deposit' || input.action === 'pay' ? { bankAccountId: bank!.id } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cheques.id, c.id));
    // Ciro: eşleştirme ilk belgenin olayına bağlanır (kalemler toplamı kapatır; belge başına bölünmez)
    if (input.action === 'endorse' && c === rows[0]) {
      await insertAllocations(tx, ctx, { chequeId: c.id, eventId, partyId: endorsee!.id, control: 'payable', entryId: entry.id, items: settleItems, plan: plan!, itemLineIndex });
    }
  }

  const detail = await tx.execute<ChequeView>(sql`select ${COLS} ${FROM} where c.id in (${uuidList(ids)}) order by c.due_date, c.doc_no`);
  return { batch: { id: batchId, batchNo, action: input.action, eventDate: date, total: dec(total).toFixed(2),totalBase:toDbAmount(totalBase),currencyCode:currency, docCount: rows.length, entryId: entry.id }, cheques: detail.rows };
}

/** Toplu işlem (takas) geçmişi: son N işlem. */
export async function listBatches(tx: Tx, limit = 100) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    select b.id, b.batch_no as "batchNo", b.action, b.event_date::text as "eventDate", b.total::text as total,b.total_base::text as "totalBase",b.currency_code as "currencyCode", b.doc_count as "docCount",
           ta.name as "bankAccountName", p.name as "partyName", je.entry_no as "entryNo", b.entry_id as "entryId", b.note
      from cheque_batches b
      left join treasury_accounts ta on ta.id = b.bank_account_id and ta.company_id = b.company_id
      left join parties p on p.id = b.party_id and p.company_id = b.company_id
      join journal_entries je on je.id = b.entry_id
     order by b.event_date desc, b.batch_no desc limit ${limit}`);
  return { batches: res.rows };
}
