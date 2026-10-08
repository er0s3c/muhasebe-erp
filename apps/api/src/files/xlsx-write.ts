import { strToU8, zipSync, Zip, ZipDeflate } from 'fflate';
import { Readable } from 'node:stream';
import { CURRENCY_SYMBOLS } from '@erp/shared';
import { DEFAULT_WIDTH, TOTAL_LABEL, type CellValue, type ColumnKind, type ReportTable, type TableColumn } from './table';

/**
 * Küçük, bağımlılıksız XLSX yazıcı (fflate + elle OOXML). Metinler satır içi dizge (`inlineStr`) olarak
 * yazılır: hücre içeriği hiçbir zaman formül sayılmaz. Tutar/miktar/kur hücreleri gerçek sayıdır,
 * tarihler Excel tarih hücresidir. Çok sayfalı çalışma kitabı, dondurulmuş başlık ve süzgeç destekler.
 */

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const XML_CONTROL_CHARS_REGEX = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]`, 'g');

/** XML'de geçersiz denetim karakterlerini atar ve özel karakterleri kaçırır. */
export const xmlEscape = (s: string) =>
  s
    .replace(XML_CONTROL_CHARS_REGEX, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Renk paleti (ARGB): uygulamanın Obsidian/Bone/sarı kimliği. */
const C = {
  ink: 'FF1A1919',
  inkSoft: 'FF262524',
  white: 'FFFFFFFF',
  band: 'FFF4F2F0',
  hair: 'FFE5E7EB',
  muted: 'FFA3A19F',
  accent: 'FFE4F222',
  totalFill: 'FFF1F6B4',
  plainHead: 'FFF4F2F0',
} as const;

/** Sayı biçimleri: negatifler kırmızı. */
const NF = {
  date: 'dd\\.mm\\.yyyy',
  money: '#,##0.00;[Red]-#,##0.00',
  qty: '#,##0.####;[Red]-#,##0.####',
  rate: '#,##0.0000',
  int: '#,##0;[Red]-#,##0',
} as const;
const currencyFormat = (code: string) => {
  const sym = CURRENCY_SYMBOLS[code]!;
  return `"${sym}"#,##0.00;[Red]-"${sym}"#,##0.00`;
};

type Role = 'body' | 'band' | 'total' | 'header' | 'headerNum' | 'title' | 'subtitle' | 'plainHeader';
interface XfSpec {
  role: Role;
  kind?: ColumnKind;
  currency?: string;
}

/**
 * Stil kayıt defteri: ihtiyaç duyulan (rol × tür × para birimi) birleşimleri istek sırasıyla `cellXfs` indeksine çevirir;
 * yazı tipi, dolgu, kenarlık ve sayı biçimleri tekilleştirilir. Çalışma kitabı yazılırken sayfalar önce üretilir, stil dosyası sonra.
 */
class StyleBook {
  private fonts: string[] = ['<font><sz val="10"/><name val="Arial"/></font>'];
  private fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private borders: string[] = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  private numFmts: string[] = [];
  private xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private index = new Map<string, number>();

