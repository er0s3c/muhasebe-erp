import type { Queryable } from './db/client';
import { auditLog } from './db/schema';

export interface AuditEntry {
  actor: 'admin' | 'cli' | 'installation' | 'system';
  adminId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  meta?: unknown;
}

/** Denetim kaydı (yalnızca eklenir). Gizli değerler (kodlar, parolalar, sırlar) `meta`'ya KONMAZ. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.insert(auditLog).values({
    actor: e.actor,
    adminId: e.adminId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    ip: e.ip ?? null,
    meta: e.meta ?? null,
  });
}
