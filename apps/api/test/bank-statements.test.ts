import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dec } from '@erp/shared';
import { readXlsx } from '../src/files/xlsx-read';
import { suggestMatches, dayDiff, type LedgerCandidateInput } from '../src/modules/bank-statements/matching';
import { balancesOf } from '../src/modules/imports/handlers/bank-statement';
import { PASSWORD, accountIds, asDb, asOwner, client, createCompany, day, expectDbError, makeApp, orgOf, registerUser } from './helpers';

const trDate = (iso: string) => iso.split('-').reverse().join('.');

describe('banka ekstresi: eşleştirme algoritması (saf)', () => {
  const cand = (over: Partial<LedgerCandidateInput> & { journalLineId: string }): LedgerCandidateInput => ({
    entryId: `e-${over.journalLineId}`,
    entryNo: `YV-${over.journalLineId}`,
    entryDate: '2026-03-10',
    description: 'Hareket',
    amount: '100.0000',
    txnId: null,
    txnNo: null,
    partyName: null,
    ...over,
  });
  const line = (id: string, over: Partial<{ txnDate: string; amount: string; description: string; reference: string | null }> = {}) => ({
    id,
    txnDate: '2026-03-10',
    amount: '100.00',
    description: 'Havale',
    reference: null,
    ...over,
  });

  it('tarih toleransı ±3 gün dahil, 4 gün dışarıda; tutar ve işaret birebir', () => {
    expect(dayDiff('2026-03-10', '2026-03-13')).toBe(3);
    const c = [cand({ journalLineId: 'a', entryDate: '2026-03-13' })];
    expect(suggestMatches([line('s', { txnDate: '2026-03-10' })], c).get('s')).toHaveLength(1);
    expect(suggestMatches([line('s', { txnDate: '2026-03-11' })], c).get('s')).toHaveLength(1);
    expect(suggestMatches([line('s', { txnDate: '2026-03-09' })], c).get('s')).toHaveLength(0); // 4 gün
    expect(suggestMatches([line('s', { txnDate: '2026-03-08' })], c).get('s')).toHaveLength(0); // 5 gün
    expect(suggestMatches([line('s', { txnDate: '2026-03-08' })], [cand({ journalLineId: 'a', entryDate: '2026-03-12' })]).get('s')).toHaveLength(0); // 4 gün: dışarıda
    expect(suggestMatches([line('s', { txnDate: '2026-03-08' })], [cand({ journalLineId: 'a', entryDate: '2026-03-11' })]).get('s')).toHaveLength(1); // 3 gün: içeride
  });

  it('işaret duyarlı: +100 ile −100 eşleşmez; 100,00 ile 100,0001 eşleşmez', () => {
    const c = [cand({ journalLineId: 'a', amount: '-100.0000' })];
    expect(suggestMatches([line('s', { amount: '100.00' })], c).get('s')).toHaveLength(0);
    expect(suggestMatches([line('s', { amount: '-100.00' })], c).get('s')).toHaveLength(1);
    expect(suggestMatches([line('s', { amount: '100.01' })], [cand({ journalLineId: 'b' })]).get('s')).toHaveLength(0);
  });

  it('güven: tek aday ve yalnız bu satıra uyan → exact; iki aday ya da iki satır aynı adaya uyuyorsa → probable; hareket no exact yapar', () => {
    const one = suggestMatches([line('s')], [cand({ journalLineId: 'a' })]);
    expect(one.get('s')![0]!.confidence).toBe('exact');

    const two = suggestMatches([line('s')], [cand({ journalLineId: 'a', entryDate: '2026-03-10' }), cand({ journalLineId: 'b', entryDate: '2026-03-12' })]);
    expect(two.get('s')!.map((x) => [x.journalLineId, x.confidence])).toEqual([
      ['a', 'probable'],
      ['b', 'probable'],
    ]); // yakın tarihli ilk sırada

    const shared = suggestMatches([line('s1'), line('s2')], [cand({ journalLineId: 'a' })]);
    expect(shared.get('s1')![0]!.confidence).toBe('probable');
    expect(shared.get('s2')![0]!.confidence).toBe('probable');

    // Açıklamada hareket numarası geçen aday tek olunca exact (iki aday olsa da)
    const byNumber = suggestMatches(
      [line('s', { description: 'EFT TAH-2026-000007 nolu tahsilat' })],
      [cand({ journalLineId: 'a', txnNo: 'TAH-2026-000006' }), cand({ journalLineId: 'b', txnNo: 'TAH-2026-000007' })],
    );
    expect(byNumber.get('s')![0]).toMatchObject({ journalLineId: 'b', confidence: 'exact' });
    expect(byNumber.get('s')![1]).toMatchObject({ journalLineId: 'a', confidence: 'probable' });
  });

  it('bakiye yönü: eskiden yeniye ve yeniden eskiye dosyalar aynı açılış/kapanışı verir', () => {
    const a = (n: string) => dec(n);
    const asc = [
      { amount: a('100'), balance: a('1100') },
      { amount: a('-50'), balance: a('1050') },
      { amount: a('25'), balance: a('1075') },
    ];
    expect(balancesOf(asc)).toEqual({ opening: a('1000'), closing: a('1075') });
    expect(balancesOf([...asc].reverse())).toEqual({ opening: a('1000'), closing: a('1075') });
    expect(balancesOf([{ amount: a('5'), balance: null }])).toBeNull();
    expect(balancesOf([{ amount: a('5'), balance: a('15') }])).toEqual({ opening: a('10'), closing: a('15') });
  });
});

