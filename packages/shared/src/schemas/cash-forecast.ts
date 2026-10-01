import { z } from 'zod';
import { currencyCode, isoDate, moneyString, uuid } from './common';

export const cashForecastQuerySchema = z.object({
  from: isoDate.optional(),
  weeks: z.coerce.number().int().min(4).max(26).default(13),
  projectId: uuid.optional(),
});
export type CashForecastQuery = z.infer<typeof cashForecastQuerySchema>;

const itemBody = {
  itemDate: isoDate,
  direction: z.enum(['in', 'out']),
  description: z.string().trim().min(2, 'Açıklama gerekli').max(200),
  amount: moneyString.refine((v) => Number(v) > 0, 'Tutar sıfırdan büyük olmalı'),
  currencyCode,
  projectId: uuid.nullable().optional(),
};
export const createCashForecastItemSchema = z.object(itemBody);
export type CreateCashForecastItemInput = z.infer<typeof createCashForecastItemSchema>;
export const updateCashForecastItemSchema = z.object(itemBody);
export type UpdateCashForecastItemInput = z.infer<typeof updateCashForecastItemSchema>;
