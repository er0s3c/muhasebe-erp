import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  TREASURY_TXN_PREFIX,
  applyRate,
  dec,
  isSettlementType,
  isoYear,
  partyKindFits,
  proportionalBase,
  todayIso,
  toDbAmount,
  toDbRate,
  type AccountMappingKey,
  type CancelTreasuryTransactionInput,
  type CreateTreasuryTransactionInput,
  type MoneyValue,
  type PartyControlType,
  type PartyKind,
  type TreasuryTxnType,
} from '@erp/shared';
import type { Tx } from '../../db/client';
import { accounts, parties, partyAllocations, treasuryAccounts, treasuryTransactions } from '../../db/schema';
import { notFound, unprocessable } from '../../http/errors';
import { uuidList } from '../inventory/balances';
import { createJournalEntry, reverseJournalEntry, type AutoJournalLine, type LedgerCtx } from '../ledger/journal';
import { requireMappings } from '../ledger/mappings';
import { openItemsFor } from '../parties/service';
import { formatDocumentNumber, nextNumber } from '../settings/numbering';
import { requireOpenPeriod } from '../settings/periods';
import { requireRate } from '../settings/rates';
import { assertCashOk, glBalance, lockTreasuryAccounts, type TreasuryAccountRow } from './accounts';
import {
  buildExchangeJournal,
  buildOtherJournal,
  buildSettlementJournal,
  planSettlement,
  type SettleItemInput,
} from './journal';
import { getTreasuryTransaction } from './transactions';

export const TXN_LABEL: Record<TreasuryTxnType, string> = {
  receipt: 'Tahsilat',
  payment: 'Ödeme',
  transfer: 'Virman',
  exchange: 'Döviz alım-satım',
  other_receipt: 'Diğer tahsilat',
  other_payment: 'Diğer ödeme',
};

/** Kasa/banka para biriminin defter para birimine kuru: elle verilen ya da hareket tarihindeki kayıtlı kur. */
async function rateOf(tx: Tx, ctx: LedgerCtx, currency: string, date: string, explicit?: string): Promise<MoneyValue> {
  if (currency === ctx.baseCurrency) return dec(1);
  if (explicit) {
    const r = dec(explicit);
    if (r.lte(0)) throw unprocessable('Kur sıfırdan büyük olmalı', 'FX_RATE_INVALID');
    return r;
  }
  return requireRate(tx, currency, ctx.baseCurrency, date, ctx.baseCurrency);
}

/**
 * Yabancı para biriminden çıkan tutarın defter değeri: hesabın ortalama maliyeti (tüm bakiye çıkıyorsa
 * kalan defter tutarının tamamı: kuruş artığı kalmaz). Bakiye yetersizse (banka eksiye düşüyorsa) piyasa kuru.
 */
export async function releaseCost(tx: Tx, ctx: LedgerCtx, ta: TreasuryAccountRow, x: MoneyValue, date: string): Promise<MoneyValue> {
  if (ta.currencyCode === ctx.baseCurrency) return x;
  const bal = await glBalance(tx, ta.accountId, date);
  if (bal.doc.gt(0) && bal.doc.gte(x) && bal.base.gt(0)) {
    return proportionalBase(x, bal.doc, bal.base);
  }
  return applyRate(x, await rateOf(tx, ctx, ta.currencyCode, date));
}

function mapKeys(gain: MoneyValue, loss: MoneyValue): AccountMappingKey[] {
  return [...(gain.gt(0) ? (['fx_gain'] as const) : []), ...(loss.gt(0) ? (['fx_loss'] as const) : [])];
}

async function requireActive(ta: TreasuryAccountRow) {
  if (!ta.isActive) throw unprocessable(`${ta.name} hesabı pasif`, 'TREASURY_ACCOUNT_INACTIVE');
}

/**
 * Kasa/banka hareketini kaydeder: tek işlemde numara, yevmiye (kaynak `treasury`), hareket ve cari eşleştirmeleri.
 * Kilit sırası: kasa/banka hesapları → cari → cari kalem satırları → numara → yevmiye numarası.
 */
