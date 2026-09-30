import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { renderCsv } from '../src/files/csv-write';
import { columnName, excelSerial, sheetNames, writeXlsx } from '../src/files/xlsx-write';
import { isDateFormatCode, readXlsx, serialToText, XlsxReadError } from '../src/files/xlsx-read';
import type { ReportTable } from '../src/files/table';

const sample: ReportTable = {
  key: 'deneme',
  title: 'Deneme raporu',
  subtitle: '01.01.2026 – 30.09.2026',
  columns: [
    { key: 'name', label: 'Ad', kind: 'text' },
    { key: 'date', label: 'Tarih', kind: 'date' },
    { key: 'qty', label: 'Miktar', kind: 'qty' },
    { key: 'amount', label: 'Tutar', kind: 'money' },
    { key: 'rate', label: 'Kur', kind: 'rate' },
    { key: 'n', label: 'Adet', kind: 'int' },
  ],
  rows: [
    { name: 'Çelik & Demir <A.Ş.> "özel"', date: '2026-09-29', qty: '12.5000', amount: '1234.5600', rate: '64.72680000', n: 3 },
    { name: '=HYPERLINK("http://x")', date: null, qty: null, amount: '-0.5000', rate: null, n: 0 },
    { name: 'Şğüıİö çğ', date: '2024-02-29', qty: '0.0001', amount: '999999999999.9900', rate: null, n: 12345 },
  ],
  totals: { amount: '1000000001234.0500', n: 12348 },
};

/** Elle kurulmuş minimal xlsx: `sheetXml` ve isteğe bağlı parçalarla. */
function handmade(opts: { sheet: string; shared?: string; styles?: string; workbookPr?: string; extra?: Record<string, string> }): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.workbookPr ?? ''}<sheets><sheet name="Veri" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${opts.sheet}</sheetData></worksheet>`,
    ),
  };
  if (opts.shared) files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${opts.shared}</sst>`);
  if (opts.styles) files['xl/styles.xml'] = strToU8(`<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${opts.styles}</styleSheet>`);
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files);
}

