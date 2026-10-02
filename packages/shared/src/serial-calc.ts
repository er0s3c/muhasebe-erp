/**
 * Seri no yardımcıları (X3) — saf hesap. Seri no'lar büyük harfe çevrilir ve kırpılır (sicilde tek biçim).
 */
export const SERIAL_MAX_LENGTH = 60;

export const normalizeSerial = (s: string): string => s.trim().replace(/\s+/g, ' ').toUpperCase();

/** Yapıştırılan metni (satır sonu, noktalı virgül, virgül, sekme ayraçlı; CSV'nin ilk sütunu) seri no listesine çevirir. */
export function parseSerialList(text: string): { serials: string[]; duplicates: string[]; tooLong: string[] } {
  const seen = new Set<string>();
  const serials: string[] = [];
  const duplicates: string[] = [];
  const tooLong: string[] = [];
  for (const raw of text.split(/[\r\n;,\t]+/)) {
    const s = normalizeSerial(raw.replace(/^"|"$/g, ''));
    if (!s) continue;
    if (s.length > SERIAL_MAX_LENGTH) {
      tooLong.push(s);
      continue;
    }
    if (seen.has(s)) {
      if (!duplicates.includes(s)) duplicates.push(s);
      continue;
    }
    seen.add(s);
    serials.push(s);
  }
  return { serials, duplicates, tooLong };
}

export const SERIAL_STATUSES = ['in_stock', 'issued', 'returned', 'scrapped', 'void', 'pending'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];
export const SERIAL_EVENTS = ['receive', 'issue', 'return_in', 'return_out', 'scrap', 'transfer', 'reversal'] as const;
export type SerialEventKind = (typeof SERIAL_EVENTS)[number];
