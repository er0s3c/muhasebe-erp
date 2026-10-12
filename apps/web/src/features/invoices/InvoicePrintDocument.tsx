import { FX_PROVIDER_LABELS, FX_RATE_TYPE_LABELS, INVOICE_TYPE_META, dec, type InvoicePrintTemplate } from '@erp/shared';
import { useTranslation } from 'react-i18next';
import { PrintSignatures } from '../../components/print/PrintBlocks';
import { Table, Td, Th, Tr } from '../../components/ui/Table';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import { formatDateTR, money, moneyIn } from '../../lib/format';
import type { InvoiceDetail } from '../../lib/types';
import { qtyText, useUnitLabel } from '../inventory/common';

type PartyInfo = { name: string; taxNumber?: string | null; taxOffice?: string | null; address?: string | null };
function PartyBlock({ title, value }: { title: string; value: PartyInfo }) {
  return <section className="min-w-0"><h2 className="mb-1 text-xs text-muted">{title}</h2><p className="break-words text-sm">{value.name}</p>{value.taxOffice && <p className="mt-1 break-words text-xs">Vergi dairesi: {value.taxOffice}</p>}{value.taxNumber && <p className="mt-1 break-words text-xs">Vergi numarası: {value.taxNumber}</p>}{value.address && <p className="mt-1 whitespace-pre-line break-words text-xs">{value.address}</p>}</section>;
}

