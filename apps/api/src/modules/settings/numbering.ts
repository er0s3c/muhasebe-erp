import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { documentNumberPreview, documentSeriesOption, operationsSettingsSchema } from '@erp/shared';

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

/** Aynı sayaç satırı/kilidi kullanılır; yeni önek geçmiş belge ve sayaç değerlerini değiştirmez. */
export async function nextDocumentNumber(tx: Tx, companyId: string, key: string, year: number, fallbackPrefix: string): Promise<string> {
  const row = (await tx.execute<{ settings: unknown }>(sql`select settings from company_operations_settings where company_id=${companyId}`)).rows[0];
  const settings = operationsSettingsSchema.parse(row?.settings ?? {});
  const option = documentSeriesOption(settings.documentSeries, key, fallbackPrefix);
  return documentNumberPreview(option, year, await nextNumber(tx, companyId, key, year));
}
