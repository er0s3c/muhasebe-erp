/**
 * Dışa aktarılabilir düz tablo: her rapor bunu üretir, CSV ve XLSX yazıcıları aynı yapıyı kullanır.
 * Tutarlar ondalık metin ("1234.5600"), tarihler `YYYY-MM-DD`, tam sayılar `number`'dır; biçimlendirme
 * (Türkçe gösterim ya da Excel sayı biçimi) yazıcılara aittir.
 */
export type ColumnKind = 'text' | 'money' | 'date' | 'qty' | 'rate' | 'int';

export interface TableColumn {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Excel sütun genişliği (karakter); boşsa türe göre. */
  width?: number;
}

export type CellValue = string | number | null;

export interface ReportTable {
  /** Dosya adı için kısa anahtar (ör. `mizan`). */
  key: string;
  title: string;
  /** Excel sayfa adı; boşsa başlık (en çok 31 karakter). */
  sheet?: string;
  /** Dönem/süzgeç bilgisi (tek satır). */
  subtitle?: string;
  /** XLSX'te başlık/dönem satırları olmadan, sütun başlıkları 1. satırda (içe aktarma şablonları için). */
  plain?: boolean;
  columns: TableColumn[];
  rows: Record<string, CellValue>[];
  /** Toplam satırı: yalnızca dolu anahtarlar yazılır; ilk metin sütununa "Toplam" etiketi konur. */
  totals?: Record<string, CellValue>;
}

export const DEFAULT_WIDTH: Record<ColumnKind, number> = { text: 32, money: 16, date: 12, qty: 12, rate: 12, int: 8 };

/** İlk sütunda Excel/CSV'de görünen toplam satırı etiketi. */
export const TOTAL_LABEL = 'Toplam';
