import { useQuery } from '@tanstack/react-query';
import { formatDateTR, getCompanyTimeZone } from '@erp/shared';
import type { Sector } from '@erp/shared';
import { api } from './api';
import { useSession } from './session';

export type LicenseState = 'unlicensed' | 'active' | 'grace' | 'restricted';

/** `GET /api/license`: durum giriş yapmış herkese, kurulum ayrıntıları (`isOwner`) yalnızca şirket sahibine. */
export interface LicenseInfo {
  enforced: boolean;
  state: LicenseState;
  reason: string | null;
  message: string | null;
  expiresSoon: boolean;
  daysUntilExpiry: number | null;
  activeUntil: string | null;
  graceUntil: string | null;
  license: {
    customer: string;
    kind: 'commercial' | 'trial' | 'demo';
    sectors: Sector[];
    deviceLimit: number;
    companyLimit: number;
    deviceIdleDays: number;
    graceDays: number;
    validUntil: string | null;
    leaseUntil: string | null;
    offline: boolean;
  } | null;
  usage: { companies: number; devices: number };
  isOwner: boolean;
  installationId?: string;
  fingerprintStrength?: 'strong' | 'weak';
  serverConfigured?: boolean;
  lastCheckAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: { code: string; message: string } | null;
  pendingOfflineRequest?: boolean;
}

export interface DeviceRow {
  id: string;
  name: string;
  userAgent: string | null;
  ip: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUser: { email: string; fullName: string } | null;
  status: 'active' | 'idle' | 'revoked';
  current: boolean;
  revokedAt: string | null;
}

export interface DeviceList {
  enforced: boolean;
  limit: number | null;
  active: number;
  devices: DeviceRow[];
}

/** Lisans durumu (banner, sektör kilidi, Lisans sayfası). Yalnızca oturum açıkken sorulur; 5 dakikada bir tazelenir. */
export function useLicense() {
  const { status } = useSession();
  return useQuery<LicenseInfo>({
    queryKey: ['license'],
    queryFn: () => api<LicenseInfo>('/api/license'),
    enabled: status === 'authenticated',
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** ISO zamanını `gg.aa.yyyy` (Europe/Nicosia) olarak biçimlendirir. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = toInstant(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDateTR(d.toLocaleDateString('sv-SE', { timeZone: getCompanyTimeZone() }));
}

/**
 * Sunucu zaman damgasını Date'e çevirir. ISO ("2026-10-02T20:03:56.615Z") yanında PostgreSQL metin biçimini
 * ("2026-10-02 20:03:58.641+00") da kabul eder: Safari bu biçimi ayrıştıramıyordu (UI-16).
 */
export function toInstant(value: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value.trim());
  if (!m) return new Date(value);
  let tz = m[3] ?? 'Z';
  if (/^[+-]\d{2}$/.test(tz)) tz += ':00';
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return new Date(`${m[1]}T${m[2]}${tz}`);
}

/** ISO zamanını `gg.aa.yyyy ss:dd` (Europe/Nicosia) olarak biçimlendirir. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = toInstant(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString('tr-TR', { timeZone: getCompanyTimeZone(), hour: '2-digit', minute: '2-digit' });
  return `${fmtDate(iso)} ${time}`;
}
