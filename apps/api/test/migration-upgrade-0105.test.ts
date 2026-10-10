import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { databaseNameOf } from '../src/db/reset';

interface MigrationJournal {
  version: string;
  dialect: string;
  entries: { idx: number; tag: string; when: number; [key: string]: unknown }[];
}

const sourceFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const cacheRoot = resolve(workspace, '.cache');
const folderPrefix = 'erp-upgrade-0105-';
const swapDatabase = (connectionString: string, name: string) => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Recursive cleanup is limited to the one generated, immediate child of this workspace's cache. */
async function checkedFolder(folder: string): Promise<string> {
  const root = await realpath(cacheRoot);
  const base = await realpath(workspace);
  const cacheRelative = relative(base, root);
  const target = await realpath(folder);
  if (cacheRelative === '..' || cacheRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(cacheRelative) ||
      dirname(target) !== root || !basename(target).startsWith(folderPrefix)) {
    throw new Error('Upgrade test cleanup target is outside its generated workspace directory');
  }
  return target;
}

async function dropUpgradeDatabase(admin: pg.Client, name: string, ownerUrl: string) {
  if (!/^erp_upgrade_test_[0-9a-f]{32}$/.test(name) || databaseNameOf(ownerUrl) !== name) throw new Error('Unsafe upgrade cleanup database');
  for (let attempt = 0; ; attempt++) {
    try { await admin.query(`drop database if exists "${name}"`); return; }
    catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 49) throw error;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}

async function legacySnapshot(client: pg.Client, companyId: string) {
  // Select the legacy columns explicitly: newly added nullable context must not disguise an amount change.
  const queries = {
    accounts: 'select id, code, name, type, is_postable, currency_code, is_active from accounts where company_id=$1 order by code',
    mappings: 'select id, key, account_id, updated_at::text from account_mappings where company_id=$1 order by key',
    invoice: 'select id, type, status, invoice_no, invoice_date::text, currency_code, fx_rate::text, net_total::text, vat_total::text, gross_total::text, net_total_base::text, vat_total_base::text, gross_total_base::text, journal_entry_id from invoices where company_id=$1 order by id',
    invoiceLines: 'select id, invoice_id, line_no, quantity::text, unit_price::text, vat_code, vat_rate::text, net::text, vat::text, gross::text, net_base::text, vat_base::text from invoice_lines where company_id=$1 order by line_no',
    journal: 'select id, entry_no, entry_date::text, period_id, description, status, source_type, source_id from journal_entries where company_id=$1 order by id',
    journalLines: 'select id, entry_id, line_no, account_id, currency_code, fx_rate::text, debit::text, credit::text, debit_base::text, credit_base::text, debit_reporting::text, credit_reporting::text, party_id from journal_lines where company_id=$1 order by line_no',
    fx: 'select id, rate_date::text, currency_code, quote_code, buy::text, sell::text, source from exchange_rates where company_id=$1 order by id',
    vat: 'select id, code, rate::text, valid_from::text, valid_to::text, source_note from tax_rates where company_id=$1 order by id',
  };
  const result: Record<string, pg.QueryResultRow[]> = {};
  for (const [key, query] of Object.entries(queries)) result[key] = (await client.query(query, [companyId])).rows;
  return result;
}

