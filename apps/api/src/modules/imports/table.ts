import { IMPORT_FIELDS, IMPORT_LIMITS, type ImportKind, type ImportParseResult, type NumberFormat } from '@erp/shared';
import { DEFAULT_XLSX_LIMITS, readXlsx, XlsxReadError, type ParsedSheet } from '../../files/xlsx-read';
import { unprocessable } from '../../http/errors';
import { foldKey } from './values';

/**
 * Yüklenen dosyayı (CSV/TXT ya da xlsx) metin matrisine çevirir. CSV: UTF-8/UTF-16 BOM, UTF-8 değilse
 * windows-1254 (Türkçe Excel'in eski "CSV" çıktısı), ayraç `;` `,` sekme `|` otomatik, tırnaklı alan ve
 * tırnak içinde satır sonu. Sınırlar: dosya boyutu, satır, sütun ve hücre uzunluğu.
 */

export interface RawRow {
  /** Kaynak satır numarası (1 tabanlı; CSV'de kayıt sırası). */
  no: number;
  cells: string[];
}

export interface RawTable {
  format: 'csv' | 'xlsx';
  sheets: string[];
  sheet: string | null;
  /** Boş olmayan tüm satırlar (ilki başlık satırıdır). */
  rows: RawRow[];
}

const fail = (code: string, message: string) => unprocessable(message, code);

/** Hücre metnini temizler: NUL ve kontrol karakterleri atılır, NBSP boşluğa dönüşür, uçlar kırpılır. */
export function cleanCell(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\u00a0/g, ' ').trim();
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // UTF-8 değil: Türkçe Windows/Excel'in eski kod sayfası
    return new TextDecoder('windows-1254').decode(bytes);
  }
}

const DELIMITERS = [';', ',', '\t', '|'] as const;

/** İlk mantıksal satırdaki (tırnak dışı) ayraçları sayar; en çok geçen kazanır, eşitlikte `;`. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let seenContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      seenContent = true;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (seenContent) break;
    } else if (!inQuotes) {
      if (ch.trim() !== '') seenContent = true;
      if (counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
    }
  }
  let best: string = ';';
  let bestN = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d)!;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/**
 * RFC 4180 benzeri ayrıştırıcı. Boş kayıtlar (tüm hücreler boş) atlanır ama kayıt numarası ilerler.
 * Tavanlar aşılırsa hemen durur (bellek/CPU korunur).
 */
export function parseDelimited(text: string, delimiter: string): RawRow[] {
  const rows: RawRow[] = [];
  let record: string[] = [];
  let cell = '';
  let inQuotes = false;
  let recordNo = 0;
  let cellStart = true; // hücrenin ilk karakteri mi (tırnak açılışı yalnızca burada geçerli)
  const maxRecords = IMPORT_LIMITS.maxRows + 1;

  const endCell = () => {
    if (cell.length > IMPORT_LIMITS.maxCellChars) {
      throw fail('IMPORT_CELL_TOO_LONG', `Satır ${recordNo + 1}: hücre ${IMPORT_LIMITS.maxCellChars} karakterden uzun`);
    }
    record.push(cleanCell(cell));
    if (record.length > IMPORT_LIMITS.maxCols) {
      throw fail('IMPORT_TOO_MANY_COLUMNS', `Dosyada en çok ${IMPORT_LIMITS.maxCols} sütun olabilir`);
    }
    cell = '';
    cellStart = true;
  };
  const endRecord = () => {
    endCell();
    recordNo++;
    if (record.some((c) => c !== '')) {
      if (rows.length >= maxRecords) {
        throw fail('IMPORT_TOO_MANY_ROWS', `Dosyada en çok ${IMPORT_LIMITS.maxRows} veri satırı olabilir; dosyayı bölün`);
      }
      rows.push({ no: recordNo, cells: record });
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
        if (cell.length > IMPORT_LIMITS.maxCellChars + 1) {
          throw fail('IMPORT_CELL_TOO_LONG', `Satır ${recordNo + 1}: hücre ${IMPORT_LIMITS.maxCellChars} karakterden uzun`);
        }
      }
      continue;
    }
    if (ch === '"' && cellStart) {
      inQuotes = true;
      cellStart = false;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      cell += ch;
      if (ch.trim() !== '') cellStart = false;
    }
  }
  if (inQuotes) throw fail('IMPORT_FILE_INVALID', 'CSV dosyasında kapanmamış tırnak var');
  if (cell !== '' || record.length > 0) endRecord();
  return rows;
}

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
const isOle = (b: Uint8Array) => b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

