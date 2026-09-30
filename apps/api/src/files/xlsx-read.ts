import { Unzip, UnzipInflate, UnzipPassThrough, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { dec } from '@erp/shared';

/**
 * Bağımlılıksız XLSX okuyucu (fflate + fast-xml-parser). Her sayfayı metin matrisine çevirir: sayılar
 * normalleştirilmiş ondalık metin, tarih biçimli hücreler `YYYY-MM-DD`, formül hücreleri sonuç değeridir.
 * Güvenlik: sıkıştırılmış boyut sınırı, akışlı açma sırasında gerçek çıktı boyutu sınırı (zip bombası),
 * DOCTYPE/ENTITY reddi, satır ve sütun tavanı.
 */

export type XlsxErrorCode = 'XLSX_INVALID' | 'XLSX_TOO_LARGE';

export class XlsxReadError extends Error {
  constructor(
    public readonly code: XlsxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxReadError';
  }
}

export interface XlsxLimits {
  /** Yüklenen dosyanın en büyük boyutu (bayt). */
  maxCompressed: number;
  /** Tek bir parçanın açılmış en büyük boyutu. */
  maxEntryBytes: number;
  /** Tüm parçaların açılmış toplam boyutu. */
  maxTotalBytes: number;
  maxRows: number;
  maxCols: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  maxCompressed: 5 * 1024 * 1024,
  maxEntryBytes: 10 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
  maxRows: 20_000,
  maxCols: 60,
};

export interface ParsedSheet {
  name: string;
  /** Satırlar hücre metinleri; kısa satırlar sağdan eksik bırakılabilir. */
  rows: string[][];
}

const CHUNK = 32 * 1024;

function extract(data: Uint8Array, limits: XlsxLimits): Map<string, Uint8Array> {
  if (data.length > limits.maxCompressed) throw new XlsxReadError('XLSX_TOO_LARGE', 'Dosya çok büyük');
  const out = new Map<string, Uint8Array>();
  const wanted = (name: string) => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml' || name === 'xl/styles.xml' || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
  let total = 0;
  // fflate, geri çağrımda fırlatılan hatayı yakalayıp yeniden bildirir; ilk hatayı burada saklarız
  let failure: XlsxReadError | null = null;
  const fail = (e: XlsxReadError): never => {
    failure ??= e;
    throw failure;
  };
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    const keep = wanted(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) fail(new XlsxReadError('XLSX_INVALID', 'Dosya açılamadı'));
      size += chunk.length;
      total += chunk.length;
      if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) fail(new XlsxReadError('XLSX_TOO_LARGE', 'Dosya açıldığında çok büyük'));
      if (keep) chunks.push(chunk);
      if (final && keep) {
        const all = new Uint8Array(size);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        out.set(file.name, all);
      }
    };
    file.start();
  };
  try {
    if (data.length === 0) fail(new XlsxReadError('XLSX_INVALID', 'Dosya boş'));
    for (let i = 0; i < data.length; i += CHUNK) {
      unzip.push(data.subarray(i, Math.min(i + CHUNK, data.length)), i + CHUNK >= data.length);
      if (failure) break;
    }
  } catch {
    throw failure ?? new XlsxReadError('XLSX_INVALID', 'Geçerli bir Excel (.xlsx) dosyası değil');
  }
  if (failure) throw failure;
  return out;
}

const ARRAY_TAGS = new Set(['si', 'r', 'row', 'c', 'sheet', 'Relationship', 'xf', 'numFmt']);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

function parseXml(bytes: Uint8Array | undefined, what: string): Node {
  if (!bytes) throw new XlsxReadError('XLSX_INVALID', `${what} bulunamadı`);
  const text = strFromU8(bytes);
  // Harici varlık (XXE) ve varlık-şişirme saldırılarına karşı: Excel dosyalarında DOCTYPE bulunmaz.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XlsxReadError('XLSX_INVALID', 'Dosyada izin verilmeyen XML tanımı var');
  try {
    return parser.parse(text) as Node;
  } catch {
    throw new XlsxReadError('XLSX_INVALID', `${what} okunamadı`);
  }
}

/** `<t>` düğümünün metni (öznitelikli düğümde `#text`). */
function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as Node)['#text']);
}

/** `<si>` / `<is>`: düz metin ya da zengin metin parçalarının birleşimi (fonetik parçalar atılır). */
function richText(node: unknown): string {
  if (node === undefined || node === null || typeof node === 'string') return textOf(node);
  const n = node as Node;
  if (n.r !== undefined) return (n.r as Node[]).map((run) => textOf(run.t)).join('');
  return textOf(n.t);
}

function asArray<T>(v: T | T[] | undefined | ''): T[] {
  if (v === undefined || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Özel sayı biçimi tarih/saat içeriyor mu? (tırnaklı metin, köşeli ayraç ve kaçışlı karakterler atılır) */
export function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '');
  return /[dmyhs]/i.test(stripped.split(';')[0] ?? '');
}

