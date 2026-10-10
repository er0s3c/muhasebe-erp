export const COMPANY_TIME_ZONE = 'Europe/Nicosia';

let companyTimeZoneResolver: () => string | null | undefined = () => COMPANY_TIME_ZONE;

/** Sunucuda istek bağlamı, tarayıcıda etkin şirket tarafından bir kez kurulur. */
export function setCompanyTimeZoneResolver(resolver: () => string | null | undefined): void {
  companyTimeZoneResolver = resolver;
}

export function getCompanyTimeZone(): string {
  return companyTimeZoneResolver() || COMPANY_TIME_ZONE;
}

/** Şirket saat diliminde bugünün tarihi, ISO biçiminde (YYYY-MM-DD). */
export function todayIso(now: Date = new Date(), timeZone: string = getCompanyTimeZone()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
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

/** "2026-03-30" + 3 -> "2026-04-02" (takvim günü aritmetiği, saat dilimi/yaz saati etkisiz). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
