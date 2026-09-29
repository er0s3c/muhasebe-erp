import { z } from 'zod';
import {
  accountLedgerQuerySchema,
  agingQuerySchema,
  fullDataQuerySchema,
  fxDifferencesQuerySchema,
  generalLedgerQuerySchema,
  itemMovementsQuerySchema,
  itemProfitQuerySchema,
  journalBookQuerySchema,
  openItemsQuerySchema,
  partyStatementQuerySchema,
  salesReportQuerySchema,
  stockStatusQuerySchema,
  todayIso,
  trialBalanceQuerySchema,
  treasuryStatementQuerySchema,
  uuid,
  vatSummaryQuerySchema,
  type ExportFormat,
  type Permission,
} from '@erp/shared';
import type { ReportTable } from '../../files/table';
import {
  accountLedgerTable,
  fxDifferencesTable,
  generalLedgerTable,
  itemCardTable,
  itemProfitTable,
  journalBookTable,
  partyAgingTable,
  partyOpenItemsTable,
  partyStatementTable,
  salesReportTable,
  stockStatusTable,
  trialBalanceTable,
  treasuryStatementTable,
  vatSummaryTable,
  type BuildCtx,
} from './builders';
import { fullDataTables } from './full-data';

/** Dışa aktarılabilir rapor: kendi modül ve izniyle korunur (ekran raporuyla aynı). */
export interface ExportDef {
  key: string;
  module: string;
  permission: Permission;
  schema: z.ZodType<Record<string, unknown>>;
  build: (ctx: BuildCtx, q: never) => Promise<ReportTable[]>;
  formats: readonly ExportFormat[];
  /** Dosya adı (uzantısız, ASCII): rapor + dönem/tarih. */
  fileName: (q: never) => string;
}

function def<S extends z.ZodType<Record<string, unknown>>>(
  d: Omit<ExportDef, 'schema' | 'build' | 'fileName' | 'formats'> & {
    schema: S;
    build: (ctx: BuildCtx, q: z.infer<S>) => Promise<ReportTable[]>;
    file: string | ((q: z.infer<S>) => string);
    formats?: readonly ExportFormat[];
  },
): ExportDef {
  return {
    key: d.key,
    module: d.module,
    permission: d.permission,
    schema: d.schema,
    build: d.build as ExportDef['build'],
    formats: d.formats ?? ['xlsx', 'csv'],
    fileName: ((q: z.infer<S>) => (typeof d.file === 'function' ? d.file(q) : d.file)) as ExportDef['fileName'],
  };
}

const range = (name: string) => (q: { from: string; to: string }) => `${name}-${q.from}_${q.to}`;
const asOf = (name: string) => (q: { asOf: string }) => `${name}-${q.asOf}`;

const ledger = { module: 'core.ledger', permission: 'reports.read' } as const;
const invoices = { module: 'core.invoices', permission: 'reports.read' } as const;

export const EXPORTS: readonly ExportDef[] = [
  // Mevcut raporlar
  def({ key: 'trial-balance', ...ledger, schema: trialBalanceQuerySchema.extend({ view: z.enum(['groups', 'accounts']).default('groups') }), build: trialBalanceTable, file: range('mizan') }),
  def({ key: 'account-ledger', ...ledger, schema: accountLedgerQuerySchema, build: accountLedgerTable, file: range('muavin') }),
  def({ key: 'party-aging', module: 'core.parties', permission: 'parties.read', schema: agingQuerySchema, build: partyAgingTable, file: (q) => `yaslandirma-${q.type === 'receivable' ? 'alacak' : 'borc'}-${q.asOf}` }),
  def({ key: 'party-statement', module: 'core.parties', permission: 'parties.read', schema: partyStatementQuerySchema.extend({ partyId: uuid }), build: partyStatementTable, file: range('cari-ekstre') }),
  def({ key: 'party-open-items', module: 'core.parties', permission: 'parties.read', schema: openItemsQuerySchema.extend({ partyId: uuid }), build: partyOpenItemsTable, file: asOf('acik-kalemler') }),
  def({ key: 'stock-status', module: 'core.inventory', permission: 'inventory.read', schema: stockStatusQuerySchema, build: stockStatusTable, file: asOf('stok-durumu') }),
  def({ key: 'item-card', module: 'core.inventory', permission: 'inventory.read', schema: itemMovementsQuerySchema.extend({ itemId: uuid }), build: itemCardTable, file: range('stok-karti') }),
  def({ key: 'vat-summary', ...invoices, schema: vatSummaryQuerySchema, build: vatSummaryTable, file: range('kdv-ozeti') }),
  def({ key: 'treasury-statement', module: 'core.treasury', permission: 'treasury.read', schema: treasuryStatementQuerySchema.extend({ accountId: uuid }), build: treasuryStatementTable, file: range('hesap-ekstresi') }),
  // Yeni raporlar
  def({ key: 'journal-book', ...ledger, schema: journalBookQuerySchema.pick({ from: true, to: true }), build: journalBookTable, file: range('yevmiye-defteri') }),
  def({ key: 'general-ledger', ...ledger, schema: generalLedgerQuerySchema.pick({ from: true, to: true, codePrefix: true }), build: generalLedgerTable, file: range('kebir') }),
  def({ key: 'sales-report', ...invoices, schema: salesReportQuerySchema, build: (ctx, q) => salesReportTable(ctx, 'sales', q), file: (q) => `satis-raporu-${q.groupBy}-${q.from}_${q.to}` }),
  def({ key: 'purchase-report', ...invoices, schema: salesReportQuerySchema, build: (ctx, q) => salesReportTable(ctx, 'purchases', q), file: (q) => `alis-raporu-${q.groupBy}-${q.from}_${q.to}` }),
  def({ key: 'item-profitability', ...invoices, schema: itemProfitQuerySchema, build: itemProfitTable, file: range('stok-karliligi') }),
  def({ key: 'fx-differences', module: 'core.treasury', permission: 'reports.read', schema: fxDifferencesQuerySchema, build: fxDifferencesTable, file: range('kambiyo-raporu') }),
  def({ key: 'full-data', module: 'core.settings', permission: 'data.export', schema: fullDataQuerySchema, build: fullDataTables, file: () => `tum-veriler-${todayIso()}`, formats: ['xlsx'] }),
];

export const EXPORT_BY_KEY = new Map(EXPORTS.map((e) => [e.key, e]));
