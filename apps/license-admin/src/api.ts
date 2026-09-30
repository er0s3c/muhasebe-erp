/** Yönetim paneli API istemcisi: oturum httpOnly çerezdedir; değiştiren isteklere CSRF başlığı eklenir. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, opts: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-requested-with'] = 'erp-license-admin';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: { error?: { code?: string; message?: string; details?: unknown } } | null = null;
  try {
    json = await res.json();
  } catch {
    /* gövde yok */
  }
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? `İstek başarısız (${res.status})`, json?.error?.details);
  return json as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
      return (err.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join('; ') || err.message;
    }
    return err.message;
  }
  if (err instanceof TypeError) return 'Sunucuya ulaşılamadı.';
  return err instanceof Error ? err.message : 'Beklenmeyen bir hata oluştu.';
}

// ---- Sunucu yanıt tipleri (apps/license-server/src/modules/licenses.ts serileştiricileriyle aynı) -----------------

export type Sector = 'CONSTRUCTION' | 'RETAIL_MARKET' | 'COMMERCE';
export type LicenseStatus = 'active' | 'suspended' | 'revoked';

export interface Customer {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: string;
}

export interface License {
  id: string;
  customerId: string;
  customer?: string;
  kind: 'commercial' | 'trial' | 'demo';
  status: LicenseStatus;
  sectors: Sector[];
  deviceLimit: number;
  companyLimit: number;
  deviceIdleDays: number;
  validUntil: string;
  leaseDays: number;
  graceDays: number;
  maxActivations: number;
  offlineAllowed: boolean;
  codePrefix: string;
  transfersUsed: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  activeActivations?: number;
  reportedDevices?: number;
  flagged?: boolean;
}

export interface Activation {
  id: string;
  licenseId: string;
  installationId: string;
  fingerprintPrefix: string;
  appVersion: string;
  status: 'active' | 'deactivated';
  offline: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIp: string | null;
  reportedDevices: number;
  reportedCompanies: number;
  fingerprintChanges: number;
  flagged: boolean;
  flagReason: string | null;
  deactivatedAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  adminId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  meta: unknown;
}

export interface Dashboard {
  customers: number;
  licenses: Partial<Record<LicenseStatus, number>>;
  activations: { active: number; flagged: number; reportedDevices: number };
  expiringIn30Days: number;
}
