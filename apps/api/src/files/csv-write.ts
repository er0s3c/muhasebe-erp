import { formatDateTR, formatTR } from '@erp/shared';
import { TOTAL_LABEL, type CellValue, type ReportTable, type TableColumn } from './table';

const BOM = '﻿';

/**
 * Formül enjeksiyonuna karşı: Excel'in formül saydığı önekle başlayan metin hücresinin başına `'` konur.
 * Yalnızca metin sütunlarına uygulanır (negatif tutarlar zaten Türkçe biçimli metindir ve `-` ile başlar).
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function display(col: TableColumn, v: CellValue): string {
  if (v === null || v === undefined || v === '') return '';
  switch (col.kind) {
    case 'money':
      return formatTR(String(v), 2);
    case 'rate':
      return formatTR(String(v), 4);
    case 'qty':
      return formatTR(String(v), 4).replace(/,?0+$/, '');
    case 'date':
      return formatDateTR(String(v));
    case 'int':
      return String(v);
    default:
      return neutralizeFormula(String(v));
  }
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * CSV: `;` ayraç, hücreler tırnaklı, başta BOM, satır sonu `\r\n`, tutarlar Türkçe biçimli metin
 * (Türkçe Excel'de doğrudan açılır). İlk satır sütun başlıklarıdır; rapor başlığı ve dönem bilgisi
 * yalnızca XLSX'te yer alır (CSV başka programlara aktarılabilsin diye düz tutulur).
 */
export function renderCsv(table: ReportTable): string {
  const lines: string[] = [];
  lines.push(table.columns.map((c) => quote(c.label)).join(';'));
  for (const row of table.rows) lines.push(table.columns.map((c) => quote(display(c, row[c.key] ?? null))).join(';'));
  if (table.totals) {
    const firstText = table.columns.findIndex((c) => c.kind === 'text');
    lines.push(
      table.columns
        .map((c, i) => {
          const v = table.totals![c.key];
          if (v !== undefined && v !== null && v !== '') return quote(display(c, v));
          return quote(i === (firstText < 0 ? 0 : firstText) ? TOTAL_LABEL : '');
        })
        .join(';'),
    );
  }
  return BOM + lines.join('\r\n') + '\r\n';
}
