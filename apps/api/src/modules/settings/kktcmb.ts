/**
 * KKTC Merkez Bankası döviz kuru XML'i.
 *
 * Kaynak (kurumun "Döviz kurlarına erişim" sayfasına göre):
 *   güncel:  https://www.mb.gov.ct.tr/kur/gunluk.xml
 *   tarihli: https://www.mb.gov.ct.tr/kur/tarih/YYYYMMDD   (XML: 09/04/2011'den itibaren)
 *
 * Dosya yapısı gerçek bir örnek dosyadan alınmıştır (test/fixtures/kktcmb-gunluk.xml):
 *   KKTCMB_Doviz_Kurlari > Kur_Tarihi (gg/AA/yyyy), Duyuru_No,
 *   Resmi_Kurlar > Resmi_Kur { Birim, Sembol, Isim, Doviz_Alis, Doviz_Satis, Efektif_Alis, Efektif_Satis }
 * `Birim` 1'den farklı olabilir (örn. JPY için 100): kur o birim için verilmiştir, tek birime bölünür.
 */
import { XMLParser } from 'fast-xml-parser';
import { CURRENCY_CODES, dec, toDbRate } from '@erp/shared';
import type { Tx } from '../../db/client';
import { exchangeRates } from '../../db/schema';
import { and, eq } from 'drizzle-orm';
import { AppError, unprocessable } from '../../http/errors';

const BASE_URL = 'https://www.mb.gov.ct.tr/kur';
const MAX_XML_CHARS = 500_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface KktcmbRate {
  symbol: string;
  name: string;
  unit: number;
  /** Tek birim için, 8 ondalık */
  buy: string;
  sell: string;
  effectiveBuy: string;
  effectiveSell: string;
}

export interface KktcmbDay {
  /** ISO tarih (YYYY-MM-DD) */
  date: string;
  announcementNo: string | null;
  rates: KktcmbRate[];
}

const invalid = (message: string) => unprocessable(message, 'RATE_XML_INVALID');

const parser = new XMLParser({
  parseTagValue: false, // sayıları metin olarak tut: kayan nokta yok
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'Resmi_Kur',
});

function parseDate(value: unknown): string {
  const m = typeof value === 'string' ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim()) : null;
  if (!m) throw invalid('Kur_Tarihi gg/AA/yyyy biçiminde olmalı');
  const [, dd, mm, yyyy] = m as unknown as [string, string, string, string];
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw invalid(`Geçersiz kur tarihi: ${value as string}`);
  }
  return iso;
}

function parseRate(value: unknown, field: string, symbol: string): string {
  if (typeof value !== 'string' || !/^\d{1,9}(\.\d{1,8})?$/.test(value.trim()) || dec(value).lte(0)) {
    throw invalid(`${symbol}: ${field} geçerli bir pozitif sayı değil`);
  }
  return value.trim();
}

/** XML metnini doğrular ve ayrıştırır. Hatalı/şüpheli girdide `RATE_XML_INVALID`. */
export function parseKktcmbXml(xml: string): KktcmbDay {
  if (xml.length > MAX_XML_CHARS) throw invalid('XML dosyası çok büyük');
  // Harici varlık (XXE) ve varlık-şişirme saldırılarına karşı: resmî dosyada DOCTYPE yoktur.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('XML içinde DOCTYPE/ENTITY tanımı bulunamaz');

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw invalid('XML ayrıştırılamadı');
  }
  const root = doc.KKTCMB_Doviz_Kurlari as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') throw invalid('KKTCMB_Doviz_Kurlari kök öğesi bulunamadı');

  const date = parseDate(root.Kur_Tarihi);
  const announcementNo = typeof root.Duyuru_No === 'string' && root.Duyuru_No.trim() ? root.Duyuru_No.trim() : null;

  const list = (root.Resmi_Kurlar as { Resmi_Kur?: Record<string, unknown>[] } | undefined)?.Resmi_Kur;
  if (!list || list.length === 0) throw invalid('Resmi_Kur kaydı bulunamadı');

  const rates: KktcmbRate[] = list.map((r) => {
    const symbol = typeof r.Sembol === 'string' ? r.Sembol.trim() : '';
    if (!/^[A-Z]{3}$/.test(symbol)) throw invalid('Geçersiz para birimi sembolü');
    const unit = typeof r.Birim === 'string' && /^\d{1,6}$/.test(r.Birim.trim()) ? Number(r.Birim.trim()) : 0;
    if (unit <= 0) throw invalid(`${symbol}: Birim geçerli bir pozitif tam sayı değil`);
    const perUnit = (raw: string) => dec(raw).div(unit).toDecimalPlaces(8);
    return {
      symbol,
      name: typeof r.Isim === 'string' ? r.Isim.trim() : symbol,
      unit,
      buy: toDbRate(perUnit(parseRate(r.Doviz_Alis, 'Doviz_Alis', symbol))),
      sell: toDbRate(perUnit(parseRate(r.Doviz_Satis, 'Doviz_Satis', symbol))),
      effectiveBuy: toDbRate(perUnit(parseRate(r.Efektif_Alis, 'Efektif_Alis', symbol))),
      effectiveSell: toDbRate(perUnit(parseRate(r.Efektif_Satis, 'Efektif_Satis', symbol))),
    };
  });
  return { date, announcementNo, rates };
}

