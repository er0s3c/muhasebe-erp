import Decimal from 'decimal.js';

/**
 * Para hesabı için yalıtılmış Decimal sınıfı. JS `number` ile para hesabı yapılmaz;
 * tutarlar API'de ve DB'de string/numeric olarak taşınır.
 */
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type MoneyValue = InstanceType<typeof Money>;

/** Kayıt para birimlerinin küçük birim basamağı (hepsi 2). */
export const CURRENCY_MINOR_UNITS = 2;

export const dec = (value: Decimal.Value): MoneyValue => new Money(value);

export const ZERO = dec(0);

/**
 * Güvenli dönüşüm: sonlu bir sayı değilse (`'1,5'`, `'abc'`, `''`, `'NaN'`, `'Infinity'`, `'1e999'`) `null` döner, asla fırlatmaz.
 * Doğrulama şemalarının `.refine`/`.superRefine` gövdeleri bunu kullanır: Zod, `.regex` başarısız olsa da sonraki
 * kuralları çalıştırır; `dec()` orada DecimalError fırlatıp 500'e yol açıyordu (API-2).
 */
export function tryDec(value: unknown): MoneyValue | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  try {
    const d = new Money(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** `tryDec(v)` sonucu verilen koşulu sağlıyor mu (geçersiz sayı → false). Şema kurallarında kullanılır. */
export const decCheck =
  (pred: (d: MoneyValue) => boolean) =>
  (value: unknown): boolean => {
    const d = tryDec(value);
    return d !== null && pred(d);
  };

export function sum(values: Iterable<Decimal.Value>): MoneyValue {
  let total = dec(0);
  for (const v of values) total = total.plus(v);
  return total;
}

/** Yarıya yukarı yuvarlama ile küçük birime yuvarlar (varsayılan 2 basamak). */
export function roundMoney(value: Decimal.Value, dp = CURRENCY_MINOR_UNITS): MoneyValue {
  return dec(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP);
}

/** tutar × kur, küçük birime yuvarlanmış. */
export function applyRate(amount: Decimal.Value, rate: Decimal.Value, dp = 2): MoneyValue {
  return roundMoney(dec(amount).times(rate), dp);
}

/** DB numeric(19,4) için kanonik string. */
export function toDbAmount(value: Decimal.Value): string {
  return dec(value).toFixed(4);
}

/** DB numeric(19,8) kur için kanonik string. */
export function toDbRate(value: Decimal.Value): string {
  return dec(value).toFixed(8);
}

/** "1234.5" -> "1.234,50" (Türkçe gösterim). */
export function formatTR(value: Decimal.Value | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '';
  const d = dec(value);
  const negative = d.isNegative() && !d.isZero();
  const [intPart = '0', frac = ''] = d.abs().toFixed(dp).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = dp > 0 ? `${grouped},${frac}` : grouped;
  return negative ? `-${body}` : body;
}

/**
 * Para birimi simgeleri. Yalnızca GÖSTERİM içindir: değer, parametre ve API alanlarında daima kod (TRY, GBP …) kullanılır.
 * Sistem dört para birimi bilir (`CURRENCY_CODES`); listede olmayan bir kod simge yerine kodun kendisiyle gösterilir.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = { TRY: '₺', GBP: '£', EUR: '€', USD: '$' };

const hasSymbol = (code: string) => Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, code);

/** "GBP" -> "£" (bilinmeyen kod olduğu gibi döner). */
export const currencySymbol = (code: string): string => (hasSymbol(code) ? CURRENCY_SYMBOLS[code]! : code);

/**
 * Simge önde Türkçe tutar: ("1234.5", "TRY") -> "₺1.234,50"; negatifte işaret simgeden önce: "-₺1.234,50".
 * Bilinmeyen kodda kod + sabit boşluk öneki ("CHF 1.234,50"). Boş değer boş döner.
 */
export function formatMoney(value: Decimal.Value | null | undefined, currency: string, dp = 2): string {
  const body = formatTR(value, dp);
  if (body === '') return '';
  const prefix = hasSymbol(currency) ? CURRENCY_SYMBOLS[currency]! : `${currency}\u00A0`;
  return body.startsWith('-') ? `-${prefix}${body.slice(1)}` : `${prefix}${body}`;
}

/**
 * Türkçe girişi kanonik ondalık string'e çevirir: "1.234,56" -> "1234.56".
 * Nokta binlik ayracı, virgül ondalık ayracıdır. Geçersizse null.
 */
export function parseTR(input: string): string | null {
  const trimmed = input.trim().replace(/\s/g, '');
  if (trimmed === '') return null;
  if (!/^-?[\d.]*(,\d*)?$/.test(trimmed)) return null;
  const [intRaw = '', fracRaw] = trimmed.split(',');
  const intPart = intRaw.replace(/\./g, '');
  if (intPart === '' || intPart === '-') {
    if (fracRaw === undefined || fracRaw === '') return null;
    return `${intPart === '-' ? '-' : ''}0.${fracRaw}`;
  }
  return fracRaw ? `${intPart}.${fracRaw}` : intPart;
}
