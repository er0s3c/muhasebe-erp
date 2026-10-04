import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MigrationLock = Record<string, { sha256: string; when: number }>;

/** Satır sonları normalleştirilerek (Windows'ta autocrlf ile klonlanan depoda da aynı özet) dosya özeti. */
export function lockEntry(root: string, e: { tag: string; when: number }) {
  const sql = readFileSync(join(root, 'drizzle', `${e.tag}.sql`), 'utf8').replace(/\r\n/g, '\n');
  return { sha256: createHash('sha256').update(sql).digest('hex'), when: e.when };
}
