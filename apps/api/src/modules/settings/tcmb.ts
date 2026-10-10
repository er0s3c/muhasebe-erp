import { XMLParser } from 'fast-xml-parser';
import { AppError } from '../../http/errors';
import {
  invalidRateXml,
  MAX_RATE_XML_CHARS,
  normalizePublishedRate,
  rateXmlDate,
  validateRateXml,
  type PublishedRateDay,
} from './xml-rates';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'Currency',
});
/** Official daily XML: https://www.tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml */
export function parseTcmbXml(xml: string): PublishedRateDay {
  validateRateXml(xml);
  const root = (parser.parse(xml) as Record<string, unknown>).Tarih_Date as
    Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') throw invalidRateXml('Tarih_Date kök öğesi bulunamadı');
  const date = rateXmlDate(root['@_Tarih'], '.');
  const list = root.Currency as Record<string, unknown>[] | undefined;
  if (!Array.isArray(list) || !list.length) throw invalidRateXml('Currency kaydı bulunamadı');
  const seen = new Set<string>();
  const rates = list.map((row) => {
    const symbol = row['@_CurrencyCode'] ?? row['@_Kod'];
    if (typeof symbol !== 'string' || !/^[A-Z]{3}$/.test(symbol) || seen.has(symbol))
      throw invalidRateXml('Geçersiz veya yinelenen para birimi');
    seen.add(symbol);
    const unit = typeof row.Unit === 'string' && /^\d{1,6}$/.test(row.Unit) ? Number(row.Unit) : 0;
    if (unit <= 0) throw invalidRateXml(`${symbol}: Unit geçerli bir pozitif tam sayı değil`);
    return {
      symbol,
      name: typeof row.Isim === 'string' ? row.Isim : symbol,
      unit,
      buy: normalizePublishedRate(row.ForexBuying, unit, 'ForexBuying', symbol),
      sell: normalizePublishedRate(row.ForexSelling, unit, 'ForexSelling', symbol),
      effectiveBuy: normalizePublishedRate(row.BanknoteBuying, unit, 'BanknoteBuying', symbol),
      effectiveSell: normalizePublishedRate(row.BanknoteSelling, unit, 'BanknoteSelling', symbol),
    };
  });
  return {
    date,
    announcementNo: typeof root['@_Bulten_No'] === 'string' ? root['@_Bulten_No'] : null,
    rates,
  };
}
export function tcmbUrl(date?: string) {
  if (!date) return 'https://www.tcmb.gov.tr/kurlar/today.xml';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('geçersiz tarih');
  return `https://www.tcmb.gov.tr/kurlar/${date.slice(0, 4)}${date.slice(5, 7)}/${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}.xml`;
}
export async function fetchTcmbXml(date?: string) {
  const unavailable = (detail: string) =>
    new AppError(
      502,
      'RATE_SOURCE_UNAVAILABLE',
      `TCMB kur servisine ulaşılamadı (${detail}). Resmî XML dosyasını indirip yükleyebilirsiniz.`,
    );
  let response: Response;
  try {
    response = await fetch(tcmbUrl(date), {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      headers: { accept: 'application/xml, text/xml;q=0.9' },
    });
  } catch (error) {
    throw unavailable(error instanceof Error ? error.name : 'bağlantı hatası');
  }
  if (!response.ok) throw unavailable(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_RATE_XML_CHARS) throw unavailable('yanıt çok büyük');
  return text;
}
