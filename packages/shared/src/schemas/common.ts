import { z } from 'zod';

export const CURRENCY_CODES = ['TRY', 'GBP', 'EUR', 'USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const currencyCode = z.enum(CURRENCY_CODES);

/** Kanonik ondalık tutar: en çok 15 tam, 4 ondalık basamak; eksi değer yok. */
export const moneyString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz tutar');

/** Kanonik kur: en çok 11 tam, 8 ondalık basamak; sıfırdan büyük olmalı (servis doğrular). */
export const rateString = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,8})?$/, 'Geçersiz kur');

export const isoDate = z.iso.date();

export const uuid = z.uuid();
