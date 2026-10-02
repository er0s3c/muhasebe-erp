import { z } from 'zod';
import { boolQuery, isoDate } from './common';
import { isMonthAlignedRange, monthsInRange } from '../year-end';

export const createFiscalYearSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate,
    /** Boşsa varsayılan ad (takvim yılı "2026"). */
    name: z.string().trim().min(1).max(40).optional(),
  })
  .superRefine((v, ctx) => {
    if (!isMonthAlignedRange(v.startDate, v.endDate)) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Mali yıl tam aylara oturmalı: başlangıç ayın 1\'i, bitiş ayın son günü olmalı' });
    } else if (monthsInRange(v.startDate, v.endDate).length > 12) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Mali yıl en çok 12 ay olabilir' });
    }
  });
export type CreateFiscalYearInput = z.infer<typeof createFiscalYearSchema>;

/** Önizleme/kapanış seçenekleri. */
export const closingOptionsShape = {
  /** Dönem sonucunu sonraki yılın ilk gününe geçmiş yıllar hesabına devreden ikinci fişi de yaz. */
  carryForward: z.boolean().default(true),
  /** 7. sınıf maliyet hesaplarını da sonuç hesabına kapat (varsayılan evet; doğrulanmadı). */
  includeCostAccounts: z.boolean().default(true),
};

export const closeFiscalYearSchema = z.object({
  /** Yazılı onay: mali yılın adı. */
  confirm: z.string().trim().min(1),
  ...closingOptionsShape,
});
export type CloseFiscalYearInput = z.infer<typeof closeFiscalYearSchema>;

export const previewFiscalYearQuerySchema = z.object({
  carryForward: boolQuery.default(true),
  includeCostAccounts: boolQuery.default(true),
});

export const reopenFiscalYearSchema = z.object({
  reason: z.string().trim().min(5, 'Gerekçe en az 5 karakter olmalı').max(300),
});
export type ReopenFiscalYearInput = z.infer<typeof reopenFiscalYearSchema>;