export async function postTreasuryTransaction(tx: Tx, ctx: LedgerCtx, input: CreateTreasuryTransactionInput) {
  const type = input.type;
  const date = input.date;
  const amount = dec(input.amount);
  await requireOpenPeriod(tx, date);

  const locked = await lockTreasuryAccounts(tx, [input.accountId, ...(input.toAccountId ? [input.toAccountId] : [])]);
  const from = locked.get(input.accountId)!;
  await requireActive(from);

  const txnId = uuidv7();
  let partyId: string | null = null;
  let glAccountId: string | null = null;
  let toAccountId: string | null = null;
  let counterAmount: MoneyValue | null = null;
  let effectiveRate: MoneyValue;
  let plan: ReturnType<typeof planSettlement> | null = null;
  let settleItems: SettleItemInput[] = [];
  let built: { lines: AutoJournalLine[]; itemLineIndex: number[] };

  // Boşluksuz numara, gerekli tüm doğrulamalardan sonra alınır (numara sayacı kilitlerin sonuncusudur).
  const numberOf = async () => {
    const year = isoYear(date);
    const seq = await nextNumber(tx, ctx.companyId, `TRS:${type}`, year);
    return formatDocumentNumber(TREASURY_TXN_PREFIX[type], year, seq);
  };

  let txnNo: string;
  let text: string;

  if (isSettlementType(type)) {
    const control: PartyControlType = type === 'receipt' ? 'receivable' : 'payable';
    const [party] = await tx.select().from(parties).where(eq(parties.id, input.partyId!)).for('update');
    if (!party) throw unprocessable('Cari bulunamadı', 'PARTY_NOT_FOUND');
    if (!party.isActive) throw unprocessable(`${party.name} carisi pasif`, 'PARTY_INACTIVE');
    if (!partyKindFits(party.kind as PartyKind, control)) {
      throw unprocessable(
        `${party.name} carisi bu hareket türüyle uyumlu değil (${control === 'receivable' ? 'müşteri' : 'tedarikçi'} olmalı)`,
        'PARTY_KIND_MISMATCH',
      );
    }
    partyId = party.id;

    const open = new Map<string, Awaited<ReturnType<typeof openItemsFor>>['items'][number]>();
    if (input.items.length > 0) {
      await tx.execute(sql`select id from journal_lines where id in (${uuidList(input.items.map((i) => i.lineId))}) order by id for update`);
      for (const it of (await openItemsFor(tx, party.id, control, date)).items) open.set(it.lineId, it);
    }
    settleItems = input.items.map((it, n) => {
      const o = open.get(it.lineId);
      if (!o) throw unprocessable(`Kalem ${n + 1}: açık kalem bulunamadı ya da tümüyle kapanmış`, 'ITEM_NOT_OPEN', { lineId: it.lineId });
      return {
        lineId: it.lineId,
        currency: o.currencyCode,
        remainingDoc: dec(o.remaining),
        remainingBase: dec(o.remainingBase),
        amount: dec(it.amount),
        settleAmount: dec(it.settleAmount),
        description: undefined,
      };
    });

    const rate = await rateOf(tx, ctx, from.currencyCode, date, input.fxRate);
    effectiveRate = rate;
    plan = planSettlement({ kind: type === 'receipt' ? 'receipt' : 'payment', amount, rate, items: settleItems });
    const map = await requireMappings(tx, [control, ...mapKeys(plan.fxGain, plan.fxLoss)] as AccountMappingKey[]);
    if (type === 'payment') await assertCashOk(tx, from, date, amount);

    txnNo = await numberOf();
    text = `${TXN_LABEL[type]} ${txnNo} — ${party.name}`.slice(0, 300);
    const j = buildSettlementJournal({
      baseCurrency: ctx.baseCurrency,
      plan,
      items: settleItems.map((it) => ({ ...it, description: text })),
      treasury: { accountId: from.accountId, currency: from.currencyCode, amount, rate },
      partyId: party.id,
      controlAccountId: (map as Record<string, string>)[control]!,
      fxGainAccountId: (map as Record<string, string>).fx_gain,
      fxLossAccountId: (map as Record<string, string>).fx_loss,
      text,
    });
    built = j;
  } else if (type === 'transfer' || type === 'exchange') {
    const to = locked.get(input.toAccountId!)!;
    await requireActive(to);
    toAccountId = to.id;
    if (type === 'transfer' && from.currencyCode !== to.currencyCode) {
      throw unprocessable('Virman aynı para birimindeki hesaplar arasında yapılır; farklı para birimleri için döviz alım-satım girin', 'TRANSFER_CURRENCY_MISMATCH');
    }
    if (type === 'exchange' && from.currencyCode === to.currencyCode) {
      throw unprocessable('Döviz alım-satımda iki hesabın para birimi farklı olmalı; aynı para biriminde virman girin', 'EXCHANGE_SAME_CURRENCY');
    }
    counterAmount = type === 'transfer' ? amount : dec(input.counterAmount!);
    await assertCashOk(tx, from, date, amount);

    const fromBase = from.currencyCode === ctx.baseCurrency ? amount : await releaseCost(tx, ctx, from, amount, date);
    let toBase: MoneyValue;
    if (type === 'transfer' || to.currencyCode === ctx.baseCurrency) {
      // Virmanda maliyet taşınır; yabancıdan TL'ye satışta alınan TL defter değeridir
      toBase = type === 'transfer' ? fromBase : counterAmount;
    } else if (from.currencyCode === ctx.baseCurrency) {
      toBase = fromBase; // TL ile döviz alımı: ödenen TL, alınan dövizin maliyetidir
    } else {
      toBase = applyRate(counterAmount, await rateOf(tx, ctx, to.currencyCode, date, input.fxRate));
    }
    const diff = toBase.minus(fromBase);
    const map = await requireMappings(tx, mapKeys(diff.gt(0) ? diff : dec(0), diff.isNegative() ? diff.abs() : dec(0)));
    const foreignSide = from.currencyCode !== ctx.baseCurrency ? { base: fromBase, amount } : { base: toBase, amount: counterAmount };
    effectiveRate = foreignSide.base.div(foreignSide.amount);

    txnNo = await numberOf();
    text = `${TXN_LABEL[type]} ${txnNo} — ${from.name} → ${to.name}`.slice(0, 300);
    built = {
      lines: buildExchangeJournal({
        baseCurrency: ctx.baseCurrency,
        from: { accountId: from.accountId, currency: from.currencyCode, amount, baseValue: fromBase },
        to: { accountId: to.accountId, currency: to.currencyCode, amount: counterAmount, baseValue: toBase },
        fxGainAccountId: (map as Record<string, string>).fx_gain,
        fxLossAccountId: (map as Record<string, string>).fx_loss,
        text,
      }),
      itemLineIndex: [],
    };
  } else {
    const [gl] = await tx.select().from(accounts).where(eq(accounts.id, input.glAccountId!));
    if (!gl) throw unprocessable('Karşı hesap bulunamadı', 'ACCOUNT_NOT_FOUND');
    if (!gl.isPostable || !gl.isActive || gl.partyControl || gl.currencyCode) {
      throw unprocessable(`${gl.code} hesabı karşı hesap olarak kullanılamaz (kayıt atılabilir, aktif, dövizsiz ve cari kontrol dışı olmalı)`, 'ACCOUNT_NOT_ALLOWED');
    }
    const [linked] = await tx.select({ id: treasuryAccounts.id }).from(treasuryAccounts).where(eq(treasuryAccounts.accountId, gl.id));
    if (linked) {
      throw unprocessable(`${gl.code} bir kasa/banka hesabıdır; hesaplar arası aktarım için virman girin`, 'ACCOUNT_NOT_ALLOWED');
    }
    glAccountId = gl.id;
    const rate = await rateOf(tx, ctx, from.currencyCode, date, input.fxRate);
    effectiveRate = rate;
    const baseValue = applyRate(amount, rate);
    if (type === 'other_payment') await assertCashOk(tx, from, date, amount);

    txnNo = await numberOf();
    text = `${TXN_LABEL[type]} ${txnNo} — ${gl.code} ${gl.name}`.slice(0, 300);
    built = {
      lines: buildOtherJournal({
        baseCurrency: ctx.baseCurrency,
        kind: type === 'other_receipt' ? 'receipt' : 'payment',
        treasury: { accountId: from.accountId, currency: from.currencyCode, amount, baseValue, rate },
        counterAccountId: gl.id,
        text,
        projectId: input.projectId,
        wbsId: input.wbsId,
      }),
      itemLineIndex: [],
    };
  }

  const entry = await createJournalEntry(
    tx,
    ctx,
    {
      entryDate: date,
      description: input.description ? `${text} — ${input.description}`.slice(0, 300) : text,
      lines: built.lines,
      post: true,
    },
    { source: { type: 'treasury', id: txnId } },
  );

  await tx.insert(treasuryTransactions).values({
    id: txnId,
    companyId: ctx.companyId,
    type,
    txnNo,
    txnDate: date,
    accountId: from.id,
    toAccountId,
    partyId,
    glAccountId,
    currencyCode: from.currencyCode,
    amount: toDbAmount(amount),
    counterAmount: counterAmount ? toDbAmount(counterAmount) : null,
    fxRate: !effectiveRate.eq(1) ? toDbRate(effectiveRate) : null,
    description: input.description ?? null,
    journalEntryId: entry.id,
    postedBy: ctx.userId,
    createdBy: ctx.userId,
  });

  if (plan && settleItems.length > 0) {
    const lineRows = await tx.execute<{ id: string; line_no: number }>(sql`select id, line_no from journal_lines where entry_id = ${entry.id}`);
    const idByNo = new Map(lineRows.rows.map((r) => [Number(r.line_no), r.id]));
    const control = type === 'receipt' ? 'receivable' : 'payable';
    const prepared = plan;
    await tx.insert(partyAllocations).values(
      settleItems.map((it, n) => ({
        companyId: ctx.companyId,
        partyId: partyId!,
        control,
        transactionId: txnId,
        chargeLineId: it.lineId,
        settleLineId: idByNo.get(built.itemLineIndex[n]! + 1)!,
        amount: toDbAmount(it.amount),
        amountBase: toDbAmount(prepared.parts[n]!.carry),
        settleAmount: toDbAmount(it.settleAmount),
      })),
    );
  }

  return getTreasuryTransaction(tx, txnId);
}

