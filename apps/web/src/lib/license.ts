import { useQuery } from '@tanstack/react-query';
import { formatDateTR } from '@erp/shared';
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
  return formatDateTR(new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Nicosia' }));
}

/** ISO zamanını `gg.aa.yyyy ss:dd` (Europe/Nicosia) olarak biçimlendirir. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('tr-TR', { timeZone: 'Europe/Nicosia', hour: '2-digit', minute: '2-digit' });
  return `${fmtDate(iso)} ${time}`;
}
