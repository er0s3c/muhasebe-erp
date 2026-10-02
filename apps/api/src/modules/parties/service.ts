import { eq, sql, type SQL } from 'drizzle-orm';
import {
  dec,
  toDbAmount,
  type CreatePartyInput,
  type ListPartiesQuery,
  type PartyControlType,
  type UpdatePartyInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { journalLines, parties } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { TR, trContains } from '../../db/search';
import { nextNumber } from '../settings/numbering';
import { assertReportSize, maxReportRows } from '../../http/limits';
import { buildAgingReport, computeOpenItems, type PartyAllocation, type PartyLine } from './aging';

const PARTY_SEQUENCE = 'PARTY';

export async function generateCode(tx: Tx, companyId: string, taken?: ReadonlySet<string>): Promise<string> {
  // Yıla bağlı olmayan sayaç: yıl = 0. `taken`: toplu içe aktarmada dosyadaki açık kodlar (çakışan numara atlanır)
  for (;;) {
    const n = await nextNumber(tx, companyId, PARTY_SEQUENCE, 0);
    const code = `CR-${String(n).padStart(6, '0')}`;
    if (!taken?.has(code)) return code;
  }
}

export async function createParty(tx: Tx, companyId: string, input: CreatePartyInput, taken?: ReadonlySet<string>) {
  const code = input.code ?? (await generateCode(tx, companyId, taken));
  const [dup] = await tx.select({ id: parties.id }).from(parties).where(eq(parties.code, code));
  if (dup) throw conflict(`${code} kodlu cari zaten var`, 'PARTY_CODE_TAKEN');

  const [row] = await tx
    .insert(parties)
    .values({
      companyId,
      code,
      name: input.name,
      kind: input.kind,
      taxNumber: input.taxNumber ?? null,
      taxOffice: input.taxOffice ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      currencyCode: input.currencyCode,
      creditLimit: input.creditLimit ?? null,
      paymentTermDays: input.paymentTermDays,
      notes: input.notes ?? null,
    })
    .returning();
  return row!;
}

export async function updateParty(tx: Tx, id: string, input: UpdatePartyInput) {
  const values: Partial<typeof parties.$inferInsert> = {};
  for (const key of ['name', 'kind', 'taxNumber', 'taxOffice', 'phone', 'email', 'address', 'currencyCode', 'paymentTermDays', 'notes', 'isActive'] as const) {
    if (input[key] !== undefined) (values as Record<string, unknown>)[key] = input[key];
  }
  if (input.creditLimit !== undefined) values.creditLimit = input.creditLimit;

  // Türü daraltırken (örn. "her ikisi" -> "müşteri") tersine hareketi olan cariyi bozma
  if (input.kind && input.kind !== 'both') {
    const wrong = input.kind === 'customer' ? 'payable' : 'receivable';
    const r = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_lines l
      join accounts a on a.id = l.account_id
      where l.party_id = ${id} and a.party_control = ${wrong}`);
    if ((r.rows[0]?.n ?? 0) > 0) {
      throw unprocessable('Cari, diğer türde hareket gördüğü için türü daraltılamaz', 'PARTY_KIND_IN_USE');
    }
  }

  if (Object.keys(values).length === 0) return getPartyRow(tx, id);
  const [row] = await tx.update(parties).set(values).where(eq(parties.id, id)).returning();
  if (!row) throw notFound('Cari');
  return row;
}

async function getPartyRow(tx: Tx, id: string) {
  const [row] = await tx.select().from(parties).where(eq(parties.id, id));
  if (!row) throw notFound('Cari');
  return row;
}

export async function deleteParty(tx: Tx, id: string) {
  await getPartyRow(tx, id);
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(journalLines)
    .where(eq(journalLines.partyId, id));
  if (used && used.n > 0) {
    throw unprocessable('Hareketi olan cari silinemez; pasifleştirin', 'PARTY_HAS_MOVEMENTS');
  }
  await tx.delete(parties).where(eq(parties.id, id));
}

interface BalanceRow extends Record<string, unknown> {
  debit: string;
  credit: string;
  movements: number;
}

export async function getParty(tx: Tx, id: string) {
  const party = await getPartyRow(tx, id);
  const totals = await tx.execute<BalanceRow>(sql`
    select coalesce(sum(l.debit_base), 0) as debit, coalesce(sum(l.credit_base), 0) as credit, count(*)::int as movements
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.party_id = ${id}`);
  const byCurrency = await tx.execute<{ currency: string; balance: string }>(sql`
    select l.currency_code as currency, sum(l.debit) - sum(l.credit) as balance
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.party_id = ${id}
    group by l.currency_code order by l.currency_code`);
  const t = totals.rows[0]!;
  return {
    party,
    summary: {
      debit: toDbAmount(t.debit),
      credit: toDbAmount(t.credit),
      /** Borç − alacak (defter para birimi). Pozitif: cari bize borçlu. */
      balance: toDbAmount(dec(t.debit).minus(t.credit)),
      movements: t.movements,
      byCurrency: byCurrency.rows
        .filter((r) => !dec(r.balance).isZero())
        .map((r) => ({ currency: r.currency, balance: toDbAmount(r.balance) })),
    },
  };
}

export async function listParties(tx: Tx, q: ListPartiesQuery) {
  // Personel carileri (Faz X5) cari listesinde görünmez: personel cari ekranından (ücret/avans izinleriyle) yönetilir
  const conds: SQL[] = [sql`p.kind <> 'employee'`];
  if (q.query) conds.push(trContains(['p.name', 'p.code', "coalesce(p.tax_number, '')", "coalesce(p.phone, '')"], q.query));
  if (q.kind === 'customer') conds.push(sql`p.kind in ('customer','both')`);
  if (q.kind === 'supplier') conds.push(sql`p.kind in ('supplier','both')`);
  if (q.kind === 'both') conds.push(sql`p.kind = 'both'`);
  if (q.active) conds.push(sql`p.is_active = ${q.active === 'true'}`);
  if (q.hasBalance === 'true') conds.push(sql`coalesce(t.debit, 0) <> coalesce(t.credit, 0)`);
  const where = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;

  const from = sql`
    from parties p
    left join (
      select l.party_id, sum(l.debit_base) as debit, sum(l.credit_base) as credit, count(*) as n
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      where l.party_id is not null
      group by l.party_id
    ) t on t.party_id = p.id
    ${where}`;

  const rows = await tx.execute<Record<string, unknown>>(sql`
    select p.id, p.code, p.name, p.kind, p.phone, p.email, p.tax_number as "taxNumber",
           p.currency_code as "currencyCode", p.is_active as "isActive", p.credit_limit as "creditLimit",
           coalesce(t.debit, 0) as debit, coalesce(t.credit, 0) as credit,
           coalesce(t.debit, 0) - coalesce(t.credit, 0) as balance,
           coalesce(t.n, 0)::int as movements
    ${from}
    order by p.name collate ${TR}, p.code
    limit ${q.limit} offset ${q.offset}`);
  const total = await tx.execute<{ n: number }>(sql`select count(*)::int as n ${from}`);
  return { parties: rows.rows, total: total.rows[0]?.n ?? 0 };
}

interface StatementRow extends Record<string, unknown> {
  entry_id: string;
  entry_no: string;
  entry_date: string;
  account_code: string;
  control: PartyControlType;
  description: string;
  currency_code: string;
  fx_rate: string;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
  due_date: string | null;
}

export async function partyStatement(tx: Tx, id: string, q: { from: string; to: string }) {
  const party = await getPartyRow(tx, id);
  const opening = await tx.execute<{ d: string; c: string }>(sql`
    select coalesce(sum(l.debit_base), 0) as d, coalesce(sum(l.credit_base), 0) as c
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.party_id = ${id} and e.entry_date < ${q.from}::date`);

  const lines = await tx.execute<StatementRow>(sql`
    select e.id as entry_id, e.entry_no, e.entry_date::text as entry_date, a.code as account_code,
           a.party_control as control, coalesce(l.description, e.description) as description,
           l.currency_code, l.fx_rate, l.debit, l.credit, l.debit_base, l.credit_base,
           l.due_date::text as due_date
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    join accounts a on a.id = l.account_id
    where l.party_id = ${id} and e.entry_date between ${q.from}::date and ${q.to}::date
    order by e.entry_date, e.entry_no, l.line_no
    limit ${maxReportRows() + 1}`);
  assertReportSize(lines.rows.length);

  const openingNet = dec(opening.rows[0]?.d ?? 0).minus(opening.rows[0]?.c ?? 0);
  let running = openingNet;
  let totalD = dec(0);
  let totalC = dec(0);
  const out = lines.rows.map((r) => {
    running = running.plus(r.debit_base).minus(r.credit_base);
    totalD = totalD.plus(r.debit_base);
    totalC = totalC.plus(r.credit_base);
    return {
      entryId: r.entry_id,
      entryNo: r.entry_no,
      entryDate: r.entry_date,
      dueDate: r.due_date,
      accountCode: r.account_code,
      control: r.control,
      description: r.description,
      currencyCode: r.currency_code,
      fxRate: r.fx_rate,
      debit: r.debit,
      credit: r.credit,
      debitBase: r.debit_base,
      creditBase: r.credit_base,
      balance: toDbAmount(running),
    };
  });

  return {
    party: { id: party.id, code: party.code, name: party.name },
    from: q.from,
    to: q.to,
    opening: toDbAmount(openingNet),
    lines: out,
    totals: { debitBase: toDbAmount(totalD), creditBase: toDbAmount(totalC) },
    closing: toDbAmount(running),
  };
}

interface LineRow extends Record<string, unknown> {
  line_id: string;
  party_id: string;
  party_code: string;
  party_name: string;
  entry_id: string;
  entry_no: string;
  entry_date: string;
  line_no: number;
  due_date: string | null;
  description: string;
  currency_code: string;
  debit: string;
  credit: string;
  debit_base: string;
  credit_base: string;
}

/**
 * Cari kontrol hesabı satırları (kaydedilmiş, `asOf` tarihine kadar) ve tahsilat/ödeme eşleştirmeleri.
 * Ters çevrilmiş fiş çiftleri (orijinal + ters kayıt, ters kayıt `asOf`'a kadar yapılmışsa) açık kalem
 * hesabında nötr sayılır: iptal edilen fatura/tahsilat hayalet kalem bırakmaz. Ekstre etkilenmez.
 */
async function loadPartyLines(tx: Tx, type: PartyControlType, asOf: string, partyId?: string) {
  const rows = await tx.execute<LineRow>(sql`
    select l.id as line_id, l.party_id, p.code as party_code, p.name as party_name,
           e.id as entry_id, e.entry_no, e.entry_date::text as entry_date, l.line_no,
           l.due_date::text as due_date, coalesce(l.description, e.description) as description,
           l.currency_code, l.debit, l.credit, l.debit_base, l.credit_base
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    left join journal_entries rv on rv.id = e.reversed_by_id and rv.status = 'posted' and rv.entry_date <= ${asOf}::date
    join accounts a on a.id = l.account_id
    join parties p on p.id = l.party_id
    where a.party_control = ${type} and e.entry_date <= ${asOf}::date
      and e.reversal_of_id is null and rv.id is null
      ${partyId ? sql`and l.party_id = ${partyId}` : sql``}`);

  const byParty = new Map<string, { code: string; name: string; lines: PartyLine[]; allocations: PartyAllocation[] }>();
  for (const r of rows.rows) {
    let entry = byParty.get(r.party_id);
    if (!entry) {
      entry = { code: r.party_code, name: r.party_name, lines: [], allocations: [] };
      byParty.set(r.party_id, entry);
    }
    entry.lines.push({
      lineId: r.line_id,
      partyId: r.party_id,
      entryId: r.entry_id,
      entryNo: r.entry_no,
      entryDate: r.entry_date,
      lineNo: r.line_no,
      dueDate: r.due_date,
      description: r.description,
      currencyCode: r.currency_code,
      debit: r.debit,
      credit: r.credit,
      debitBase: r.debit_base,
      creditBase: r.credit_base,
    });
  }

  // Kasa/banka hareketlerinin kalem eşleştirmeleri: hareket `asOf`'ta geçerliyse (iptali sonradan) sayılır
  const allocs = await tx.execute<{ party_id: string; charge_line_id: string; settle_line_id: string; amount: string; amount_base: string }>(sql`
    select a.party_id, a.charge_line_id, a.settle_line_id, a.amount, a.amount_base
    from party_allocations a
    join treasury_transactions t on t.id = a.transaction_id
    left join journal_entries cj on cj.id = t.cancel_journal_entry_id
    where a.control = ${type} and t.txn_date <= ${asOf}::date
      and (t.status = 'posted' or cj.entry_date > ${asOf}::date)
      ${partyId ? sql`and a.party_id = ${partyId}` : sql``}`);
  // Kasasız kalem kapatma (gayrimenkul fesih yevmiyesi): fesih tarihinde geçerlidir
  const writeoffs = type === 'receivable'
    ? await tx.execute<{ party_id: string; charge_line_id: string; settle_line_id: string; amount: string; amount_base: string }>(sql`
        select w.party_id, w.charge_line_id, w.settle_line_id, w.amount, w.amount_base
        from sales_writeoffs w
        join journal_entries e on e.id = w.entry_id
        where e.entry_date <= ${asOf}::date
          ${partyId ? sql`and w.party_id = ${partyId}` : sql``}`)
    : { rows: [] as { party_id: string; charge_line_id: string; settle_line_id: string; amount: string; amount_base: string }[] };
  // Çek/senet kaydı ve cirosunun kalem kapatması (Faz X1): olay tarihinde geçerlidir
  const chequeAllocs = await tx.execute<{ party_id: string; charge_line_id: string; settle_line_id: string; amount: string; amount_base: string }>(sql`
    select a.party_id, a.charge_line_id, a.settle_line_id, a.amount, a.amount_base
    from cheque_allocations a
    join cheque_events ev on ev.id = a.event_id
    where a.control = ${type} and ev.event_date <= ${asOf}::date
      ${partyId ? sql`and a.party_id = ${partyId}` : sql``}`);
  for (const a of [...allocs.rows, ...writeoffs.rows, ...chequeAllocs.rows]) {
    byParty.get(a.party_id)?.allocations.push({
      chargeLineId: a.charge_line_id,
      settleLineId: a.settle_line_id,
      amount: a.amount,
      amountBase: a.amount_base,
    });
  }
  return byParty;
}

/** Tüm carilerin açık kalemleri (nakit projeksiyonu): vade, kalan tutar (kalem para biriminde ve defterde), cari adı. */
export async function allOpenItems(tx: Tx, type: PartyControlType, asOf: string) {
  const byParty = await loadPartyLines(tx, type, asOf);
  const out: (ReturnType<typeof computeOpenItems>['items'][number] & { partyName: string })[] = [];
  for (const p of byParty.values()) for (const it of computeOpenItems(p.lines, type, asOf, p.allocations).items) out.push({ ...it, partyName: p.name });
  return out;
}

/** Bir carinin açık kalemleri (kasa/banka tahsilat ve ödemesinde eşleştirme için de kullanılır). */
export async function openItemsFor(tx: Tx, partyId: string, type: PartyControlType, asOf: string) {
  const byParty = await loadPartyLines(tx, type, asOf, partyId);
  const p = byParty.get(partyId);
  return computeOpenItems(p?.lines ?? [], type, asOf, p?.allocations ?? []);
}

export async function partyAging(tx: Tx, q: { type: PartyControlType; asOf: string }) {
  return buildAgingReport(await loadPartyLines(tx, q.type, q.asOf), q.type, q.asOf);
}

export async function partyOpenItems(tx: Tx, id: string, q: { asOf: string; type?: PartyControlType }) {
  await getPartyRow(tx, id);
  const types: PartyControlType[] = q.type ? [q.type] : ['receivable', 'payable'];
  const result: Partial<Record<PartyControlType, ReturnType<typeof computeOpenItems>>> = {};
  for (const type of types) {
    const byParty = await loadPartyLines(tx, type, q.asOf, id);
    const p = byParty.get(id);
    result[type] = computeOpenItems(p?.lines ?? [], type, q.asOf, p?.allocations ?? []);
  }
  return { asOf: q.asOf, ...result };
}
