import { z } from 'zod';
import { installZodTurkish } from '../zod-tr';

// Paylaşılan şemaları kullanan her yer (API, web formları) Türkçe doğrulama iletileri alır (API-9, UI-11).
installZodTurkish();

export const CURRENCY_CODES = ['TRY', 'GBP', 'EUR', 'USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const currencyCode = z.enum(CURRENCY_CODES);

/** Kanonik ondalık tutar: en çok 15 tam, 4 ondalık basamak; eksi değer yok. */
export const moneyString = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Geçersiz tutar');

/**
 * Veritabanı tutar sütunlarının (numeric(19,4)) üst sınırı: mutlak değer 10^15'ten küçük olmalı. Tek tek girilen tutarlar
 * `moneyString` ile zaten sınırlıdır; HESAPLANAN tutarlar (miktar × fiyat, × kur, + KDV) için şemalar bu sınırı kullanır (ACC-8).
 */
export const DB_AMOUNT_LIMIT = '1000000000000000';

/** Kanonik kur: en çok 11 tam, 8 ondalık basamak; sıfırdan büyük olmalı (servis doğrular). */
export const rateString = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,8})?$/, 'Geçersiz kur');

/** Kabul edilen tarih penceresi (API-4): yazım hatası (0001, 9999) hesap ve raporları bozmasın; doğum tarihi gibi eski tarihler 1900'den başlar. */
export const MIN_DATE = '1900-01-01';
export const MAX_DATE = '2100-12-31';

export const isoDate = z.iso
  .date({ error: 'Geçersiz tarih', abort: true })
  .refine((v) => v >= MIN_DATE && v <= MAX_DATE, { error: 'Tarih 01.01.1900 ile 31.12.2100 arasında olmalı', abort: true });

export const uuid = z.uuid();

/** Sorgu dizesindeki mantıksal değer ("true"/"1" → true; "false"/"0"/yok → false). `z.coerce.boolean` "false"i true yapar, bu yüzden kullanılmaz. */
export const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/**
 * Liste sayfalama parametreleri (API-7): `limit` (varsayılan `dflt`, en çok `max`) ve `offset`. Yanıt, sınır aşıldığında
 * `truncated: true` taşır; arayüz "daha fazla" göstermek için `offset` ile sonraki sayfayı ister.
 */
export const pageParams = (dflt = 500, max = 2000) => ({
  limit: z.coerce.number().int().min(1).max(max).default(dflt),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const pageQuerySchema = z.object(pageParams());
export interface PageQuery {
  limit: number;
  offset: number;
}
