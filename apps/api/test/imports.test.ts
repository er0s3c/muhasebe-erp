import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IMPORT_FIELDS, IMPORT_LIMITS } from '@erp/shared';
import type { ReportTable } from '../src/files/table';
import { writeXlsx } from '../src/files/xlsx-write';
import { readXlsx } from '../src/files/xlsx-read';
import { suggestMapping } from '../src/modules/imports/mapping';
import { detectDelimiter, parseDelimited, readTable, splitHeader } from '../src/modules/imports/table';
import { foldKey, parseDate, parseDecimal, parseInteger } from '../src/modules/imports/values';
import { PASSWORD, client, createCompany, makeApp, registerUser } from './helpers';

/** windows-1254 (Türkçe Excel'in eski CSV kod sayfası): yalnızca Türkçe harfleri eşler, gerisi ASCII. */
const CP1254: Record<string, number> = { Ü: 0xdc, ü: 0xfc, Ç: 0xc7, ç: 0xe7, Ğ: 0xd0, ğ: 0xf0, İ: 0xdd, ı: 0xfd, Ö: 0xd6, ö: 0xf6, Ş: 0xde, ş: 0xfe };
const cp1254 = (s: string) => Uint8Array.from([...s].map((ch) => CP1254[ch] ?? ch.charCodeAt(0)));
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const expectAppError = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`${code} hatası bekleniyordu`);
};

