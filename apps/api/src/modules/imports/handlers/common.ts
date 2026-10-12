import type {
  ImportCommitResult,
  ImportKind,
  ImportMessage,
  ImportPreviewRow,
  ImportRow,
  ImportRowStatus,
  ImportUnmatched,
  Permission,
} from '@erp/shared';
import { sql, type SQL } from 'drizzle-orm';
import { dec, type MoneyValue } from '@erp/shared';
import type { Tx } from '../../../db/client';
import type { CompanyInfo } from '../../../http/context';
import type { LedgerCtx } from '../../ledger/journal';
import type { StockCtx } from '../../inventory/documents';

export interface ImportCtx {
  tx: Tx;
  company: CompanyInfo;
  userId: string;
}

export const ledgerCtxOf = ({ company, userId }: ImportCtx): LedgerCtx => ({
  companyId: company.id,
  userId,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
});

export const stockCtxOf = ({ company, userId }: ImportCtx): StockCtx => ({
  companyId: company.id,
  userId,
  baseCurrency: company.baseCurrency,
  reportingCurrency: company.reportingCurrency,
  allowNegativeStock: company.allowNegativeStock,
});

/** Satır durumunu ve iletilerini toplar. `error` satırı yazılmasını engeller, `skip` satırı atlanır. */
export class RowState {
  status: ImportRowStatus = 'ok';
  readonly messages: ImportMessage[] = [];

  constructor(
    readonly row: number,
    public label = '',
  ) {}

  error(field: string | undefined, code: string, message: string): void {
    this.status = 'error';
    this.messages.push({ severity: 'error', field, code, message });
  }

  warn(field: string | undefined, code: string, message: string): void {
    this.messages.push({ severity: 'warning', field, code, message });
  }

  /** Satır yazılmaz ama hata da değildir (yinelenen kayıt, sıfır tutar…). Hata varsa hata olarak kalır. */
  skip(code: string, message: string): void {
    if (this.status !== 'error') this.status = 'skip';
    this.messages.push({ severity: 'info', code, message });
  }

  get ok(): boolean {
    return this.status === 'ok';
  }

  preview(): ImportPreviewRow {
    return { row: this.row, status: this.status, label: this.label, messages: this.messages };
  }
}

/** Satırdaki alan metni (kırpılmış; yoksa boş). */
export const cellOf = (row: ImportRow, key: string): string => (row.cells[key] ?? '').trim();

export interface ApplyResult extends Omit<ImportCommitResult, 'kind' | 'skipped'> {
  skipped?: number;
}

/** Mutabakat satırı: kaynak ve sonuç aynı biçimde metne çevrilir, eşitlik sayısal karşılaştırılır. */
export function reconRow(label: string, source: MoneyValue | number, result: MoneyValue | number, format: (v: MoneyValue) => string = (v) => v.toString()) {
  const s = dec(source), r = dec(result);
  return { label, source: format(s), result: format(r), ok: s.eq(r) };
}

/** Yazılan yevmiyenin yeniden okunan borç/alacak toplamı (defter para birimi); `where` satırları süzer (ör. yalnız cari satırları). */
export async function journalTotals(tx: Tx, entryId: string, where: SQL = sql`true`) {
  const r = await tx.execute<{ d: string; c: string; n: number }>(sql`
    select coalesce(sum(debit_base), 0)::text as d, coalesce(sum(credit_base), 0)::text as c, count(*)::int as n
      from journal_lines where entry_id = ${entryId}::uuid and ${where}`);
  const row = r.rows[0]!;
  return { debit: dec(row.d), credit: dec(row.c), lines: Number(row.n) };
}

export interface PlanResult {
  rows: ImportPreviewRow[];
  general: ImportMessage[];
  summary: { label: string; value: string }[];
  /** Eşleşmeyen cari/stok metinleri (arayüz elle eşletir). */
  unmatched?: ImportUnmatched[];
  /** Doğrulanmış verilerle yazma işlemi. Hata varsa çağrılmaz. */
  apply: () => Promise<ApplyResult>;
}

export interface ImportHandler {
  kind: ImportKind;
  /** Modül kayıt anahtarı: etkin değilse uç 403 verir. */
  module: string;
  permission: Permission;
  /**
   * Hiçbir şey yazmadan doğrular ve yazılacakları hazırlar. Ön izleme ve gerçek içe aktarma aynı fonksiyonu
   * çağırır; böylece ikisi asla ayrışmaz. Yazma yalnızca `apply` ile, doğrulama tamamen bittikten sonra yapılır.
   */
  plan(ctx: ImportCtx, rows: ImportRow[], options: Record<string, unknown>): Promise<PlanResult>;
}

export const money = (n: { toFixed: (dp?: number) => string }) => n.toFixed(2);

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_RE = /^[A-Za-z0-9ÇĞİÖŞÜçğıöşü._/-]+$/;
