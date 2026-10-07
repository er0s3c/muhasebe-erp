import { z } from 'zod';
import { decCheck, tryDec } from '../money';
import { currencyCode, isoDate, moneyString, rateString, uuid } from './common';

// --- Kasa/banka hesabı -------------------------------------------------------

export const TREASURY_ACCOUNT_KINDS = ['cash', 'bank'] as const;
export type TreasuryAccountKind = (typeof TREASURY_ACCOUNT_KINDS)[number];

/** Kasa 100, banka 102 hesap grubunda tutulur. */
export const TREASURY_PARENT_CODE: Record<TreasuryAccountKind, string> = { cash: '100', bank: '102' };

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

export const createTreasuryAccountSchema = z.object({
  kind: z.enum(TREASURY_ACCOUNT_KINDS),
  name: z.string().trim().min(2).max(80),
  currency: currencyCode,
  bankName: optionalText(80),
  branch: optionalText(80),
  iban: optionalText(34),
  accountNo: optionalText(40),
  /**
   * Doluysa yeni alt hesap açılmaz, mevcut (100.x / 102.x) muhasebe hesabına bağlanır.
   * Kasa/bankaya hareket görmüş şirketlerde alt hesap açılamadığı için gereklidir.
   */
  linkAccountId: uuid.optional(),
});
export type CreateTreasuryAccountInput = z.infer<typeof createTreasuryAccountSchema>;

export const updateTreasuryAccountSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  bankName: clearableText(80),
  branch: clearableText(80),
  iban: clearableText(34),
  accountNo: clearableText(40),
  isActive: z.boolean().optional(),
});
export type UpdateTreasuryAccountInput = z.infer<typeof updateTreasuryAccountSchema>;

// --- Hareket -----------------------------------------------------------------

/**
 * Tahsilat/ödeme (cari ile), virman (aynı para birimi), döviz alım-satım (farklı para birimi),
 * diğer tahsilat/ödeme (banka masrafı, faiz… karşı hesap seçilir).
 */
export const TREASURY_TXN_TYPES = ['receipt', 'payment', 'transfer', 'exchange', 'other_receipt', 'other_payment'] as const;
export type TreasuryTxnType = (typeof TREASURY_TXN_TYPES)[number];

export const TREASURY_TXN_STATUSES = ['posted', 'cancelled'] as const;
export type TreasuryTxnStatus = (typeof TREASURY_TXN_STATUSES)[number];

/** Boşluksuz numara önekleri (TAH-2026-000001). */
export const TREASURY_TXN_PREFIX: Record<TreasuryTxnType, string> = {
  receipt: 'TAH',
  payment: 'ODE',
  transfer: 'VRM',
  exchange: 'DVZ',
  other_receipt: 'DTH',
  other_payment: 'DOD',
};

/** Cari ile çalışan türler. */
export const isSettlementType = (t: TreasuryTxnType) => t === 'receipt' || t === 'payment';

export const positiveMoney = moneyString.refine(decCheck((d) => d.gt(0)), 'Tutar sıfırdan büyük olmalı');

/** Tahsilat/ödemenin kapattığı açık kalem (cari kontrol hesabı satırı). */
export const treasuryItemSchema = z.object({
  /** Cari kontrol hesabındaki yevmiye satırı (açık kalem). */
  lineId: uuid,
  /** Kalemin kendi para biriminde kapatılan tutar. */
  amount: positiveMoney,
  /** Kalemi kapatmak için kasa/banka para biriminde karşılığı. */
  settleAmount: positiveMoney,
});
export type TreasuryItemInput = z.infer<typeof treasuryItemSchema>;

