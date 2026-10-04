import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lockEntry, type MigrationLock } from './migration-lock-lib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'test/fixtures/migration-lock.json'), 'utf8')) as MigrationLock;
const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };

/**
 * Yayımlanmış migration'lar değiştirilemez (DB-6): 0037/0038 yayımdan sonra düzenlendiği için eski sürümden yükseltme bozulmuştu.
 * Kilit `npm run db:lock -w @erp/api` ile yalnızca yeni dosyaları ekleyerek güncellenir; mevcut bir kaydı değiştirmek yerine
 * yeni bir migration yazılmalıdır (docs/ARCHITECTURE.md "Migration kuralları").
 */
describe('migration kilidi', () => {
  it('kilitli her migration dosyası ve günlük kaydı (tag/when) değişmemiş', () => {
    const changed: string[] = [];
    for (const [tag, want] of Object.entries(lock)) {
      const e = journal.entries.find((j) => j.tag === tag);
      if (!e) {
        changed.push(`${tag}: günlükten çıkarılmış`);
        continue;
      }
      const got = lockEntry(root, e);
      if (got.sha256 !== want.sha256) changed.push(`${tag}: içerik değişmiş`);
      if (got.when !== want.when) changed.push(`${tag}: günlük zamanı (when) değişmiş`);
    }
    expect(changed).toEqual([]);
  });

  it('kilitli olmayan migration\'lar yalnızca sonda (yeni) ve günlükteki sıra/zaman artan', () => {
    const tags = journal.entries.map((e) => e.tag);
    const locked = tags.filter((t) => lock[t]);
    expect(tags.slice(0, locked.length)).toEqual(locked);
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.idx).toBe(i);
      expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    }
    // Günlükte olmayan .sql dosyası kalmamalı
    const files = readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''));
    expect(files.sort()).toEqual([...tags].sort());
  });

  it('kilit, depodaki en az 0078 dahil tüm yayımlanmış migration\'ları kapsar', () => {
    expect(lock['0078_year_end_rules']).toBeDefined();
  });
});
