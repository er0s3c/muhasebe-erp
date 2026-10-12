import { XMLValidator } from 'fast-xml-parser';
import { dec, toDbRate } from '@erp/shared';
import { unprocessable } from '../../http/errors';

export const MAX_RATE_XML_CHARS = 500_000;
export const invalidRateXml = (message: string) => unprocessable(message, 'RATE_XML_INVALID');
export interface PublishedRate {
  symbol: string;
  name: string;
  unit: number;
  buy: string | null;
  sell: string | null;
  effectiveBuy: string | null;
  effectiveSell: string | null;
}
export interface PublishedRateDay {
  date: string;
  announcementNo: string | null;
  rates: PublishedRate[];
}
export function validateRateXml(xml: string) {
  if (xml.length > MAX_RATE_XML_CHARS) throw invalidRateXml('XML dosyası çok büyük');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw invalidRateXml('XML içinde DOCTYPE/ENTITY tanımı bulunamaz');
  if (XMLValidator.validate(xml) !== true) throw invalidRateXml('XML ayrıştırılamadı');
}
export function rateXmlDate(value: unknown, separator: '/' | '.') {
  const pattern = separator === '/' ? /^(\d{2})\/(\d{2})\/(\d{4})$/ : /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const m = typeof value === 'string' ? pattern.exec(value.trim()) : null;
  if (!m) throw invalidRateXml('Geçersiz kur tarihi');
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso)
    throw invalidRateXml('Geçersiz kur tarihi');
  return iso;
}
export function normalizePublishedRate(
  value: unknown,
  unit: number,
  field: string,
  symbol: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,8})?$/.test(value.trim()) || dec(value).lte(0))
    throw invalidRateXml(`${symbol}: ${field} geçerli bir pozitif sayı değil`);
  const normalized = dec(value).div(unit).toDecimalPlaces(8);
  if (normalized.lte(0))
    throw invalidRateXml(`${symbol}: ${field} tek birime bölündüğünde sıfır olamaz`);
  return toDbRate(normalized);
}
