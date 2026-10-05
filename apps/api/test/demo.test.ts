import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Demo zaman çizelgesi "bugün"e göre kurulur (modül yüklenirken okunur): beklenen sayılar için tarih sabitlenir (yalnızca Date taklit
// edilir; zamanlayıcılar gerçek kalır). Bu ayar içe aktarmalardan önce çalışır.
const PINNED_NOW = '2026-10-05T09:00:00Z';
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-05T09:00:00Z'));
});
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

/** Tohumlamanın her tarihte çalıştığını gösteren "bugün"ler: gece yarısı sınırı (Lefkoşa saatiyle ertesi gün), ay başı, yıl sonu ve yıl başı. */
const ROBUST_DATES = ['2026-10-02T22:00:00Z', '2026-12-20T10:00:00Z', '2027-01-02T10:00:00Z', '2027-03-01T10:00:00Z'];
const robustDbs = ROBUST_DATES.map((_, i) => `${dbName}_d${i}`);
const failDb = `${dbName}_fail`;

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
    cwd: fileURLToPath(new URL('..', import.meta.url)),
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
  // Farklı "bugün"lerde tohumlama denemesi için aynı şemanın kopyaları (şablon bağlantısızken kopyalanır)
  await admin(async (c) => {
    for (const name of [...robustDbs, failDb]) {
      await c.query(`CREATE DATABASE "${name}" OWNER erp TEMPLATE "${dbName}"`);
      await c.query(`GRANT CONNECT ON DATABASE "${name}" TO erp_app`);
    }
  });
}, 240_000);

