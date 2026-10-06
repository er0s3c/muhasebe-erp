import { DAY_MS, type Lease } from './claims';

export type LicenseState = 'unlicensed' | 'active' | 'grace' | 'restricted';
export type RestrictedReason =
  | 'expired'
  | 'revoked'
  | 'suspended'
  | 'fingerprint_mismatch'
  | 'installation_mismatch'
  | 'clock_rollback';

export interface LeaseEvaluation {
  state: LicenseState;
  reason?: RestrictedReason;
  /** Tam işlevli (uyarısız) olunan son an. */
  activeUntil?: number;
  /** Tolerans dahil tam işlevli olunan son an; sonrası salt-okunur. */
  graceUntil?: number;
  /** Abonelik bitişine kalan gün (negatifse geçmiş). */
  daysUntilExpiry?: number;
  /** Abonelik 14 gün içinde bitiyor (uyarı bandı). */
  expiresSoon: boolean;
}

/** Saat geri alma tespitinde tolerans (küçük saat ayarları ve NTP düzeltmeleri normaldir). */
export const CLOCK_SKEW_MS = 10 * 60 * 1000;
export const EXPIRY_WARNING_DAYS = 14;

export interface EvaluateContext {
  now: number;
  /** Bu kurulumda görülen en yüksek zaman (yerel saat ve satıcı `serverTime`'ı). */
  highWater: number;
  installationId: string;
  fingerprint: string;
}

/**
 * Kirayı değerlendirir (saf, yan etkisiz): hangi durumda olunduğunu ve nedenini söyler.
 * Sıra önemlidir: kimlik/bağlama ve saat denetimleri süre hesabından önce gelir.
 */
export function evaluateLease(lease: Lease | null, ctx: EvaluateContext): LeaseEvaluation {
  if (!lease) return { state: 'unlicensed', expiresSoon: false };
  const restricted = (reason: RestrictedReason): LeaseEvaluation => ({ state: 'restricted', reason, expiresSoon: false });

  if (lease.status === 'revoked') return restricted('revoked');
  if (lease.status === 'suspended') return restricted('suspended');
  if (lease.installationId !== ctx.installationId) return restricted('installation_mismatch');
  if (lease.fingerprint !== ctx.fingerprint) return restricted('fingerprint_mismatch');
  if (ctx.now + CLOCK_SKEW_MS < ctx.highWater) return restricted('clock_rollback');

  const activeUntil = Math.min(lease.leaseUntil, lease.validUntil);
  const graceUntil = activeUntil + lease.graceDays * DAY_MS;
  const daysUntilExpiry = Math.floor((lease.validUntil - ctx.now) / DAY_MS);
  const base = { activeUntil, graceUntil, daysUntilExpiry, expiresSoon: daysUntilExpiry <= EXPIRY_WARNING_DAYS };

  if (ctx.now <= activeUntil) return { state: 'active', ...base };
  if (ctx.now <= graceUntil) return { state: 'grace', ...base };
  return { state: 'restricted', reason: 'expired', ...base };
}

/** En yüksek görülen zaman: geri gitmez. */
export const nextHighWater = (previous: number, now: number, serverTime?: number): number => Math.max(previous, now, serverTime ?? 0);
