import { formatDateTR } from '@erp/shared';
import type { ReportTable } from '../../files/table';
import { notFound } from '../../http/errors';
import { col, type BuildCtx } from '../exports/builders';
import { DEFAULT_CLOSING_OPTIONS, closingEntryLines, getFiscalYear } from './service';

/** Kapanış fişi dışa aktarma: kapalı yılda kaydedilmiş fişler, açık yılda önizleme (başlıkta belirtilir). Doğrulanmadı notu başlıktadır. */
export async function yearEndClosingTable(
  ctx: BuildCtx,
  q: { fiscalYearId: string; carryForward?: boolean; includeCostAccounts?: boolean },
): Promise<ReportTable[]> {
  const year = await getFiscalYear(ctx.tx, q.fiscalYearId).catch(() => {
    throw notFound('Mali yıl');
  });
  const opts = { ...DEFAULT_CLOSING_OPTIONS, ...(q.carryForward !== undefined ? { carryForward: q.carryForward } : {}), ...(q.includeCostAccounts !== undefined ? { includeCostAccounts: q.includeCostAccounts } : {}) };
  const data = await closingEntryLines(ctx.tx, ctx.company.baseCurrency, year, opts);
  const b = ctx.company.baseCurrency;
  const columns = [
    col('entryNo', 'Fiş no', 'text', 16),
    col('date', 'Tarih', 'date'),
    col('account', 'Hesap', 'text', 12),
    col('name', 'Hesap adı', 'text', 36),
    col('description', 'Açıklama', 'text', 40),
    col('project', 'Proje', 'text', 14),
    col('wbs', 'İş kalemi', 'text', 14),
    col('debitBase', `Borç (${b})`, 'money'),
    col('creditBase', `Alacak (${b})`, 'money'),
  ];
  const rows: Record<string, string | null>[] = [];
  if (data.source === 'posted') {
    for (const l of data.entries) {
      rows.push({ entryNo: l.entry_no ?? null, date: l.entry_date ?? null, account: l.code ?? null, name: l.name ?? null, description: l.description ?? null, project: l.project_code ?? null, wbs: l.wbs_code ?? null, debitBase: l.debit_base ?? null, creditBase: l.credit_base ?? null });
    }
  } else if (data.preview) {
    for (const [no, e] of [['ÖNİZLEME-KAPANIŞ', data.preview.closingEntry], ['ÖNİZLEME-DEVİR', data.preview.carryEntry]] as const) {
      for (const l of e?.lines ?? []) {
        rows.push({ entryNo: no, date: e!.date, account: l.accountCode, name: l.accountName, description: l.description, project: l.projectCode, wbs: l.wbsCode, debitBase: l.debitBase, creditBase: l.creditBase });
      }
    }
  }
  rows.push({ entryNo: null, date: null, account: null, name: null, description: 'Doğrulanmadı: hesap seçimleri ve kapanış yöntemi mali müşavir onayı gerektirir (LEGAL-NOTES §23)', project: null, wbs: null, debitBase: null, creditBase: null });
  return [
    {
      key: 'yil-sonu-kapanis',
      title: `Yıl sonu kapanış fişi · ${year.name}`,
      sheet: 'Kapanış',
      subtitle: `${ctx.company.name} · ${formatDateTR(year.startDate)} – ${formatDateTR(year.endDate)} · ${data.source === 'posted' ? 'Kaydedilmiş fiş' : 'Önizleme (kaydedilmedi)'} · Doğrulanmadı: hesap seçimleri mali müşavir onayı gerektirir`,
      columns,
      rows,
    },
  ];
}
