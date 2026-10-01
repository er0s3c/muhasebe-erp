import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Queryable } from '../../db/client';
import { securityEvents } from '../../db/schema';

export type SecurityEventName =
  | 'login_succeeded'
  | 'login_failed'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'email_verified'
  | 'refresh_reuse_detected'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_reset'
  | 'mfa_recovery_used'
  | 'mfa_recovery_regenerated'
  | 'mfa_failed'
  | 'update_requested'
  | 'member_added'
  | 'member_role_changed'
  | 'member_removed'
  | 'license_activated'
  | 'license_offline_activated'
  | 'license_refreshed'
  | 'license_deactivated'
  | 'device_registered'
  | 'device_revoked'
  | 'device_renamed'
  | 'device_limit_reached';

/**
 * Güvenlik olayını kaydeder; kayıt hatası asıl işlemi bozmaz (yalnızca günlüğe düşer). Parola, jeton ve
 * benzeri gizli değerler asla `meta` içine konmaz.
 */
export async function recordSecurityEvent(
  db: Queryable,
  log: FastifyBaseLogger,
  req: FastifyRequest,
  e: { event: SecurityEventName; organizationId?: string | null; userId?: string | null; email?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      event: e.event,
      organizationId: e.organizationId ?? null,
      userId: e.userId ?? null,
      email: e.email ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      meta: e.meta ?? null,
    });
  } catch (err) {
    log.error({ err, event: e.event }, 'güvenlik olayı kaydedilemedi');
  }
}
