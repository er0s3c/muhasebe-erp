import { createHash } from 'node:crypto';

/**
 * Sunucu parmak izi: ana makine kimliği (`machine-id`) ve PostgreSQL küme kimliği (`system_identifier`) birleşimi.
 * Veritabanı kopyalanıp başka bir makineye taşınırsa `machine-id` değişir; aynı makinede veritabanı yeniden
 * kurulursa `system_identifier` değişir. Ham kimlikler dışarı çıkmaz, yalnızca özet gönderilir.
 */
export function computeFingerprint(machineId: string | null | undefined, dbSystemId: string): string {
  const machine = (machineId ?? '').trim().toLowerCase();
  return createHash('sha256').update(`erp-fp-v1|${machine}|${dbSystemId.trim()}`).digest('hex');
}
