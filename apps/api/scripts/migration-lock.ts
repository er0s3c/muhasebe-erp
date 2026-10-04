/**
 * Yayımlanmış migration'ların kilidi: her dosyanın SHA-256 özeti ve günlükteki (`_journal.json`) `tag`/`when` değeri
 * `test/fixtures/migration-lock.json` dosyasına yazılır. `test/migration-lock.test.ts` kilitli bir dosyanın sonradan
 * değiştirilmesini yakalar (yayımlanmış migration düzenlenirse eski sürümden yükseltme bozulur).
 *
 * Kullanım (yeni migration'lar yayımlanmadan önce, yalnızca YENİ dosyaları ekler; mevcut kayıtlara dokunmaz):
 *   npm run db:lock -w @erp/api
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockEntry, type MigrationLock } from '../test/migration-lock-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'test/fixtures/migration-lock.json');
const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };

const readLock = (): MigrationLock => {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as MigrationLock;
  } catch {
    return {};
  }
};
const lock = readLock();
let added = 0;
for (const e of journal.entries) {
  if (lock[e.tag]) continue;
  lock[e.tag] = lockEntry(root, e);
  added++;
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`${added} migration kilide eklendi (${Object.keys(lock).length} toplam).`);
