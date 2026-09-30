import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { DEMO_EMAIL, seedDemo } from '../src/db/demo';
import { runMigrations } from '../src/db/migrate';
import { databaseNameOf, resetSchema } from '../src/db/reset';

const ownerTestUrl = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';
const appTestUrl = process.env.DATABASE_URL!;
const dbName = `erp_demo_test_${randomUUID().slice(0, 8)}`;
const swap = (url: string, name: string) => url.replace(/\/[^/]*$/, `/${name}`);
const ownerUrl = swap(ownerTestUrl, dbName);
const appUrl = swap(appTestUrl, dbName);

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: swap(ownerTestUrl, 'postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Operatör aracını gerçek bir süreç olarak çalıştırır (kabuktaki gibi). */
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/demo-cli.ts', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: appUrl, MIGRATION_DATABASE_URL: ownerUrl, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`CREATE DATABASE "${dbName}" OWNER erp`);
    await c.query(`GRANT CONNECT ON DATABASE "${dbName}" TO erp_app`);
  });
  await runMigrations(ownerUrl);
});

afterAll(async () => {
  await admin((c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
});

describe('demo aracı', () => {
  it('databaseNameOf bağlantı adresinden veritabanı adını okur', () => {
    expect(databaseNameOf('postgres://erp:p%40ss@host:5432/erp_demo')).toBe('erp_demo');
    expect(() => databaseNameOf('postgres://erp:x@host:5432/')).toThrow();
  });

  it('seedDemo: demo verisini uygulama rolüyle yükler, dengeli ve mutabık; ikinci çağrı dokunmaz', async () => {
    const handle = createDb(appUrl);
    try {
      const logs: string[] = [];
      expect(await seedDemo(handle.db, (m) => logs.push(m))).toBe(true);
      expect(logs.join('\n')).toContain(DEMO_EMAIL);
      expect(await seedDemo(handle.db, () => {})).toBe(false);
    } finally {
      await handle.close();
    }
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      const q = async (sql: string) => (await c.query(sql)).rows[0];
      // Her fiş kendi içinde dengeli (çift taraflı kayıt)
      expect((await q(`select count(*)::int as n from (select entry_id from journal_lines group by entry_id having sum(debit_base) <> sum(credit_base)) x`)).n).toBe(0);
      // Stok hareketleri var ve demo kullanıcıları doğrulanmış (arayüzde "e-postanızı doğrulayın" uyarısı çıkmaz)
      expect((await q(`select count(*)::int as n from stock_movements`)).n).toBeGreaterThan(10);
      expect((await q(`select count(*)::int as n from users where email like '%@ornek.local' and email_verified_at is null`)).n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('CLI reset: onay yoksa ya da ad yanlışsa silmez', async () => {
    const before = await admin(async () => {
      const c = new pg.Client({ connectionString: ownerUrl });
      await c.connect();
      try {
        return (await c.query(`select count(*)::int as n from users`)).rows[0].n as number;
      } finally {
        await c.end();
      }
    });
    expect(before).toBeGreaterThan(0);
    for (const args of [['reset'], ['reset', '--confirm=baska_veritabani']]) {
      const r = cli(args);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('Yıkıcı işlem');
    }
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      expect((await c.query(`select count(*)::int as n from users`)).rows[0].n).toBe(before);
    } finally {
      await c.end();
    }
  });

  it('CLI: üretim modunda ALLOW_DEMO olmadan hiçbir demo komutu çalışmaz; farklı veritabanları reddedilir', () => {
    const prod = { NODE_ENV: 'production', JWT_SECRET: 'Zk9xQ2mVb7Lw4Rt8Yp3Hc6Nd1Fs5Ja0Ue' };
    for (const args of [['seed'], ['reset', `--confirm=${dbName}`]]) {
      const r = cli(args, prod);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('ALLOW_DEMO=true');
    }
    const mismatch = cli(['reset', `--confirm=${dbName}`], { DATABASE_URL: swap(appUrl, 'erp_test') });
    expect(mismatch.code, mismatch.out).toBe(1);
    expect(mismatch.out).toContain('farklı veritabanlarını');
    expect(cli(['bilinmeyen']).code).toBe(1);
  });

  it('CLI reset --confirm=<ad>: şemayı siler, migration + demo verisini yeniden yükler', async () => {
    // Araya sahte veri koy; sıfırlama bunu silmeli
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      await c.query(`insert into organizations (id, name) values (gen_random_uuid(), 'Silinecek Kuruluş')`);
    } finally {
      await c.end();
    }
    const r = cli(['reset', `--confirm=${dbName}`]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Demo verisi yüklendi');
    const c2 = new pg.Client({ connectionString: ownerUrl });
    await c2.connect();
    try {
      expect((await c2.query(`select count(*)::int as n from organizations where name = 'Silinecek Kuruluş'`)).rows[0].n).toBe(0);
      expect((await c2.query(`select count(*)::int as n from users where email = $1`, [DEMO_EMAIL])).rows[0].n).toBe(1);
    } finally {
      await c2.end();
    }
    // resetSchema yeniden çağrılabilir (idempotent) ve boş şema bırakır
    await resetSchema(ownerUrl);
    const c3 = new pg.Client({ connectionString: ownerUrl });
    await c3.connect();
    try {
      expect((await c3.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`)).rows[0].n).toBe(0);
    } finally {
      await c3.end();
    }
  });
});