export const createTreasuryTransactionSchema = z
  .object({
    type: z.enum(TREASURY_TXN_TYPES),
    date: isoDate,
    /** Kasa/banka hesabı: tahsilatta giren, ödemede/virmanda/dövizde çıkan. */
    accountId: uuid,
    /** Kasa/banka hesabının para biriminde tutar. */
    amount: positiveMoney,
    description: optionalText(300),
    /** Tahsilat/ödeme: cari. */
    partyId: uuid.optional(),
    /** Tahsilat/ödeme: kapatılan açık kalemler; kalan tutar avans olur. */
    items: z.array(treasuryItemSchema).max(100).default([]),
    /** Virman/döviz: hedef hesap. */
    toAccountId: uuid.optional(),
    /** Döviz: hedef hesabın para biriminde tutar. */
    counterAmount: positiveMoney.optional(),
    /** Diğer tahsilat/ödeme: karşı muhasebe hesabı. */
    glAccountId: uuid.optional(),
    /** Diğer tahsilat/ödeme: karşı hesap satırının proje boyutu (yalnızca gelir/gider/maliyet hesabıysa). */
    projectId: uuid.optional(),
    /** Projenin yaprak iş kalemi; projesiz verilemez. */
    wbsId: uuid.optional(),
    /**
     * Kasa/banka para biriminin defter para birimine işlem kuru. Boşsa hareket tarihindeki kayıtlı kur.
     * Döviz alım-satımda yalnızca iki hesap da yabancıysa (hedef para birimi kuru) kullanılır.
     */
    fxRate: rateString.optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const settle = isSettlementType(t.type);
    if (settle) {
      if (!t.partyId) issue('partyId', 'Cari seçilmeli');
      const lineIds = t.items.map((i) => i.lineId);
      if (new Set(lineIds).size !== lineIds.length) issue('items', 'Aynı kalem iki kez seçilemez');
      const amounts = [t.amount, ...t.items.map((i) => i.settleAmount)].map(tryDec);
      const used = amounts.slice(1).reduce((s, d) => (s && d ? s.plus(d) : null), tryDec(0));
      if (used && amounts[0] && used.gt(amounts[0])) issue('items', 'Kalemlere ayrılan tutar hareket tutarını aşıyor');
    } else {
      if (t.partyId && t.type !== 'other_receipt') issue('partyId', 'Cari yalnızca tahsilat, ödeme veya müşteri kaporasında kullanılır');
      if (t.items.length > 0) issue('items', 'Kalem eşleştirme yalnızca tahsilat ve ödemede kullanılır');
    }
    if (t.type === 'transfer' || t.type === 'exchange') {
      if (!t.toAccountId) issue('toAccountId', 'Hedef hesap seçilmeli');
      else if (t.toAccountId === t.accountId) issue('toAccountId', 'Kaynak ve hedef hesap aynı olamaz');
    } else if (t.toAccountId) {
      issue('toAccountId', 'Hedef hesap yalnızca virman ve dövizde kullanılır');
    }
    if (t.type === 'exchange') {
      if (!t.counterAmount) issue('counterAmount', 'Hedef tutar girilmeli');
    } else if (t.counterAmount) {
      issue('counterAmount', 'Hedef tutar yalnızca dövizde kullanılır');
    }
    if (t.type === 'other_receipt' || t.type === 'other_payment') {
      if (!t.glAccountId) issue('glAccountId', 'Karşı hesap seçilmeli');
    } else if (t.glAccountId) {
      issue('glAccountId', 'Karşı hesap yalnızca diğer tahsilat/ödemede kullanılır');
    }
    if (t.projectId && t.type !== 'other_receipt' && t.type !== 'other_payment') {
      issue('projectId', 'Proje yalnızca diğer tahsilat/ödemede kullanılır (cari ödemesinde maliyet faturada doğar)');
    }
    if (t.wbsId && !t.projectId) issue('wbsId', 'İş kalemi için proje seçilmeli');
  });
export type CreateTreasuryTransactionInput = z.infer<typeof createTreasuryTransactionSchema>;

export const cancelTreasuryTransactionSchema = z.object({
  /** İptal (ters kayıt) tarihi; boşsa bugün. */
  date: isoDate.optional(),
  reason: z.string().trim().min(3, 'İptal nedeni gerekli').max(300),
});
export type CancelTreasuryTransactionInput = z.infer<typeof cancelTreasuryTransactionSchema>;

export const listTreasuryTransactionsQuerySchema = z.object({
  type: z.enum(TREASURY_TXN_TYPES).optional(),
  status: z.enum(TREASURY_TXN_STATUSES).optional(),
  accountId: uuid.optional(),
  partyId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Hareket no, açıklama, cari adı/kodu. */
  query: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTreasuryTransactionsQuery = z.infer<typeof listTreasuryTransactionsQuerySchema>;

export const treasuryStatementQuerySchema = z.object({ from: isoDate, to: isoDate });
export type TreasuryStatementQuery = z.infer<typeof treasuryStatementQuerySchema>;