/** Yalnızca sabit resmî adres; tarih önceden ISO olarak doğrulanmış olmalıdır. */
export function kktcmbUrl(isoDate?: string): string {
  if (!isoDate) return `${BASE_URL}/gunluk.xml`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error('geçersiz tarih');
  return `${BASE_URL}/tarih/${isoDate.replaceAll('-', '')}`;
}

/**
 * XML'i resmî adresten indirir. TLS sertifika doğrulaması HER ZAMAN açıktır (kapatılmaz);
 * sertifika zinciri sorunluysa hata döner ve kullanıcı XML'i dosya olarak yükleyebilir.
 */
export async function fetchKktcmbXml(isoDate?: string): Promise<string> {
  const unavailable = (detail: string) =>
    new AppError(
      502,
      'RATE_SOURCE_UNAVAILABLE',
      `Merkez Bankası kur servisine ulaşılamadı (${detail}). XML dosyasını indirip elle yükleyebilirsiniz.`,
    );
  let res: Response;
  try {
    res = await fetch(kktcmbUrl(isoDate), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
      headers: { accept: 'application/xml, text/xml;q=0.9' },
    });
  } catch (e) {
    throw unavailable(e instanceof Error ? e.name : 'bağlantı hatası');
  }
  if (!res.ok) throw unavailable(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_XML_CHARS) throw unavailable('yanıt çok büyük');
  return text;
}

export interface ImportResult {
  date: string;
  announcementNo: string | null;
  imported: { currency: string; buy: string; sell: string }[];
  skipped: string[];
}

/**
 * Desteklenen para birimlerinin (TRY dışındakiler) kurlarını şirkete yazar. Aynı gün/çift için
 * güncelleme yapar (yinelenen kayıt oluşmaz). Kurlar TRY'ye karşı saklanır; defter para birimi
 * TRY değilse kur arama üçgenleme ile çözer. Efektif kurlar saklanmaz.
 */
export async function importKktcmbRates(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  day: KktcmbDay,
  preserveManual = false,
): Promise<ImportResult> {
  const supported = new Set<string>(CURRENCY_CODES.filter((c) => c !== 'TRY'));
  const source = `KKTCMB${day.announcementNo ? ` ${day.announcementNo}` : ''}`;
  const imported: ImportResult['imported'] = [];
  const skipped: string[] = [];

  for (const r of day.rates) {
    if (!supported.has(r.symbol)) {
      skipped.push(r.symbol);
      continue;
    }
    if (preserveManual) {
      const existing = await tx.select({source: exchangeRates.source}).from(exchangeRates).where(and(eq(exchangeRates.companyId, ctx.companyId),eq(exchangeRates.rateDate,day.date),eq(exchangeRates.currencyCode,r.symbol),eq(exchangeRates.quoteCode,'TRY')));
      if (existing.length && !existing[0]!.source?.startsWith('KKTCMB')) {
        skipped.push(r.symbol + ' (elle girilen kur korundu)');
        continue;
      }
    }
    await tx
      .insert(exchangeRates)
      .values({
        companyId: ctx.companyId,
        rateDate: day.date,
        currencyCode: r.symbol,
        quoteCode: 'TRY',
        buy: r.buy,
        sell: r.sell,
        source,
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [exchangeRates.companyId, exchangeRates.rateDate, exchangeRates.currencyCode, exchangeRates.quoteCode],
        set: { buy: r.buy, sell: r.sell, source, createdBy: ctx.userId },
      });
    imported.push({ currency: r.symbol, buy: r.buy, sell: r.sell });
  }
  if (!day.rates.some(r=>supported.has(r.symbol))) {
    throw unprocessable('Dosyada desteklenen para birimi yok (GBP, EUR, USD)', 'RATE_XML_NO_SUPPORTED');
  }
  return { date: day.date, announcementNo: day.announcementNo, imported, skipped };
}