describe('içe aktarma: CSV/xlsx okuyucu', () => {
  it('ayraç otomatik: ; , sekme; tırnaklı alan, çift tırnak, tırnak içinde satır sonu, CRLF, boş satır', () => {
    const csv = 'Ünvan;Not;Tutar\r\n"Demir; Çelik A.Ş.";"iki ""tırnaklı""\nsatır";1.234,50\r\n\r\nAli;;10\r\n';
    expect(detectDelimiter(csv)).toBe(';');
    const rows = parseDelimited(csv, ';');
    expect(rows.map((r) => r.cells)).toEqual([
      ['Ünvan', 'Not', 'Tutar'],
      ['Demir; Çelik A.Ş.', 'iki "tırnaklı"\nsatır', '1.234,50'],
      ['Ali', '', '10'],
    ]);
    // Boş kayıt atlanır ama satır numarası ilerler
    expect(rows.map((r) => r.no)).toEqual([1, 2, 4]);

    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    // Tırnak içindeki ayraçlar sayılmaz
    expect(detectDelimiter('"a;b;c";d;e\n')).toBe(';');
  });

  it('kodlama: UTF-8 BOM, UTF-8, UTF-16 BOM ve windows-1254 Türkçe harfleri bozmaz', () => {
    const text = 'Ünvan;Şehir\nÇelik Ağı;İzmir\nŞişe;Iğdır\n';
    const expected = [
      ['Ünvan', 'Şehir'],
      ['Çelik Ağı', 'İzmir'],
      ['Şişe', 'Iğdır'],
    ];
    const cells = (bytes: Uint8Array) => readTable(bytes, 'a.csv').rows.map((r) => r.cells);
    expect(cells(utf8(text))).toEqual(expected);
    expect(cells(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]))).toEqual(expected);
    // windows-1254: geçerli UTF-8 değildir, kod sayfası olarak çözülür
    expect(cells(cp1254(text))).toEqual(expected);
    const utf16 = Buffer.from(text, 'utf16le');
    expect(cells(new Uint8Array([0xff, 0xfe, ...utf16]))).toEqual(expected);
  });

  it('tavanlar ve bozuk dosyalar: satır, sütun, hücre, kapanmamış tırnak, eski .xls, boş dosya, büyük dosya', () => {
    const many = ['a;b', ...Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => `${i};x`)].join('\n');
    expectAppError(() => readTable(utf8(many), 'a.csv'), 'IMPORT_TOO_MANY_ROWS');
    // Tam sınırda kabul edilir
    const exact = ['a;b', ...Array.from({ length: IMPORT_LIMITS.maxRows }, (_, i) => `${i};x`)].join('\n');
    expect(readTable(utf8(exact), 'a.csv').rows).toHaveLength(IMPORT_LIMITS.maxRows + 1);

    expectAppError(() => readTable(utf8(Array.from({ length: IMPORT_LIMITS.maxCols + 1 }, (_, i) => `c${i}`).join(';')), 'a.csv'), 'IMPORT_TOO_MANY_COLUMNS');
    expectAppError(() => readTable(utf8(`a;b\n${'x'.repeat(IMPORT_LIMITS.maxCellChars + 1)};1`), 'a.csv'), 'IMPORT_CELL_TOO_LONG');
    expectAppError(() => readTable(utf8('a;b\n"kapanmayan;1'), 'a.csv'), 'IMPORT_FILE_INVALID');
    expectAppError(() => readTable(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'eski.xls'), 'IMPORT_FORMAT_UNSUPPORTED');
    expectAppError(() => readTable(new Uint8Array(), 'a.csv'), 'IMPORT_FILE_EMPTY');
    expectAppError(() => readTable(new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1).fill(65), 'a.csv'), 'IMPORT_FILE_TOO_LARGE');
    expectAppError(() => readTable(utf8('bu bir xlsx değil'), 'a.xlsx'), 'IMPORT_FILE_INVALID');
    // Yalnızca başlık: veri yok
    expectAppError(() => splitHeader(readTable(utf8('a;b\n'), 'a.csv')), 'IMPORT_FILE_EMPTY');
  });

  it('xlsx: sayfa seçimi, sayı hücresi kanonik ondalık, tarih hücresi ISO, baştaki sıfırlı metin korunur', () => {
    const table = (title: string, rows: ReportTable['rows']): ReportTable => ({
      key: title,
      title,
      columns: [
        { key: 'kod', label: 'Kod', kind: 'text' },
        { key: 'tarih', label: 'Tarih', kind: 'date' },
        { key: 'tutar', label: 'Tutar', kind: 'money' },
      ],
      rows,
    });
    const bytes = writeXlsx([
      table('Birinci', [{ kod: '007', tarih: '2026-01-05', tutar: '1234.5' }]),
      table('İkinci', [{ kod: 'B-2', tarih: '2026-02-10', tutar: '0.25' }]),
    ]);
    const first = readTable(bytes, 'a.xlsx');
    expect(first.format).toBe('xlsx');
    expect(first.sheets).toEqual(['Birinci', 'İkinci']);
    const data = splitHeader(first, 'parties');
    expect(data.headers).toEqual(['Kod', 'Tarih', 'Tutar']);
    expect(data.rows[0]!.cells).toEqual(['007', '2026-01-05', '1234.5']);
    expect(data.suggestedNumberFormat).toBe('en');
    expect(splitHeader(readTable(bytes, 'a.xlsx', 'İkinci'), 'parties').rows[0]!.cells).toEqual(['B-2', '2026-02-10', '0.25']);
    expectAppError(() => readTable(bytes, 'a.xlsx', 'Yok'), 'IMPORT_SHEET_NOT_FOUND');
    // Yazıcı ve okuyucu tutarlı: aynı baytlar readXlsx ile de okunur
    expect(readXlsx(bytes)).toHaveLength(2);
  });
});

