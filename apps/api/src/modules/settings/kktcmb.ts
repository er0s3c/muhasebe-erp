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
import type { Tx } from '../../db/client';
import { AppError, unprocessable } from '../../http/errors';
import { importPublishedRates, type FxImportResult } from './fx-import';
import { normalizePublishedRate, rateXmlDate, validateRateXml } from './xml-rates';

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

/** XML metnini doğrular ve ayrıştırır. Hatalı/şüpheli girdide `RATE_XML_INVALID`. */
export function parseKktcmbXml(xml: string): KktcmbDay {
  validateRateXml(xml);
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

  const date = rateXmlDate(root.Kur_Tarihi, '/');
  const announcementNo =
    typeof root.Duyuru_No === 'string' && root.Duyuru_No.trim() ? root.Duyuru_No.trim() : null;

  const list = (root.Resmi_Kurlar as { Resmi_Kur?: Record<string, unknown>[] } | undefined)
    ?.Resmi_Kur;
  if (!list || list.length === 0) throw invalid('Resmi_Kur kaydı bulunamadı');

  const seen = new Set<string>();
  const rates: KktcmbRate[] = list.map((r) => {
    const symbol = typeof r.Sembol === 'string' ? r.Sembol.trim() : '';
    if (!/^[A-Z]{3}$/.test(symbol)) throw invalid('Geçersiz para birimi sembolü');
    if (seen.has(symbol)) throw invalid('Yinelenen para birimi sembolü');
    seen.add(symbol);
    const unit =
      typeof r.Birim === 'string' && /^\d{1,6}$/.test(r.Birim.trim()) ? Number(r.Birim.trim()) : 0;
    if (unit <= 0) throw invalid(`${symbol}: Birim geçerli bir pozitif tam sayı değil`);
    const normalized = (field: string) => {
      const rate = normalizePublishedRate(r[field], unit, field, symbol);
      if (!rate) throw invalid(`${symbol}: ${field} bulunamadı`);
      return rate;
    };
    return {
      symbol,
      name: typeof r.Isim === 'string' ? r.Isim.trim() : symbol,
      unit,
      buy: normalized('Doviz_Alis'),
      sell: normalized('Doviz_Satis'),
      effectiveBuy: normalized('Efektif_Alis'),
      effectiveSell: normalized('Efektif_Satis'),
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

export type ImportResult = FxImportResult;

/**
 * Desteklenen para birimlerinin (TRY dışındakiler) kurlarını şirkete yazar. Aynı gün/çift için
 * güncelleme yapar (yinelenen kayıt oluşmaz). Kurlar TRY'ye karşı saklanır; defter para birimi
 * TRY değilse kur arama üçgenleme ile çözer. Dört kur da saklanır; manuel değerler korunur.
 */
export async function importKktcmbRates(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  day: KktcmbDay,
  _preserveManual = true,
): Promise<ImportResult> {
  return importPublishedRates(tx, ctx, day, { provider: 'kktcmb', sourceUrl: kktcmbUrl(day.date) });
}