  private intern(list: string[], xml: string, base = 0): number {
    const i = list.indexOf(xml);
    if (i >= 0) return i + base;
    list.push(xml);
    return list.length - 1 + base;
  }
  private font(opts: { b?: boolean; i?: boolean; sz?: number; color?: string }) {
    return this.intern(this.fonts, `<font>${opts.b ? '<b/>' : ''}${opts.i ? '<i/>' : ''}<sz val="${opts.sz ?? 10}"/>${opts.color ? `<color rgb="${opts.color}"/>` : ''}<name val="Arial"/></font>`);
  }
  private fill(rgb: string | null) {
    return rgb === null ? 0 : this.intern(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`);
  }
  private border(parts: { bottom?: [string, string]; top?: [string, string] } | null) {
    if (!parts) return 0;
    const side = (n: string, v?: [string, string]) => (v ? `<${n} style="${v[0]}"><color rgb="${v[1]}"/></${n}>` : `<${n}/>`);
    return this.intern(this.borders, `<border><left/><right/>${side('top', parts.top)}${side('bottom', parts.bottom)}<diagonal/></border>`);
  }
  private numFmt(code: string | null): number {
    if (code === null) return 0;
    const builtin = new Map<string, number>([['General', 0]]);
    if (builtin.has(code)) return builtin.get(code)!;
    return this.intern(this.numFmts, `<numFmt numFmtId="@@" formatCode="${xmlEscape(code)}"/>`, 164);
  }

  xf(spec: XfSpec): number {
    const key = `${spec.role}|${spec.kind ?? ''}|${spec.currency ?? ''}`;
    const hit = this.index.get(key);
    if (hit !== undefined) return hit;

    const kind = spec.kind ?? 'text';
    const numeric = kind !== 'text';
    const code =
      kind === 'money' ? (spec.currency && Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, spec.currency) ? currencyFormat(spec.currency) : NF.money)
      : kind === 'date' ? NF.date
      : kind === 'qty' ? NF.qty
      : kind === 'rate' ? NF.rate
      : kind === 'int' ? NF.int
      : null;
    let font = 0;
    let fill = 0;
    let border = 0;
    let align = '';
    let fmt = this.numFmt(spec.role === 'body' || spec.role === 'band' || spec.role === 'total' ? code : null);
    switch (spec.role) {
      case 'title':
        font = this.font({ b: true, sz: 16, color: C.white });
        fill = this.fill(C.ink);
        align = '<alignment vertical="center"/>';
        break;
      case 'subtitle':
        font = this.font({ sz: 10, color: C.muted });
        fill = this.fill(C.ink);
        align = '<alignment vertical="center"/>';
        border = this.border({ bottom: ['medium', C.accent] });
        break;
      case 'header':
      case 'headerNum':
        font = this.font({ b: true, color: C.white });
        fill = this.fill(C.inkSoft);
        border = this.border({ bottom: ['medium', C.accent] });
        align = `<alignment${spec.role === 'headerNum' ? ' horizontal="right"' : ''} vertical="center" wrapText="1"/>`;
        break;
      case 'plainHeader':
        font = this.font({ b: true });
        fill = this.fill(C.plainHead);
        border = this.border({ bottom: ['thin', C.ink] });
        align = `<alignment${numeric ? ' horizontal="right"' : ''} vertical="center" wrapText="1"/>`;
        break;
      case 'body':
      case 'band':
        fill = spec.role === 'band' ? this.fill(C.band) : 0;
        border = this.border({ bottom: ['hair', C.hair] });
        align = kind === 'text' ? '<alignment vertical="top" wrapText="1"/>' : '<alignment vertical="top"/>';
        break;
      case 'total':
        font = this.font({ b: true });
        fill = this.fill(C.totalFill);
        border = this.border({ top: ['double', C.ink], bottom: ['thin', C.ink] });
        align = '<alignment vertical="center"/>';
        break;
    }
    if (fmt === 0 && spec.role !== 'body' && spec.role !== 'band' && spec.role !== 'total') fmt = 0;
    const xml =
      `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
      `${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1"' : ''}` +
      (align ? `>${align}</xf>` : '/>');
    this.xfs.push(xml);
    const i = this.xfs.length - 1;
    this.index.set(key, i);
    return i;
  }

  toXml(): string {
    const numFmts = this.numFmts.map((x, i) => x.replace('@@', String(164 + i)));
    return (
      XML_HEAD +
      `<styleSheet xmlns="${NS_MAIN}">` +
      (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '') +
      `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

/** Çalışma kitabında kullanılan para birimleri (sütun `currency` alanı, yalnızca simgesi bilinenler), sıralı ve tekil. */
export function workbookCurrencies(tables: readonly ReportTable[]): string[] {
  const used = new Set<string>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.kind === 'money' && c.currency && Object.prototype.hasOwnProperty.call(CURRENCY_SYMBOLS, c.currency)) used.add(c.currency);
    }
  }
  return [...used].sort();
}

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

function valueCell(ref: string, kind: ColumnKind, style: number, fallback: number, v: CellValue): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (kind === 'text') return textCell(ref, style, String(v));
  if (kind === 'date') {
    const serial = excelSerial(String(v));
    return serial === null ? textCell(ref, fallback, String(v)) : `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
  }
  const s = String(v);
  // Sayı olmayan içerik (beklenmeyen) metin olarak yazılır: dosya bozulmaz
  return NUMBER_RE.test(s) ? `<c r="${ref}" s="${style}"><v>${s}</v></c>` : textCell(ref, fallback, s);
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

/** Başlık satırı: başlıklı raporlarda 4 (1: rapor adı, 2: dönem, 3: boş), düz tablolarda 1. */
const headerRowOf = (table: ReportTable) => (table.plain ? 1 : 4);

/** Sütun genişliği: bildirilen genişlik en az, içerik (başlık ve değerler) en çok 60 karakter. */
function fitWidth(c: TableColumn, rows: readonly Record<string, CellValue>[]): number {
  let w = Math.max(c.width ?? DEFAULT_WIDTH[c.kind], c.label.length * 1.15 + 3);
  for (const r of rows.slice(0, 500)) {
    const v = r[c.key];
    if (v === null || v === undefined || v === '') continue;
    const len = String(v).length;
    w = Math.max(w, c.kind === 'money' ? len * 1.2 + 5 : c.kind === 'text' ? Math.min(len, 60) + 2 : len + 3);
  }
  return Math.min(Math.round(w), c.kind === 'text' ? 60 : 28);
}

const escapeHf = (s: string) => xmlEscape(s.replace(/&/g, '&&'));

function* sheetXmlChunks(table: ReportTable, book: StyleBook): Generator<string> {
  const plain = !!table.plain;
  const HEADER_ROW = headerRowOf(table);
  const cols = table.columns;
  const lastIdx = Math.max(cols.length - 1, 0);
  const lastCol = columnName(lastIdx);
  const merges: string[] = [];
  const fallback = book.xf({ role: 'body' });
  const finalRow=HEADER_ROW+table.rows.length+(table.totals?1:0);
  const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${fitWidth(c, table.rows)}" customWidth="1"/>`).join('');
  const totalWidth = cols.reduce((s, c) => s + fitWidth(c, table.rows), 0);
  const landscape = totalWidth > 95;
  yield XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheetPr>${plain ? '' : `<tabColor rgb="${C.accent}"/>`}<pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<dimension ref="A1:${lastCol}${finalRow}"/>` +
    `<sheetViews><sheetView${plain ? '' : ' showGridLines="0"'} workbookViewId="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' + `<cols>${widths}</cols><sheetData>`;

  if (!plain) {
    const titleStyle = book.xf({ role: 'title' });
    const subStyle = book.xf({ role: 'subtitle' });
    const bar = (r: number, style: number, text: string | undefined, ht: number) =>
      `<row r="${r}" ht="${ht}" customHeight="1">` +
      cols.map((_, i) => (i === 0 && text ? textCell(`A${r}`, style, text) : `<c r="${columnName(i)}${r}" s="${style}"/>`)).join('') +
      '</row>';
    yield bar(1, titleStyle, table.title, 30);
    yield bar(2, subStyle, table.subtitle ?? '', 20);
    yield '<row r="3" ht="8" customHeight="1"/>';
    if (cols.length > 1) merges.push(`<mergeCell ref="A1:${lastCol}1"/>`, `<mergeCell ref="A2:${lastCol}2"/>`);
  }

  yield (
    `<row r="${HEADER_ROW}" ht="${plain ? 30 : 32}" customHeight="1">` +
      cols
        .map((c, i) => {
          const numeric = c.kind !== 'text' && c.kind !== 'date';
          const role: Role = plain ? 'plainHeader' : numeric ? 'headerNum' : 'header';
          return textCell(`${columnName(i)}${HEADER_ROW}`, book.xf({ role, kind: c.kind }), c.label);
        })
        .join('') +
      '</row>'
  );

  const styleOf = (c: TableColumn, role: Role) => book.xf({ role, kind: c.kind, ...(c.kind === 'money' && c.currency ? { currency: c.currency } : {}) });
  let r = HEADER_ROW;
  for (const [n,row] of table.rows.entries()) {
    r++;
    const role: Role = plain || n % 2 === 0 ? 'body' : 'band';
    const cells = cols
      .map((c, i) => {
        const st = styleOf(c, role);
        const v = row[c.key] ?? null;
        // Boş hücre de bant rengini ve kenarlığı taşısın
        return valueCell(`${columnName(i)}${r}`, c.kind, st, fallback, v) ?? (plain ? null : `<c r="${columnName(i)}${r}" s="${st}"/>`);
      })
      .filter((x): x is string => x !== null);
    yield `<row r="${r}">${cells.join('')}</row>`;
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
      const st = styleOf(c, 'total');
      const filled = valueCell(ref, c.kind, st, book.xf({ role: 'total' }), table.totals![c.key] ?? null);
      if (filled) return filled;
      // Boş toplam hücresi de çizgiyi ve dolguyu taşısın; ilk metin sütununa etiket yazılır
      return i === firstText ? textCell(ref, book.xf({ role: 'total' }), TOTAL_LABEL) : `<c r="${ref}" s="${st}"/>`;
    });
    yield `<row r="${r}" ht="20" customHeight="1">${cells.join('')}</row>`;
  }

  yield (
    '</sheetData>' +
    (table.rows.length > 0 ? `<autoFilter ref="A${HEADER_ROW}:${lastCol}${lastDataRow}"/>` : '') +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '') +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.7" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="9" orientation="${landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    `<headerFooter><oddFooter>&amp;L&amp;8 ${escapeHf(table.title)}&amp;C&amp;8 Sayfa &amp;P / &amp;N&amp;R&amp;8 &amp;D</oddFooter></headerFooter>` +
    '</worksheet>'
  );
}

/** Tabloları tek çalışma kitabında (her tablo bir sayfa) XLSX olarak yazar. */
function workbookParts(tables: readonly ReportTable[]) {
  if (tables.length === 0) throw new Error('En az bir tablo gerekli');
  const names = sheetNames(tables.map((t) => t.sheet ?? t.title));
  const book = new StyleBook();
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
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(quoted(names[i]!))}!$A$${headerRowOf(t)}:$${columnName(Math.max(t.columns.length - 1, 0))}$${headerRowOf(t) + t.rows.length}</definedName>`
        : '',
    )
    .join('');
  const titles = tables
    .map((t, i) => (t.plain ? '' : `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xmlEscape(quoted(names[i]!))}!$${headerRowOf(t)}:$${headerRowOf(t)}</definedName>`))
    .join('');
  files['xl/workbook.xml'] = strToU8(
    XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>' +
      `<sheets>${tables.map((_, i) => `<sheet name="${xmlEscape(names[i]!)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      (filters || titles ? `<definedNames>${filters}${titles}</definedNames>` : '') +
      '</workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${tables.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  return {files,book};
}

export function writeXlsx(tables: readonly ReportTable[]): Uint8Array {
  const {files,book}=workbookParts(tables);
  tables.forEach((t,i)=>{files[`xl/worksheets/sheet${i+1}.xml`]=strToU8([...sheetXmlChunks(t,book)].join(''));});
  files['xl/styles.xml'] = strToU8(book.toXml());
  return zipSync(files, { level: 6 });
}

/** Incremental OOXML + ZIP output. Readable backpressure bounds the output queue;
 * report queries still materialize their existing rows before this writer starts. */
export function writeXlsxStream(tables: readonly ReportTable[]): Readable {
  const {files,book}=workbookParts(tables);
  async function* archive() {
    const output:Uint8Array[]=[];
    let failure:Error|null=null;
    const zip=new Zip((error,data)=>{if(error)failure=error;else output.push(data);});
    const drain=function*(){if(failure)throw failure;while(output.length)yield Buffer.from(output.shift()!);};
    try {
      for(const [name,data] of Object.entries(files)) {
        const entry=new ZipDeflate(name,{level:6});zip.add(entry);entry.push(data,true);yield* drain();
      }
      for(const [i,table] of tables.entries()) {
        const entry=new ZipDeflate(`xl/worksheets/sheet${i+1}.xml`,{level:6});zip.add(entry);
        let chunk='';
        for(const part of sheetXmlChunks(table,book)) {
          chunk+=part;
          if(chunk.length>=65536){entry.push(strToU8(chunk),false);chunk='';yield* drain();}
        }
        entry.push(strToU8(chunk),true);yield* drain();
      }
      const styles=new ZipDeflate('xl/styles.xml',{level:6});zip.add(styles);styles.push(strToU8(book.toXml()),true);yield* drain();
      zip.end();yield* drain();
    }finally{zip.terminate();}
  }
  return Readable.from(archive(),{objectMode:false,highWaterMark:65536});
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
