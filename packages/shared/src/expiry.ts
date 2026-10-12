import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';

/** Son kullanma riski (öneri 47): süresi geçmiş, kritik (≤ kritik gün) ve uyarı (ufuk içinde) partiler. */
export type ExpiryState = 'expired' | 'critical' | 'warning';
export function expiryState(daysLeft: number, criticalDays: number): ExpiryState {
  if (daysLeft < 0) return 'expired';
  return daysLeft <= criticalDays ? 'critical' : 'warning';
}
export const EXPIRY_ADVICE: Record<ExpiryState, string> = {
  expired: 'Partiyi blokeye alın; imha, iade ya da yeniden değerlendirme kararı verin.',
  critical: 'Önce bu partiyi sevk edin ya da sarf edin; gerekirse indirimli satış planlayın.',
  warning: 'FEFO sırasında öncelikli; satın alma ve üretim planında dikkate alın.',
};
export const expiryRiskQuerySchema = z
  .object({
    horizonDays: z.coerce.number().int().min(1).max(730).default(60),
    criticalDays: z.coerce.number().int().min(0).max(365).default(15),
    warehouseId: uuid.optional(),
  })
  .refine((v) => v.criticalDays <= v.horizonDays, { message: 'Kritik gün ufuktan büyük olamaz', path: ['criticalDays'] });
export const lotExpiryUpdateSchema = z.object({
  expiryDate: isoDate.nullable(),
  reason: z.string().trim().min(3).max(300),
});
