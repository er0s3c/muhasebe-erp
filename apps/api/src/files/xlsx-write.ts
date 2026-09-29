import { strToU8, zipSync } from 'fflate';
import { DEFAULT_WIDTH, TOTAL_LABEL, type CellValue, type ColumnKind, type ReportTable } from './table';

/**
 * Küçük, bağımlılıksız XLSX yazıcı (fflate + elle OOXML). Metinler satır içi dizge (`inlineStr`) olarak
 * yazılır: hücre içeriği hiçbir zaman formül sayılmaz. Tutar/miktar/kur hücreleri gerçek sayıdır,
 * tarihler Excel tarih hücresidir. Çok sayfalı çalışma kitabı, dondurulmuş başlık ve süzgeç destekler.
 */

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML'de geçersiz denetim karakterlerini atar ve özel karakterleri kaçırır. */
export const xmlEscape = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Hücre biçimi (styles.xml `cellXfs` sırası). */
const STYLE = {
  title: 1,
  subtitle: 2,
  header: 3,
  headerNum: 4,
  text: 5,
  money: 6,
  date: 7,
  qty: 8,
  rate: 9,
  int: 10,
  totalText: 11,
  totalMoney: 12,
  totalQty: 13,
  totalRate: 14,
  totalInt: 15,
  totalDate: 16,
} as const;

const BODY_STYLE: Record<ColumnKind, number> = {
  text: STYLE.text,
  money: STYLE.money,
  date: STYLE.date,
  qty: STYLE.qty,
  rate: STYLE.rate,
  int: STYLE.int,
};
const TOTAL_STYLE: Record<ColumnKind, number> = {
  text: STYLE.totalText,
  money: STYLE.totalMoney,
  date: STYLE.totalDate,
  qty: STYLE.totalQty,
  rate: STYLE.totalRate,
  int: STYLE.totalInt,
};

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/><numFmt numFmtId="165" formatCode="#,##0.####"/><numFmt numFmtId="166" formatCode="#,##0.0000"/></numFmts>' +
  '<fonts count="4">' +
  '<font><sz val="10"/><name val="Arial"/></font>' +
  '<font><b/><sz val="10"/><name val="Arial"/></font>' +
  '<font><b/><sz val="14"/><name val="Arial"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF6D6C6B"/><name val="Arial"/></font>' +
  '</fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF4F2F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="3">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF0C0A08"/></bottom><diagonal/></border>' +
  '<border><left/><right/><top style="thin"><color rgb="FF0C0A08"/></top><bottom/><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="17">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 1 title
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 2 subtitle
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' + // 3 header
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>' + // 4 header (sayı)
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 5 text
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 6 money
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 7 date
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 8 qty
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 9 rate
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 10 int
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>' + // 11 total text
  '<xf numFmtId="4" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 12
  '<xf numFmtId="165" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 13
  '<xf numFmtId="166" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 14
  '<xf numFmtId="3" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 15
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' + // 16
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** 0 → A, 25 → Z, 26 → AA */
export function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** `YYYY-MM-DD` → Excel tarih seri numarası (1900 sistemi); geçersizse null. */
export function excelSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return Math.round(ms / 86_400_000) + 25569;
}