/** Dosyayı okur; `sheet` yalnızca xlsx için anlamlıdır (verilmezse ilk sayfa). */
export function readTable(bytes: Uint8Array, fileName: string, sheet?: string): RawTable {
  if (bytes.length === 0) throw fail('IMPORT_FILE_EMPTY', 'Dosya boş');
  if (bytes.length > IMPORT_LIMITS.maxFileBytes) {
    throw fail('IMPORT_FILE_TOO_LARGE', `Dosya en çok ${Math.round(IMPORT_LIMITS.maxFileBytes / 1024 / 1024)} MB olabilir`);
  }
  if (isOle(bytes)) {
    throw fail('IMPORT_FORMAT_UNSUPPORTED', 'Eski .xls biçimi desteklenmiyor; dosyayı Excel\'de .xlsx ya da CSV olarak kaydedip yükleyin');
  }

  if (isZip(bytes)) {
    let sheets: ParsedSheet[];
    try {
      sheets = readXlsx(bytes, { ...DEFAULT_XLSX_LIMITS, maxRows: IMPORT_LIMITS.maxRows + 50, maxCols: IMPORT_LIMITS.maxCols });
    } catch (e) {
      if (e instanceof XlsxReadError) {
        throw fail(e.code === 'XLSX_TOO_LARGE' ? 'IMPORT_FILE_TOO_LARGE' : 'IMPORT_FILE_INVALID', e.code === 'XLSX_TOO_LARGE' ? 'Excel dosyası çok büyük' : `Excel dosyası okunamadı: ${e.message}`);
      }
      throw e;
    }
    const chosen = sheet ? sheets.find((s) => s.name === sheet) : sheets[0];
    if (!chosen) throw fail('IMPORT_SHEET_NOT_FOUND', `"${sheet}" sayfası bulunamadı`);
    const rows: RawRow[] = [];
    chosen.rows.forEach((cells, i) => {
      const cleaned = cells.map(cleanCell);
      if (cleaned.some((c) => c !== '')) {
        if (cleaned.some((c) => c.length > IMPORT_LIMITS.maxCellChars)) {
          throw fail('IMPORT_CELL_TOO_LONG', `Satır ${i + 1}: hücre ${IMPORT_LIMITS.maxCellChars} karakterden uzun`);
        }
        rows.push({ no: i + 1, cells: cleaned });
      }
    });
    if (rows.length > IMPORT_LIMITS.maxRows + 1) {
      throw fail('IMPORT_TOO_MANY_ROWS', `Dosyada en çok ${IMPORT_LIMITS.maxRows} veri satırı olabilir; dosyayı bölün`);
    }
    return { format: 'xlsx', sheets: sheets.map((s) => s.name), sheet: chosen.name, rows };
  }

  if (/\.xlsx$/i.test(fileName)) {
    throw fail('IMPORT_FILE_INVALID', 'Dosya geçerli bir .xlsx (Excel) dosyası değil');
  }
  const text = decodeText(bytes);
  const rows = parseDelimited(text, detectDelimiter(text));
  return { format: 'csv', sheets: [], sheet: null, rows };
}

/** Başlık satırı aranan en fazla satır sayısı (üstteki rapor başlığı/dönem satırlarını atlamak için). */
const HEADER_SCAN_ROWS = 15;

/**
 * Başlık satırı: türün alan adlarına/eş anlamlılarına en çok uyan satır (eşitlikte ilki). Hiçbir satır uymuyorsa
 * ilk satır. Böylece başında rapor adı/dönem satırı olan dosyalar (bizim dışa aktarmalarımız, başka programların
 * Excel çıktıları) da doğru okunur.
 */
export function detectHeaderRow(rows: readonly RawRow[], kind?: ImportKind): number {
  if (!kind) return 0;
  const known = new Set(IMPORT_FIELDS[kind].flatMap((f) => f.synonyms.map(foldKey)));
  let best = 0;
  let bestScore = 0;
  rows.slice(0, HEADER_SCAN_ROWS).forEach((r, i) => {
    const score = new Set(r.cells.map(foldKey).filter((c) => c !== '' && known.has(c))).size;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** Ham tabloyu başlık + veri satırlarına ayırır (eşleme önerisi çağıran tarafta eklenir). */
export function splitHeader(raw: RawTable, kind?: ImportKind): Pick<ImportParseResult, 'headers' | 'rows'> & { suggestedNumberFormat: NumberFormat } {
  const headerIndex = detectHeaderRow(raw.rows, kind);
  const head = raw.rows[headerIndex];
  const data = raw.rows.slice(headerIndex + 1);
  if (!head) throw fail('IMPORT_FILE_EMPTY', 'Dosyada başlık satırı bulunamadı');
  if (data.length === 0) throw fail('IMPORT_FILE_EMPTY', 'Dosyada başlıktan sonra veri satırı yok');
  const width = Math.min(IMPORT_LIMITS.maxCols, Math.max(head.cells.length, ...data.map((r) => r.cells.length)));
  const headers = Array.from({ length: width }, (_, i) => head.cells[i] || `Sütun ${i + 1}`);
  const rows = data.map((r) => ({ no: r.no, cells: Array.from({ length: width }, (_, i) => r.cells[i] ?? '') }));
  // xlsx sayı hücreleri kanonik (noktalı) ondalıktır; CSV metni Türkçe ya da İngilizce olabilir
  return { headers, rows, suggestedNumberFormat: raw.format === 'xlsx' ? 'en' : 'auto' };
}