describe('içe aktarma: değer ayrıştırma', () => {
  it('tarih biçimleri: gg.aa.yyyy, gg/aa/yyyy, yyyy-aa-gg, seri no, saatli; geçersizler ve belirsiz yıl reddedilir', () => {
    for (const [text, iso] of [
      ['05.01.2026', '2026-01-05'],
      ['5/1/2026', '2026-01-05'],
      ['05-01-2026', '2026-01-05'],
      ['2026-01-05', '2026-01-05'],
      ['2026/01/05', '2026-01-05'],
      ['20260105', '2026-01-05'],
      ['2026-01-05 00:00:00', '2026-01-05'],
      ['46027', '2026-01-05'],
    ] as const) {
      expect(parseDate(text), text).toEqual({ ok: true, value: iso });
    }
    for (const bad of ['', '31.02.2026', '05.13.2026', '05.01.26', 'dün', '2026-1', '12']) {
      expect(parseDate(bad).ok, bad).toBe(false);
    }
  });

  it('sayı: Türkçe, İngilizce, otomatik; belirsiz "1.234" reddedilir; eksi biçimleri; ondalık ve büyüklük sınırı', () => {
    const p = (text: string, fmt: 'auto' | 'tr' | 'en', maxDp = 2, allowNegative = false) => parseDecimal(text, fmt, { maxDp, allowNegative });
    const val = (r: ReturnType<typeof p>) => (r.ok ? r.value : `HATA:${r.code}`);

    expect(val(p('1.234,56', 'tr'))).toBe('1234.56');
    expect(val(p('1234,5', 'tr'))).toBe('1234.5');
    expect(val(p('12.345.678,9', 'tr'))).toBe('12345678.9');
    expect(val(p('12.5', 'tr'))).toBe('HATA:INVALID_NUMBER');
    expect(val(p('1,234.56', 'en'))).toBe('1234.56');
    expect(val(p('1234.5', 'en'))).toBe('1234.5');
    expect(val(p('1,5', 'en'))).toBe('HATA:INVALID_NUMBER');

    // Otomatik: iki ayraç → sonuncusu ondalık
    expect(val(p('1.234,56', 'auto'))).toBe('1234.56');
    expect(val(p('1,234.56', 'auto'))).toBe('1234.56');
    expect(val(p('1.234.567', 'auto'))).toBe('1234567');
    expect(val(p('1,234,567', 'auto'))).toBe('1234567');
    expect(val(p('0,5', 'auto'))).toBe('0.5');
    expect(val(p('12.5', 'auto'))).toBe('12.5');
    expect(val(p('1500', 'auto'))).toBe('1500');
    // Tek ayraç + tam 3 hane belirsizdir: sessizce yanlış okunmaz
    expect(val(p('1.234', 'auto'))).toBe('HATA:AMBIGUOUS_NUMBER');
    expect(val(p('1,234', 'auto'))).toBe('HATA:AMBIGUOUS_NUMBER');
    // ...ama biçim seçilince kesinleşir
    expect(val(p('1.234', 'tr'))).toBe('1234');
    expect(val(p('1.234', 'en', 3))).toBe('1.234');
    // 4 haneli tam kısım belirsiz değildir
    expect(val(p('1234.567', 'auto', 3))).toBe('1234.567');

    expect(val(p('₺ 1.000,00', 'tr'))).toBe('1000');
    expect(val(p('-5,00', 'tr'))).toBe('HATA:NEGATIVE_NOT_ALLOWED');
    expect(val(p('-5,00', 'tr', 2, true))).toBe('-5');
    expect(val(p('(5,00)', 'tr', 2, true))).toBe('-5');
    expect(val(p('5,00-', 'tr', 2, true))).toBe('-5');
    expect(val(p('0,00', 'tr', 2, true))).toBe('0');
    expect(val(p('10,123', 'tr'))).toBe('HATA:TOO_MANY_DECIMALS');
    expect(val(p('10,120', 'tr'))).toBe('10.12'); // sondaki sıfır ondalık sayılmaz
    for (const bad of ['', 'abc', '1e5', '1,2,3,4', '--5', '1..2', ',5']) expect(p(bad, 'auto').ok, bad).toBe(false);
    expect(val(p('1000000000000000', 'tr'))).toBe('HATA:NUMBER_TOO_LARGE');
  });

  it('tam sayı ve ad anahtarı', () => {
    expect(parseInteger('30', 0, 365)).toEqual({ ok: true, value: 30 });
    expect(parseInteger('30.0', 0, 365)).toEqual({ ok: true, value: 30 });
    expect(parseInteger('400', 0, 365).ok).toBe(false);
    expect(parseInteger('3,5', 0, 365).ok).toBe(false);
    expect(foldKey('Çelik İnşaat Ş.A.')).toBe('celikinsaatsa');
    expect(foldKey('m²')).toBe('m2');
    expect(foldKey('ÇUVAL')).toBe('cuval');
  });

  it('sütun eşleme önerisi: Türkçe/büyük harf/aksansız başlıklar, her sütun bir kez', () => {
    const m = suggestMapping('parties', ['CARİ KODU', 'Unvan / Ad Soyad', 'VERGI NO', 'Vergi Dairesi', 'Tel', 'E-Posta', 'Bilinmeyen', 'Vade']);
    expect(m.code).toBe(0);
    expect(m.name).toBe(1);
    expect(m.taxNumber).toBe(2);
    expect(m.taxOffice).toBe(3);
    expect(m.phone).toBe(4);
    expect(m.email).toBe(5);
    expect(m.paymentTermDays).toBe(7);
    expect(m.notes).toBeNull();

    const o = suggestMapping('party_openings', ['Cari Kodu', 'Borç Bakiyesi', 'Alacak Bakiyesi', 'Bakiye', 'Bakiye Türü']);
    expect([o.party, o.debit, o.credit, o.amount, o.side]).toEqual([0, 1, 2, 3, 4]);

    // Şablonun kendi başlıkları her zaman eşleşir
    for (const kind of ['parties', 'items', 'party_openings', 'stock_openings', 'ledger_openings'] as const) {
      const labels = IMPORT_FIELDS[kind].map((f) => f.label);
      const mapping = suggestMapping(kind, labels);
      IMPORT_FIELDS[kind].forEach((f, i) => expect(mapping[f.key], `${kind}.${f.key}`).toBe(i));
    }
  });
});

