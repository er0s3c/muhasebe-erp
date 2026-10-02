import { z } from 'zod';
import { boolQuery, currencyCode, isoDate, moneyString, uuid } from './common';
import { MAP_LEVELS, parseRateList } from '../consolidation-calc';

/** "TRY:0.0245,EUR:1.08": para birimi:kur çiftleri (kur yöntemi kullanıcı verisidir, doğrulanmadı). */
export const rateListString = z
  .string()
  .max(300)
  .refine((v) => {
    try {
      parseRateList(v);
      return true;
    } catch {
      return false;
    }
  }, 'Geçersiz kur listesi (örn. EUR:41.5,USD:38)');

export const CONSOLIDATION_PL_METHODS = ['closing', 'average'] as const;

export const createGroupSchema = z.object({
  name: z.string().trim().min(2, 'Ad en az 2 karakter olmalı').max(100),
  reportingCurrency: currencyCode,
  companyIds: z.array(uuid).min(1, 'En az bir şirket seçin').max(20),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z
  .object({ name: z.string().trim().min(2).max(100).optional(), isArchived: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isArchived !== undefined, 'Değişiklik yok');
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const addGroupMemberSchema = z.object({ companyId: uuid });

export const consolidationReportQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  /** Bilanço (kapanış) kuru tarihi; yoksa dönem sonu. */
  closingDate: isoDate.optional(),
  /** Gelir tablosu kuru: kapanış kuru ya da dönem içi kayıtlı kurların aritmetik ortalaması (kullanıcı seçimi; doğrulanmadı). */
  plMethod: z.enum(CONSOLIDATION_PL_METHODS).default('closing'),
  /** Elle kur (şirket defter para birimi -> grup para birimi); verilen para birimi için kayıtlı kuru geçersiz kılar. */
  closingRates: rateListString.optional(),
  plRates: rateListString.optional(),
  mapLevel: z.enum(MAP_LEVELS).default('3'),
  /** Yıl sonu kapanış/devir fişlerini DAHİL et (varsayılan: hariç; gelir tablosu kapanışla sıfırlanmasın). */
  includeClosing: boolQuery,
});
export type ConsolidationReportQuery = z.infer<typeof consolidationReportQuerySchema>;

export const eliminationKinds = ['intercompany_balance', 'intercompany_sales', 'other'] as const;

export const createEliminationSchema = z
  .object({
    periodFrom: isoDate,
    periodTo: isoDate,
    kind: z.enum(eliminationKinds).default('intercompany_balance'),
    description: z.string().trim().min(2, 'Açıklama gerekli').max(300),
    lines: z
      .array(
        z.object({
          accountCode: z.string().trim().regex(/^[0-9][0-9A-Za-z.]{0,19}$/, 'Geçersiz hesap kodu'),
          debit: moneyString.optional(),
          credit: moneyString.optional(),
          memo: z.string().trim().max(200).optional(),
        }),
      )
      .min(2, 'En az iki satır gerekli')
      .max(50),
  })
  .superRefine((v, ctx) => {
    if (v.periodFrom > v.periodTo) ctx.addIssue({ code: 'custom', message: 'Dönem başlangıcı bitişten sonra olamaz', path: ['periodTo'] });
    let d = 0;
    let c = 0;
    v.lines.forEach((l, i) => {
      const dv = Number(l.debit ?? 0);
      const cv = Number(l.credit ?? 0);
      if (!(dv > 0) === !(cv > 0)) ctx.addIssue({ code: 'custom', message: 'Satırda borç ya da alacaktan yalnızca biri girilmeli', path: ['lines', i] });
      d += dv;
      c += cv;
    });
    if (Math.abs(d - c) > 0.00005) ctx.addIssue({ code: 'custom', message: 'Eliminasyon dengeli olmalı (borç = alacak)', path: ['lines'] });
  });
export type CreateEliminationInput = z.infer<typeof createEliminationSchema>;

export const voidEliminationSchema = z.object({ reason: z.string().trim().min(3, 'Gerekçe gerekli').max(300) });

export const fxPositionQuerySchema = z.object({
  asOf: isoDate,
  /** Kur tarihi (yoksa asOf; o tarihe kadar en yeni kayıtlı kur). */
  rateDate: isoDate.optional(),
  /** Elle kur: yabancı para -> (şirket modunda) defter para birimi, (grup modunda) grup para birimi. */
  rates: rateListString.optional(),
});
export type FxPositionQuery = z.infer<typeof fxPositionQuerySchema>;

export const executiveSummaryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  compare: z.enum(['none', 'previous', 'last_year']).default('previous'),
  /** Grup modunda şirket defter para birimi -> grup para birimi elle kur (yoksa dönem sonundaki kayıtlı kur). */
  rates: rateListString.optional(),
  /** Yıl sonu kapanış/devir fişlerini DAHİL et (varsayılan: hariç). */
  includeClosing: boolQuery,
});
export type ExecutiveSummaryQuery = z.infer<typeof executiveSummaryQuerySchema>;

export const intercompanyHintsQuerySchema = z.object({ asOf: isoDate });
