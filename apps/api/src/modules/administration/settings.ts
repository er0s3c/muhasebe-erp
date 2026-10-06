import { sql } from 'drizzle-orm';
import { operationsSettingsSchema } from '@erp/shared';
import type { Tx } from '../../db/client';
export async function operationalSettings(tx: Tx) {
  const row = (await tx.execute<{ settings: unknown; version: number }>(sql`select settings,version from company_operations_settings`)).rows[0];
  return { settings: operationsSettingsSchema.parse(row?.settings ?? {}), version: row?.version ?? 0 };
}
