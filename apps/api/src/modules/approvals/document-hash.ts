import { createHash } from 'node:crypto';

/** Alan sırası değişse de aynı içerik aynı özet olur; dizi sırası belge satır sırasıdır. */
export function canonicalDocument(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDocument).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalDocument(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const documentHash = (snapshot: Record<string, unknown>) =>
  createHash('sha256').update(canonicalDocument(snapshot)).digest('hex');