async function seedLegacy(client: pg.Client) {
  const ids = {
    organization: randomUUID(), user: randomUUID(), company: randomUUID(), period: randomUUID(),
    party: randomUUID(), invoice: randomUUID(), entry: randomUUID(), stockMapping: randomUUID(),
  };
  const accounts = new Map<string, string>();
  await client.query('begin');
  try {
    await client.query('insert into organizations(id,name) values($1,$2)', [ids.organization, 'Upgrade fixture organization']);
    await client.query('insert into users(id,organization_id,email,password_hash,full_name,email_verified_at) values($1,$2,$3,$4,$5,now())',
      [ids.user, ids.organization, `upgrade-${ids.user}@example.test`, 'unused upgrade fixture hash', 'Upgrade fixture owner']);
    await client.query('insert into companies(id,organization_id,name,sector,base_currency) values($1,$2,$3,$4,$5)',
      [ids.company, ids.organization, 'Populated legacy company', 'COMMERCE', 'TRY']);
    await client.query('insert into memberships(id,company_id,user_id,role) values($1,$2,$3,$4)', [randomUUID(), ids.company, ids.user, 'owner']);
    for (const [code, type, control] of [
      ['120', 'asset', 'receivable'], ['150', 'asset', null], ['151', 'asset', null], ['152', 'asset', null],
      ['620', 'cost', null], ['381', 'liability', null], ['600', 'income', null], ['391', 'liability', null],
    ] as const) {
      const id = randomUUID(); accounts.set(code, id);
      await client.query('insert into accounts(id,company_id,code,name,type,party_control) values($1,$2,$3,$4,$5,$6)',
        [id, ids.company, code, `Legacy account ${code}`, type, control]);
    }
    // Deliberately retain the company's existing choice, rather than accepting a newly inferred stock account.
    await client.query('insert into account_mappings(id,company_id,key,account_id,updated_at) values($1,$2,$3,$4,$5)',
      [ids.stockMapping, ids.company, 'stock', accounts.get('152'), '2025-02-03T10:00:00Z']);
    await client.query('insert into fiscal_periods(id,company_id,year,month,start_date,end_date) values($1,$2,2025,2,$3,$4)',
      [ids.period, ids.company, '2025-02-01', '2025-02-28']);
    await client.query('insert into parties(id,company_id,code,name,kind,currency_code) values($1,$2,$3,$4,$5,$6)',
      [ids.party, ids.company, 'LEGACY-CUSTOMER', 'Legacy customer', 'customer', 'GBP']);
    await client.query('insert into tax_rates(id,company_id,code,name,rate,valid_from,source_note) values($1,$2,$3,$4,16,$5,$6)',
      [randomUUID(), ids.company, 'KDV-16', 'Legacy manually configured VAT', '2020-01-01', 'Existing manually configured rate']);
    await client.query('insert into exchange_rates(id,company_id,rate_date,currency_code,quote_code,buy,sell,source,created_by) values($1,$2,$3,$4,$5,40,41,$6,$7)',
      [randomUUID(), ids.company, '2025-02-03', 'GBP', 'TRY', 'manual', ids.user]);
    await client.query(`insert into invoices(id,company_id,type,invoice_date,party_id,currency_code,fx_rate,net_total,vat_total,gross_total,net_total_base,vat_total_base,gross_total_base,created_by)
      values($1,$2,'sales','2025-02-03',$3,'GBP',40,100,16,116,4000,640,4640,$4)`, [ids.invoice, ids.company, ids.party, ids.user]);
    await client.query(`insert into invoice_lines(id,company_id,invoice_id,line_no,description,quantity,unit_price,vat_code,vat_rate,net,vat,gross,net_base,vat_base)
      values($1,$2,$3,1,'Legacy service',2,50,'KDV-16',16,100,16,116,4000,640)`, [randomUUID(), ids.company, ids.invoice]);
    await client.query(`insert into journal_entries(id,company_id,entry_date,period_id,description,source_type,source_id,created_by)
      values($1,$2,'2025-02-03',$3,'Legacy posted sales invoice','invoice',$4,$5)`, [ids.entry, ids.company, ids.period, ids.invoice, ids.user]);
    for (const [line, code, debit, credit, debitBase, creditBase, party] of [
      [1, '120', 116, 0, 4640, 0, ids.party], [2, '600', 0, 100, 0, 4000, null], [3, '391', 0, 16, 0, 640, null],
    ] as const) {
      await client.query(`insert into journal_lines(id,company_id,entry_id,line_no,account_id,currency_code,fx_rate,debit,credit,debit_base,credit_base,party_id)
        values($1,$2,$3,$4,$5,'GBP',40,$6,$7,$8,$9,$10)`, [randomUUID(), ids.company, ids.entry, line, accounts.get(code), debit, credit, debitBase, creditBase, party]);
    }
    // Use the real guards and posting transitions; no trigger is disabled to manufacture historical records.
    await client.query(`update journal_entries set status='posted',entry_no='YEV-LEGACY-1',posted_at='2025-02-03T10:00:00Z',posted_by=$2 where id=$1`, [ids.entry, ids.user]);
    await client.query(`update invoices set status='posted',invoice_no='FAT-LEGACY-1',journal_entry_id=$2,posted_at='2025-02-03T10:00:00Z',posted_by=$3 where id=$1`, [ids.invoice, ids.entry, ids.user]);
    await client.query('commit');
    return { ids, accounts };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

it('0104 dolu veritabanından yükseltme: 0105 eşleme kimlikleri oluşur; kesinleşmiş geçmiş, manuel ülke ve şubesiz kayıt korunur; tekrar çalıştırma değişmez', async () => {
  const ownerSource = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';
  if (databaseNameOf(ownerSource) !== 'erp_test') throw new Error('Upgrade test requires an explicit erp_test owner connection');
  const name = `erp_upgrade_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^erp_upgrade_test_[0-9a-f]{32}$/.test(name)) throw new Error('Invalid disposable upgrade database name');
  const ownerUrl = swapDatabase(ownerSource, name);
  const admin = new pg.Client({ connectionString: swapDatabase(ownerSource, 'postgres') });
  let connected = false;
  let created = false;
  let folder: string | undefined;
  let owner: pg.Client | undefined;
  let handle: ReturnType<typeof createDb> | undefined;
  try {
    const journal = JSON.parse(await readFile(join(sourceFolder, 'meta', '_journal.json'), 'utf8')) as MigrationJournal;
    const legacyEntries = journal.entries.filter((entry) => entry.idx <= 104);
    const foundation = journal.entries.find((entry) => entry.tag === '0105_leather_foundation');
    expect(legacyEntries.at(-1)?.tag).toBe('0104_tidy_daimon_hellstrom');
    expect(foundation?.idx).toBe(105);
    const foundationHash = createHash('sha256').update(await readFile(join(sourceFolder, '0105_leather_foundation.sql'))).digest('hex');
    await mkdir(cacheRoot, { recursive: true });
    folder = await mkdtemp(join(cacheRoot, folderPrefix));
    await checkedFolder(folder);
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: legacyEntries }));
    await Promise.all(legacyEntries.map((entry) => copyFile(join(sourceFolder, `${entry.tag}.sql`), join(folder!, `${entry.tag}.sql`))));

    await admin.connect(); connected = true;
    await admin.query(`create database "${name}"`); created = true;
    await admin.query(`grant connect on database "${name}" to erp_app`);
    handle = createDb(ownerUrl, { max: 1 });
    await migrate(handle.db, { migrationsFolder: folder });
    await handle.close(); handle = undefined;
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const { ids, accounts } = await seedLegacy(owner);
    const before = await legacySnapshot(owner, ids.company);
    const oldHistory = (await owner.query('select id,hash,created_at::text from drizzle.__drizzle_migrations order by id')).rows;
    expect(oldHistory).toHaveLength(legacyEntries.length);
    expect(oldHistory.some((row) => row.hash === foundationHash)).toBe(false);
    await owner.end(); owner = undefined;

    await runMigrations(ownerUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const after = await legacySnapshot(owner, ids.company);
    expect(after.accounts).toEqual(before.accounts);
    for (const key of ['invoice', 'invoiceLines', 'journal', 'journalLines', 'fx', 'vat']) expect(after[key], key).toEqual(before[key]);
    expect(after.mappings).toEqual(expect.arrayContaining(before.mappings!));
    const newKeys = ['raw_material_stock', 'semi_finished_stock', 'finished_goods_stock', 'production_wip', 'produced_cogs', 'goods_receipt_accrual'];
    const mappings = (await owner.query('select id,key,account_id from account_mappings where company_id=$1 and key=any($2::text[]) order by key', [ids.company, newKeys])).rows;
    expect(mappings).toHaveLength(6);
    expect(new Set(mappings.map((row) => row.id)).size).toBe(6);
    expect(mappings.every((row) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id))).toBe(true);
    for (const [key, code] of [['raw_material_stock', '150'], ['semi_finished_stock', '151'], ['finished_goods_stock', '152'], ['production_wip', '151'], ['produced_cogs', '620'], ['goods_receipt_accrual', '381']]) {
      expect(mappings.find((row) => row.key === key)?.account_id, key).toBe(accounts.get(code!));
    }
    expect((await owner.query('select jurisdiction,profile_mode,profile_version_id,fx_provider,tax_setup_status from companies where id=$1', [ids.company])).rows).toEqual([
      { jurisdiction: null, profile_mode: 'legacy_manual', profile_version_id: null, fx_provider: null, tax_setup_status: 'legacy_manual' },
    ]);
    expect((await owner.query('select branch_id,legal_profile_snapshot from invoices where id=$1', [ids.invoice])).rows).toEqual([{ branch_id: null, legal_profile_snapshot: null }]);
    expect((await owner.query('select branch_id,legal_profile_snapshot from journal_entries where id=$1', [ids.entry])).rows).toEqual([{ branch_id: null, legal_profile_snapshot: null }]);
    expect((await owner.query('select sum(debit_base)::text as debit,sum(credit_base)::text as credit from journal_lines where entry_id=$1', [ids.entry])).rows).toEqual([{ debit: '4640.0000', credit: '4640.0000' }]);
    expect((await owner.query('select provider from exchange_rates where company_id=$1', [ids.company])).rows).toEqual([{ provider: 'manual' }]);
    const upgradedHistory = (await owner.query('select id,hash,created_at::text from drizzle.__drizzle_migrations order by id')).rows;
    expect(upgradedHistory).toHaveLength(journal.entries.length);
    expect(upgradedHistory.slice(0, oldHistory.length)).toEqual(oldHistory);
    expect(upgradedHistory.filter((row) => row.hash === foundationHash)).toHaveLength(1);
    expect(upgradedHistory.find((row) => row.hash === foundationHash)?.created_at).toBe(String(foundation!.when));
    await owner.end(); owner = undefined;

    await runMigrations(ownerUrl);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    expect(await legacySnapshot(owner, ids.company)).toEqual(after);
    expect((await owner.query('select id,hash,created_at::text from drizzle.__drizzle_migrations order by id')).rows).toEqual(upgradedHistory);
  } finally {
    try {
      await handle?.close();
      await owner?.end();
      if (created) {
        // Only this generated database can be dropped; all fixture connections have already closed.
        await dropUpgradeDatabase(admin, name, ownerUrl);
      }
    } finally {
      if (connected) await admin.end();
      if (folder) await rm(await checkedFolder(folder), { recursive: true, force: true });
    }
  }
}, 180_000);