function textCell(ref: string, style: number, value: string): string {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function valueCell(ref: string, kind: ColumnKind, style: number, v: CellValue): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (kind === 'text') return textCell(ref, style, String(v));
  if (kind === 'date') {
    const serial = excelSerial(String(v));
    return serial === null ? textCell(ref, STYLE.text, String(v)) : `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
  }
  const s = String(v);
  // Sayı olmayan içerik (beklenmeyen) metin olarak yazılır: dosya bozulmaz
  return NUMBER_RE.test(s) ? `<c r="${ref}" s="${style}"><v>${s}</v></c>` : textCell(ref, STYLE.text, s);
}

/** Excel sayfa adı: en çok 31 karakter, `[]:*?/\` yok, tekil. */
export function sheetNames(titles: readonly string[]): string[] {
  const used = new Set<string>();
  return titles.map((t) => {
    const base = (t.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim() || 'Sayfa').slice(0, 31);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` (${i})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const HEADER_ROW = 4;

function sheetXml(table: ReportTable): string {
  const cols = table.columns;
  const lastCol = columnName(Math.max(cols.length - 1, 0));
  const rows: string[] = [];

  rows.push(`<row r="1">${textCell('A1', STYLE.title, table.title)}</row>`);
  if (table.subtitle) rows.push(`<row r="2">${textCell('A2', STYLE.subtitle, table.subtitle)}</row>`);

  rows.push(
    `<row r="${HEADER_ROW}" ht="30" customHeight="1">` +
      cols.map((c, i) => textCell(`${columnName(i)}${HEADER_ROW}`, c.kind === 'text' || c.kind === 'date' ? STYLE.header : STYLE.headerNum, c.label)).join('') +
      '</row>',
  );

  let r = HEADER_ROW;
  for (const row of table.rows) {
    r++;
    const cells = cols
      .map((c, i) => valueCell(`${columnName(i)}${r}`, c.kind, BODY_STYLE[c.kind], row[c.key] ?? null))
      .filter((x): x is string => x !== null);
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }
  const lastDataRow = r;

  if (table.totals) {
    r++;
    const firstText = Math.max(
      cols.findIndex((c) => c.kind === 'text'),
      0,
    );
    const cells = cols.map((c, i) => {
      const ref = `${columnName(i)}${r}`;
      const v = table.totals![c.key];
      const filled = valueCell(ref, c.kind, TOTAL_STYLE[c.kind], v ?? null);
      if (filled) return filled;
      // Boş toplam hücresi de üst çizgiyi taşısın; ilk metin sütununa etiket yazılır
      return i === firstText ? textCell(ref, STYLE.totalText, TOTAL_LABEL) : `<c r="${ref}" s="${STYLE.totalText}"/>`;
    });
    rows.push(`<row r="${r}">${cells.join('')}</row>`);
  }

  const widths = cols
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? DEFAULT_WIDTH[c.kind]}" customWidth="1"/>`)
    .join('');
  const landscape = cols.length > 6;

  return (
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:${lastCol}${Math.max(r, HEADER_ROW)}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${widths}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    (table.rows.length > 0 ? `<autoFilter ref="A${HEADER_ROW}:${lastCol}${lastDataRow}"/>` : '') +
    '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    '</worksheet>'
  );
}

/** Tabloları tek çalışma kitabında (her tablo bir sayfa) XLSX olarak yazar. */
export function writeXlsx(tables: readonly ReportTable[]): Uint8Array {
  if (tables.length === 0) throw new Error('En az bir tablo gerekli');
  const names = sheetNames(tables.map((t) => t.sheet ?? t.title));
  const files: Record<string, Uint8Array> = {};

  files['[Content_Types].xml'] = strToU8(
    XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      tables
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('') +
      '</Types>',
  );
  files['_rels/.rels'] = strToU8(
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
  );

  const quoted = (n: string) => `'${n.replace(/'/g, "''")}'`;
  const filters = tables
    .map((t, i) =>
      t.rows.length > 0
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(quoted(names[i]!))}!$A$${HEADER_ROW}:$${columnName(Math.max(t.columns.length - 1, 0))}$${HEADER_ROW + t.rows.length}</definedName>`
        : '',
    )
    .join('');
  files['xl/workbook.xml'] = strToU8(
    XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>' +
      `<sheets>${tables.map((_, i) => `<sheet name="${xmlEscape(names[i]!)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (filters ? `<definedNames>${filters}</definedNames>` : '') +
      '</workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${tables.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  files['xl/styles.xml'] = strToU8(STYLES_XML);
  tables.forEach((t, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(t));
  });

  return zipSync(files, { level: 6 });
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
