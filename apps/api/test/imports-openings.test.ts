import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { accountIds, client, createCompany, day, makeApp, registerUser, thisYear } from './helpers';

const OPENING = day(1, 1);

/** Kalıcı (geri alınmayan) sahip bağlantısı: yalnızca test verisini hazırlamak için (RLS'i aşar). */
async function ownerExec(sql: string, params: unknown[]) {
  const db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test' });
  await db.connect();
  try {
    await db.query(sql, params);
  } finally {
    await db.end();
  }
}

describe('içe aktarma: açılış bakiyeleri', async () => {
  const { app } = await makeApp();

  async function setup(name: string, company: Record<string, unknown> = {}) {
    const s = await registerUser(app, name);
    const co = await createCompany(app, s.token, company);
    return { s, co, c: client(app, s.token, co.id) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`istek başarısız (${res.statusCode}): ${res.body}`);
    return res.json();
  };
  type Cells = Record<string, string | undefined>;
  const rowsOf = (list: readonly Cells[]) =>
    list.map((cells, i) => ({ row: i + 2, cells: Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== undefined)) as Record<string, string> }));
  const run = (c: C, kind: string, action: 'preview' | 'commit', list: readonly Cells[], options: Record<string, unknown> = {}) =>
    c.post(`/api/imports/${kind}/${action}`, { rows: rowsOf(list), options: { openingDate: OPENING, ...options } });
  const summaryOf = (preview: any, label: string) => (preview.summary as { label: string; value: string }[]).find((s) => s.label.startsWith(label))?.value;
  const errorOf = (preview: any, index: number) => preview.rows[index].messages.find((m: any) => m.severity === 'error');

  const trialBalance = async (c: C) => {
    const tb = await ok(c.get(`/api/reports/trial-balance?from=${day(1, 1)}&to=${day(12, 31)}`));
    return { tb, by: Object.fromEntries((tb.rows as any[]).map((r) => [r.code, r])) as Record<string, { debit: string; credit: string; closing: string }> };
  };
  const entryCount = async (c: C) => (await ok(c.get('/api/journal-entries?limit=200'))).entries.length as number;

  // --- Cari açılış bakiyeleri -----------------------------------------------------------------------------

  async function partiesFixture(name: string) {
    const ctx = await setup(name);
    const mk = async (body: Record<string, unknown>) => (await ok(ctx.c.post('/api/parties', body))).party as { id: string; code: string };
    const a = await mk({ name: 'Ömer Çakır Ticaret', kind: 'customer' });
    const b = await mk({ name: 'Demir Çelik A.Ş.', kind: 'supplier' });
    const both = await mk({ name: 'Her İkisi Ltd.', kind: 'both' });
    const gbp = await mk({ name: 'Sarah Thompson', kind: 'customer', currencyCode: 'GBP' });
    return { ...ctx, a, b, both, gbp };
  }

  it('cari açılışı: tek yevmiye, kontrol hesabı cari türüne göre, karşı hesap farkı taşır; açık kalem ve bakiyeler doğru; ters kayıtla geri alınır', async () => {
    const { c, a, b, both, gbp } = await partiesFixture('CariAcilis');
    const list: Cells[] = [
      { party: a.code, debit: '1.000,00', dueDate: day(3, 31) },
      { party: b.code, credit: '500,00' },
      { party: 'her ikisi ltd', debit: '200,00' }, // ünvanla, harf/aksan duyarsız
      { party: both.code, credit: '50,00' },
      { party: gbp.code, amount: '100', side: 'Borç', fxRate: '40' }, // carinin para birimi GBP
      { party: a.code, amount: '75,50', side: 'Alacak' }, // müşteride alacak bakiyesi: 120 alacak (avans)
      { party: b.code, debit: '0' }, // sıfır: atlanır
    ];

    const preview = await ok(run(c, 'party_openings', 'preview', list));
    expect(preview.counts).toEqual({ total: 7, ok: 6, skip: 1, error: 0 });
    expect(preview.canCommit).toBe(true);
    expect(summaryOf(preview, 'Borç toplamı')).toBe('5.200,00');
    expect(summaryOf(preview, 'Alacak toplamı')).toBe('625,50');
    expect(summaryOf(preview, 'Karşı hesap')).toContain('500');
    expect(summaryOf(preview, 'Karşı hesap')).toContain('4.574,50 alacak');
    expect(await entryCount(c)).toBe(0); // ön izleme hiçbir şey yazmaz

    const done = await ok(run(c, 'party_openings', 'commit', list));
    expect(done).toMatchObject({ kind: 'party_openings', created: 6, skipped: 1 });
    expect(done.entries).toHaveLength(1);
    expect(done.entries[0].no).toMatch(/^YV-\d{4}-000001$/);

    const entry = (await ok(c.get(`/api/journal-entries/${done.entries[0].id}`))).entry;
    expect(entry.status).toBe('posted');
    expect(entry.sourceType).toBeNull(); // kaynaksız: normal ters kayıtla düzeltilebilir
    expect(entry.lines).toHaveLength(7);
    const line = (i: number) => entry.lines[i];
    expect(line(0)).toMatchObject({ accountCode: '120', partyId: a.id, debit: '1000.0000', credit: '0.0000', dueDate: day(3, 31) });
    expect(line(1)).toMatchObject({ accountCode: '320', partyId: b.id, credit: '500.0000' });
    expect(line(2)).toMatchObject({ accountCode: '120', partyId: both.id, debit: '200.0000' }); // her ikisi + borç → 120
    expect(line(3)).toMatchObject({ accountCode: '320', partyId: both.id, credit: '50.0000' }); // her ikisi + alacak → 320
    expect(line(4)).toMatchObject({ accountCode: '120', partyId: gbp.id, currencyCode: 'GBP', debit: '100.0000', debitBase: '4000.0000' });
    expect(line(5)).toMatchObject({ accountCode: '120', partyId: a.id, credit: '75.5000' });
    expect(line(6)).toMatchObject({ accountCode: '500', credit: '4574.5000', partyId: null });

    const { tb, by } = await trialBalance(c);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(Number(by['500']!.credit)).toBe(4574.5);

    // Cari bakiyeleri ve açık kalemler: müşteride alacak (avans) bakiyesi FIFO ile 1.000'den düşer
    expect((await ok(c.get(`/api/parties/${a.id}`))).summary.balance).toBe('924.5000');
    expect((await ok(c.get(`/api/parties/${b.id}`))).summary.balance).toBe('-500.0000');
    const open = (await ok(c.get(`/api/parties/${a.id}/open-items?asOf=${day(6, 1)}&type=receivable`))).receivable.items as any[];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ remaining: '924.50', dueDate: day(3, 31) });
    const gbpOpen = (await ok(c.get(`/api/parties/${gbp.id}/open-items?asOf=${day(6, 1)}&type=receivable`))).receivable.items as any[];
    expect(gbpOpen[0]).toMatchObject({ currencyCode: 'GBP', remaining: '100.00', remainingBase: '4000.00' });

    // Yanlış yükleme ters kayıtla tamamen geri alınır
    const reversed = await c.post(`/api/journal-entries/${done.entries[0].id}/reverse`, { description: 'Yanlış açılış dosyası' });
    expect(reversed.statusCode).toBe(201);
    const after = await trialBalance(c);
    expect(Number(after.by['500']!.closing)).toBe(0);
    expect((await ok(c.get(`/api/parties/${a.id}`))).summary.balance).toBe('0.0000');
  });

  it('cari açılışı: her satır hatası alan ve Türkçe ileti ile bildirilir; hatalı dosya hiçbir şey yazmaz ve fiş sayacı geri döner', async () => {
    const { c, s, co, a, b } = await partiesFixture('CariHata');
    await ok(c.post('/api/parties', { name: 'Tekrarlı Ad' }));
    await ok(c.post('/api/parties', { name: 'Tekrarlı Ad', code: 'CR-000099' }));
    const inactive = (await ok(c.post('/api/parties', { name: 'Pasif Cari' }))).party;
    await ok(c.patch(`/api/parties/${inactive.id}`, { isActive: false }));

    const list: Cells[] = [
      { party: 'Yok Böyle Cari', debit: '10' },
      { party: 'Tekrarlı Ad', debit: '10' },
      { party: 'Pasif Cari', debit: '10' },
      { party: a.code, debit: '10', credit: '5' },
      { party: a.code, amount: '10' },
      { party: a.code, amount: '10', side: 'çapraz' },
      { party: a.code, debit: '10', currencyCode: 'EUR' }, // kayıtlı kur yok
      { party: a.code, debit: '10', dueDate: 'yarın' },
      { party: a.code },
      { party: a.code, debit: '-10' },
      { party: a.code, debit: '10,1234' },
      { party: a.code, debit: '10', currencyCode: 'JPY' },
      { party: '', debit: '10' },
    ];
    const preview = await ok(run(c, 'party_openings', 'preview', list));
    expect(preview.counts).toMatchObject({ total: 13, ok: 0, error: 13 });
    expect(preview.canCommit).toBe(false);
    expect(list.map((_, i) => errorOf(preview, i).code)).toEqual([
      'PARTY_NOT_FOUND',
      'PARTY_AMBIGUOUS',
      'PARTY_INACTIVE',
      'BOTH_SIDES',
      'SIDE_REQUIRED',
      'SIDE_UNKNOWN',
      'FX_RATE_MISSING',
      'INVALID_DATE',
      'AMOUNT_REQUIRED',
      'NEGATIVE_NOT_ALLOWED',
      'TOO_MANY_DECIMALS',
      'CURRENCY_UNKNOWN',
      'PARTY_REQUIRED',
    ]);

    // Geçerli satırların ardından tek bir hatalı satır: hiçbir şey yazılmaz
    const mixed: Cells[] = [{ party: a.code, debit: '100' }, { party: b.code, credit: '40' }, { party: 'Yok Böyle Cari', debit: '1' }];
    const res = await run(c, 'party_openings', 'commit', mixed);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IMPORT_INVALID');
    expect(res.json().error.details.rows[0]).toMatchObject({ row: 4, messages: [{ code: 'PARTY_NOT_FOUND', field: 'party' }] });
    expect(await entryCount(c)).toBe(0);
    expect((await ok(c.get(`/api/parties/${a.id}`))).summary.movements).toBe(0);

    // Fiş sayacı kullanılmadı: elle kaydedilen ilk yevmiye YV-…-000001 alır
    const ids = await accountIds(app, s.token, co.id);
    const manual = await ok(
      c.post('/api/journal-entries', {
        entryDate: OPENING,
        description: 'Elle fiş',
        post: true,
        lines: [
          { accountId: ids['100'], currency: 'TRY', debit: '10', credit: '0' },
          { accountId: ids['500'], currency: 'TRY', debit: '0', credit: '10' },
        ],
      }),
    );
    expect(manual.entry.entryNo).toMatch(/^YV-\d{4}-000001$/);
  });

  it('cari açılışı: dönem tanımsız/kapalı ve eksik hesap eşlemesi satırlardan bağımsız genel hata olarak bildirilir', async () => {
    const { c, co, a } = await partiesFixture('CariGenel');
    const list: Cells[] = [{ party: a.code, debit: '100' }];

    const missingPeriod = await ok(run(c, 'party_openings', 'preview', list, { openingDate: '2015-01-01' }));
    expect(missingPeriod.canCommit).toBe(false);
    expect(missingPeriod.general[0]).toMatchObject({ severity: 'error', code: 'PERIOD_MISSING' });
    const commit = await run(c, 'party_openings', 'commit', list, { openingDate: '2015-01-01' });
    expect(commit.statusCode).toBe(422);
    expect(commit.json().error.code).toBe('IMPORT_INVALID');
    expect(commit.json().error.details.general[0].code).toBe('PERIOD_MISSING');

    const periods = (await ok(c.get(`/api/periods?year=${thisYear}`))).periods as { id: string; month: number }[];
    await ok(c.post(`/api/periods/${periods.find((p) => p.month === 1)!.id}/close`, {}));
    const closed = await ok(run(c, 'party_openings', 'preview', list));
    expect(closed.general[0]).toMatchObject({ code: 'PERIOD_CLOSED' });

    // Karşı hesap eşlemesi kaldırılınca (ve karşı hesap seçilmemişse) genel hata; hesap seçilince düzelir
    await ownerExec("delete from account_mappings where company_id = $1 and key = 'opening_offset'", [co.id]);
    const feb = { openingDate: day(2, 1) };
    const noMapping = await ok(run(c, 'party_openings', 'preview', list, feb));
    expect(noMapping.canCommit).toBe(false);
    expect(noMapping.general[0]).toMatchObject({ severity: 'error', code: 'ACCOUNT_MAPPING_MISSING' });
    const commitNoMapping = await run(c, 'party_openings', 'commit', list, feb);
    expect(commitNoMapping.statusCode).toBe(422);
    expect(commitNoMapping.json().error.details.general[0].code).toBe('ACCOUNT_MAPPING_MISSING');

    const accs = (await ok(c.get('/api/accounts'))).accounts as { id: string; code: string }[];
    const chosen = accs.find((x) => x.code === '570')!.id;
    expect((await ok(run(c, 'party_openings', 'preview', list, { ...feb, offsetAccountId: chosen }))).canCommit).toBe(true);
    // Cari kontrol hesabı ya da alt hesabı olan hesap karşı hesap olamaz
    const control = accs.find((x) => x.code === '120')!.id;
    const badOffset = await ok(run(c, 'party_openings', 'preview', list, { ...feb, offsetAccountId: control }));
    expect(badOffset.general.some((m: any) => m.code === 'OFFSET_ACCOUNT_INVALID')).toBe(true);
    const group = accs.find((x) => x.code === '10')!.id;
    expect((await ok(run(c, 'party_openings', 'preview', list, { ...feb, offsetAccountId: group }))).general.some((m: any) => m.code === 'OFFSET_ACCOUNT_INVALID')).toBe(true);
  });

  // --- Stok açılışı -------------------------------------------------------------------------------------

  it('stok açılışı: depo başına belge, dövizli satır, stok durumu ve muhasebe mutabakatı sıfır; kart adı/barkod/kodla bulunur', async () => {
    const { c } = await setup('StokAcilis');
    const item = async (body: Record<string, unknown>) => (await ok(c.post('/api/items', body))).item as { id: string; code: string };
    const cement = await item({ name: 'Çimento 50 kg', unit: 'cuval' });
    const tile = await item({ name: 'Seramik', barcode: '8690001' });
    const cable = await item({ name: 'Kablo NYY' });
    const service = await item({ name: 'Nakliye', kind: 'service' });
    void service;
    const anaId = (await ok(c.get('/api/warehouses'))).warehouses[0].id as string;
    await ok(c.post('/api/warehouses', { name: 'Şantiye Deposu', code: 'SNT' }));

    const list: Cells[] = [
      { item: cement.code, quantity: '100', unitCost: '10,50' }, // depo boş: varsayılan depo
      { warehouse: 'snt', item: '8690001', quantity: '20', unitCost: '30' }, // depo kodu, barkod
      { warehouse: 'Şantiye Deposu', item: 'kablo nyy', quantity: '5,5', unitCost: '2', currencyCode: 'EUR', fxRate: '40' }, // depo adı, kart adı, dövizli
      { item: tile.code, quantity: '0', unitCost: '5' }, // sıfır: atlanır
    ];
    const preview = await ok(run(c, 'stock_openings', 'preview', list));
    expect(preview.counts).toEqual({ total: 4, ok: 3, skip: 1, error: 0 });
    expect(summaryOf(preview, 'Stok belgesi')).toBe('2 (depo başına)');
    // 100×10,50 + 20×30 + 5,5×2×40
    expect(summaryOf(preview, 'Stok değeri')).toBe('2.090,00');

    const done = await ok(run(c, 'stock_openings', 'commit', list));
    expect(done).toMatchObject({ created: 3, skipped: 1 });
    expect(done.entries).toHaveLength(2);
    expect(done.entries.every((e: any) => e.type === 'stock' && /^SH-\d{4}-\d{6}$/.test(e.no))).toBe(true);

    const status = await ok(c.get(`/api/reports/stock-status?asOf=${day(12, 31)}`));
    const by = Object.fromEntries((status.rows as any[]).map((r) => [r.code, r]));
    expect(by[cement.code]).toMatchObject({ onHand: '100.0000', value: '1050.0000' });
    expect(by[tile.code]).toMatchObject({ onHand: '20.0000', value: '600.0000' });
    expect(by[cable.code]).toMatchObject({ onHand: '5.5000', value: '440.0000' });
    // Stok defteri ↔ 150-157 hesapları: fark yok
    expect(status.ledger.difference).toBe('0.0000');
    expect(status.ledger.unexplained).toBe('0.0000');
    const { by: tb } = await trialBalance(c);
    expect(Number(tb['150']!.debit)).toBe(2090);
    expect(Number(tb['500']!.credit)).toBe(2090);

    // Depo başına belge: ANA'da 1 satır, Şantiye'de 2 satır
    const docs = (await ok(c.get('/api/stock-documents?type=opening'))).documents as { docNo: string; lineCount: number; warehouseName: string }[];
    expect(docs.map((d) => [d.warehouseName, d.lineCount]).sort()).toEqual([['Ana depo', 1], ['Şantiye Deposu', 2]]);
    void anaId;

    // Aynı dosya yeniden yüklenirse kartların hareketi olduğu uyarılır
    const again = await ok(run(c, 'stock_openings', 'preview', list.slice(0, 1)));
    expect(again.rows[0].messages.some((m: any) => m.code === 'ITEM_HAS_MOVEMENTS')).toBe(true);
  });

  it('stok açılışı: hizmet, bilinmeyen/çoklu kart, eksik maliyet, depo ve kur hataları; dosya hatalıysa hiçbir belge yazılmaz', async () => {
    const { c } = await setup('StokHata');
    const item = async (body: Record<string, unknown>) => (await ok(c.post('/api/items', body))).item as { id: string; code: string };
    const good = await item({ name: 'İyi Kart' });
    await item({ name: 'Çift Ad' });
    await item({ name: 'Çift Ad' });
    const service = await item({ name: 'Hizmet Kartı', kind: 'service' });
    const inactive = await item({ name: 'Pasif Kart' });
    await ok(c.patch(`/api/items/${inactive.id}`, { isActive: false }));
    const closed = (await ok(c.post('/api/warehouses', { name: 'Kapalı Depo', code: 'KPL' }))).warehouse;
    await ok(c.patch(`/api/warehouses/${closed.id}`, { isActive: false }));

    const list: Cells[] = [
      { item: service.code, quantity: '1', unitCost: '1' },
      { item: 'Yok Böyle Kart', quantity: '1', unitCost: '1' },
      { item: 'çift ad', quantity: '1', unitCost: '1' },
      { item: good.code, quantity: '1' },
      { item: good.code, quantity: '1', unitCost: '1', warehouse: 'Olmayan Depo' },
      { item: good.code, quantity: '1', unitCost: '1', warehouse: 'KPL' },
      { item: good.code, quantity: '1', unitCost: '1', currencyCode: 'EUR' }, // kayıtlı kur yok
      { item: inactive.code, quantity: '1', unitCost: '1' },
      { item: good.code, quantity: '1,23456', unitCost: '1' },
      { item: '', quantity: '1', unitCost: '1' },
      { item: good.code, unitCost: '1' },
    ];
    const preview = await ok(run(c, 'stock_openings', 'preview', list));
    expect(preview.counts).toMatchObject({ ok: 0, error: 11 });
    expect(list.map((_, i) => errorOf(preview, i).code)).toEqual([
      'ITEM_NOT_STOCKED',
      'ITEM_NOT_FOUND',
      'ITEM_AMBIGUOUS',
      'UNIT_COST_REQUIRED',
      'WAREHOUSE_NOT_FOUND',
      'WAREHOUSE_INACTIVE',
      'FX_RATE_MISSING',
      'ITEM_INACTIVE',
      'TOO_MANY_DECIMALS',
      'ITEM_REQUIRED',
      'QUANTITY_REQUIRED',
    ]);

    const res = await run(c, 'stock_openings', 'commit', [{ item: good.code, quantity: '5', unitCost: '2' }, { item: 'Yok Böyle Kart', quantity: '1', unitCost: '1' }]);
    expect(res.statusCode).toBe(422);
    expect(((await ok(c.get('/api/stock-documents'))).documents as unknown[]).length).toBe(0);
    expect(await entryCount(c)).toBe(0);
  });

  it('stok açılışı: bir depoya 200 satırdan fazlası birden çok belgeye bölünür; hepsi tek işlemde yazılır', async () => {
    const { c } = await setup('StokBol');
    const kartlar = Array.from({ length: 205 }, (_, i) => ({ code: `K-${String(i + 1).padStart(3, '0')}`, name: `Toplu kart ${i + 1}` }));
    const created = await ok(c.post('/api/imports/items/commit', { rows: rowsOf(kartlar), options: {} }));
    expect(created.created).toBe(205);

    const list = kartlar.map((k) => ({ item: k.code, quantity: '2', unitCost: '3' }));
    const done = await ok(run(c, 'stock_openings', 'commit', list));
    expect(done.created).toBe(205);
    expect(done.entries).toHaveLength(2);
    const docs = (await ok(c.get('/api/stock-documents?type=opening'))).documents as { lineCount: number }[];
    expect(docs.map((d) => d.lineCount).sort((x, y) => x - y)).toEqual([5, 200]);
    const status = await ok(c.get(`/api/reports/stock-status?asOf=${day(12, 31)}`));
    expect(status.totals.value).toBe(String((205 * 2 * 3).toFixed(4)));
    expect(status.ledger.difference).toBe('0.0000');
  });

  // --- Genel mizan açılışı --------------------------------------------------------------------------------

  it('mizan açılışı: dengeli dosya tek yevmiye yazar; fark karşı hesaba atılır; hem borç hem alacak dolu satır netlenir', async () => {
    const { c } = await setup('Mizan');
    const balanced: Cells[] = [
      { account: '100', accountName: 'Kasa', debit: '50.000,00' },
      { account: '102', debit: '250.000,00' },
      { account: '254', debit: '100.000,00' },
      { account: '500', credit: '400.000,00' },
    ];
    const preview = await ok(run(c, 'ledger_openings', 'preview', balanced, { plugDifference: false }));
    expect(preview.canCommit).toBe(true);
    expect(summaryOf(preview, 'Borç toplamı')).toBe('400.000,00');
    expect(summaryOf(preview, 'Alacak toplamı')).toBe('400.000,00');
    expect(summaryOf(preview, 'Fark')).toContain('dengeli');

    const done = await ok(run(c, 'ledger_openings', 'commit', balanced, { plugDifference: false }));
    expect(done).toMatchObject({ created: 4, skipped: 0 });
    expect(done.entries[0].no).toMatch(/^YV-\d{4}-000001$/);
    const { tb, by } = await trialBalance(c);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(Number(by['102']!.debit)).toBe(250000);
    expect(Number(by['500']!.credit)).toBe(400000);
    expect(await entryCount(c)).toBe(1);

    // Fark: 570 karşı hesabına atılır; netleme: borç 10.000 − alacak 4.000 = borç 6.000
    const second: Cells[] = [
      { account: '100', debit: '10.000,00', credit: '4.000,00' },
      { account: '102', debit: '1.000,00' },
    ];
    const p2 = await ok(run(c, 'ledger_openings', 'preview', second, { plugDifference: true }));
    expect(p2.rows[0].messages.some((m: any) => m.code === 'NETTED')).toBe(true);
    expect(summaryOf(p2, 'Fark')).toContain('7.000,00 alacak'); // 6.000 + 1.000 borç
    const accs = (await ok(c.get('/api/accounts'))).accounts as { id: string; code: string }[];
    const offset570 = accs.find((a) => a.code === '570')!.id;
    const d2 = await ok(run(c, 'ledger_openings', 'commit', second, { plugDifference: true, offsetAccountId: offset570 }));
    const entry = (await ok(c.get(`/api/journal-entries/${d2.entries[0].id}`))).entry;
    expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['100', '6000.0000', '0.0000'],
      ['102', '1000.0000', '0.0000'],
      ['570', '0.0000', '7000.0000'],
    ]);
  });

  it('mizan açılışı: fark varsa ve atma kapalıysa genel hata; cari/stok hesapları, alt hesabı olanlar ve bilinmeyen kodlar reddedilir', async () => {
    const { c } = await setup('MizanHata');
    const unbalanced: Cells[] = [{ account: '100', debit: '100,00' }, { account: '500', credit: '60,00' }];
    const noPlug = await ok(run(c, 'ledger_openings', 'preview', unbalanced, { plugDifference: false }));
    expect(noPlug.canCommit).toBe(false);
    expect(noPlug.general[0]).toMatchObject({ code: 'LEDGER_UNBALANCED' });
    expect((await run(c, 'ledger_openings', 'commit', unbalanced, { plugDifference: false })).statusCode).toBe(422);
    expect(await entryCount(c)).toBe(0);
    // Fark atılırsa geçerli
    expect((await ok(run(c, 'ledger_openings', 'preview', unbalanced, { plugDifference: true }))).canCommit).toBe(true);

    const bad: Cells[] = [
      { account: '120', debit: '10' }, // cari kontrol hesabı
      { account: '320', credit: '10' },
      { account: '150', debit: '10' }, // stok hesabı
      { account: '10', debit: '10' }, // alt hesabı olan grup
      { account: '999', debit: '10' },
      { account: '', debit: '10' },
      { account: '100', debit: 'abc' },
      { account: '100', debit: '0' }, // sıfır: atlanır (hata değil)
    ];
    const preview = await ok(run(c, 'ledger_openings', 'preview', bad));
    expect(preview.counts).toMatchObject({ total: 8, error: 7, skip: 1 });
    expect(bad.slice(0, 7).map((_, i) => errorOf(preview, i).code)).toEqual([
      'PARTY_CONTROL_ACCOUNT',
      'PARTY_CONTROL_ACCOUNT',
      'STOCK_ACCOUNT',
      'ACCOUNT_NOT_POSTABLE',
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_REQUIRED',
      'INVALID_NUMBER',
    ]);
  });

  it('mizan açılışı: dövizli hesapta hesap para birimi tutarı ve kur; kayıtlı kur yoksa hata; 159 (verilen sipariş avansı) stok hesabı sayılmaz', async () => {
    const { c } = await setup('MizanDoviz');
    await ok(c.post('/api/accounts', { code: '102.010', name: 'KTB GBP Hesabı', currencyCode: 'GBP' }));

    const noRate = await ok(run(c, 'ledger_openings', 'preview', [{ account: '102.010', debit: '100' }]));
    expect(errorOf(noRate, 0).code).toBe('FX_RATE_MISSING');

    const list: Cells[] = [{ account: '102.010', debit: '100,00', fxRate: '40' }, { account: '159', debit: '500,00' }];
    const preview = await ok(run(c, 'ledger_openings', 'preview', list));
    expect(preview.counts.ok).toBe(2);
    expect(summaryOf(preview, 'Borç toplamı')).toBe('4.500,00'); // 100 GBP × 40 + 500
    const done = await ok(run(c, 'ledger_openings', 'commit', list));
    const entry = (await ok(c.get(`/api/journal-entries/${done.entries[0].id}`))).entry;
    expect(entry.lines[0]).toMatchObject({ accountCode: '102.010', currencyCode: 'GBP', debit: '100.0000', debitBase: '4000.0000', fxRate: '40.00000000' });
    expect(entry.lines[2]).toMatchObject({ accountCode: '500', credit: '4500.0000' });
  });

  // --- Yetki ve yalıtım -----------------------------------------------------------------------------------

  it('açılış içe aktarmaları yalnızca kendi şirketinin cari/kart/hesaplarını görür (RLS)', async () => {
    const mine = await setup('Yalitim1');
    const theirs = await partiesFixture('Yalitim2');
    const list: Cells[] = [{ party: theirs.a.code, debit: '10' }, { party: 'Ömer Çakır Ticaret', debit: '10' }];
    const preview = await ok(run(mine.c, 'party_openings', 'preview', list));
    expect(list.map((_, i) => errorOf(preview, i).code)).toEqual(['PARTY_NOT_FOUND', 'PARTY_NOT_FOUND']);
    const stock = await ok(run(mine.c, 'stock_openings', 'preview', [{ item: 'ST-000001', quantity: '1', unitCost: '1' }]));
    expect(errorOf(stock, 0).code).toBe('ITEM_NOT_FOUND');
  });
});