describe('içe aktarma: cari ve stok kartları', async () => {
  const { app } = await makeApp();

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
  const run = (c: C, kind: string, action: 'preview' | 'commit', list: readonly Cells[], options: Record<string, unknown> = {}) =>
    c.post(`/api/imports/${kind}/${action}`, { rows: rowsOf(list), options });
  const partyCodes = async (c: C) => ((await ok(c.get('/api/parties?limit=500'))).parties as { code: string; name: string }[]).map((p) => p.code).sort();

  it('parse: CSV (BOM, ;, Türkçe) ve xlsx dosyası satırları, başlıkları ve eşleme önerisini döndürür', async () => {
    const { c } = await setup('Parse');
    const csv = '﻿Cari Kodu;Ünvan / Ad Soyad;Vergi No;Vade\nCR-100;Çelik Ağı Ltd.;1234567890;30\n;Şişe A.Ş.;;\n';
    const res = await ok(c.post('/api/imports/parties/parse', { fileName: 'cariler.csv', contentBase64: b64(utf8(csv)) }));
    expect(res.format).toBe('csv');
    expect(res.headers).toEqual(['Cari Kodu', 'Ünvan / Ad Soyad', 'Vergi No', 'Vade']);
    expect(res.rows).toEqual([
      { no: 2, cells: ['CR-100', 'Çelik Ağı Ltd.', '1234567890', '30'] },
      { no: 3, cells: ['', 'Şişe A.Ş.', '', ''] },
    ]);
    expect(res.suggestedMapping).toMatchObject({ code: 0, name: 1, taxNumber: 2, paymentTermDays: 3, kind: null });
    expect(res.suggestedNumberFormat).toBe('auto');

    // Aynı içerik windows-1254 olarak da doğru okunur
    const legacy = await ok(c.post('/api/imports/parties/parse', { fileName: 'eski.csv', contentBase64: b64(cp1254(csv.replace('﻿', ''))) }));
    expect(legacy.rows[0].cells[1]).toBe('Çelik Ağı Ltd.');

    const xlsx = writeXlsx([
      { key: 'c', title: 'Cariler', columns: [{ key: 'a', label: 'Ünvan', kind: 'text' }, { key: 'b', label: 'Telefon', kind: 'text' }], rows: [{ a: 'Excel Ltd.', b: '0392 222 00 00' }] },
    ]);
    const x = await ok(c.post('/api/imports/parties/parse', { fileName: 'cariler.xlsx', contentBase64: b64(xlsx) }));
    expect(x.format).toBe('xlsx');
    expect(x.sheets).toEqual(['Cariler']);
    expect(x.rows[0].cells).toEqual(['Excel Ltd.', '0392 222 00 00']);
    expect(x.suggestedNumberFormat).toBe('en');
    expect(x.suggestedMapping).toMatchObject({ name: 0, phone: 1 });

    // Bozuk ve büyük dosyalar
    const bad = await c.post('/api/imports/parties/parse', { fileName: 'x.xlsx', contentBase64: b64(utf8('değil')) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('IMPORT_FILE_INVALID');
    const big = await c.post('/api/imports/parties/parse', { fileName: 'x.csv', contentBase64: 'A'.repeat(Math.ceil((IMPORT_LIMITS.maxFileBytes * 4) / 3) + 100) });
    expect(big.statusCode).toBe(422);
    expect(big.json().error.code).toBe('IMPORT_FILE_TOO_LARGE');
  });

  it('cari kartları: ön izleme ile içe aktarma aynı sonucu verir; mevcut kod ve yinelenen vergi no atlanır; kodsuz satırlar açık kodları atlayarak numaralanır', async () => {
    const { c } = await setup('Cari');
    await ok(c.post('/api/parties', { name: 'Vergili Ltd.', taxNumber: '9999999999' })); // otomatik CR-000001
    await ok(c.post('/api/parties', { name: 'Mevcut Cari', code: 'CR-000050' }));

    const list = [
      { code: 'CR-000002', name: 'Açık Kodlu Ltd.', kind: 'Tedarikçi', taxNumber: '1111111111', currencyCode: 'gbp', paymentTermDays: '30', creditLimit: '50.000,00', email: 'a@ornek.com' },
      { name: 'Kodsuz Müşteri', kind: 'müşteri', phone: '0392 111' },
      { name: 'Kodsuz İkisi', kind: 'Her ikisi' },
      { code: 'CR-000050', name: 'Var Olan Kod' }, // mevcut kod → atla
      { name: 'Aynı Vergi No', taxNumber: '9999999999' }, // mevcut vergi no → atla
      { name: 'Dosyada Tekrar', taxNumber: '1111111111' }, // dosyada önceki satırla aynı vergi no → atla
      { name: 'Mevcut Cari' }, // aynı ünvan: uyarı, yine de oluşur
    ];
    const preview = await ok(run(c, 'parties', 'preview', list));
    expect(preview.counts).toEqual({ total: 7, ok: 4, skip: 3, error: 0 });
    expect(preview.canCommit).toBe(true);
    expect(preview.rows.map((r: any) => r.status)).toEqual(['ok', 'ok', 'ok', 'skip', 'skip', 'skip', 'ok']);
    expect(preview.rows[6].messages[0]).toMatchObject({ severity: 'warning', code: 'SAME_NAME' });
    expect(await partyCodes(c)).toHaveLength(2); // ön izleme hiçbir şey yazmaz

    const done = await ok(run(c, 'parties', 'commit', list));
    expect(done).toMatchObject({ kind: 'parties', created: preview.counts.ok, skipped: preview.counts.skip });
    // Kodsuz satırlar sıradaki boş kodları alır: CR-000002 (dosyadaki açık kod) atlanır
    expect(await partyCodes(c)).toEqual(['CR-000001', 'CR-000002', 'CR-000003', 'CR-000004', 'CR-000005', 'CR-000050']);

    const parties = (await ok(c.get('/api/parties?limit=500'))).parties as any[];
    expect(parties.find((p) => p.code === 'CR-000002')).toMatchObject({ name: 'Açık Kodlu Ltd.', kind: 'supplier', currencyCode: 'GBP', creditLimit: '50000.0000' });
    expect(parties.find((p) => p.name === 'Kodsuz İkisi').kind).toBe('both');
    expect(parties.find((p) => p.name === 'Kodsuz Müşteri').phone).toBe('0392 111');
    expect(parties.filter((p) => p.name === 'Mevcut Cari')).toHaveLength(2);
  });

  it('cari kartları: yinelenen satırlar "hata" modunda hata olur; geçersiz alanlar Türkçe ve alan bazında bildirilir', async () => {
    const { c } = await setup('CariHata');
    await ok(c.post('/api/parties', { name: 'Var', code: 'CR-000009' }));
    const list = [
      { code: 'CR-000009', name: 'Yinelenen' },
      { name: 'X' },
      { name: 'Geçersiz E-posta', email: 'ali@' },
      { name: 'Geçersiz Tür', kind: 'komşu' },
      { name: 'Geçersiz Para Birimi', currencyCode: 'JPY' },
      { name: 'Geçersiz Vade', paymentTermDays: '400' },
      { name: 'Belirsiz Limit', creditLimit: '1.234' },
      { name: 'Kötü Kod', code: 'CR 1' },
    ];
    const preview = await ok(run(c, 'parties', 'preview', list, { skipDuplicates: false }));
    expect(preview.counts).toMatchObject({ total: 8, ok: 0, error: 8 });
    expect(preview.canCommit).toBe(false);
    const fields = preview.rows.map((r: any) => r.messages.find((m: any) => m.severity === 'error').field);
    expect(fields).toEqual(['code', 'name', 'email', 'kind', 'currencyCode', 'paymentTermDays', 'creditLimit', 'code']);
    expect(preview.rows[6].messages[0].code).toBe('AMBIGUOUS_NUMBER');
    // "Sayı biçimi" seçilince aynı satır geçerli olur
    const tr = await ok(run(c, 'parties', 'preview', [list[6]!], { numberFormat: 'tr' }));
    expect(tr.counts.ok).toBe(1);

    const commit = await run(c, 'parties', 'commit', list, { skipDuplicates: false });
    expect(commit.statusCode).toBe(422);
    expect(commit.json().error.code).toBe('IMPORT_INVALID');
    expect(commit.json().error.details.errorRows).toBe(8);
    expect(commit.json().error.details.rows[0]).toMatchObject({ row: 2, messages: [{ field: 'code', code: 'DUPLICATE' }] });
  });

  it('atomiklik: son satır hatalıysa hiçbir cari yazılmaz ve numara sayacı geri döner', async () => {
    const { c } = await setup('Atomik');
    const list = [{ name: 'Birinci Ltd.' }, { name: 'İkinci Ltd.' }, { name: 'Üçüncü Ltd.', email: 'bozuk' }];
    const res = await run(c, 'parties', 'commit', list);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IMPORT_INVALID');
    expect(await partyCodes(c)).toEqual([]);
    // Sayaç kullanılmadı: elle açılan ilk cari CR-000001 alır
    const first = await ok(c.post('/api/parties', { name: 'Elle' }));
    expect(first.party.code).toBe('CR-000001');
    // Geçerli satırların hepsi atlanırsa yazılacak bir şey yoktur
    const empty = await run(c, 'parties', 'commit', [{ name: 'Elle', code: 'CR-000001' }]);
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('IMPORT_EMPTY');
  });

  it('stok kartları: birim etiketi, KDV oranı/kodu, kategori bul-yoksa-oluştur, barkod çakışması, para birimi', async () => {
    const { c } = await setup('Stok');
    await ok(c.post('/api/item-categories', { name: 'İnşaat Malzemesi' }));
    await ok(c.post('/api/items', { name: 'Mevcut Kart', code: 'ST-000010', barcode: '111' }));

    const list = [
      { code: 'ST-000001', name: 'Çimento 50 kg', unit: 'çuval', category: 'inşaat malzemesi', vatCode: '16', purchasePrice: '185,50', salePrice: '240,00', minLevel: '20' },
      { name: 'Seramik 60x60', unit: 'm²', category: 'Kaplama', barcode: '8690000000017', vatCode: 'kdv-10', purchaseCurrency: 'EUR', purchasePrice: '12,5' },
      { name: 'Nakliye', kind: 'Hizmet', unit: 'saat', category: 'kaplama' },
      { name: 'Kablo', unit: 'metre', category: 'Elektrik' },
      { code: 'ST-000010', name: 'Aynı Kod' }, // mevcut kod → atla
      { name: 'Aynı Barkod', barcode: '111' }, // mevcut barkod → atla
    ];
    const preview = await ok(run(c, 'items', 'preview', list));
    expect(preview.counts).toEqual({ total: 6, ok: 4, skip: 2, error: 0 });
    const newCats = preview.summary.find((s: any) => s.label === 'Yeni kategori').value as string;
    expect(newCats.split(', ').sort()).toEqual(['Elektrik', 'Kaplama']);

    const done = await ok(run(c, 'items', 'commit', list));
    expect(done).toMatchObject({ created: 4, skipped: 2 });
    const cats = (await ok(c.get('/api/item-categories'))).categories as { name: string }[];
    expect(cats.map((k) => k.name).sort()).toEqual(['Elektrik', 'Kaplama', 'İnşaat Malzemesi'].sort());
    expect(cats).toHaveLength(3);

    const items = (await ok(c.get('/api/items?limit=500'))).items as any[];
    const byName = (n: string) => items.find((i) => i.name === n);
    expect(byName('Çimento 50 kg')).toMatchObject({ code: 'ST-000001', unit: 'cuval', vatCode: 'KDV-16', purchasePrice: '185.500000', salePrice: '240.000000', minLevel: '20.0000' });
    expect(byName('Seramik 60x60')).toMatchObject({ unit: 'm2', vatCode: 'KDV-10', purchaseCurrency: 'EUR', barcode: '8690000000017' });
    expect(byName('Nakliye')).toMatchObject({ kind: 'service', unit: 'saat' });
    expect(byName('Kablo').unit).toBe('m');
    // Kodsuz kartlar dosyadaki ST-000001 ve mevcut ST-000010 numaralarını atlar
    expect(items.map((i) => i.code).sort()).toEqual(['ST-000001', 'ST-000002', 'ST-000003', 'ST-000004', 'ST-000010']);
    // "inşaat malzemesi" (harf duyarsız) mevcut kategoriye bağlandı, ikinci bir kategori açılmadı
    const existingCat = (await ok(c.get('/api/item-categories'))).categories.find((k: any) => k.name === 'İnşaat Malzemesi');
    expect(existingCat.itemCount).toBe(1);
  });

  it('stok kartları: bilinmeyen birim/KDV/para birimi hata; hatalı son satır yüzünden kart ve kategori yazılmaz', async () => {
    const { c } = await setup('StokHata');
    const list = [
      { name: 'İyi Kart', category: 'Yeni Kategori' },
      { name: 'Kötü Birim', unit: 'bardak' },
      { name: 'Kötü KDV', vatCode: '99' },
      { name: 'Kötü Para', salePrice: '10', saleCurrency: 'JPY' },
      { name: 'Çok Ondalık', purchasePrice: '1,1234567' },
      { name: 'Kötü Tür', kind: 'karışık' },
    ];
    const preview = await ok(run(c, 'items', 'preview', list));
    expect(preview.counts).toMatchObject({ ok: 1, error: 5 });
    expect(preview.rows.slice(1).map((r: any) => r.messages[0].field)).toEqual(['unit', 'vatCode', 'saleCurrency', 'purchasePrice', 'kind']);
    const res = await run(c, 'items', 'commit', list);
    expect(res.statusCode).toBe(422);
    expect((await ok(c.get('/api/items?limit=500'))).items).toHaveLength(0);
    expect((await ok(c.get('/api/item-categories'))).categories).toHaveLength(0);
    // Sayaçlar geri döndü
    expect((await ok(c.post('/api/items', { name: 'Elle' }))).item.code).toBe('ST-000001');
  });

  it('şablon dosyaları: xlsx ve csv, başlıklar alan listesiyle aynı, örnek satır içerir', async () => {
    const { c } = await setup('Sablon');
    for (const kind of ['parties', 'items', 'party_openings', 'stock_openings', 'ledger_openings'] as const) {
      const x = await c.get(`/api/imports/${kind}/template?format=xlsx`);
      expect(x.statusCode, kind).toBe(200);
      expect(x.headers['content-disposition']).toMatch(/^attachment; filename="sablon-[a-z-]+\.xlsx"$/);
      const sheets = readXlsx(new Uint8Array(x.rawPayload));
      const labels = IMPORT_FIELDS[kind].map((f) => f.label);
      const headerRow = sheets[0]!.rows.find((r) => r.includes(labels[0]!))!;
      expect(headerRow.slice(0, labels.length)).toEqual(labels);

      const csv = await c.get(`/api/imports/${kind}/template?format=csv`);
      expect(csv.statusCode).toBe(200);
      expect(csv.body.charCodeAt(0)).toBe(0xfeff);
      expect(csv.body.slice(1).split('\r\n')[0]).toBe(labels.map((l) => `"${l}"`).join(';'));
      // Şablon, kendi içe aktarma akışından geçer: CSV → parse → tüm alanlar eşlenir
      const parsed = await ok(c.post(`/api/imports/${kind}/parse`, { fileName: 'sablon.csv', contentBase64: b64(utf8(csv.body)) }));
      expect(Object.values(parsed.suggestedMapping).every((v) => v !== null), kind).toBe(true);
    }
  });

  it('yetkiler: satış rolü cari ve stok kartı aktarır, açılış aktaramaz; şantiye sorumlusu yalnız stok açılışı; izleyici hiçbirini', async () => {
    const { c, company } = await setup('Yetki');
    const sales = await memberClient(c, company.id, 'sales');
    const site = await memberClient(c, company.id, 'site_manager');
    const viewer = await memberClient(c, company.id, 'viewer');
    const accountant = await memberClient(c, company.id, 'accountant');
    const body = { rows: rowsOf([{ name: 'Yetki Deneme' }]), options: { openingDate: `${new Date().getUTCFullYear()}-01-15` } };

    expect((await sales.post('/api/imports/parties/preview', body)).statusCode).toBe(200);
    expect((await sales.post('/api/imports/items/preview', body)).statusCode).toBe(200);
    for (const kind of ['party_openings', 'stock_openings', 'ledger_openings']) {
      expect((await sales.post(`/api/imports/${kind}/preview`, body)).statusCode, `sales ${kind}`).toBe(403);
    }
    expect((await site.post('/api/imports/stock_openings/preview', body)).statusCode).toBe(200);
    for (const kind of ['parties', 'items', 'party_openings', 'ledger_openings']) {
      expect((await site.post(`/api/imports/${kind}/preview`, body)).statusCode, `site ${kind}`).toBe(403);
    }
    for (const kind of ['parties', 'items', 'party_openings', 'stock_openings', 'ledger_openings']) {
      expect((await viewer.post(`/api/imports/${kind}/preview`, body)).statusCode, `viewer ${kind}`).toBe(403);
      expect((await viewer.get(`/api/imports/${kind}/template`)).statusCode, `viewer şablon ${kind}`).toBe(403);
      expect((await viewer.post(`/api/imports/${kind}/parse`, { fileName: 'a.csv', contentBase64: b64(utf8('a\n1')) })).statusCode).toBe(403);
      expect((await viewer.post(`/api/imports/${kind}/commit`, body)).statusCode, `viewer commit ${kind}`).toBe(403);
    }
    for (const kind of ['parties', 'items', 'party_openings', 'stock_openings', 'ledger_openings']) {
      expect((await accountant.post(`/api/imports/${kind}/preview`, body)).statusCode, `accountant ${kind}`).toBe(200);
    }
    // Oturumsuz istek
    const anon = await app.inject({ method: 'POST', url: '/api/imports/parties/preview', payload: body });
    expect(anon.statusCode).toBe(401);
  });

  it('satır ve gövde sınırları: 5.000 satırdan fazlası 400, çok büyük gövde 413; şirketler arası yalıtım', async () => {
    const { c } = await setup('Sinir');
    const tooMany = Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, (_, i) => ({ name: `Cari ${i}` }));
    const res = await run(c, 'parties', 'preview', tooMany);
    expect(res.statusCode).toBe(400);
    const empty = await c.post('/api/imports/parties/preview', { rows: [], options: {} });
    expect(empty.statusCode).toBe(400);
    const huge = await c.post('/api/imports/parties/preview', { rows: rowsOf([{ name: 'x'.repeat(9 * 1024 * 1024) }]), options: {} });
    expect(huge.statusCode).toBe(413);

    // Tam sınırdaki 5.000 satır kabul edilir
    const exact = Array.from({ length: IMPORT_LIMITS.maxRows }, (_, i) => ({ name: `Cari ${i}` }));
    const ok5000 = await ok(run(c, 'parties', 'preview', exact));
    expect(ok5000.counts.ok).toBe(IMPORT_LIMITS.maxRows);

    // Başka şirketin carisi bu şirketin içe aktarmasında "mevcut" sayılmaz (RLS)
    const other = await setup('Diger');
    await ok(other.c.post('/api/parties', { name: 'Başka Şirket Carisi', code: 'CR-000077', taxNumber: '5555555555' }));
    const mine = await ok(run(c, 'parties', 'preview', [{ code: 'CR-000077', name: 'Benim Carim', taxNumber: '5555555555' }]));
    expect(mine.counts.ok).toBe(1);
  });
});
