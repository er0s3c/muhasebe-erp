import { sql } from 'drizzle-orm';
import type { Role } from '@erp/shared';

/** Operators work on their assignment; all other read roles retain the company view. */
export function productionOrderScope(role: Role | undefined, userId: string | undefined, alias: string) {
  if (!role) return sql`false`;
  if (role !== 'operator') return sql`true`;
  if (!userId) return sql`false`;
  return sql`coalesce(${sql.identifier(alias)}.config->>'assignedUserId',${sql.identifier(alias)}.created_by::text)=${userId}`;
}

export { LEATHER_CONFIDENTIAL_COST_KEYS, LEATHER_CONFIDENTIAL_TRACE_KEYS, redactLeatherCosts } from './access';
