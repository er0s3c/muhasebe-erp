import { applyRate, dec, proportionalBase, settlementFxDiff, toDbAmount, toDbRate, type CurrencyCode, type MoneyValue } from '@erp/shared';
import { unprocessable } from '../../http/errors';
import type { AutoJournalLine } from '../ledger/journal';

/** Tahsilat/ödemenin kapattığı açık kalem (kalan tutarları o günkü açık kalem hesabından gelir). */
export interface SettleItemInput {
  lineId: string;
  currency: string;
  /** Kalemin kalan tutarı (kalem para biriminde) ve defter para birimindeki karşılığı */
  remainingDoc: MoneyValue;
  remainingBase: MoneyValue;
  /** Kalem para biriminde kapatılan tutar */
  amount: MoneyValue;
  /** Kasa/banka para biriminde karşılığı */
  settleAmount: MoneyValue;
  description?: string;
}

export interface SettlementPlan {
  kind: 'receipt' | 'payment';
  /** Kalem başına: kalemin taşıdığı defter tutarı payı ve kasa/banka karşılığının defter tutarı */
  parts: { carry: MoneyValue; settleBase: MoneyValue; gain: MoneyValue }[];
  /** Kalemlere ayrılmayan kalan tutar (kasa/banka para biriminde) = avans */
  advance: MoneyValue;
  advanceBase: MoneyValue;
  treasuryBase: MoneyValue;
  /** Kur kârı ve zararı (defter para birimi, pozitif) */
  fxGain: MoneyValue;
  fxLoss: MoneyValue;
}

/**
 * Tahsilat/ödemeyi planlar (saf): her kalemin taşıdığı defter tutarı ile kasa/banka karşılığının defter
 * tutarını karşılaştırır. Kasa/banka satırının defter tutarı, karşı satırların toplamıdır; böylece fiş
 * kur yuvarlamasından bağımsız olarak her zaman dengelidir. Kalanın tamamı kapanıyorsa kalemin kalan
 * defter tutarının tamamı taşınır (kuruş artığı kalmaz).
 */
export function planSettlement(i: {
  kind: 'receipt' | 'payment';
  amount: MoneyValue;
  /** Kasa/banka para biriminin defter para birimine kuru (defter para biriminde 1) */
  rate: MoneyValue;
  items: SettleItemInput[];
}): SettlementPlan {
  let usedSettle = dec(0);
  let fxGain = dec(0);
  let fxLoss = dec(0);
  let settleBaseTotal = dec(0);
  const parts = i.items.map((it, n) => {
    if (it.amount.gt(it.remainingDoc)) {
      throw unprocessable(
        `Kalem ${n + 1}: kapatılan tutar (${it.amount.toFixed(2)}) kalanı (${it.remainingDoc.toFixed(2)}) aşıyor`,
        'ALLOCATION_EXCEEDED',
        { lineId: it.lineId, remaining: it.remainingDoc.toFixed(2) },
      );
    }
    const carry = proportionalBase(it.amount, it.remainingDoc, it.remainingBase);
    if (carry.lt('0.01')) {
      throw unprocessable(`Kalem ${n + 1}: kapatılan tutar çok küçük`, 'ALLOCATION_TOO_SMALL', { lineId: it.lineId });
    }
    const settleBase = applyRate(it.settleAmount, i.rate);
    const gain = settlementFxDiff(i.kind, carry, settleBase);
    if (gain.gt(0)) fxGain = fxGain.plus(gain);
    else fxLoss = fxLoss.plus(gain.abs());
    usedSettle = usedSettle.plus(it.settleAmount);
    settleBaseTotal = settleBaseTotal.plus(settleBase);
    return { carry, settleBase, gain };
  });
  const advance = i.amount.minus(usedSettle);
  if (advance.isNegative()) {
    throw unprocessable('Kalemlere ayrılan tutar hareket tutarını aşıyor', 'ALLOCATION_EXCEEDS_AMOUNT');
  }
  const advanceBase = applyRate(advance, i.rate);
  return { kind: i.kind, parts, advance, advanceBase, treasuryBase: settleBaseTotal.plus(advanceBase), fxGain, fxLoss };
}

type Side = 'debit' | 'credit';

interface LineOpts {
  baseCurrency: string;
}

/** Tek satır: yabancı para birimli satırlar `fxRate` ile (defter tutarı önceden hesaplanmış) yazılır. */
function makeLine(
  o: LineOpts,
  side: Side,
  accountId: string,
  currency: string,
  amount: MoneyValue,
  base: MoneyValue,
  extra: Partial<AutoJournalLine> = {},
): AutoJournalLine {
  const foreign = currency !== o.baseCurrency;
  return {
    accountId,
    currency: currency as CurrencyCode,
    ...(foreign ? { fxRate: toDbRate(base.gt(0) ? base.div(amount) : dec(1)) } : {}),
    debit: side === 'debit' ? toDbAmount(amount) : '0',
    credit: side === 'credit' ? toDbAmount(amount) : '0',
    debitBase: side === 'debit' ? toDbAmount(base) : '0',
    creditBase: side === 'credit' ? toDbAmount(base) : '0',
    ...extra,
  };
}

export interface SettlementJournal {
  lines: AutoJournalLine[];
  /** Her kalemin cari satırının `lines` içindeki sırası (satır no = sıra + 1) */
  itemLineIndex: number[];
}

