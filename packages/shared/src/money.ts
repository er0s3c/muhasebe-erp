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
 * Türkçe girişi kanonik ondalık string'e çevirir; geçersizse `null` (asla sessizce başka bir sayı üretmez).
 *
 * Kurallar (UI-1/UI-2):
 * - Virgül ondalık ayracıdır ve en fazla bir kez yazılır: "12,5" → "12.5", "1.234,56" → "1234.56", ",5" → "0.5".
 * - Nokta binlik ayracıdır ancak YALNIZCA doğru gruplanmışsa: "250.000" → "250000", "1.234.567" → "1234567"
 *   (ilk grup 1–3, sonrakiler tam 3 basamak).
 * - Virgül yokken tek nokta doğru binlik gruplaması değilse ondalık ayracı sayılır: "12.5" → "12.5", "0.75" → "0.75",
 *   "1234.5" → "1234.5" (İngilizce klavye/sayısal tuş takımı alışkanlığı). Yani "1.500" bin beş yüzdür, "1.5" bir buçuk.
 * - Virgül varken noktalar yalnızca binlik olabilir: "1.23,4", "1,234.56" geçersizdir; birden çok virgül ya da
 *   yanlış gruplanmış birden çok nokta ("1.2.3") geçersizdir.
 * - Boşluklar (bölünmez boşluk dahil) yok sayılır; baştaki "-" negatif, "+" pozitif işarettir.
 */
export function parseTR(input: string): string | null {
  let s = input.replace(/[\s\u00A0\u202F]/g, '');
  if (s === '') return null;
  let sign = '';
  if (s[0] === '-' || s[0] === '+') {
    sign = s[0] === '-' ? '-' : '';
    s = s.slice(1);
  }
  if (s === '' || !/^[\d.,]+$/.test(s)) return null;
  const grouped = (v: string) => /^\d{1,3}(\.\d{3})+$/.test(v);
  let intPart: string;
  let frac: string;
  const commas = s.split(',').length - 1;
  if (commas > 1) return null;
  if (commas === 1) {
    const [i = '', f = ''] = s.split(',');
    if (!/^\d*$/.test(f)) return null;
    if (i.includes('.')) {
      if (!grouped(i)) return null;
      intPart = i.replace(/\./g, '');
    } else intPart = i;
    frac = f;
  } else if (!s.includes('.')) {
    intPart = s;
    frac = '';
  } else if (grouped(s)) {
    intPart = s.replace(/\./g, '');
    frac = '';
  } else {
    const parts = s.split('.');
    if (parts.length !== 2) return null;
    [intPart = '', frac = ''] = parts;
  }
  if (!/^\d*$/.test(intPart) || (intPart === '' && frac === '')) return null;
  intPart = intPart.replace(/^0+(?=\d)/, '') || '0';
  const body = frac === '' ? intPart : `${intPart}.${frac}`;
  return /^0(\.0*)?$/.test(body) ? body : `${sign}${body}`;
}
