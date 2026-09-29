export const COMPANY_TIME_ZONE = 'Europe/Nicosia';

/** Şirket saat diliminde bugünün tarihi, ISO biçiminde (YYYY-MM-DD). */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** "2026-03-05" -> "05.03.2026" */
export function formatDateTR(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export function isoYear(iso: string): number {
  return Number(iso.slice(0, 4));
}

export function isoMonth(iso: string): number {
  return Number(iso.slice(5, 7));
}
