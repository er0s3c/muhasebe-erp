import { IMPORT_FIELDS, type ImportKind } from '@erp/shared';
import { foldKey } from './values';

/**
 * Sütun başlıklarından alan eşlemesi önerir. Önce tam (harf/aksan/boşluk duyarsız) eşleşme, sonra başlığın
 * alan adını içermesi. Her sütun ve her alan en çok bir kez kullanılır. Öneri yalnızca başlangıçtır;
 * kullanıcı eşlemeyi ekranda düzeltir.
 */
export function suggestMapping(kind: ImportKind, headers: readonly string[]): Record<string, number | null> {
  const fields = IMPORT_FIELDS[kind];
  const folded = headers.map(foldKey);
  const used = new Set<number>();
  const result: Record<string, number | null> = Object.fromEntries(fields.map((f) => [f.key, null]));

  for (const field of fields) {
    const wanted = new Set(field.synonyms.map(foldKey));
    const idx = folded.findIndex((h, i) => !used.has(i) && h !== '' && wanted.has(h));
    if (idx >= 0) {
      result[field.key] = idx;
      used.add(idx);
    }
  }
  for (const field of fields) {
    if (result[field.key] !== null) continue;
    const wanted = field.synonyms.map(foldKey).filter((w) => w.length >= 4);
    const idx = folded.findIndex((h, i) => !used.has(i) && h !== '' && wanted.some((w) => h.includes(w)));
    if (idx >= 0) {
      result[field.key] = idx;
      used.add(idx);
    }
  }
  return result;
}