function dateStyles(styles: Node | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const root = (styles.styleSheet ?? {}) as Node;
  const custom = new Map<number, string>();
  for (const f of asArray((root.numFmts as Node | undefined)?.numFmt as Node[] | undefined)) {
    custom.set(Number(f['@_numFmtId']), String(f['@_formatCode'] ?? ''));
  }
  asArray((root.cellXfs as Node | undefined)?.xf as Node[] | undefined).forEach((xf, i) => {
    const id = Number(xf['@_numFmtId'] ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) out.add(i);
  });
  return out;
}

/** Excel seri numarası → `YYYY-MM-DD` (saat bilgisi varsa ` HH:mm:ss` eklenir). */
export function serialToText(serial: number, date1904: boolean): string {
  const days = Math.floor(serial);
  const frac = serial - days;
  // 1900 sistemi: 60. gün (var olmayan 29.02.1900) nedeniyle 60'tan önceki seri numaraları bir gün kayar
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * 86_400_000);
  const iso = d.toISOString().slice(0, 10);
  if (frac < 1e-9) return iso;
  const secs = Math.round(frac * 86_400);
  const hh = String(Math.floor(secs / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${iso} ${hh}:${mm}:${ss}`;
}

function normalizeNumber(v: string): string {
  try {
    const d = dec(v.trim());
    return d.isFinite() ? d.toSignificantDigits(15).toFixed() : v;
  } catch {
    return v;
  }
}

/** "AB12" → sütun indeksi (0 tabanlı) ve satır no (1 tabanlı). */
function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

export function readXlsx(data: Uint8Array, limits: XlsxLimits = DEFAULT_XLSX_LIMITS): ParsedSheet[] {
  const files = extract(data, limits);
  const workbook = (parseXml(files.get('xl/workbook.xml'), 'Çalışma kitabı').workbook ?? {}) as Node;
  const date1904 = ['1', 'true'].includes(String((workbook.workbookPr as Node | undefined)?.['@_date1904'] ?? '0'));
  const rels = new Map<string, string>();
  const relRoot = parseXml(files.get('xl/_rels/workbook.xml.rels'), 'İlişki dosyası').Relationships as Node | undefined;
  for (const r of asArray(relRoot?.Relationship as Node[] | undefined)) rels.set(String(r['@_Id']), String(r['@_Target']));

  const shared: string[] = files.has('xl/sharedStrings.xml')
    ? asArray(((parseXml(files.get('xl/sharedStrings.xml'), 'Paylaşılan metinler').sst ?? {}) as Node).si as Node[] | undefined).map(richText)
    : [];
  const dates = dateStyles(files.has('xl/styles.xml') ? parseXml(files.get('xl/styles.xml'), 'Biçimler') : undefined);

  const sheets: ParsedSheet[] = [];
  for (const s of asArray((workbook.sheets as Node | undefined)?.sheet as Node[] | undefined)) {
    const target = rels.get(String(s['@_r:id']));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const bytes = files.get(path);
    if (!bytes) continue;
    const sheetRoot = (parseXml(bytes, 'Sayfa').worksheet ?? {}) as Node;
    const sheetData = sheetRoot.sheetData;
    const rows: string[][] = [];
    let nextRow = 0;
    for (const row of asArray((typeof sheetData === 'object' && sheetData ? (sheetData as Node).row : undefined) as Node[] | undefined)) {
      const rowNo = row['@_r'] !== undefined ? Number(row['@_r']) : nextRow + 1;
      nextRow = rowNo;
      if (rowNo > limits.maxRows) throw new XlsxReadError('XLSX_TOO_LARGE', `Sayfada ${limits.maxRows} satırdan fazla var`);
      const cells: string[] = [];
      let nextCol = 0;
      for (const c of asArray(row.c as Node[] | undefined)) {
        const ref = typeof c['@_r'] === 'string' ? parseRef(c['@_r']) : null;
        const col = ref ? ref.col : nextCol;
        nextCol = col + 1;
        if (col >= limits.maxCols) throw new XlsxReadError('XLSX_TOO_LARGE', `Sayfada ${limits.maxCols} sütundan fazla var`);
        const type = String(c['@_t'] ?? 'n');
        const raw = textOf(c.v);
        let value = '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = richText(c.is);
        else if (type === 'str') value = raw;
        else if (type === 'b') value = raw === '1' ? 'true' : 'false';
        else if (type === 'e') value = '';
        else if (type === 'd') value = raw.slice(0, 19).replace('T', ' ');
        else if (raw.trim() !== '') {
          const n = Number(raw);
          value = dates.has(Number(c['@_s'] ?? 0)) && Number.isFinite(n) ? serialToText(n, date1904) : normalizeNumber(raw);
        }
        cells[col] = value;
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= '';
      rows[rowNo - 1] = cells;
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    while (rows.length > 0 && rows[rows.length - 1]!.every((v) => v === '')) rows.pop();
    sheets.push({ name: String(s['@_name'] ?? `Sayfa${sheets.length + 1}`), rows });
  }
  if (sheets.length === 0) throw new XlsxReadError('XLSX_INVALID', 'Çalışma kitabında sayfa bulunamadı');
  return sheets;
}
