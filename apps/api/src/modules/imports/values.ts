import { dec, type NumberFormat } from '@erp/shared';
import { serialToText } from '../../files/xlsx-read';

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (code: string, message: string): Parsed<never> => ({ ok: false, code, message });

/** Türkçe küçük harf, aksansız, yalnızca harf ve rakam: ad/başlık karşılaştırması için. */
export function foldKey(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

function calendar(y: number, m: number, d: number): Parsed<string> {
  if (y < 1900 || y > 2100) return bad('INVALID_DATE', `Geçersiz tarih (yıl ${y})`);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return bad('INVALID_DATE', 'Geçersiz tarih (takvimde yok)');
  }
  return ok(`${y}-${pad(m)}-${pad(d)}`);
}

/**
 * Tarih: gg.aa.yyyy, gg/aa/yyyy, gg-aa-yyyy (gün önce), yyyy-aa-gg, yyyyaagg, Excel seri numarası (5 basamak) ve
 * xlsx'in ürettiği `yyyy-aa-gg ss:dd:ss`. İki basamaklı yıl reddedilir (belirsiz).
 */
export function parseDate(text: string): Parsed<string> {
  const s = text.trim();
  if (s === '') return bad('DATE_REQUIRED', 'Tarih boş');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/.exec(s);
  if (m) return calendar(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (m) return calendar(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return calendar(Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 1 && serial < 73051) return calendar(...(serialToText(serial, false).slice(0, 10).split('-').map(Number) as [number, number, number]));
  }
  return bad('INVALID_DATE', `"${s}" tarih olarak okunamadı (gg.aa.yyyy ya da yyyy-aa-gg kullanın)`);
}

const TR_GROUPED = /^\d{1,3}(\.\d{3})+$/;
const EN_GROUPED = /^\d{1,3}(,\d{3})+$/;

interface DecimalOptions {
  /** Ondalık basamak üst sınırı (sonundaki sıfırlar sayılmaz). */
  maxDp: number;
  /** Eksi değere izin ver. */
  allowNegative?: boolean;
}

/** Para/miktar metnini kanonik ondalık dizeye çevirir ("1.234,56" → "1234.56"). Belirsiz biçim reddedilir. */
export function parseDecimal(text: string, format: NumberFormat, opts: DecimalOptions): Parsed<string> {
  let s = text.trim().replace(/[\s\u00a0]/g, '').replace(/[₺£€$]/g, '');
  if (s === '') return bad('NUMBER_REQUIRED', 'Sayı boş');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return bad('INVALID_NUMBER', `"${text.trim()}" sayı olarak okunamadı`);

  const invalid = (hint: string) => bad('INVALID_NUMBER', `"${text.trim()}" ${hint} biçiminde geçerli bir sayı değil`);
  let canonical: string;

  const asTr = (v: string): string | null => {
    // 1.234,56 · 1234,56 · 1234 · ,5 değil
    const [intRaw, frac, ...rest] = v.split(',');
    if (rest.length > 0 || intRaw === undefined || intRaw === '') return null;
    if (intRaw.includes('.') && !TR_GROUPED.test(intRaw)) return null;
    if (!intRaw.includes('.') && !/^\d+$/.test(intRaw)) return null;
    if (frac !== undefined && !/^\d+$/.test(frac)) return null;
    return `${intRaw.replace(/\./g, '')}${frac !== undefined ? `.${frac}` : ''}`;
  };
  const asEn = (v: string): string | null => {
    const [intRaw, frac, ...rest] = v.split('.');
    if (rest.length > 0 || intRaw === undefined || intRaw === '') return null;
    if (intRaw.includes(',') && !EN_GROUPED.test(intRaw)) return null;
    if (!intRaw.includes(',') && !/^\d+$/.test(intRaw)) return null;
    if (frac !== undefined && !/^\d+$/.test(frac)) return null;
    return `${intRaw.replace(/,/g, '')}${frac !== undefined ? `.${frac}` : ''}`;
  };

  if (format === 'tr') {
    const r = asTr(s);
    if (r === null) return invalid('Türkçe (1.234,56)');
    canonical = r;
  } else if (format === 'en') {
    const r = asEn(s);
    if (r === null) return invalid('İngilizce (1,234.56)');
    canonical = r;
  } else {
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    let r: string | null;
    if (hasDot && hasComma) {
      r = s.lastIndexOf(',') > s.lastIndexOf('.') ? asTr(s) : asEn(s);
    } else if (hasComma) {
      const parts = s.split(',');
      if (parts.length > 2) r = asEn(s); // 1,234,567
      else if (parts[1]!.length === 3 && /^\d{1,3}$/.test(parts[0]!)) {
        return bad('AMBIGUOUS_NUMBER', `"${text.trim()}" belirsiz: Türkçe ondalık mı, İngilizce binlik mi? Sayı biçimini seçin`);
      } else r = asTr(s);
    } else if (hasDot) {
      const parts = s.split('.');
      if (parts.length > 2) r = asTr(s); // 1.234.567
      else if (parts[1]!.length === 3 && /^\d{1,3}$/.test(parts[0]!)) {
        return bad('AMBIGUOUS_NUMBER', `"${text.trim()}" belirsiz: Türkçe binlik mi, İngilizce ondalık mı? Sayı biçimini seçin`);
      } else r = asEn(s);
    } else {
      r = /^\d+$/.test(s) ? s : null;
    }
    if (r === null) return bad('INVALID_NUMBER', `"${text.trim()}" sayı olarak okunamadı`);
    canonical = r;
  }

  const d = dec(canonical);
  if (d.decimalPlaces() > opts.maxDp) {
    return bad('TOO_MANY_DECIMALS', `"${text.trim()}" en çok ${opts.maxDp} ondalık basamak içerebilir`);
  }
  if (d.gte('1e15')) return bad('NUMBER_TOO_LARGE', `"${text.trim()}" çok büyük`);
  if (negative && !d.isZero()) {
    if (!opts.allowNegative) return bad('NEGATIVE_NOT_ALLOWED', `"${text.trim()}" eksi olamaz`);
    return ok(`-${d.toFixed()}`);
  }
  return ok(d.toFixed());
}

/** Tam sayı (vade günü gibi). */
export function parseInteger(text: string, min: number, max: number): Parsed<number> {
  const s = text.trim().replace(/[\s\u00a0]/g, '');
  // xlsx sayı hücresi "30" ya da "30.0" gelebilir
  const m = /^(\d{1,9})(?:[.,]0+)?$/.exec(s);
  if (!m) return bad('INVALID_INTEGER', `"${text.trim()}" tam sayı olarak okunamadı`);
  const n = Number(m[1]);
  if (n < min || n > max) return bad('INTEGER_RANGE', `${min} ile ${max} arasında olmalı`);
  return ok(n);
}
