import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withContext } from '../src/db/client';
import { DEMO_EMAIL, seedDemo } from '../src/db/demo';
import { runMigrations } from '../src/db/migrate';
import { databaseNameOf, resetSchema } from '../src/db/reset';
import { projectsSummary } from '../src/modules/projects/reports';

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

  it('seedDemo: şantiye projeleri (WBS, bütçe revizyonları, ilerleme, etiketli maliyet) ve defter mutabakatı', async () => {
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    let ids: { uid: string; oid: string; cid: string };
    try {
      const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
      expect(await q(`select kind, status, code from projects order by code`)).toEqual([
        { kind: 'own', status: 'active', code: 'PRJ-0001' },
        { kind: 'contract', status: 'active', code: 'PRJ-0002' },
      ]);
      // İşveren cari yalnızca sözleşmeli projede; ağaç derinliği (en derin düğüm 2. düzey) ve düğüm sayısı
      expect((await q(`select count(*)::int as n from projects where kind = 'contract' and client_party_id is not null`))[0].n).toBe(1);
      expect((await q(`select count(*)::int as n from project_wbs`))[0].n).toBe(12);
      // Güneş Sitesi: rev. 1 yerine geçildi, rev. 2 yürürlükte; Kuzey Villa: rev. 1 yürürlükte
      expect(await q(`select p.code, b.revision_no as rev, b.status from project_budgets b join projects p on p.id = b.project_id order by p.code, b.revision_no`)).toEqual([
        { code: 'PRJ-0001', rev: 1, status: 'superseded' },
        { code: 'PRJ-0001', rev: 2, status: 'approved' },
        { code: 'PRJ-0002', rev: 1, status: 'approved' },
      ]);
      // İlerleme geçmişi: aynı iş kalemi için birden çok tarihli kayıt (en son kayıt geçerli)
      expect((await q(`select count(*)::int as n from (select wbs_id from project_progress group by wbs_id having count(*) > 1) x`))[0].n).toBeGreaterThan(0);
      // Etiket dört kaynaktan da gelir: elle yevmiye, fatura, stok sarfı ve kasa/banka
      const sources = (await q(`select distinct coalesce(je.source_type, 'manual') as src from journal_lines jl join journal_entries je on je.id = jl.entry_id where jl.project_id is not null`)).map((r) => r.src as string);
      expect(sources).toEqual(expect.arrayContaining(['manual', 'invoice', 'treasury']));
      expect((await q(`select count(*)::int as n from stock_movements where project_id is not null`))[0].n).toBeGreaterThanOrEqual(4);
      // Taşeron (B2): 1 sözleşme (yürürlükte, onaylı revizyon), BOQ, 1 kaydedilmiş + 1 taslak hakediş, hakediş yevmiyesi maliyet kodlu
      expect(await q(`select direction, status, count(*)::int as n from progress_payments group by direction, status order by direction, status`)).toEqual([
        { direction: 'payable', status: 'draft', n: 1 },
        { direction: 'payable', status: 'posted', n: 1 },
        { direction: 'receivable', status: 'draft', n: 1 },
        { direction: 'receivable', status: 'posted', n: 1 },
      ]);
      expect((await q(`select count(*)::int as n from subcontracts where status = 'active'`))[0].n).toBe(2);
      expect((await q(`select count(*)::int as n from subcontracts where direction = 'receivable'`))[0].n).toBe(1);
      expect((await q(`select count(*)::int as n from journal_entries where source_type = 'progress_payment'`))[0].n).toBe(2);
      expect((await q(`select count(*)::int as n from journal_lines jl join cost_codes c on c.id = jl.cost_code_id where c.kind = 'subcontract' and jl.project_id is not null`))[0].n).toBeGreaterThan(0);
      expect((await q(`select coalesce(sum(amount), 0)::int as n from subcontract_advances`))[0].n).toBe(160000);
      // Satın alma: 2 talep (1 siparişe dönüşmüş, 1 onayda), RFQ 2 teklif, verilmiş sipariş ve kısmi mal kabul
      expect(await q(`select status, count(*)::int as n from purchase_requests group by status order by status`)).toEqual([
        { status: 'ordered', n: 1 },
        { status: 'submitted', n: 1 },
      ]);
      expect((await q(`select count(*)::int as n from rfq_offers`))[0].n).toBe(2);
      expect((await q(`select status from purchase_orders`)).map((r) => r.status)).toEqual(['issued']);
      expect((await q(`select count(*)::int as n from po_receipts where status = 'posted'`))[0].n).toBe(1);
      // Gayrimenkul: 24 birim; sözleşmeler: yürürlükte, teslim, fesih, taslak; 380 bakiyesi yalnızca yürürlükteki sözleşmedir
      expect((await q(`select status, count(*)::int as n from real_estate_units group by status order by status`))).toEqual([
        { status: 'available', n: 21 },
        { status: 'handed_over', n: 1 },
        { status: 'reserved', n: 1 },
        { status: 'sold', n: 1 },
      ]);
      expect((await q(`select status, count(*)::int as n from sales_contracts group by status order by status`))).toEqual([
        { status: 'active', n: 1 },
        { status: 'draft', n: 1 },
        { status: 'handed_over', n: 1 },
        { status: 'terminated', n: 1 },
      ]);
      expect((await q(`select count(*)::int as n from fee_schedules`))[0].n).toBe(3);
      expect((await q(`select count(*)::int as n from sales_installments where kind = 'fee'`))[0].n).toBe(1);
      expect((await q(`select count(*)::int as n from cash_forecast_items`))[0].n).toBe(2);
      expect((await q(`select count(*)::int as n from sales_writeoffs`))[0].n).toBe(4); // fesihte kapatılan taksitler
      expect((await q(`select coalesce(sum(credit_base - debit_base), 0)::int as n from journal_lines jl join accounts a on a.id = jl.account_id where a.code = '380'`))[0].n).toBe(
        Math.round(Number((await q(`select coalesce(sum(price * activation_fx), 0) as v from sales_contracts where status = 'active'`))[0].v)),
      );
      // Kalem etiketsiz proje satırı (iş kalemine atanmamış) ve projesiz maliyet demo'da bilerek bulunur
      expect((await q(`select count(*)::int as n from journal_lines where project_id is not null and wbs_id is null and debit_base > 0`))[0].n).toBeGreaterThan(0);
      ids = (await q(`select u.id as uid, u.organization_id as oid, c.id as cid from users u join companies c on c.organization_id = u.organization_id where u.email = $1`, [DEMO_EMAIL]))[0];
    } finally {
      await c.end();
    }
    const handle = createDb(appUrl);
    try {
      const s = await withContext(handle.db, { userId: ids.uid, orgId: ids.oid, companyId: ids.cid }, (tx) => projectsSummary(tx, '2099-12-31'));
      expect(s.projects).toHaveLength(2);
      // Proje raporlarının toplamı (iş kalemi satırları) = defterde projeye etiketli maliyet; projeli + projesiz = defter maliyet tarafı
      expect(s.totals.actual).toBe(s.allocatedCost);
      expect(Number(s.allocatedCost)).toBeGreaterThan(0);
      expect(Number(s.unallocatedCost)).toBeGreaterThan(0);
      expect(Number(s.allocatedCost) + Number(s.unallocatedCost)).toBeCloseTo(Number(s.ledgerCost), 2);
      // En az bir iş kalemi/proje bütçeyi aşıyor (sapma eksi) ve en az birinde gelir etiketi var
      expect(s.projects.some((p) => Number(p.variance) < 0)).toBe(true);
      expect(s.projects.some((p) => Number(p.revenue) > 0)).toBe(true);
    } finally {
      await handle.close();
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
    // Lisans durumu sıfırlamadan sağ çıkar: aynı kurulum kimliği ve kira (demo örneği yeniden etkinleştirme istemez)
    const c4 = new pg.Client({ connectionString: ownerUrl });
    await c4.connect();
    let saved: { installation_id: string; lease_token: string };
    try {
      await c4.query(
        `insert into license_state (id, installation_id, public_key, private_key_pem, lease_token, high_water) values (1, gen_random_uuid(), 'pub', 'pem', 'erp1.k.p.s', 12345)`,
      );
      saved = (await c4.query(`select installation_id, lease_token from license_state`)).rows[0];
    } finally {
      await c4.end();
    }
    const again = cli(['reset', `--confirm=${dbName}`]);
    expect(again.code, again.out).toBe(0);
    const c5 = new pg.Client({ connectionString: ownerUrl });
    await c5.connect();
    try {
      const row = (await c5.query(`select installation_id, lease_token, high_water from license_state`)).rows[0];
      expect(row.installation_id).toBe(saved.installation_id);
      expect(row.lease_token).toBe('erp1.k.p.s');
      expect(Number(row.high_water)).toBe(12345);
    } finally {
      await c5.end();
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
