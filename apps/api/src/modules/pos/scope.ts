import { sql } from 'drizzle-orm';

/** Reuse the POS session/till boundary in shared record tools and exports. */
export function posSaleScope(userId: string | undefined, canManage: boolean, alias: string) {
  if (canManage) return sql`true`;
  if (!userId) return sql`false`;
  return sql`exists(select 1 from pos_sessions ps join pos_tills pt on pt.id=ps.till_id
    where ps.id=${sql.identifier(alias)}.session_id and ps.user_id=${userId}::uuid
      and pt.assigned_user_ids @> ${JSON.stringify([userId])}::jsonb)`;
}
