import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';

/**
 * Boşluksuz numara: satır kilidi işlem bitene kadar tutulur; işlem geri alınırsa
 * artış da geri alınır, dolayısıyla numara atlanmaz.
 */
export async function nextNumber(
  tx: Tx,
  companyId: string,
  key: string,
  year: number,
): Promise<number> {
  const result = await tx.execute<{ value: number }>(sql`
    insert into document_sequences (company_id, key, year, next_value)
    values (${companyId}, ${key}, ${year}, 2)
    on conflict (company_id, key, year)
    do update set next_value = document_sequences.next_value + 1
    returning next_value - 1 as value`);
  const row = result.rows[0];
  if (!row) throw new Error('numara üretilemedi');
  return Number(row.value);
}

export function formatDocumentNumber(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
}
