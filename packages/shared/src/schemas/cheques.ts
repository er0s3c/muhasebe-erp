import { z } from 'zod';
import { BANK_GUARANTEE_STATUSES, CHEQUE_ACTIONS, CHEQUE_DIRECTIONS, CHEQUE_DOC_TYPES, CHEQUE_STATUSES, GUARANTEE_DIRECTIONS } from '../cheque-calc';
import { dec } from '../money';
import { isoDate, moneyString, uuid } from './common';
import { treasuryItemSchema } from './treasury';

const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).nullable().optional();
const positive = moneyString.refine((v) => dec(v).gt(0), 'Tutar sıfırdan büyük olmalı');

// --- Çek / senet -------------------------------------------------------------------------------------------------

export const createChequeSchema = z
  .object({
    direction: z.enum(CHEQUE_DIRECTIONS),
    docType: z.enum(CHEQUE_DOC_TYPES),
    docNo: text(60).min(1, 'Çek/senet numarası gerekli'),
    /** Çekte keşide edilen banka, senette ödeme yeri/banka (serbest metin). */
    bankName: text(80).default(''),
    branch: optText(80),
    /** Alınanda keşideci (müşteri), verilende lehtar (tedarikçi) cari. */
    partyId: uuid,
    amount: positive,
    issueDate: isoDate,
    dueDate: isoDate,
    /** Defter kaydı (alınış/veriliş) tarihi; boşsa bugün. */
    registerDate: isoDate.optional(),
    description: optText(300),
    /** Kayıtla birlikte kapatılan açık kalemler (alınanda alacak, verilende borç); kalan tutar avans olur. */
    items: z.array(treasuryItemSchema).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.dueDate < v.issueDate) issue('dueDate', 'Vade tarihi düzenleme tarihinden önce olamaz');
    const ids = v.items.map((i) => i.lineId);
    if (new Set(ids).size !== ids.length) issue('items', 'Aynı kalem iki kez seçilemez');
    const used = v.items.reduce((s, i) => s.plus(i.settleAmount), dec(0));
    if (used.gt(v.amount)) issue('items', 'Kalemlere ayrılan tutar belge tutarını aşıyor');
  });
export type CreateChequeInput = z.infer<typeof createChequeSchema>;

export const updateChequeSchema = z
  .object({ branch: optText(80), description: optText(300) })
  .refine((v) => v.branch !== undefined || v.description !== undefined, { message: 'Değişiklik yok' });

/**
 * Durum eylemi (tek belge ya da takas = çok belge). Takas: aynı bankaya toplu tahsile verme/tahsil; tek yevmiye,
 * banka satırı toplu. Ciro: tek tedarikçi cari; kalemler ve avans toplam tutar üzerinden hesaplanır.
 */
export const chequeActionSchema = z
  .object({
    action: z.enum(CHEQUE_ACTIONS),
    chequeIds: z.array(uuid).min(1, 'En az bir belge seçin').max(200),
    date: isoDate,
    /** deposit/pay: banka hesabı (aynı para biriminde, banka türü). */
    bankAccountId: uuid.optional(),
    /** endorse: ciro edilen tedarikçi cari. */
    partyId: uuid.optional(),
    items: z.array(treasuryItemSchema).max(100).default([]),
    note: optText(300),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (new Set(v.chequeIds).size !== v.chequeIds.length) issue('chequeIds', 'Aynı belge iki kez seçilemez');
    const needsBank = v.action === 'deposit' || v.action === 'pay';
    if (needsBank && !v.bankAccountId) issue('bankAccountId', 'Banka hesabı seçilmeli');
    if (!needsBank && v.bankAccountId) issue('bankAccountId', 'Banka hesabı yalnızca tahsile verme ve ödemede kullanılır');
    if (v.action === 'endorse') {
      if (!v.partyId) issue('partyId', 'Ciro edilecek cari seçilmeli');
      const ids = v.items.map((i) => i.lineId);
      if (new Set(ids).size !== ids.length) issue('items', 'Aynı kalem iki kez seçilemez');
    } else {
      if (v.partyId) issue('partyId', 'Cari yalnızca ciroda kullanılır');
      if (v.items.length > 0) issue('items', 'Kalem eşleştirme yalnızca ciroda kullanılır');
    }
  });
export type ChequeActionInput = z.infer<typeof chequeActionSchema>;

