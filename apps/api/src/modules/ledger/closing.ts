import { sql, type SQL } from 'drizzle-orm';
import { YEAR_END_SOURCE_TYPES } from '@erp/shared';

const SOURCES = sql.join(YEAR_END_SOURCE_TYPES.map((s) => sql`${s}`), sql`, `);

/**
 * Yıl sonu kapanış/devir fişlerini (ve bunların ters kayıtlarını; kaynak türü aynen taşınır) dışarıda bırakan SQL koşulu.
 * `alias` yevmiye başlığı (journal_entries) takma adıdır. Gelir tablosu, proje maliyeti, konsolidasyon, yönetici özeti gibi
 * "dönem hareketi" raporları kapanışla sıfırlanmasın diye bunu kullanır; mizan ve hesap ekstresi dahil eder (seçenekle hariç).
 */
export function notClosingEntry(alias = 'je'): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.source_type is null or ${a}.source_type not in (${SOURCES}))`;
}

/** `exclude` doğruysa kapanış fişlerini dışlar, değilse her zaman doğru. */
export function closingFilter(exclude: boolean | undefined, alias = 'e'): SQL {
  return exclude ? notClosingEntry(alias) : sql`true`;
}