describe('xlsx yazıcı ve okuyucu', () => {
  it('yazılan çalışma kitabı okunur: metinler, sayılar, tarihler ve toplam satırı korunur', () => {
    const [sheet] = readXlsx(writeXlsx([sample]));
    expect(sheet!.name).toBe('Deneme raporu');
    const rows = sheet!.rows;
    expect(rows[0]![0]).toBe('Deneme raporu');
    expect(rows[1]![0]).toBe('01.01.2026 – 30.09.2026');
    expect(rows[3]).toEqual(['Ad', 'Tarih', 'Miktar', 'Tutar', 'Kur', 'Adet']);
    // Özel karakterler ve Türkçe harfler bozulmaz; formül gibi görünen metin metin olarak kalır
    expect(rows[4]).toEqual(['Çelik & Demir <A.Ş.> "özel"', '2026-09-29', '12.5', '1234.56', '64.7268', '3']);
    expect(rows[5]).toEqual(['=HYPERLINK("http://x")', '', '', '-0.5', '', '0']);
    expect(rows[6]).toEqual(['Şğüıİö çğ', '2024-02-29', '0.0001', '999999999999.99', '', '12345']);
    expect(rows[7]).toEqual(['Toplam', '', '', '1000000001234.05', '', '12348']);
  });

  it('tutar hücreleri sayı, tarih hücreleri Excel tarihi, metin hücreleri satır içi dizgedir', () => {
    const zip = unzipSync(writeXlsx([sample]));
    const xml = new TextDecoder().decode(zip['xl/worksheets/sheet1.xml']);
    // 1234.5600 sayı hücresi (t niteliği yok), 2026-09-29 seri numarası, metin inlineStr
    expect(xml).toContain('<c r="D5" s="6"><v>1234.5600</v></c>');
    expect(xml).toContain(`<c r="B5" s="7"><v>${excelSerial('2026-09-29')}</v></c>`);
    expect(xml).toMatch(/<c r="A6" s="5" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
    expect(xml).toContain('<pane ySplit="4"');
    expect(xml).toContain('<autoFilter ref="A4:F7"/>');
    expect(excelSerial('2026-09-29')).toBe(46294);
    expect(excelSerial('2026-02-30')).toBeNull();
  });

  it('para birimli tutar sütunları simgeli hücre biçimi alır; hücre yine sayıdır, yüzde/para birimsiz sütun düz kalır', () => {
    const table: ReportTable = {
      key: 'para',
      title: 'Para',
      columns: [
        { key: 'name', label: 'Ad', kind: 'text' },
        { key: 'try', label: 'Tutar (TRY)', kind: 'money', currency: 'TRY' },
        { key: 'gbp', label: 'Tutar (GBP)', kind: 'money', currency: 'GBP' },
        { key: 'pct', label: 'Yüzde', kind: 'money' },
        { key: 'chf', label: 'Tutar (CHF)', kind: 'money', currency: 'CHF' },
        { key: 'qty', label: 'Adet', kind: 'qty', currency: 'TRY' },
      ],
      rows: [{ name: 'A', try: '1234.5000', gbp: '-10.2500', pct: '12.5000', chf: '7.0000', qty: '3.0000' }],
      totals: { try: '1234.5000', gbp: '-10.2500' },
    };
    const bytes = writeXlsx([table]);
    const files = unzipSync(bytes);
    const styles = new TextDecoder().decode(files['xl/styles.xml']);
    // Biçimler: tırnaklı simge; negatif kolu ayrı; bilinmeyen para birimi (CHF) ve para birimi olmayan sütunlar biçim almaz
    expect(styles).toContain('formatCode="&quot;£&quot;#,##0.00;-&quot;£&quot;#,##0.00"');
    expect(styles).toContain('formatCode="&quot;₺&quot;#,##0.00;-&quot;₺&quot;#,##0.00"');
    expect(styles).not.toContain('CHF');
    expect(styles).toContain('<numFmts count="5">'); // 3 sabit + GBP + TRY
    expect(styles).toContain('<cellXfs count="21">'); // 17 sabit + 2 × 2
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
    // Sıralama: GBP (gövde 17, toplam 18), TRY (gövde 19, toplam 20); yüzde ve CHF düz tutar stili (6)
    expect(sheet).toMatch(/<c r="B\d+" s="19"><v>1234\.5000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="C\d+" s="17"><v>-10\.2500<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="D\d+" s="6"><v>12\.5000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="E\d+" s="6"><v>7\.0000<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="F\d+" s="8"><v>3\.0000<\/v><\/c>/); // miktar sütununda para birimi yok sayılır
    expect(sheet).toMatch(/<c r="B6" s="20"><v>1234\.5000<\/v><\/c>/); // toplam satırı: kalın + üst çizgi + aynı biçim
    // Okuyucu: para birimli hücreler tarih sanılmaz, sayı olarak okunur
    const read = readXlsx(bytes)[0]!;
    const row = read.rows.find((r) => r[0] === 'A')!;
    expect(row.slice(1, 4)).toEqual(['1234.5', '-10.25', '12.5']);
    expect(isDateFormatCode('"₺"#,##0.00;-"₺"#,##0.00')).toBe(false);
    expect(isDateFormatCode('"£"#,##0.00;-"£"#,##0.00')).toBe(false);
  });

  it('çok sayfalı kitap: sayfa adları temizlenir, kısaltılır ve tekilleşir', () => {
    expect(sheetNames(['Mizan: 2026/1', 'A'.repeat(40), 'a'.repeat(40), 'Mizan: 2026/1'])).toEqual(['Mizan- 2026-1', 'A'.repeat(31), `${'a'.repeat(27)} (2)`, 'Mizan- 2026-1 (2)']);
    const sheets = readXlsx(writeXlsx([{ ...sample, sheet: 'Cariler' }, { ...sample, sheet: 'Stok' }]));
    expect(sheets.map((s) => s.name)).toEqual(['Cariler', 'Stok']);
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });

  it('XML için geçersiz denetim karakterleri atılır (dosya bozulmaz)', () => {
    const t: ReportTable = { key: 'x', title: 'Kontrol', columns: [{ key: 'a', label: 'A', kind: 'text' }], rows: [{ a: 'a\u0000b\u0008c\u001fd' }] };
    expect(readXlsx(writeXlsx([t]))[0]!.rows[4]![0]).toBe('abcd');
  });

  it('CSV: başlık ilk satır, Türkçe biçim, formül etkisizleştirme ve toplam satırı', () => {
    const csv = renderCsv(sample);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('"Ad";"Tarih";"Miktar";"Tutar";"Kur";"Adet"');
    expect(lines[1]).toBe('"Çelik & Demir <A.Ş.> ""özel""";"29.09.2026";"12,5";"1.234,56";"64,7268";"3"');
    // Formül gibi başlayan metin `'` ile başlar; negatif tutar (sayı sütunu) dokunulmaz
    expect(lines[2]).toBe('"\'=HYPERLINK(""http://x"")";"";"";"-0,50";"";"0"');
    expect(lines[4]).toBe('"Toplam";"";"";"1.000.000.001.234,05";"";"12348"');
  });
});

describe('xlsx okuyucu: Excel yapıları', () => {
  it('paylaşılan metin, zengin metin, satır içi metin, formül sonucu, mantıksal değer ve seyrek hücreler', () => {
    const bytes = handmade({
      shared: '<si><t>Ad</t></si><si><r><t xml:space="preserve">Çimento </t></r><r><t>50 kg</t></r></si><si><t>Tutar</t></si><si><t>Ömer</t><rPh><t>x</t></rPh></si>',
      sheet:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="inlineStr"><is><t>satır içi</t></is></c><c r="C3"><f>1+2</f><v>3</v></c><c r="D3" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="E3" t="b"><v>1</v></c><c r="F3" t="e"><v>#N/A</v></c></row>' +
        '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="B4"><v>0.30000000000000004</v></c><c r="C4"><v>1.0000000000000001E-2</v></c><c r="D4"><v>1234567.891</v></c></row>',
    });
    const rows = readXlsx(bytes)[0]!.rows;
    expect(rows[0]).toEqual(['Ad', '', 'Tutar']);
    expect(rows[1]).toEqual([]); // boş satır korunur (satır numaraları kaymaz)
    expect(rows[2]).toEqual(['Çimento 50 kg', 'satır içi', '3', 'ab', 'true', '']);
    expect(rows[3]).toEqual(['Ömer', '0.3', '0.01', '1234567.891']);
  });

  it('tarih biçimli hücreler ISO tarihe çevrilir; 1904 sistemi ve saat bilgisi', () => {
    const styles =
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="0.00&quot;m&quot;"/></numFmts>' +
      '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs>';
    const sheet =
      '<row r="1"><c r="A1" s="1"><v>46294</v></c><c r="B1" s="2"><v>45000</v></c><c r="C1" s="3"><v>46294</v></c><c r="D1" s="0"><v>46294</v></c><c r="E1" s="1"><v>46294.5</v></c></row>';
    const r1 = readXlsx(handmade({ sheet, styles }))[0]!.rows[0]!;
    expect(r1).toEqual(['2026-09-29', '2023-03-15', '46294', '46294', '2026-09-29 12:00:00']);
    // 1904 sistemi: aynı takvim günü 1462 daha küçük seri numarasıyla saklanır
    const r2 = readXlsx(handmade({ sheet: sheet.replace('<v>46294</v></c><c r="B1"', '<v>44832</v></c><c r="B1"'), styles, workbookPr: '<workbookPr date1904="1"/>' }))[0]!.rows[0]!;
    expect(r2[0]).toBe('2026-09-29');
    expect(serialToText(44832, true)).toBe('2026-09-29');
    expect(serialToText(59, false)).toBe('1900-02-28');
    expect(serialToText(61, false)).toBe('1900-03-01');
  });

  it('tarih biçimi tanıma', () => {
    for (const c of ['dd.mm.yyyy', 'yyyy-mm-dd hh:mm', 'd/m/yy', '[$-tr-TR]dd mmmm yyyy', 'h:mm:ss']) expect(isDateFormatCode(c), c).toBe(true);
    for (const c of ['General', '#,##0.00', '0.00%', '0.00E+00', '0.00"m"', '#,##0.00 "TL";[Red]-#,##0.00', '\\d0']) expect(isDateFormatCode(c), c).toBe(false);
  });
});

describe('xlsx okuyucu: güvenlik ve sınırlar', () => {
  const limitsWith = (over: Partial<Parameters<typeof readXlsx>[1]>) => ({ maxCompressed: 5_000_000, maxEntryBytes: 2_000_000, maxTotalBytes: 4_000_000, maxRows: 100, maxCols: 10, ...over });

  it('xlsx olmayan ve boş dosya reddedilir', () => {
    expect(() => readXlsx(strToU8('a;b\n1;2'))).toThrow(XlsxReadError);
    expect(() => readXlsx(new Uint8Array(0))).toThrow(XlsxReadError);
    try {
      readXlsx(strToU8('düz metin dosyası, zip değil'));
    } catch (e) {
      expect((e as XlsxReadError).code).toBe('XLSX_INVALID');
    }
  });

  it('zip bombası: küçük dosya çok büyük içeriğe açılıyorsa, bellek şişmeden reddedilir', () => {
    const big = new Uint8Array(60 * 1024 * 1024); // 60 MB sıfır: sıkıştırınca birkaç yüz KB
    const bomb = zipSync({ 'xl/workbook.xml': big });
    expect(bomb.length).toBeLessThan(200_000);
    const t0 = Date.now();
    try {
      readXlsx(bomb, limitsWith({ maxEntryBytes: 5_000_000, maxTotalBytes: 8_000_000 }));
      throw new Error('reddedilmeliydi');
    } catch (e) {
      expect(e).toBeInstanceOf(XlsxReadError);
      expect((e as XlsxReadError).code).toBe('XLSX_TOO_LARGE');
    }
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('sıkıştırılmış boyut, satır ve sütun tavanı', () => {
    const wide = handmade({ sheet: `<row r="1">${Array.from({ length: 11 }, (_, i) => `<c r="${columnName(i)}1"><v>1</v></c>`).join('')}</row>` });
    expect(() => readXlsx(wide, limitsWith({}))).toThrow(/sütun/);
    const tall = handmade({ sheet: '<row r="101"><c r="A101"><v>1</v></c></row>' });
    expect(() => readXlsx(tall, limitsWith({}))).toThrow(/satır/);
    expect(() => readXlsx(wide, limitsWith({ maxCompressed: 100 }))).toThrow(/büyük/);
  });

  it('DOCTYPE/ENTITY içeren XML reddedilir (XXE ve varlık şişirme)', () => {
    const evil = handmade({
      sheet: '<row r="1"><c r="A1" t="inlineStr"><is><t>&x;</t></is></c></row>',
      extra: {
        'xl/sharedStrings.xml': '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY x "aaaa">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></sst>',
      },
    });
    expect(() => readXlsx(evil)).toThrow(/izin verilmeyen/);
  });
});
