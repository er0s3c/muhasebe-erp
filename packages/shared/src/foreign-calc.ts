import type { ForeignDocStatus } from './schemas/foreignworkers';

/**
 * Yabancı işçi belge durumu hesabı (Faz D5). Geçerlilik süresi, uyarı günü ya da başka yasal değer burada YOKTUR: son kullanma tarihi
 * belgeden, uyarı günü kullanıcının girdiği tarihli (doğrulanmamış olabilir) parametreden gelir. Uyarı günü yoksa (parametre tanımsız ya da
 * kapalı) "dolmak üzere" durumu hiç üretilmez: belge yalnızca geçerli ya da süresi dolmuş olur.
 */
const DAY_MS = 86_400_000;
const toUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** b - a, takvim günü olarak (a, b: YYYY-AA-GG). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export interface ForeignDocStatusInput {
  expiryDate: string | null;
  revoked: boolean;
  /** Değerlendirme günü (enjekte edilir; testler sabit gün verir). */
  today: string;
  /** Kullanıcı parametresi; null = tanımsız/kapalı. */
  warningDays: number | null;
}

export interface ForeignDocStatusResult {
  status: ForeignDocStatus;
  /** Son kullanmaya kalan gün (geçmişse negatif); son kullanma yoksa null. */
  daysToExpiry: number | null;
}

/**
 * revoked → revoked; son kullanma yok → valid (süresiz); son kullanma günü dahil geçerlidir (kalan gün 0 = bugün son gün);
 * kalan gün < 0 → expired; kalan gün <= uyarı günü → expiring.
 */
export function foreignDocStatus(i: ForeignDocStatusInput): ForeignDocStatusResult {
  const daysToExpiry = i.expiryDate ? daysBetween(i.today, i.expiryDate) : null;
  if (i.revoked) return { status: 'revoked', daysToExpiry };
  if (daysToExpiry === null) return { status: 'valid', daysToExpiry };
  if (daysToExpiry < 0) return { status: 'expired', daysToExpiry };
  if (i.warningDays !== null && daysToExpiry <= i.warningDays) return { status: 'expiring', daysToExpiry };
  return { status: 'valid', daysToExpiry };
}

export interface DatedParamRow {
  key: string;
  effectiveFrom: string;
  enabled: boolean;
  value: string;
  currency?: string | null;
}

/**
 * Tarihli parametre çözümü: anahtar için başlangıcı verilen günden önce/aynı gün olan EN YENİ satır geçerlidir; o satır kapalıysa
 * parametre kapalıdır (null). Satır yoksa null: hiçbir varsayılan değer yoktur.
 */
export function resolveDatedParam<T extends DatedParamRow>(rows: readonly T[], key: string, onDate: string): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.key !== key || r.effectiveFrom > onDate) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best && best.enabled ? best : null;
}