/** Ekran ve PDF aynı kesinleşmiş tutarları ve tarihsel taraf/kur kaydını kullanır. */
export function InvoicePrintDocument({ data, template, preview = false }: { data: InvoiceDetail; template: InvoicePrintTemplate; preview?: boolean }) {
  const { t } = useTranslation();
  const company = useCompany();
  const unitLabel = useUnitLabel();
  const { invoice: inv, lines } = data;
  const metadata = inv.documentMetadata;
  const legacyCompany = useCQuery<{ company: PartyInfo }>(['company'], metadata?.company ? null : '/api/company');
  const issuer = metadata?.company ?? legacyCompany.data?.company ?? { name: company.name };
  const party = metadata?.party ?? { name: inv.partyName };
  const detailed = template === 'detailed';
  const meta = INVOICE_TYPE_META[inv.type];
  const fx = inv.fxSnapshot;
  const base = fx?.to ?? company.baseCurrency;
  const sourceInvoice = metadata?.originalInvoice?.invoiceNo ?? inv.returnOfNo;
  const title = { sales: 'Satış faturası', sales_return: 'Satış iade faturası', purchase: 'Alış faturası', expense: 'Gider faturası', purchase_return: 'Alış iade faturası' }[inv.type];
  const provider = fx?.provider === 'tcmb' || fx?.provider === 'kktcmb' ? FX_PROVIDER_LABELS[fx.provider] : fx?.provider === 'xml' ? 'XML dosyası' : fx?.provider === 'manual' || fx?.method === 'manual' ? 'Elle girilen kur' : 'Kayıtlı kur';
  const taxes = inv.taxTotalsSnapshot;
  return (
    <article data-invoice-print-document data-print-company-name={issuer.name} data-print-template={template} className={preview ? 'invoice-print-document rounded-xl border border-border bg-surface p-4 sm:p-6 print:border-0 print:p-0' : 'invoice-print-document print-only'}>
      <style>{`@media print { main:has([data-invoice-print-document]) .print-letterhead { display: none !important; } .invoice-print-document { display: block !important; } .invoice-print-document th { white-space: normal !important; } .invoice-print-document td { overflow-wrap: anywhere; } .invoice-print-final-section { break-inside: avoid; } }`}</style>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-text pb-4">
        <div className="min-w-0"><p className="break-words text-xl" data-testid="print-company-name">{issuer.name}</p><h1 className="mt-2 text-base">{title} · {inv.invoiceNo}</h1></div>
        <dl className="space-y-1 text-right text-xs"><div><dt className="inline text-muted">Belge tarihi: </dt><dd className="inline">{formatDateTR(inv.invoiceDate)}</dd></div>{inv.dueDate && <div><dt className="inline text-muted">Vade: </dt><dd className="inline">{formatDateTR(inv.dueDate)}</dd></div>}<div><dt className="inline text-muted">Para birimi: </dt><dd className="inline">{inv.currencyCode}</dd></div>{inv.externalNo && <div><dt className="inline text-muted">Haricî belge no: </dt><dd className="inline break-all">{inv.externalNo}</dd></div>}</dl>
      </header>
      {inv.status === 'cancelled' && <div className="mb-4 border border-danger p-3 text-sm"><p>İPTAL EDİLMİŞ BELGE{inv.cancelledAt ? ` · ${formatDateTR(inv.cancelledAt.slice(0, 10))}` : ''}</p>{inv.cancelReason && <p className="mt-1">{inv.cancelReason}</p>}</div>}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2">
        <PartyBlock title="Şirket" value={issuer} />
        <PartyBlock title={meta.side === 'sales' ? 'Müşteri' : 'Tedarikçi'} value={party} />
      </div>
      {sourceInvoice && <p className="mb-3 text-xs">İadenin özgün faturası: {sourceInvoice}</p>}
      {inv.description && <p className="mb-4 whitespace-pre-line break-words text-sm">{inv.description}</p>}
      <div className="overflow-x-auto print:overflow-visible"><Table className="text-xs"><thead><Tr><Th>Kalem</Th><Th num>Miktar</Th><Th num>Birim fiyat</Th>{detailed && <Th num>İndirim</Th>}<Th num>KDV</Th>{detailed && <Th num>Net tutar</Th>}<Th num>Toplam</Th></Tr></thead><tbody>{lines.map(line => <Tr key={line.id}>
        <Td className="min-w-36 print:min-w-0"><p className="whitespace-pre-line break-words">{line.description}</p>{detailed && <>
          {line.itemCode && <p className="mt-1 font-mono text-xs text-muted">{line.itemCode}</p>}
          {!!line.serials?.length && <p className="mt-1 break-all text-xs text-muted">Seri numaraları: {line.serials.join(', ')}</p>}
          {line.orderCode && <p className="mt-1 text-xs text-muted">Sipariş: {line.orderCode}</p>}
          {line.deliveryNoteNo && <p className="mt-1 text-xs text-muted">İrsaliye: {line.deliveryNoteNo}</p>}
          {line.projectCode && <p className="mt-1 text-xs text-muted">Proje: {line.projectCode}{line.wbsCode ? ` · ${line.wbsCode}` : ''}</p>}
        </>}
        {line.taxCalculation && <div className="mt-1 text-xs text-muted">
          {dec(line.taxCalculation.vatWithheld).gt(0) && <p>KDV tevkifatı: {moneyIn(line.taxCalculation.vatWithheld, inv.currencyCode)}</p>}
          {dec(line.taxCalculation.incomeWithheld).gt(0) && <p>Stopaj: {moneyIn(line.taxCalculation.incomeWithheld, inv.currencyCode)}</p>}
          {dec(line.taxCalculation.stamp).gt(0) && <p>Damga / pul: {moneyIn(line.taxCalculation.stamp, inv.currencyCode)}</p>}
        </div>}</Td>
        <Td num>{qtyText(line.quantity)} {line.unit ? unitLabel(line.unit) : ''}</Td><Td num>{money(line.unitPrice)}</Td>{detailed && <Td num>{dec(line.discountPct).isZero() ? '—' : `%${qtyText(line.discountPct)}`}</Td>}<Td num>{line.vatCode ? `%${qtyText(line.vatRate)}` : '—'}</Td>{detailed && <Td num>{money(line.net)}</Td>}<Td num>{money(line.gross)}</Td>
      </Tr>)}</tbody></Table></div>
      <div className="invoice-print-final-section">
      <div className="mt-4 flex justify-end"><dl className="w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between gap-4"><dt>Net toplam</dt><dd className="num">{moneyIn(inv.netTotal, inv.currencyCode)}</dd></div>
        <div className="flex justify-between gap-4"><dt>KDV toplamı</dt><dd className="num">{moneyIn(inv.vatTotal, inv.currencyCode)}</dd></div>
        <div className="flex justify-between gap-4 border-t border-text pt-2"><dt>Genel toplam</dt><dd className="num" data-testid="print-gross-total">{moneyIn(inv.grossTotal, inv.currencyCode)}</dd></div>
        {taxes && <><div className="flex justify-between gap-4"><dt>KDV tevkifatı</dt><dd className="num">{moneyIn(taxes.vatWithheld, inv.currencyCode)}</dd></div><div className="flex justify-between gap-4"><dt>Stopaj</dt><dd className="num">{moneyIn(taxes.incomeWithheld, inv.currencyCode)}</dd></div><div className="flex justify-between gap-4"><dt>Damga / pul</dt><dd className="num">{moneyIn(taxes.stamp, inv.currencyCode)}</dd></div><div className="flex justify-between gap-4 border-t border-border pt-2"><dt>Satıcıya ödenecek</dt><dd className="num">{moneyIn(taxes.payableToSeller, inv.currencyCode)}</dd></div></>}
        {inv.currencyCode !== base && inv.grossTotalBase && <div className="flex justify-between gap-4 text-xs text-muted"><dt>Defter karşılığı</dt><dd className="num">{moneyIn(inv.grossTotalBase, base)}</dd></div>}
      </dl></div>
      {inv.currencyCode !== base && inv.fxRate && <section className="mt-5 border-t border-border pt-3 text-xs text-muted">
        <p>İşlem kuru: 1 {inv.currencyCode} = {money(inv.fxRate, 8)} {base}{fx?.rateType ? ` · ${FX_RATE_TYPE_LABELS[fx.rateType]}` : ''}</p>
        {detailed && fx && <><p className="mt-1">Kur kaynağı: {provider}{fx.rateDate ? ` · ${formatDateTR(fx.rateDate)}` : ''}{fx.source ? ` · ${fx.source}` : ''}</p>{fx.sourceUrl && <p className="mt-1 break-all">Kaynak: {fx.sourceUrl}</p>}{fx.manualReason && <p className="mt-1">Elle kur gerekçesi: {fx.manualReason}</p>}{fx.legs?.length > 1 && <p className="mt-1">Çapraz kur: {fx.legs.map(leg => `${leg.currencyCode}/${leg.quoteCode} · ${formatDateTR(leg.rateDate)} · ${money(leg.value, 8)}`).join(' / ')}</p>}</>}
        {fx?.originalInvoiceId && <p className="mt-1">İade hesabında özgün faturanın kur kaydı kullanılmıştır.</p>}
      </section>}
      {!metadata?.company && <p className="mt-4 text-xs text-muted">Bu eski belgede şirket bilgileri belge anında saklanmamıştır; mevcut şirket bilgileri gösterilir.</p>}
      <p className="mt-4 text-xs text-muted">Bu çıktı iç kullanım belgesidir; resmî belge biçimi doğrulanmamıştır.</p>
      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved')]} />
      </div>
    </article>
  );
}