export const chequeListQuerySchema = z.object({
  direction: z.enum(CHEQUE_DIRECTIONS).optional(),
  docType: z.enum(CHEQUE_DOC_TYPES).optional(),
  /** Gerçek durum ya da 'open' (portföyde/tahsilde olan alınan + ödenmemiş verilen). */
  status: z.union([z.enum(CHEQUE_STATUSES), z.literal('open')]).optional(),
  partyId: uuid.optional(),
  bankAccountId: uuid.optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  q: text(80).optional(),
});
export type ChequeListQuery = z.infer<typeof chequeListQuerySchema>;

export const chequeMaturityQuerySchema = z.object({ asOf: isoDate.optional(), direction: z.enum(CHEQUE_DIRECTIONS).optional() });
export type ChequeMaturityQuery = z.infer<typeof chequeMaturityQuerySchema>;

export const chequeDueQuerySchema = z.object({
  /** Bugünden itibaren kaç gün içinde vadesi gelenler (vadesi geçmişler de dahil). */
  days: z.coerce.number().int().min(0).max(365).default(7),
  direction: z.enum(CHEQUE_DIRECTIONS).optional(),
});
export type ChequeDueQuery = z.infer<typeof chequeDueQuerySchema>;

export const chequeBouncedQuerySchema = z.object({ direction: z.enum(CHEQUE_DIRECTIONS).optional() });

// --- Banka teminat mektubu ---------------------------------------------------------------------------------------

const rate = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Geçersiz oran').refine((v) => dec(v).lte(100), "Oran 100'ü aşamaz");

export const createBankGuaranteeSchema = z
  .object({
    /** given: bankanın bizim adımıza lehtara (işveren vb.) verdiği; received: taşeron/tedarikçiden aldığımız mektup. */
    direction: z.enum(GUARANTEE_DIRECTIONS),
    letterNo: text(60).min(1, 'Mektup numarası gerekli'),
    bankName: text(80).min(1, 'Banka gerekli'),
    branch: optText(80),
    /** Cari (lehtar ya da mektubu veren) seçilirse adı kaydedilir; yoksa karşı taraf adı elle girilir. */
    partyId: uuid.nullable().optional(),
    counterpartyName: optText(160),
    projectId: uuid.nullable().optional(),
    subcontractId: uuid.nullable().optional(),
    purpose: optText(160),
    amount: positive,
    currencyCode: z.string().regex(/^[A-Z]{3}$/, 'Geçersiz para birimi'),
    issueDate: isoDate,
    /** Süresiz mektup için boş bırakılır. */
    expiryDate: isoDate.nullable().optional(),
    /** Komisyon ve masraf: KULLANICI GİRİŞİDİR (kodda oran yoktur); yalnızca bilgi. */
    commissionRate: rate.nullable().optional(),
    commissionAmount: moneyString.nullable().optional(),
    commissionNote: optText(300),
    note: optText(500),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.expiryDate && v.expiryDate < v.issueDate) issue('expiryDate', 'Son kullanma tarihi düzenleme tarihinden önce olamaz');
    if (!v.partyId && !v.counterpartyName?.trim()) issue('counterpartyName', 'Cari seçin ya da karşı taraf adını girin');
  });
export type CreateBankGuaranteeInput = z.infer<typeof createBankGuaranteeSchema>;

export const updateBankGuaranteeSchema = z
  .object({
    branch: optText(80),
    purpose: optText(160),
    expiryDate: isoDate.nullable().optional(),
    commissionRate: rate.nullable().optional(),
    commissionAmount: moneyString.nullable().optional(),
    commissionNote: optText(300),
    note: optText(500),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Değişiklik yok' });

export const resolveBankGuaranteeSchema = z.object({
  status: z.enum(['returned', 'liquidated', 'expired']),
  resolvedDate: isoDate,
  note: optText(300),
});

export const bankGuaranteeListQuerySchema = z.object({
  direction: z.enum(GUARANTEE_DIRECTIONS).optional(),
  status: z.enum(BANK_GUARANTEE_STATUSES).optional(),
  projectId: uuid.optional(),
  partyId: uuid.optional(),
  /** Bugünden itibaren N gün içinde süresi dolacak (süresi geçmiş ama kapatılmamışlar dahil) aktif mektuplar. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
  q: text(80).optional(),
});
export type BankGuaranteeListQuery = z.infer<typeof bankGuaranteeListQuerySchema>;

/** Uyarı günü: kullanıcı ayarı (boş = uyarı üretilmez). */
export const updatePortfolioSettingsSchema = z.object({ guaranteeWarningDays: z.number().int().min(0).max(3650).nullable() });
export type UpdatePortfolioSettingsInput = z.infer<typeof updatePortfolioSettingsSchema>;