afterAll(async () => {
  vi.useRealTimers();
  await admin(async (c) => {
    for (const name of [dbName, ...robustDbs, failDb]) await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}, 240_000);

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
      // Puantaj: kurgusal personel, geçen ayın kayıtları (işçilik etiketli) ve kapalı ay
      expect((await q(`select count(*)::int as n from employees`)).n).toBe(4);
      expect((await q(`select count(*)::int as n from attendance_entries`)).n).toBeGreaterThanOrEqual(4 * 28);
      expect((await q(`select count(*)::int as n from attendance_entries where project_id is not null and wbs_id is not null and cost_code_id is not null`)).n).toBeGreaterThan(40);
      expect((await q(`select count(*)::int as n from attendance_months where status = 'closed'`)).n).toBe(1);
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
      // Taşerona malzeme: bir verme kaydı; ikinci (taslak) hakedişte bakiye kadar mahsup önerilir
      expect((await q(`select count(*)::int as n from subcontract_material_issues`))[0].n).toBe(1);
      expect(Number((await q(`select coalesce(sum(material), 0)::text as m from progress_payments where status = 'draft'`))[0].m)).toBeGreaterThan(0);
      // Değişiklik emirleri: taşeronda uygulanmış (+15.000, +15 gün), işverende işveren kabulü bekleyen
      expect(await q(`select direction, status, amount_delta::int as delta, time_extension_days as days from variation_orders order by direction`)).toEqual([
        { direction: 'payable', status: 'applied', delta: 15000, days: 15 },
        { direction: 'receivable', status: 'awaiting_client', delta: 180000, days: 20 },
      ]);
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
      // Fesihte kapatılan taksitler; tarihe (demo kurlarına) bağlı olarak ek olarak FIFO havuzunun bıraktığı kur artığı kalemi
      // (kalem para biriminde 0, defter tutarı 1 TL'nin altında) olabilir
      expect((await q(`select count(*) filter (where amount > 0)::int as n, count(*) filter (where amount = 0 and amount_base >= 1)::int as big from sales_writeoffs`))[0]).toEqual({ n: 4, big: 0 });
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

  it('seedDemo herhangi bir tarihte tek işlemde ve dengeli yüklenir (fesih kur artığı, yıl başı, gece yarısı)', async () => {
    expect(new Date().toISOString()).toBe(new Date(PINNED_NOW).toISOString());
    for (const [i, now] of ROBUST_DATES.entries()) {
      vi.setSystemTime(new Date(now));
      vi.resetModules();
      const mod = (await import('../src/db/demo')) as typeof import('../src/db/demo');
      const { createDb: create } = (await import('../src/db/client')) as typeof import('../src/db/client');
      const handle = create(swap(appTestUrl, robustDbs[i]!));
      try {
        expect(await mod.seedDemo(handle.db, () => {}), now).toBe(true);
      } finally {
        await handle.close();
      }
      const c = new pg.Client({ connectionString: swap(ownerTestUrl, robustDbs[i]!) });
      await c.connect();
      try {
        const q = async (text: string) => (await c.query(text)).rows[0];
        expect((await q(`select count(*)::int as n from (select entry_id from journal_lines group by entry_id having sum(debit_base) <> sum(credit_base)) x`)).n, now).toBe(0);
        expect((await q(`select count(*)::int as n from sales_contracts where status = 'terminated'`)).n, now).toBe(1);
        // Hiçbir belge "bugün"den sonraya yazılmaz
        expect((await q(`select count(*)::int as n from journal_entries where entry_date > '${now.slice(0, 10)}'::date + 1`)).n, now).toBe(0);
      } finally {
        await c.end();
      }
    }
    vi.setSystemTime(new Date(PINNED_NOW));
  }, 180_000);

  it('seedDemo bir adımda hata verirse hiçbir şey bırakmaz (tek işlem); sorun giderilince yeniden çalışır', async () => {
    const url = swap(ownerTestUrl, failDb);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      // Tohumlamanın sonlarına doğru (puantaj ayı kapatma) yapay hata
      await c.query(`create function demo_fail() returns trigger language plpgsql as $$ begin raise exception 'demo yapay hata'; end $$`);
      await c.query(`create trigger demo_fail before insert on attendance_months for each row execute function demo_fail()`);
      const handle = createDb(swap(appTestUrl, failDb));
      try {
        await expect(seedDemo(handle.db, () => {})).rejects.toThrow();
        expect((await c.query(`select count(*)::int as n from organizations`)).rows[0].n).toBe(0);
        expect((await c.query(`select count(*)::int as n from users`)).rows[0].n).toBe(0);
        expect((await c.query(`select count(*)::int as n from journal_entries`)).rows[0].n).toBe(0);
        await c.query(`drop trigger demo_fail on attendance_months`);
        expect(await seedDemo(handle.db, () => {})).toBe(true);
      } finally {
        await handle.close();
      }
    } finally {
      await c.end();
    }
  }, 60_000);

  it('seedDemo: tamamlayıcı modüller (satış, İK, portföy, gider, rehber, ithalat, onay) dolu ve defter dengeli', async () => {
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      const q = async (sql: string) => (await c.query(sql)).rows;
      const n = async (table: string, where = 'true') => (await q(`select count(*)::int as n from ${table} where ${where}`))[0].n as number;
      // Tüm fişler (yeni modüllerin otomatik yevmiyeleri dahil) dengeli
      expect(await n(`(select entry_id from journal_lines group by entry_id having sum(debit_base) <> sum(credit_base)) x`)).toBe(0);
      // Satış: fiyat listeleri (varsayılan satış/alış), cariye özel fiyat, teklif/sipariş durumları, toplu faturalama
      expect(await n('price_lists')).toBe(3);
      expect(await n('price_lists', `is_default and kind = 'sales'`)).toBe(1);
      expect(await n('party_prices')).toBeGreaterThanOrEqual(3);
      expect((await q(`select kind, status, count(*)::int as n from sales_orders group by kind, status order by kind, status`)).map((r) => `${r.kind}:${r.status}:${r.n}`)).toEqual(
        expect.arrayContaining(['order:confirmed:2', 'order:cancelled:1', 'order:draft:1', 'quote:converted:1', 'quote:sent:1', 'quote:rejected:1', 'quote:draft:1']),
      );
      expect(await n('invoice_batches')).toBe(1);
      // Bu ayın satışları dolu (gösterge panosu): ay başından bugüne kaydedilmiş satış faturası
      expect(await n('invoices', `type = 'sales' and status = 'posted' and invoice_date >= date_trunc('month', current_date)`)).toBeGreaterThan(0);
      // İK: onaylı bordro (4 satır), avanslar, net ödemeler, sosyal güvenlik bildirimi, yabancı işçi belgeleri (yenilenen + dolmuş)
      expect(await q(`select status from payroll_runs`)).toEqual([{ status: 'approved' }]);
      expect(await n('payroll_lines')).toBe(4);
      expect(await n('employee_advances')).toBe(2);
      expect(await n('employee_salary_payments')).toBe(2);
      expect(await n('social_declarations', `status = 'finalized'`)).toBe(1);
      expect(await n('employee_social_profiles')).toBe(4);
      expect(await n('foreign_worker_docs')).toBeGreaterThanOrEqual(4);
      expect(await n('foreign_doc_renewals')).toBe(1);
      expect(await n('foreign_worker_guarantees')).toBe(1);
      // Yasal parametreler yalnızca demo değeri ve DOĞRULANMAMIŞ (bordro/bildirim "doğrulanmadı" uyarısı çıkar)
      expect(await n('payroll_params', 'verified_at is not null')).toBe(0);
      expect(await n('payroll_params', `source_note like 'Demo%'`)).toBe(await n('payroll_params'));
      // Çek/senet: durumların çeşitliliği, kalem eşleştirmesi; teminat mektupları (biri iade edilmiş)
      expect((await q(`select distinct status from cheques order by status`)).map((r) => r.status)).toEqual(expect.arrayContaining(['portfolio', 'collected', 'bounced', 'endorsed', 'issued', 'paid']));
      expect(await n('cheque_allocations')).toBeGreaterThan(0);
      expect(await n('bank_guarantees')).toBe(3);
      expect(await n('bank_guarantees', `status = 'returned'`)).toBe(1);
      // Gider kartı/fişleri (1 iptal), rehber ve ajanda, ithalat dosyaları, onay kuralları
      expect(await n('expense_cards')).toBe(4);
      expect(await n('expense_entries', `status = 'cancelled'`)).toBe(1);
      expect(await n('directory_organizations')).toBe(4);
      expect(await n('directory_contacts')).toBe(5);
      expect(await n('agenda_items', `status = 'done'`)).toBe(1);
      expect(await n('import_files', `status = 'posted'`)).toBe(1);
      expect(await n('import_files', `status = 'draft'`)).toBe(1);
      expect(await n('approval_rules')).toBe(4);
      expect(await n('retention_releases')).toBe(1);
      // SGK numaraları şifreli saklanır (düz metin değil)
      expect(await n('employee_social_profiles', `ssn_enc is not null and ssn_enc not like '%SGK-%'`)).toBe(4);
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
