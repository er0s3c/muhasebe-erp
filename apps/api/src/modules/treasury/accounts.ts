import { eq, inArray, sql } from 'drizzle-orm';
import {
  TREASURY_PARENT_CODE,
  dec,
  roundMoney,
  toDbAmount,
  type CreateTreasuryAccountInput,
  type MoneyValue,
  type TreasuryAccountKind,
  type UpdateTreasuryAccountInput,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { accounts, treasuryAccounts } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { createAccount } from '../ledger/accounts';
import type { LedgerCtx } from '../ledger/journal';
import { findRate } from '../settings/rates';

export type TreasuryAccountRow = typeof treasuryAccounts.$inferSelect;

/** Üst hesabın (100/102) altındaki bir sonraki alt hesap kodu: 102.001, 102.002… */
async function nextSubCode(tx: Tx, parentCode: string): Promise<string> {
  const rows = await tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(sql`${accounts.code} like ${`${parentCode}.%`}`);
  let max = 0;
  for (const r of rows) {
    const m = new RegExp(`^${parentCode}\\.(\\d+)$`).exec(r.code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${parentCode}.${String(max + 1).padStart(3, '0')}`;
}

/** Yeni alt hesap açar ya da mevcut hesaba bağlar; kasa/banka hesabını oluşturur. */
export async function createTreasuryAccount(tx: Tx, ctx: LedgerCtx, input: CreateTreasuryAccountInput) {
  const foreign = input.currency !== ctx.baseCurrency;
  const parentCode = TREASURY_PARENT_CODE[input.kind];

  let glId: string;
  if (input.linkAccountId) {
    const [a] = await tx.select().from(accounts).where(eq(accounts.id, input.linkAccountId));
    if (!a) throw unprocessable('Muhasebe hesabı bulunamadı', 'ACCOUNT_NOT_FOUND');
    if (a.code !== parentCode && !a.code.startsWith(`${parentCode}.`)) {
      throw unprocessable(`Bağlanacak hesap ${parentCode} grubunda olmalı (${a.code})`, 'TREASURY_ACCOUNT_GROUP');
    }
    if (!a.isPostable || !a.isActive || a.partyControl) {
      throw unprocessable(`${a.code} hesabı kayıt atılabilir ve aktif olmalı`, 'ACCOUNT_NOT_POSTABLE');
    }
    if ((a.currencyCode ?? ctx.baseCurrency) !== input.currency) {
      throw unprocessable(
        `${a.code} hesabı ${a.currencyCode ?? ctx.baseCurrency} cinsinden; seçilen para birimi ${input.currency}`,
        'ACCOUNT_CURRENCY_MISMATCH',
      );
    }
    glId = a.id;
  } else {
    const created = await createAccount(tx, ctx.companyId, {
      code: await nextSubCode(tx, parentCode),
      name: input.name,
      currencyCode: foreign ? input.currency : null,
    });
    glId = created.id;
  }

  const [dupGl] = await tx.select({ id: treasuryAccounts.id }).from(treasuryAccounts).where(eq(treasuryAccounts.accountId, glId));
  if (dupGl) throw conflict('Bu muhasebe hesabı zaten bir kasa/banka hesabına bağlı', 'TREASURY_ACCOUNT_LINKED');
  const [dupName] = await tx.select({ id: treasuryAccounts.id }).from(treasuryAccounts).where(eq(treasuryAccounts.name, input.name));
  if (dupName) throw conflict(`"${input.name}" adlı kasa/banka hesabı zaten var`, 'TREASURY_ACCOUNT_NAME_TAKEN');

  const [row] = await tx
    .insert(treasuryAccounts)
    .values({
      companyId: ctx.companyId,
      kind: input.kind,
      name: input.name,
      currencyCode: input.currency,
      accountId: glId,
      bankName: input.bankName ?? null,
      branch: input.branch ?? null,
      iban: input.iban ?? null,
      accountNo: input.accountNo ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  return row!;
}

export async function updateTreasuryAccount(tx: Tx, id: string, input: UpdateTreasuryAccountInput) {
  const [existing] = await tx.select().from(treasuryAccounts).where(eq(treasuryAccounts.id, id));
  if (!existing) throw notFound('Kasa/banka hesabı');
  if (input.name && input.name !== existing.name) {
    const [dup] = await tx.select({ id: treasuryAccounts.id }).from(treasuryAccounts).where(eq(treasuryAccounts.name, input.name));
    if (dup) throw conflict(`"${input.name}" adlı kasa/banka hesabı zaten var`, 'TREASURY_ACCOUNT_NAME_TAKEN');
  }
  const [row] = await tx
    .update(treasuryAccounts)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
      ...(input.iban !== undefined ? { iban: input.iban } : {}),
      ...(input.accountNo !== undefined ? { accountNo: input.accountNo } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(treasuryAccounts.id, id))
    .returning();
  return row!;
}

export async function getTreasuryAccountRow(tx: Tx, id: string): Promise<TreasuryAccountRow> {
  const [row] = await tx.select().from(treasuryAccounts).where(eq(treasuryAccounts.id, id));
  if (!row) throw notFound('Kasa/banka hesabı');
  return row;
}

/** İşlemde kullanılacak hesapları kilitler (id sırasıyla): bakiye/maliyet hesapları sıraya girer. */
export async function lockTreasuryAccounts(tx: Tx, ids: readonly string[]): Promise<Map<string, TreasuryAccountRow>> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx
    .select()
    .from(treasuryAccounts)
    .where(inArray(treasuryAccounts.id, unique))
    .orderBy(treasuryAccounts.id)
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) if (!byId.has(id)) throw notFound('Kasa/banka hesabı');
  return byId;
}

export interface Balance {
  /** Hesabın kendi para biriminde bakiye (borç − alacak). */
  doc: MoneyValue;
  /** Defter para biriminde bakiye (tarihsel maliyet). */
  base: MoneyValue;
}

/** Bağlı muhasebe hesabının kaydedilmiş bakiyesi (`asOf` verilirse o tarihe kadar). */
export async function glBalance(tx: Tx, glAccountId: string, asOf?: string): Promise<Balance> {
  const r = await tx.execute<{ doc: string; base: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0) as doc, coalesce(sum(l.debit_base - l.credit_base), 0) as base
    from journal_lines l join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.account_id = ${glAccountId} ${asOf ? sql`and e.entry_date <= ${asOf}::date` : sql``}`);
  return { doc: dec(r.rows[0]?.doc ?? 0), base: dec(r.rows[0]?.base ?? 0) };
}

/** Kasa (nakit) hesabı eksiye düşemez; banka hesabı düşebilir (kredili mevduat). */
export async function assertCashOk(tx: Tx, ta: TreasuryAccountRow, date: string, outflow: MoneyValue) {
  if (ta.kind !== 'cash') return;
  const bal = await glBalance(tx, ta.accountId, date);
  if (bal.doc.minus(outflow).isNegative()) {
    throw unprocessable(
      `${ta.name} kasasında yeterli bakiye yok: ${date} itibarıyla ${bal.doc.toFixed(2)} ${ta.currencyCode}, çıkış ${outflow.toFixed(2)} ${ta.currencyCode}`,
      'CASH_INSUFFICIENT',
      { accountId: ta.id, balance: toDbAmount(bal.doc), requested: toDbAmount(outflow) },
    );
  }
}

/** Kasa/banka hesapları ve bakiyeleri (güncel kurla karşılık: kur yoksa null). */
export async function listTreasuryAccounts(tx: Tx, ctx: LedgerCtx, today: string) {
  const rows = await tx
    .select()
    .from(treasuryAccounts)
    .orderBy(treasuryAccounts.kind, treasuryAccounts.name);
  const bal = await tx.execute<{ id: string; doc: string; base: string; last_date: string | null }>(sql`
    select ta.id, coalesce(sum(l.debit - l.credit), 0) as doc, coalesce(sum(l.debit_base - l.credit_base), 0) as base,
           max(e.entry_date)::text as last_date
    from treasury_accounts ta
    left join journal_lines l on l.account_id = ta.account_id
    left join journal_entries e on e.id = l.entry_id and e.status = 'posted'
    where l.id is null or e.id is not null
    group by ta.id`);
  const byId = new Map(bal.rows.map((r) => [r.id, r]));
  const accountRows = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts);
  const codeById = new Map(accountRows.map((a) => [a.id, a.code]));

  const rateCache = new Map<string, MoneyValue | null>();
  const out = [];
  for (const r of rows) {
    const b = byId.get(r.id);
    const doc = dec(b?.doc ?? 0);
    const book = dec(b?.base ?? 0);
    let equivalent: MoneyValue | null = doc;
    if (r.currencyCode !== ctx.baseCurrency) {
      if (!rateCache.has(r.currencyCode)) {
        rateCache.set(r.currencyCode, await findRate(tx, r.currencyCode, ctx.baseCurrency, today, ctx.baseCurrency));
      }
      const rate = rateCache.get(r.currencyCode) ?? null;
      equivalent = rate ? roundMoney(doc.times(rate)) : null;
    }
    out.push({
      id: r.id,
      kind: r.kind as TreasuryAccountKind,
      name: r.name,
      currencyCode: r.currencyCode,
      accountId: r.accountId,
      accountCode: codeById.get(r.accountId) ?? '',
      bankName: r.bankName,
      branch: r.branch,
      iban: r.iban,
      accountNo: r.accountNo,
      isActive: r.isActive,
      balance: toDbAmount(doc),
      /** Defter para biriminde tarihsel maliyet (yevmiyedeki tutar). */
      balanceBase: toDbAmount(book),
      /** Güncel kurla defter para birimi karşılığı; kur yoksa null. */
      equivalent: equivalent ? toDbAmount(equivalent) : null,
      lastActivity: b?.last_date ?? null,
    });
  }
  return out;
}

/** Genel bakış: hesap sayısı ve toplam karşılık (kur eksikse tarihsel maliyetle, `approximate`). */
export async function treasurySummary(tx: Tx, ctx: LedgerCtx, today: string) {
  const list = (await listTreasuryAccounts(tx, ctx, today)).filter((a) => a.isActive);
  let total = dec(0);
  let approximate = false;
  const byCurrency = new Map<string, MoneyValue>();
  for (const a of list) {
    if (a.equivalent !== null) total = total.plus(a.equivalent);
    else {
      total = total.plus(a.balanceBase);
      approximate = true;
    }
    byCurrency.set(a.currencyCode, (byCurrency.get(a.currencyCode) ?? dec(0)).plus(a.balance));
  }
  return {
    accountCount: list.length,
    equivalent: toDbAmount(total),
    approximate,
    byCurrency: [...byCurrency].map(([currency, balance]) => ({ currency, balance: toDbAmount(balance) })),
  };
}