/**
 * Hareketi iptal eder: yevmiyesi ters çevrilir, cari eşleştirmeleri hesaba katılmaz olur (işlem `cancelled`),
 * numara serinin parçası kalır. Kasa hesabı ters kayıtla eksiye düşecekse iptal edilemez.
 */
export async function cancelTreasuryTransaction(tx: Tx, ctx: LedgerCtx, id: string, input: CancelTreasuryTransactionInput) {
  const [txn] = await tx.select().from(treasuryTransactions).where(eq(treasuryTransactions.id, id)).for('update');
  if (!txn) throw notFound('Kasa/banka hareketi');
  if (txn.status === 'cancelled') throw unprocessable('Hareket zaten iptal edilmiş', 'TREASURY_ALREADY_CANCELLED');
  // Banka ekstresiyle eşleşmiş hareket iptal edilemez: önce eşleşme kaldırılır (mutabakat sessizce bozulmasın)
  const reconciled = await tx.execute(sql`
    select 1 from bank_statement_lines b join journal_lines l on l.id = b.journal_line_id
    where b.status = 'matched' and l.entry_id = ${txn.journalEntryId} limit 1`);
  if (reconciled.rows.length > 0) {
    throw unprocessable('Bu hareketin banka satırı ekstreyle eşleşmiş; iptal etmeden önce Banka ekstresi sekmesinden eşleşmeyi kaldırın', 'TXN_RECONCILED');
  }

  const date = input.date ?? todayIso();
  if (date < txn.txnDate) throw unprocessable('İptal tarihi hareket tarihinden önce olamaz', 'CANCEL_DATE_BEFORE_TXN');
  await requireOpenPeriod(tx, date);

  const locked = await lockTreasuryAccounts(tx, [txn.accountId, ...(txn.toAccountId ? [txn.toAccountId] : [])]);
  const type = txn.type as TreasuryTxnType;
  const amount = dec(txn.amount);
  // Ters kayıtta kasadan çıkan taraf: tahsilat/diğer tahsilat kaynak hesaptan, virman/döviz hedef hesaptan
  if (type === 'receipt' || type === 'other_receipt') await assertCashOk(tx, locked.get(txn.accountId)!, date, amount);
  if (type === 'transfer' || type === 'exchange') {
    await assertCashOk(tx, locked.get(txn.toAccountId!)!, date, dec(txn.counterAmount ?? txn.amount));
  }

  const reversal = await reverseJournalEntry(tx, ctx, txn.journalEntryId, {
    entryDate: date,
    description: `Hareket iptali: ${txn.txnNo} — ${input.reason}`.slice(0, 300),
    source: { type: 'treasury', id: txn.id },
  });
  await tx
    .update(treasuryTransactions)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: ctx.userId,
      cancelReason: input.reason,
      cancelJournalEntryId: reversal.id,
    })
    .where(eq(treasuryTransactions.id, id));
  return getTreasuryTransaction(tx, id);
}