/**
 * Tahsilat: B kasa/banka / A cari (kalem başına + avans) / A kambiyo kârı, B kambiyo zararı.
 * Ödeme: aynısının tersi (cari borçlanır, kasa/banka alacaklanır).
 */
export function buildSettlementJournal(i: {
  baseCurrency: string;
  plan: SettlementPlan;
  items: SettleItemInput[];
  treasury: { accountId: string; currency: string; amount: MoneyValue; rate: MoneyValue };
  partyId: string;
  controlAccountId: string;
  fxGainAccountId?: string;
  fxLossAccountId?: string;
  text: string;
}): SettlementJournal {
  const o = { baseCurrency: i.baseCurrency };
  const receipt = i.plan.kind === 'receipt';
  const treasurySide: Side = receipt ? 'debit' : 'credit';
  const partySide: Side = receipt ? 'credit' : 'debit';
  const lines: AutoJournalLine[] = [];

  const t = i.treasury;
  const treasuryLine = makeLine(o, treasurySide, t.accountId, t.currency, t.amount, i.plan.treasuryBase, { description: i.text });
  // Kasa/banka satırında kur, işlem kurudur (bilgi); defter tutarı karşı satırların toplamıdır
  if (t.currency !== i.baseCurrency) treasuryLine.fxRate = toDbRate(t.rate);
  lines.push(treasuryLine);

  const itemLineIndex: number[] = [];
  i.items.forEach((it, n) => {
    itemLineIndex.push(lines.length);
    lines.push(
      makeLine(o, partySide, i.controlAccountId, it.currency, it.amount, i.plan.parts[n]!.carry, {
        partyId: i.partyId,
        description: it.description ?? i.text,
      }),
    );
  });
  if (i.plan.advance.gt(0)) {
    const adv = makeLine(o, partySide, i.controlAccountId, t.currency, i.plan.advance, i.plan.advanceBase, { partyId: i.partyId, description: `${i.text} (avans)` });
    if (t.currency !== i.baseCurrency) adv.fxRate = toDbRate(t.rate);
    lines.push(adv);
  }
  if (i.plan.fxGain.gt(0)) {
    lines.push(makeLine(o, 'credit', i.fxGainAccountId!, i.baseCurrency, i.plan.fxGain, i.plan.fxGain, { description: `Kambiyo kârı: ${i.text}` }));
  }
  if (i.plan.fxLoss.gt(0)) {
    lines.push(makeLine(o, 'debit', i.fxLossAccountId!, i.baseCurrency, i.plan.fxLoss, i.plan.fxLoss, { description: `Kambiyo zararı: ${i.text}` }));
  }
  return { lines, itemLineIndex };
}

/**
 * Virman ve döviz alım-satım (tek kalıp): kaynak hesap `from.baseValue` defter değeriyle çıkar (kaynak
 * bakiyenin ortalama maliyeti), hedef `to.baseValue` ile girer. Fark kambiyo kârı/zararıdır; aynı para
 * biriminde virmanda fark yoktur.
 */
export function buildExchangeJournal(i: {
  baseCurrency: string;
  from: { accountId: string; currency: string; amount: MoneyValue; baseValue: MoneyValue };
  to: { accountId: string; currency: string; amount: MoneyValue; baseValue: MoneyValue };
  fxGainAccountId?: string;
  fxLossAccountId?: string;
  text: string;
}): AutoJournalLine[] {
  const o = { baseCurrency: i.baseCurrency };
  const diff = i.to.baseValue.minus(i.from.baseValue);
  const lines: AutoJournalLine[] = [
    makeLine(o, 'credit', i.from.accountId, i.from.currency, i.from.amount, i.from.baseValue, { description: i.text }),
    makeLine(o, 'debit', i.to.accountId, i.to.currency, i.to.amount, i.to.baseValue, { description: i.text }),
  ];
  if (diff.gt(0) && i.fxGainAccountId) {
    lines.push(makeLine(o, 'credit', i.fxGainAccountId, i.baseCurrency, diff, diff, { description: `Kambiyo kârı: ${i.text}` }));
  } else if (diff.isNegative() && i.fxLossAccountId) {
    lines.push(makeLine(o, 'debit', i.fxLossAccountId, i.baseCurrency, diff.abs(), diff.abs(), { description: `Kambiyo zararı: ${i.text}` }));
  }
  return lines;
}

/** Diğer tahsilat/ödeme: kasa/banka ↔ karşı hesap (defter para biriminde). */
export function buildOtherJournal(i: {
  baseCurrency: string;
  kind: 'receipt' | 'payment';
  treasury: { accountId: string; currency: string; amount: MoneyValue; baseValue: MoneyValue; rate: MoneyValue };
  counterAccountId: string;
  text: string;
}): AutoJournalLine[] {
  const o = { baseCurrency: i.baseCurrency };
  const tSide: Side = i.kind === 'receipt' ? 'debit' : 'credit';
  const cSide: Side = i.kind === 'receipt' ? 'credit' : 'debit';
  const treasury = makeLine(o, tSide, i.treasury.accountId, i.treasury.currency, i.treasury.amount, i.treasury.baseValue, { description: i.text });
  if (i.treasury.currency !== i.baseCurrency) treasury.fxRate = toDbRate(i.treasury.rate);
  return [treasury, makeLine(o, cSide, i.counterAccountId, i.baseCurrency, i.treasury.baseValue, i.treasury.baseValue, { description: i.text })];
}
