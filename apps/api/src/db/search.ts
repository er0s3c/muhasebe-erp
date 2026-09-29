import { sql, type SQL } from 'drizzle-orm';

/** ICU Türkçe sıralama/karşılaştırma (Ç, Ğ, İ, Ö, Ş, Ü doğru yerde); PostgreSQL ICU ile derlenmiş olmalı. */
export const TR = sql.raw('"tr-TR-x-icu"');

/**
 * Türkçe büyük/küçük harf kuralıyla (İ→i, I→ı) "içeriyor" araması; LIKE joker karakterlerinden kaçılır.
 * `columns` güvenilir (sabit) SQL ifadeleridir, kullanıcı girdisi değildir.
 */
export function trContains(columns: readonly string[], text: string): SQL {
  const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  const needle = sql`lower(${like}::text collate ${TR})`;
  const hits = columns.map((col) => sql`lower(${sql.raw(col)} collate ${TR}) like ${needle}`);
  return sql`(${sql.join(hits, sql` or `)})`;
}