describe('banka ekstresi: içe aktarma, eşleştirme ve mutabakat', async () => {
  const { app, handle } = await makeApp();

  async function setup(name: string) {
    const s = await registerUser(app, name);
    const company = await createCompany(app, s.token);
    return { s, company, c: client(app, s.token, company.id) };
  }
  type C = Awaited<ReturnType<typeof setup>>['c'];
  const ok = async (p: Promise<{ statusCode: number; body: string; json: () => any }>) => {
    const res = await p;
    if (res.statusCode >= 300) throw new Error(`istek başarısız (${res.statusCode}): ${res.body}`);
    return res.json();
  };
  async function memberClient(owner: C, companyId: string, role: string) {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const add = await owner.post('/api/company/members', { email, fullName: `${role} Kişi`, role, password: PASSWORD });
    if (add.statusCode !== 201) throw new Error(`member failed: ${add.body}`);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
    return client(app, login.json().accessToken as string, companyId);
  }

  type Cells = Record<string, string | undefined>;
  const rowsOf = (list: readonly Cells[]) =>
    list.map((cells, i) => ({ row: i + 2, cells: Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== undefined)) as Record<string, string> }));
  const stmt = (c: C, action: 'preview' | 'commit', accountId: string, list: readonly Cells[], options: Record<string, unknown> = {}) =>
    c.post(`/api/imports/bank_statement/${action}`, { rows: rowsOf(list), options: { accountId, fileName: 'ekstre.csv', numberFormat: 'tr', ...options } });
  const errorOf = (preview: any, index: number) => preview.rows[index].messages.find((m: any) => m.severity === 'error');

  const recon = async (c: C, accountId: string, qs = '') => (await ok(c.get(`/api/treasury/accounts/${accountId}/reconciliation${qs}`))) as import('@erp/shared').ReconciliationData;
  const lineBy = (data: import('@erp/shared').ReconciliationData, description: string) => data.lines.find((l) => l.description === description)!;

  /**
   * Banka hesabı + 6 hareket (T1..T6) + 7 satırlık ekstre:
   *  T1 sermaye +10.000 (03-01) · T2 tedarikçi avansı −2.500 (03-05) · T3 masraf −35 (03-08) · T4 EFT +750 (03-08)
   *  T5 −500 (03-12) · T6 −500 (03-13) — ekstrede yalnız 03-12'de bir −500 var (iki aday: probable)
   */
  async function fixture(name: string) {
    const ctx = await setup(name);
    const { c, s, company } = ctx;
    const ids = await accountIds(app, s.token, company.id);
    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB TL', currency: 'TRY' }))).account as { id: string; accountCode: string };
    const supplier = (await ok(c.post('/api/parties', { name: 'Demir Çelik A.Ş.', kind: 'supplier' }))).party as { id: string };
    const txn = async (body: Record<string, unknown>) => (await ok(c.post('/api/treasury/transactions', { accountId: bank.id, ...body }))).transaction as { id: string; txnNo: string };
    const t1 = await txn({ type: 'other_receipt', date: day(3, 1), amount: '10000', glAccountId: ids['500'], description: 'Sermaye girişi' });
    const t2 = await txn({ type: 'payment', date: day(3, 5), amount: '2500', partyId: supplier.id, items: [], description: 'Demir Çelik avans' });
    const t3 = await txn({ type: 'other_payment', date: day(3, 8), amount: '35', glAccountId: ids['770'], description: 'Hesap işletim ücreti' });
    const t4 = await txn({ type: 'other_receipt', date: day(3, 8), amount: '750', glAccountId: ids['642'], description: 'EFT gelen' });
    const t5 = await txn({ type: 'other_payment', date: day(3, 12), amount: '500', glAccountId: ids['770'], description: 'Kira ödemesi' });
    const t6 = await txn({ type: 'other_payment', date: day(3, 13), amount: '500', glAccountId: ids['770'], description: 'Aidat ödemesi' });

    const lines: Cells[] = [
      { date: trDate(day(3, 1)), description: 'Sermaye girişi', reference: 'DKN-1', amount: '10.000,00', balance: '10.000,00' },
      { date: trDate(day(3, 6)), description: 'HAVALE Demir Çelik', reference: 'DKN-2', amount: '-2.500,00', balance: '7.500,00' },
      { date: trDate(day(3, 8)), description: 'Hesap işletim ücreti', reference: 'DKN-3', amount: '-35,00', balance: '7.465,00' },
      { date: trDate(day(3, 9)), description: 'EFT gelen', reference: 'DKN-4', amount: '750,00', balance: '8.215,00' },
      { date: trDate(day(3, 12)), description: 'Kira ödemesi', reference: 'DKN-5', amount: '-500,00', balance: '7.715,00' },
      { date: trDate(day(3, 20)), description: 'Faiz geliri', reference: 'DKN-6', amount: '42,50', balance: '7.757,50' },
      { date: trDate(day(3, 25)), description: 'Kart komisyonu', reference: 'DKN-7', amount: '-12,00', balance: '7.745,50' },
    ];
    const done = await ok(stmt(c, 'commit', bank.id, lines));
    return { ...ctx, ids, bank, supplier, t1, t2, t3, t4, t5, t6, lines, done };
  }

  // --- İçe aktarma ---------------------------------------------------------------------------------------

  it('ekstre içe aktarma: satırlar ve bakiyeler; aynı ekstre iki kez alınamaz; çakışan dönemli ekstrede yinelenen satırlar atlanır', async () => {
    const { c, bank, lines, done } = await fixture('EkstreAl');
    expect(done).toMatchObject({ kind: 'bank_statement', created: 7, skipped: 0 });

    const data = await recon(c, bank.id);
    expect(data.statements).toHaveLength(1);
    expect(data.statements[0]).toMatchObject({ fileName: 'ekstre.csv', lineCount: 7, matchedCount: 0, openingBalance: '0.0000', closingBalance: '7745.5000', fromDate: day(3, 1), toDate: day(3, 25) });
    expect(data.lines).toHaveLength(7);
    expect(data.lines[1]).toMatchObject({ amount: '-2500.0000', description: 'HAVALE Demir Çelik', reference: 'DKN-2', status: 'open', balance: '7500.0000' });

    // Aynı dosya: genel hata, hiçbir şey yazılmaz
    const again = await ok(stmt(c, 'preview', bank.id, lines));
    expect(again.canCommit).toBe(false);
    expect(again.general[0]).toMatchObject({ code: 'STATEMENT_DUPLICATE' });
    expect(again.counts).toMatchObject({ skip: 7 });
    const commitAgain = await stmt(c, 'commit', bank.id, lines);
    expect(commitAgain.statusCode).toBe(422);
    expect(commitAgain.json().error.code).toBe('IMPORT_INVALID');

    // Çakışan dönem: ilk 3 satır zaten var, 2 yeni satır gelir
    const overlap: Cells[] = [
      ...lines.slice(4),
      { date: trDate(day(4, 2)), description: 'Yeni EFT', reference: 'DKN-8', amount: '100,00', balance: '7.845,50' },
      { date: trDate(day(4, 3)), description: 'Yeni ücret', reference: 'DKN-9', amount: '-5,00', balance: '7.840,50' },
    ];
    const p = await ok(stmt(c, 'preview', bank.id, overlap));
    expect(p.counts).toEqual({ total: 5, ok: 2, skip: 3, error: 0 });
    expect(p.rows[0].messages[0]).toMatchObject({ code: 'DUPLICATE_LINE' });
    const d2 = await ok(stmt(c, 'commit', bank.id, overlap));
    expect(d2.created).toBe(2);
    const after = await recon(c, bank.id, `?from=${day(3, 1)}&to=${day(4, 30)}`);
    expect(after.lines).toHaveLength(9);
    expect(after.statements.map((x) => [x.lineCount, x.closingBalance])).toEqual([[2, '7840.5000'], [7, '7745.5000']]);

    // Aynı gün, aynı tutar, aynı açıklamalı iki gerçek satır dosyada ayrı kalır (sıra numarası anahtarda)
    const twins: Cells[] = [
      { date: trDate(day(5, 4)), description: 'Kart komisyonu', amount: '-12,00' },
      { date: trDate(day(5, 4)), description: 'Kart komisyonu', amount: '-12,00' },
    ];
    expect((await ok(stmt(c, 'commit', bank.id, twins))).created).toBe(2);
    expect((await ok(stmt(c, 'preview', bank.id, [...twins, ...twins.slice(0, 1)]))).counts).toMatchObject({ skip: 2, ok: 1 });
  });

  it('üç tutar biçimi aynı sonucu verir: işaretli sütun, Giriş/Çıkış sütunları, Tutar + Yön', async () => {
    const { c } = await setup('Modlar');
    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'Mod Bankası', currency: 'TRY' }))).account;
    const d = trDate(day(6, 1));
    const signed = await ok(stmt(c, 'preview', bank.id, [{ date: d, description: 'a', amount: '-100,00' }, { date: d, description: 'b', amount: '250,50' }]));
    const split = await ok(stmt(c, 'preview', bank.id, [{ date: d, description: 'a', moneyOut: '100,00' }, { date: d, description: 'b', moneyIn: '250,50' }]));
    const direction = await ok(stmt(c, 'preview', bank.id, [{ date: d, description: 'a', amount: '100,00', direction: 'Borç' }, { date: d, description: 'b', amount: '250,50', direction: 'Alacak' }]));
    for (const p of [signed, split, direction]) {
      expect(p.counts).toMatchObject({ ok: 2, error: 0 });
      expect(p.summary.find((x: any) => x.label.startsWith('Giren toplam')).value).toBe('250,50');
      expect(p.summary.find((x: any) => x.label.startsWith('Çıkan toplam')).value).toBe('100,00');
    }
    // Hatalar: yön yok/bilinmiyor, ikisi birden dolu, tutar yok, bozuk tarih, sıfır tutar atlanır
    const bad = await ok(
      stmt(
        c,
        'preview',
        bank.id,
        [
          { date: d, description: 'x', amount: '10', direction: 'sağa' },
          { date: d, description: 'x', moneyIn: '10', moneyOut: '5' },
          { date: d, description: 'x' },
          { date: 'dün', description: 'x', amount: '1' },
          { date: d, description: 'x', amount: '0' },
          { date: d, description: 'x', amount: '1,234' },
        ],
        { numberFormat: 'auto' },
      ),
    );
    expect([0, 1, 2, 3].map((i) => errorOf(bad, i).code)).toEqual(['DIRECTION_UNKNOWN', 'BOTH_SIDES', 'AMOUNT_REQUIRED', 'INVALID_DATE']);
    expect(bad.rows[4].status).toBe('skip');
    expect(errorOf(bad, 5).code).toBe('AMBIGUOUS_NUMBER'); // "1,234" belirsiz; numberFormat=tr seçilince geçerli olurdu
  });

  it('ekstre yalnızca banka hesabına: kasa, pasif ve bulunmayan hesap genel hata; hatalı satır varsa hiçbir şey yazılmaz', async () => {
    const { c } = await setup('Hesaplar');
    const cash = (await ok(c.post('/api/treasury/accounts', { kind: 'cash', name: 'Ana kasa', currency: 'TRY' }))).account;
    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'Banka', currency: 'TRY' }))).account;
    const row: Cells[] = [{ date: trDate(day(3, 1)), description: 'x', amount: '10,00' }];

    const onCash = await ok(stmt(c, 'preview', cash.id, row));
    expect(onCash.general[0]).toMatchObject({ code: 'NOT_A_BANK_ACCOUNT' });
    expect((await stmt(c, 'commit', cash.id, row)).statusCode).toBe(422);
    expect((await c.get(`/api/treasury/accounts/${cash.id}/reconciliation`)).json().error.code).toBe('NOT_A_BANK_ACCOUNT');
    const missing = await ok(stmt(c, 'preview', randomUUID(), row));
    expect(missing.general[0]).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await ok(c.patch(`/api/treasury/accounts/${bank.id}`, { isActive: false }));
    expect((await ok(stmt(c, 'preview', bank.id, row))).general[0]).toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    await ok(c.patch(`/api/treasury/accounts/${bank.id}`, { isActive: true }));

    const mixed: Cells[] = [...row, { date: trDate(day(3, 2)), description: 'y', amount: '5,00' }, { date: 'bozuk', description: 'z', amount: '1,00' }];
    expect((await stmt(c, 'commit', bank.id, mixed)).statusCode).toBe(422);
    expect((await recon(c, bank.id)).statements).toHaveLength(0);
    expect((await recon(c, bank.id)).lines).toHaveLength(0);
  });

  // --- Öneriler ve eşleştirme ------------------------------------------------------------------------------

  it('mutabakat özeti ve öneriler: kesin/olası/öneri yok; ekstre kapanışı − defter bakiyesi farkı açık kalemlerle açıklanır', async () => {
    const { c, bank, t1, t2, t3, t4, t5, t6 } = await fixture('Oneri');
    const data = await recon(c, bank.id);
    const sug = (desc: string) => lineBy(data, desc).suggestions;

    expect(sug('Sermaye girişi')).toHaveLength(1);
    expect(sug('Sermaye girişi')[0]).toMatchObject({ confidence: 'exact', txnNo: t1.txnNo, dayDiff: 0 });
    expect(sug('HAVALE Demir Çelik')[0]).toMatchObject({ confidence: 'exact', txnNo: t2.txnNo, dayDiff: 1, partyName: 'Demir Çelik A.Ş.' });
    expect(sug('Hesap işletim ücreti')[0]).toMatchObject({ confidence: 'exact', txnNo: t3.txnNo });
    expect(sug('EFT gelen')[0]).toMatchObject({ confidence: 'exact', txnNo: t4.txnNo, dayDiff: 1 });
    // −500: T5 (aynı gün) ve T6 (1 gün sonra) → ikisi de olası, yakın tarihli T5 önde
    expect(sug('Kira ödemesi').map((x) => [x.txnNo, x.confidence])).toEqual([[t5.txnNo, 'probable'], [t6.txnNo, 'probable']]);
    expect(sug('Faiz geliri')).toEqual([]);
    expect(sug('Kart komisyonu')).toEqual([]);

    expect(data.summary).toMatchObject({
      statementClosing: '7745.5000',
      statementClosingDate: day(3, 25),
      ledgerBalance: '7215.0000', // 10.000 − 2.500 − 35 + 750 − 500 − 500
      difference: '530.5000',
      openLines: 7,
      matchedLines: 0,
      unmatchedLedgerCount: 6,
    });
    expect(data.unmatchedLedger.map((x) => x.txnNo)).toEqual([t1, t2, t3, t4, t5, t6].map((t) => t.txnNo));
  });

  it('kesin eşleşmeleri uygula: yalnızca exact öneriler eşleşir, olası olan açık kalır; fark = açık ekstre − eşleşmemiş defter', async () => {
    const { c, bank, t5, t6 } = await fixture('Otomatik');
    const res = await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    expect(res).toMatchObject({ matched: 4, considered: 7 });

    const data = await recon(c, bank.id);
    expect(data.lines.filter((l) => l.status === 'matched').map((l) => l.description)).toEqual(['Sermaye girişi', 'HAVALE Demir Çelik', 'Hesap işletim ücreti', 'EFT gelen']);
    const rent = lineBy(data, 'Kira ödemesi');
    expect(rent.status).toBe('open');
    // Eşleşenlerin bağlı hareketi de kaydedildi
    const first = lineBy(data, 'Sermaye girişi');
    expect(first.match).toMatchObject({ entryDate: day(3, 1), description: expect.stringContaining('Sermaye') });
    expect(first.transactionId).toBeTruthy();
    expect(data.unmatchedLedger.map((x) => x.txnNo)).toEqual([t5.txnNo, t6.txnNo]);
    // Açık ekstre satırları: −500 + 42,50 − 12 = −469,50; eşleşmemiş defter: −1.000 → fark 530,50
    expect(data.summary).toMatchObject({ openLines: 3, openAmount: '-469.5000', unmatchedLedgerAmount: '-1000.0000', difference: '530.5000', matchedLines: 4 });
    expect(dec(data.summary.openAmount).minus(data.summary.unmatchedLedgerAmount).toFixed(4)).toBe(data.summary.difference);

    // Tekrar çalıştırmak yeni bir şey eşleştirmez
    expect((await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}))).matched).toBe(0);
    // Eşleşen satırın ekstresi
    expect((await recon(c, bank.id)).statements[0]).toMatchObject({ matchedCount: 4 });
  });

  it('elle eşleştir / kaldır / yoksay / geri al; hatalı eşleştirmeler reddedilir', async () => {
    const { c, bank, t5, t6 } = await fixture('Elle');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    const data = await recon(c, bank.id);
    const rent = lineBy(data, 'Kira ödemesi');
    const t6Line = rent.suggestions.find((x) => x.txnNo === t6.txnNo)!;

    // Farklı tutarlı ya da başka yönlü defter satırı: veritabanı kuralı reddeder
    const wrongAmount = data.unmatchedLedger.find((x) => x.txnNo === t5.txnNo)!;
    const faiz = lineBy(data, 'Faiz geliri');
    const r1 = await c.post(`/api/bank-statement-lines/${faiz.id}/match`, { journalLineId: wrongAmount.journalLineId });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.code).toBe('BANK_RULE_VIOLATION');

    // Doğru eşleştirme: olası öneriyi kabul et
    const m = await ok(c.post(`/api/bank-statement-lines/${rent.id}/match`, { journalLineId: t6Line.journalLineId }));
    expect(m.line).toMatchObject({ status: 'matched', journalLineId: t6Line.journalLineId });
    expect(m.line.transactionId).toBeTruthy();
    // Aynı defter satırı ikinci bir ekstre satırına verilemez / eşleşmiş satır tekrar eşleştirilemez
    const again = await c.post(`/api/bank-statement-lines/${rent.id}/match`, { journalLineId: t6Line.journalLineId });
    expect(again.json().error.code).toBe('LINE_NOT_OPEN');

    // Kaldır → tekrar açık; yoksay → geri al
    expect((await ok(c.post(`/api/bank-statement-lines/${rent.id}/unmatch`, {}))).line).toMatchObject({ status: 'open', journalLineId: null, transactionId: null });
    expect((await c.post(`/api/bank-statement-lines/${rent.id}/unmatch`, {})).json().error.code).toBe('LINE_NOT_MATCHED');
    const ign = await ok(c.post(`/api/bank-statement-lines/${faiz.id}/ignore`, { reason: 'Kampanya faizi, defterde ayrıca yok' }));
    expect(ign.line).toMatchObject({ status: 'ignored', ignoreReason: 'Kampanya faizi, defterde ayrıca yok' });
    expect((await c.post(`/api/bank-statement-lines/${faiz.id}/match`, { journalLineId: t6Line.journalLineId })).json().error.code).toBe('LINE_NOT_OPEN');
    expect((await recon(c, bank.id)).summary.ignoredLines).toBe(1);
    expect((await ok(c.post(`/api/bank-statement-lines/${faiz.id}/restore`, {}))).line).toMatchObject({ status: 'open', ignoreReason: null });
    expect((await c.post(`/api/bank-statement-lines/${faiz.id}/restore`, {})).json().error.code).toBe('LINE_NOT_IGNORED');
    expect((await c.post(`/api/bank-statement-lines/${randomUUID()}/match`, { journalLineId: t6Line.journalLineId })).statusCode).toBe(404);
  });

  it('ters çevrilmiş fiş çifti aday değil: iptal edilen hareketin satırları ne önerilir ne "eşleşmemiş defter" listesinde çıkar', async () => {
    const { c, bank, t6 } = await fixture('TersCift');
    const before = await recon(c, bank.id);
    expect(before.unmatchedLedger.some((x) => x.txnNo === t6.txnNo)).toBe(true);
    await ok(c.post(`/api/treasury/transactions/${t6.id}/cancel`, { reason: 'Yanlış hesap', date: day(3, 14) }));

    const after = await recon(c, bank.id);
    expect(after.unmatchedLedger.some((x) => x.txnNo === t6.txnNo)).toBe(false);
    expect(after.unmatchedLedger).toHaveLength(5); // yalnızca T1-T5; T6 ve ters kaydı yok
    // −500 satırının artık tek adayı T5: exact
    expect(lineBy(after, 'Kira ödemesi').suggestions.map((x) => [x.txnNo, x.confidence])).toEqual([[expect.stringMatching(/^ODE|DOD/), 'exact']]);
    expect(after.summary.ledgerBalance).toBe('7715.0000'); // iptal defter bakiyesini eski haline getirdi (T6 −500 geri alındı)
  });

  it('eşleşmeyen satırdan hareket oluştur: tarih/tutar/hesap satırdan, yön kontrolü, hareket ve eşleşme aynı işlemde', async () => {
    const { c, bank, ids, supplier } = await fixture('Olustur');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    let data = await recon(c, bank.id);
    const faiz = lineBy(data, 'Faiz geliri'); // +42,50
    const komisyon = lineBy(data, 'Kart komisyonu'); // −12,00

    // Yön uyuşmazlığı ve eksik alanlar
    const wrongDir = await c.post(`/api/bank-statement-lines/${faiz.id}/create-transaction`, { type: 'other_payment', glAccountId: ids['770'] });
    expect(wrongDir.statusCode).toBe(422);
    expect(wrongDir.json().error.code).toBe('LINE_DIRECTION_MISMATCH');
    expect((await c.post(`/api/bank-statement-lines/${faiz.id}/create-transaction`, { type: 'other_receipt' })).statusCode).toBe(400);
    expect((await c.post(`/api/bank-statement-lines/${faiz.id}/create-transaction`, { type: 'receipt' })).statusCode).toBe(400); // cari yok

    const a = await ok(c.post(`/api/bank-statement-lines/${faiz.id}/create-transaction`, { type: 'other_receipt', glAccountId: ids['642'] }));
    expect(a.transaction).toMatchObject({ type: 'other_receipt', amount: '42.5000', txnDate: faiz.txnDate, status: 'posted', description: 'Faiz geliri' });
    expect(a.line).toMatchObject({ status: 'matched', transactionId: a.transaction.id });
    const b = await ok(c.post(`/api/bank-statement-lines/${komisyon.id}/create-transaction`, { type: 'other_payment', glAccountId: ids['770'], description: 'Banka kart komisyonu' }));
    expect(b.transaction).toMatchObject({ type: 'other_payment', amount: '12.0000', description: 'Banka kart komisyonu' });

    // Tedarikçiye ödeme (avans) çıkış satırından
    const extra = await ok(stmt(c, 'commit', bank.id, [{ date: trDate(day(4, 1)), description: 'HAVALE tedarikçi', amount: '-300,00' }]));
    expect(extra.created).toBe(1);
    data = await recon(c, bank.id, `?from=${day(3, 1)}&to=${day(4, 30)}`);
    const pay = lineBy(data, 'HAVALE tedarikçi');
    const p = await ok(c.post(`/api/bank-statement-lines/${pay.id}/create-transaction`, { type: 'payment', partyId: supplier.id }));
    expect(p.transaction).toMatchObject({ type: 'payment', amount: '300.0000' });

    // Mutabakat: yalnız T6 (−500) eşleşmemiş ve Kira ödemesi (olası) açık
    data = await recon(c, bank.id, `?from=${day(3, 1)}&to=${day(3, 31)}`);
    expect(data.summary).toMatchObject({ openLines: 1, unmatchedLedgerCount: 2, matchedLines: 6 });
    // Oluşturulan hareketlerin ekstre satırı yeniden eşleştirilemez / hareket iptal edilemez
    const cancel = await c.post(`/api/treasury/transactions/${a.transaction.id}/cancel`, { reason: 'Deneme', date: day(3, 26) });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('TXN_RECONCILED');
  });

  // --- Korumalar -------------------------------------------------------------------------------------------

  it('eşleşmiş hareket iptal edilemez (TXN_RECONCILED), eşleşmiş fiş ters çevrilemez (ENTRY_RECONCILED); eşleşme kalkınca serbest', async () => {
    const { c, bank, t1, ids } = await fixture('Koruma');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    const data = await recon(c, bank.id);
    const first = lineBy(data, 'Sermaye girişi');

    const cancel = await c.post(`/api/treasury/transactions/${t1.id}/cancel`, { reason: 'Vazgeçildi', date: day(3, 2) });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.code).toBe('TXN_RECONCILED');
    const reverse = await c.post(`/api/journal-entries/${first.match!.entryId}/reverse`, { description: 'Ters', entryDate: day(3, 2) });
    expect(reverse.statusCode).toBe(422);
    // Hareketin yevmiyesi kaynaklıdır (treasury): doğrudan ters kayıt zaten kaynak korumasıyla reddedilir
    expect(reverse.json().error.code).toBe('ENTRY_HAS_SOURCE');

    // Elle yevmiye (banka 102.x borç): eşleştir → ters çevrilemez → eşleşmeyi kaldır → ters çevrilir
    const manual = (
      await ok(
        c.post('/api/journal-entries', {
          entryDate: day(4, 1),
          description: 'Elle banka girişi',
          post: true,
          lines: [
            { accountId: (await ok(c.get('/api/accounts'))).accounts.find((a: any) => a.code === bank.accountCode).id, currency: 'TRY', debit: '77', credit: '0' },
            { accountId: ids['600'], currency: 'TRY', debit: '0', credit: '77' },
          ],
        }),
      )
    ).entry;
    await ok(stmt(c, 'commit', bank.id, [{ date: trDate(day(4, 1)), description: 'Nakit yatırma', amount: '77,00' }]));
    const d2 = await recon(c, bank.id, `?from=${day(4, 1)}&to=${day(4, 30)}`);
    const dep = lineBy(d2, 'Nakit yatırma');
    expect(dep.suggestions[0]).toMatchObject({ confidence: 'exact', entryNo: manual.entryNo });
    await ok(c.post(`/api/bank-statement-lines/${dep.id}/match`, { journalLineId: dep.suggestions[0]!.journalLineId }));
    const blocked = await c.post(`/api/journal-entries/${manual.id}/reverse`, { description: 'Ters', entryDate: day(4, 2) });
    expect(blocked.json().error.code).toBe('ENTRY_RECONCILED');
    await ok(c.post(`/api/bank-statement-lines/${dep.id}/unmatch`, {}));
    expect((await c.post(`/api/journal-entries/${manual.id}/reverse`, { description: 'Ters', entryDate: day(4, 2) })).statusCode).toBe(201);
    // Eşleşme kalkınca T1 de iptal edilebilir
    await ok(c.post(`/api/bank-statement-lines/${first.id}/unmatch`, {}));
    expect((await c.post(`/api/treasury/transactions/${t1.id}/cancel`, { reason: 'Vazgeçildi', date: day(3, 2) })).statusCode).toBe(200);
  });

  it('ekstreyi geri al: eşleşmemiş ekstre silinir (satırları da), eşleşmiş satırı olan silinemez; sonra aynı dosya yeniden alınabilir', async () => {
    const { c, bank, lines } = await fixture('GeriAl');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    const st = (await recon(c, bank.id)).statements[0]!;
    const blocked = await c.delete(`/api/bank-statements/${st.id}`);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('STATEMENT_HAS_MATCHES');
    for (const l of (await recon(c, bank.id)).lines.filter((x) => x.status === 'matched')) await ok(c.post(`/api/bank-statement-lines/${l.id}/unmatch`, {}));
    expect((await c.delete(`/api/bank-statements/${st.id}`)).json()).toEqual({ ok: true });
    const empty = await recon(c, bank.id);
    expect(empty.statements).toHaveLength(0);
    expect(empty.lines).toHaveLength(0);
    expect((await c.delete(`/api/bank-statements/${st.id}`)).statusCode).toBe(404);
    expect((await ok(stmt(c, 'commit', bank.id, lines))).created).toBe(7);
  });

  it('DB kuralları (ERP06): satır içeriği değişmez; yanlış hesap/tutar/ters fiş reddedilir; eşleşmiş satır silinemez; başlık değişmez', async () => {
    const { s, company, c, bank, t5, t6 } = await fixture('ERP06');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    // Aynı tutar/tarihli ikinci −500 satırı: "Kira ödemesi" T5'e eşleşir, ikiz satır aynı defter satırına raw SQL ile bağlanmaya çalışılır
    await ok(stmt(c, 'commit', bank.id, [{ date: trDate(day(3, 12)), description: 'İkiz satır', amount: '-500,00' }]));
    const data = await recon(c, bank.id);
    const sermaye = lineBy(data, 'Sermaye girişi'); // eşleşmiş
    const kira = lineBy(data, 'Kira ödemesi'); // −500 (T5'e eşleştirilecek)
    const ikiz = lineBy(data, 'İkiz satır'); // −500, açık kalır
    const faiz = lineBy(data, 'Faiz geliri'); // +42,50, açık
    const t5Line = data.unmatchedLedger.find((x) => x.txnNo === t5.txnNo)!;
    const t6JournalLine = data.unmatchedLedger.find((x) => x.txnNo === t6.txnNo)!.journalLineId;
    // T6'yı iptal et: orijinal fiş artık ters çevrilmiş
    await ok(c.post(`/api/treasury/transactions/${t6.id}/cancel`, { reason: 'Deneme', date: day(3, 14) }));
    await ok(c.post(`/api/bank-statement-lines/${kira.id}/match`, { journalLineId: t5Line.journalLineId }));
    const orgId = await orgOf(app, s.token);
    const st = data.statements[0]!;
    const matchSql = `update bank_statement_lines set status = 'matched', journal_line_id = $2, matched_at = now() where id = $1`;
    const match = (line: string, ledgerLine: string): [string, unknown[]] => [matchSql, [line, ledgerLine]];

    await asDb(handle, { userId: s.userId, orgId, companyId: company.id }, async (q) => {
      // İçerik değişmez
      expect((await expectDbError(q, `update bank_statement_lines set amount = 1 where id = $1`, [ikiz.id])).code).toBe('ERP06');
      expect((await expectDbError(q, `update bank_statement_lines set description = 'x' where id = $1`, [ikiz.id])).code).toBe('ERP06');
      expect((await expectDbError(q, `update bank_statement_lines set txn_date = txn_date + 1 where id = $1`, [ikiz.id])).code).toBe('ERP06');
      // Defter satırı olmadan "eşleşti" olamaz
      expect((await expectDbError(q, `update bank_statement_lines set status = 'matched' where id = $1`, [ikiz.id])).code).toBe('ERP06');
      // Tutar/işaret uyuşmuyor: +42,50 ekstre satırına −500 defter satırı; −500 ekstre satırına +10.000 defter satırı
      expect((await expectDbError(q, ...match(faiz.id, t5Line.journalLineId))).code).toBe('ERP06');
      expect((await expectDbError(q, ...match(ikiz.id, sermaye.journalLineId!))).code).toBe('ERP06');
      // Ters çevrilmiş fişin satırı (tutar uyuşsa bile)
      expect((await expectDbError(q, ...match(ikiz.id, t6JournalLine))).code).toBe('ERP06');
      // Başka hesabın satırı: sermaye fişinin 500 alacak satırı
      const other = await q(
        `select l.id from journal_lines l join accounts a on a.id = l.account_id
          where l.entry_id = (select entry_id from journal_lines where id = $1) and a.code = '500'`,
        [sermaye.journalLineId!],
      );
      expect((await expectDbError(q, ...match(ikiz.id, other.rows[0].id))).code).toBe('ERP06');
      // Eşleşmiş satır: silinemez, eşleşmesi değiştirilemez, doğrudan yoksayılamaz
      expect((await expectDbError(q, `delete from bank_statement_lines where id = $1`, [sermaye.id])).code).toBe('ERP06');
      expect((await expectDbError(q, `update bank_statement_lines set journal_line_id = $2 where id = $1`, [sermaye.id, t5Line.journalLineId])).code).toBe('ERP06');
      expect((await expectDbError(q, `update bank_statement_lines set status = 'ignored', journal_line_id = null, matched_at = null where id = $1`, [sermaye.id])).code).toBe('ERP06');
      // Aynı defter satırı ikinci bir ekstre satırıyla eşleşemez (tekil dizin; tetikleyici kuralları geçse bile)
      expect((await expectDbError(q, ...match(ikiz.id, t5Line.journalLineId))).code).toBe('23505');
      // Ekstre aralığı dışında satır eklenemez
      expect(
        (
          await expectDbError(
            q,
            `insert into bank_statement_lines (id, company_id, statement_id, account_id, line_no, txn_date, description, amount, currency_code, dedupe_key)
             values (gen_random_uuid(), $1, $2, $3, 99, $4, 'x', 10, 'TRY', 'zzz')`,
            [company.id, st.id, bank.id, day(8, 1)],
          )
        ).code,
      ).toBe('ERP06');
      // Ekstre başlığı: erp_app güncelleyemez (yetki); eşleşmiş satırı olan ekstre silinemez
      expect((await expectDbError(q, `update bank_statements set file_name = 'x' where id = $1`, [st.id])).code).toBe('42501');
      expect((await expectDbError(q, `delete from bank_statements where id = $1`, [st.id])).code).toBe('ERP06');
    });

    // Sahip bağlantısı (yetki kısıtı yok): başlık güncellemesi yine tetikleyiciyle reddedilir
    await asOwner(async (q) => {
      expect((await expectDbError(q, `update bank_statements set file_name = 'x' where id = $1`, [st.id])).code).toBe('ERP06');
    });
  });

  it('DB: eşleşmiş satırı olan fişin doğrudan ters bağlanması ERP06 ile reddedilir (ERP01 tetikleyicisi kapalıyken bile)', async () => {
    const { c, bank } = await fixture('FisKoruma');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    const first = lineBy(await recon(c, bank.id), 'Sermaye girişi');
    await asOwner(async (q) => {
      // Defter kuralı (ERP01) kapatılınca ikinci savunma (eşleşme koruması) tek başına devrede
      await q('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_guard');
      const other = await q(`select id from journal_entries where id <> $1 and status = 'posted' and company_id = (select company_id from journal_entries where id = $1) limit 1`, [first.match!.entryId]);
      const err = await expectDbError(q, `update journal_entries set reversed_by_id = $2 where id = $1`, [first.match!.entryId, other.rows[0].id]);
      expect(err.code).toBe('ERP06');
    });
  });

  // --- Eşzamanlılık ----------------------------------------------------------------------------------------

  it('eşzamanlılık: aynı defter satırını iki ekstre satırına aynı anda eşleştirme → yalnızca biri başarılı', async () => {
    const { c, bank } = await fixture('Yaris');
    // İki ekstre satırı daha: aynı tutar/tarih (−500, 03-12) → ikisi de T5'e adaydır
    await ok(stmt(c, 'commit', bank.id, [{ date: trDate(day(3, 12)), description: 'İkiz ödeme A', amount: '-500,00' }, { date: trDate(day(3, 12)), description: 'İkiz ödeme B', amount: '-500,00' }]));
    const data = await recon(c, bank.id);
    const a = lineBy(data, 'İkiz ödeme A');
    const b = lineBy(data, 'İkiz ödeme B');
    const target = a.suggestions[0]!.journalLineId;
    const [ra, rb] = await Promise.all([
      c.post(`/api/bank-statement-lines/${a.id}/match`, { journalLineId: target }),
      c.post(`/api/bank-statement-lines/${b.id}/match`, { journalLineId: target }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const after = await recon(c, bank.id);
    expect(after.lines.filter((l) => l.journalLineId === target)).toHaveLength(1);
  });

  // --- Yetki, yalıtım, dışa aktarma, dövizli hesap ---------------------------------------------------------

  it('yetkiler: izleyici okur ve dışa aktarır ama eşleştiremez/içe aktaramaz/geri alamaz; satış ve şantiye sorumlusu erişemez; muhasebeci tam', async () => {
    const { c, company, bank, lines } = await fixture('Yetki');
    const viewer = await memberClient(c, company.id, 'viewer');
    const sales = await memberClient(c, company.id, 'sales');
    const site = await memberClient(c, company.id, 'site_manager');
    const accountant = await memberClient(c, company.id, 'accountant');
    const data = await recon(c, bank.id);
    const line = data.lines[0]!;
    const st = data.statements[0]!;

    expect((await viewer.get(`/api/treasury/accounts/${bank.id}/reconciliation`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/exports/bank-reconciliation?accountId=${bank.id}&format=csv`)).statusCode).toBe(200);
    const writes = [
      viewer.post(`/api/bank-statement-lines/${line.id}/match`, { journalLineId: line.suggestions[0]!.journalLineId }),
      viewer.post(`/api/bank-statement-lines/${line.id}/ignore`, {}),
      viewer.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}),
      viewer.delete(`/api/bank-statements/${st.id}`),
      viewer.post('/api/imports/bank_statement/preview', { rows: rowsOf(lines), options: { accountId: bank.id } }),
      viewer.post(`/api/bank-statement-lines/${line.id}/create-transaction`, { type: 'other_receipt', glAccountId: randomUUID() }),
    ];
    for (const r of await Promise.all(writes)) expect(r.statusCode).toBe(403);
    for (const other of [sales, site]) {
      expect((await other.get(`/api/treasury/accounts/${bank.id}/reconciliation`)).statusCode).toBe(403);
      expect((await other.get(`/api/exports/bank-reconciliation?accountId=${bank.id}`)).statusCode).toBe(403);
      expect((await other.post('/api/imports/bank_statement/preview', { rows: rowsOf(lines), options: { accountId: bank.id } })).statusCode).toBe(403);
    }
    expect((await accountant.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {})).statusCode).toBe(200);
  });

  it('şirketler arası yalıtım: başka şirketin banka hesabı ve ekstre satırları görünmez/işlenemez', async () => {
    const mine = await fixture('Yalitim1');
    const other = await setup('Yalitim2');
    const data = await recon(mine.c, mine.bank.id);
    const line = data.lines[0]!;
    expect((await other.c.get(`/api/treasury/accounts/${mine.bank.id}/reconciliation`)).statusCode).toBe(404);
    expect((await other.c.post(`/api/bank-statement-lines/${line.id}/ignore`, {})).statusCode).toBe(404);
    expect((await other.c.post(`/api/bank-statement-lines/${line.id}/match`, { journalLineId: line.suggestions[0]!.journalLineId })).statusCode).toBe(404);
    expect((await other.c.delete(`/api/bank-statements/${data.statements[0]!.id}`)).statusCode).toBe(404);
    const preview = await ok(other.c.post('/api/imports/bank_statement/preview', { rows: rowsOf([{ date: trDate(day(3, 1)), amount: '1,00' }]), options: { accountId: mine.bank.id } }));
    expect(preview.general[0]).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('dışa aktarma: iki sayfa (ekstre satırları, eşleşmemiş defter), durum etiketleri ve toplamlar; CSV ekstre satırları', async () => {
    const { c, bank } = await fixture('Disa');
    await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}));
    const res = await c.get(`/api/exports/bank-reconciliation?accountId=${bank.id}&format=xlsx`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="banka-mutabakati-baslangic_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const sheets = readXlsx(new Uint8Array(res.rawPayload));
    expect(sheets.map((x) => x.name)).toEqual(['Ekstre satırları', 'Eşleşmemiş defter']);
    const statusOf = (desc: string) => sheets[0]!.rows.find((r) => r.includes(desc))!.slice(0, 8);
    expect(statusOf('Sermaye girişi')[4]).toBe('Eşleşti');
    expect(statusOf('Kira ödemesi')[4]).toBe('Açık');
    expect(sheets[1]!.rows.filter((r) => r[3]?.startsWith('DOD')).length).toBe(2); // T5, T6 eşleşmemiş

    const csv = await c.get(`/api/exports/bank-reconciliation?accountId=${bank.id}&format=csv`);
    expect(csv.body).toContain('"Faiz geliri";"DKN-6"');
    expect(csv.body).toContain('"Açık"');
  });

  it('dövizli banka hesabı: ekstre hesap para biriminde, defter satırı belge tutarıyla eşleşir', async () => {
    const { c, s, company } = await setup('Doviz');
    const ids = await accountIds(app, s.token, company.id);
    await ok(c.put('/api/exchange-rates', { rateDate: day(3, 1), currencyCode: 'GBP', quoteCode: 'TRY', buy: '45' }));
    const bank = (await ok(c.post('/api/treasury/accounts', { kind: 'bank', name: 'KTB GBP', currency: 'GBP' }))).account;
    await ok(c.post('/api/treasury/transactions', { type: 'other_receipt', date: day(3, 2), accountId: bank.id, amount: '100', glAccountId: ids['500'], description: 'Sermaye GBP', fxRate: '45' }));
    await ok(stmt(c, 'commit', bank.id, [{ date: trDate(day(3, 2)), description: 'Gelen havale', amount: '100,00' }]));
    const data = await recon(c, bank.id);
    expect(data.account.currencyCode).toBe('GBP');
    expect(data.lines[0]!.suggestions[0]).toMatchObject({ confidence: 'exact' });
    expect((await ok(c.post(`/api/treasury/accounts/${bank.id}/reconciliation/auto-match`, {}))).matched).toBe(1);
    expect((await recon(c, bank.id)).summary).toMatchObject({ ledgerBalance: '100.0000', matchedLines: 1, unmatchedLedgerCount: 0 });
  });
});
