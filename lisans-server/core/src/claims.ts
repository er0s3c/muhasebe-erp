import { z } from 'zod';
import { SECTORS } from '@erp/shared';
import { LicenseTokenError, verifyToken, type PublicKeyring, type TokenKind } from './token';

export const DAY_MS = 24 * 60 * 60 * 1000;

const epochMs = z.number().int().min(0).max(8.64e15);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const supportedSectors = z.array(z.enum(SECTORS)).min(1).max(SECTORS.length).optional();

/** Older installations omit capabilities and retain their original sector licenses. */
export function clientSupportsSectors(licensed: readonly string[], declared?: readonly string[]): boolean {
  return licensed.every(sector => ['CONSTRUCTION', 'RETAIL_MARKET', 'COMMERCE'].includes(sector) || declared?.includes(sector));
}

export const LICENSE_KINDS = ['commercial', 'trial', 'demo'] as const;
export type LicenseKind = (typeof LICENSE_KINDS)[number];
export const LEASE_STATUSES = ['active', 'suspended', 'revoked'] as const;

/**
 * Kira (lease): satıcının imzaladığı, bir kuruluma ve sunucu parmak izine bağlı, süreli yetki belgesi.
 * `status` ≠ active ise bu bir "iptal/askı bildirimi"dir (uygulamayı hemen salt-okunura alır).
 */
export const leaseSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  typ: z.enum(['lease', 'offline-lease']),
  licenseId: z.uuid(),
  customer: z.string().min(1).max(200),
  kind: z.enum(LICENSE_KINDS),
  status: z.enum(LEASE_STATUSES),
  sectors: z.array(z.enum(SECTORS)).min(1).max(SECTORS.length),
  deviceLimit: z.number().int().min(1).max(10_000),
  companyLimit: z.number().int().min(1).max(10_000),
  /** Bu kadar gündür görülmeyen cihaz kotadan düşer. */
  deviceIdleDays: z.number().int().min(1).max(365),
  /** Abonelik bitişi. */
  validUntil: epochMs,
  /** Bu kiranın geçerliliği (≤ validUntil); sonrasında çevrimdışı tolerans başlar. */
  leaseUntil: epochMs,
  /** `leaseUntil` sonrası tam işlevli tolerans gün sayısı. */
  graceDays: z.number().int().min(0).max(90),
  issuedAt: epochMs,
  serverTime: epochMs,
  installationId: z.uuid(),
  fingerprint: hex64,
  /** Çevrimiçi: istemcinin nonce'u. Çevrimdışı: istek kodundaki requestId. */
  nonce,
  validityMode: z.enum(['lease', 'subscription']).optional(),
});
export type Lease = z.infer<typeof leaseSchema>;

export const activateRequestSchema = z.object({
  supportedSectors,
  protocolVersion: z.literal(2).optional(),
  timeNonce: nonce.optional(),
  installationId: z.uuid(),
  fingerprint: hex64,
  appVersion: z.string().max(40),
  code: z.string().min(10).max(64),
  nonce,
  ts: epochMs,
});
export type ActivateRequest = z.infer<typeof activateRequestSchema>;

export const heartbeatRequestSchema = z.object({
  supportedSectors,
  protocolVersion: z.literal(2).optional(),
  timeNonce: nonce.optional(),
  installationId: z.uuid(),
  fingerprint: hex64,
  appVersion: z.string().max(40),
  nonce,
  ts: epochMs,
  /** Yalnızca sayılar: mali/kişisel veri gönderilmez. */
  stats: z.object({
    devices: z.number().int().min(0).max(1_000_000),
    companies: z.number().int().min(0).max(1_000_000),
  }),
  /** Kurulum kitinin hedefi (uzaktan güncellemede hangi arşivin teklif edileceği); elle/eski kurulumda yoktur. */
  platform: z.enum(['linux-x64', 'win-x64']).optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const deactivateRequestSchema = z.object({
  installationId: z.uuid(),
  nonce,
  ts: epochMs,
});
export type DeactivateRequest = z.infer<typeof deactivateRequestSchema>;

export const offlineRequestSchema = z.object({
  supportedSectors,
  installationId: z.uuid(),
  fingerprint: hex64,
  appVersion: z.string().max(40),
  requestId: nonce,
  ts: epochMs,
});
export type OfflineRequest = z.infer<typeof offlineRequestSchema>;

/** Zarf + (etkinleştirmede) kurulum açık anahtarı, satıcıya giden istek gövdesi. */
export const envelopeBodySchema = z.object({
  p: z.string().min(10).max(4096),
  s: z.string().min(40).max(200),
  /** Yalnızca etkinleştirmede: sabitlenecek ham kurulum açık anahtarı. */
  pub: z.string().length(43).optional(),
});
export type EnvelopeBody = z.infer<typeof envelopeBodySchema>;

/** Kira belirtecini imza ve şema açısından doğrular (çevrimiçi ya da çevrimdışı tür). */
export function parseLeaseToken(token: string, ring: PublicKeyring): Lease {
  let lastErr: unknown;
  for (const kind of ['lease', 'offline-lease'] as const satisfies readonly TokenKind[]) {
    try {
      const payload = leaseSchema.safeParse(verifyToken(kind, token, ring));
      if (!payload.success) throw new LicenseTokenError('BAD_PAYLOAD', 'Kira içeriği geçersiz');
      // Tür hem imzada hem yükte: uyuşmazlık kurcalama sayılır.
      if (payload.data.typ !== kind) throw new LicenseTokenError('BAD_PAYLOAD', 'Kira türü uyuşmuyor');
      return payload.data;
    } catch (err) {
      // Yalnızca "yanlış tür" imza hatası diğer türü denemeyi gerektirir; öteki hatalar kesindir.
      if (err instanceof LicenseTokenError && err.code === 'BAD_SIGNATURE') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
