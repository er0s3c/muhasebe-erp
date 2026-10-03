import { Percent } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { dec, todayIso } from '@erp/shared';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { currencySymbol, money, moneyIn } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { VatSummary } from '../../lib/types';

/** KDV özeti: hesaplanan KDV (satışlar), indirilecek KDV (alışlar/giderler), oran bazında. */
export function VatSummaryPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const { data, isPending } = useCQuery<VatSummary>(['vat-summary', from, to], `/api/reports/vat-summary?from=${from}&to=${to}`);
  const payable = data ? dec(data.totals.payable) : null;

  return (
    <>
      <PageHeader title={t('invoices.vat.title')} description={t('invoices.vat.subtitle')} actions={<ExportMenu exportKey="vat-summary" params={{ from, to }} disabled={!data || data.rows.length === 0} />} />
      <PrintHeader subtitle={`${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}`} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
      </div>

      {data && data.unverifiedCodes.length > 0 && (
        <div className="mb-5">
          <Callout tone="warning">
            {t('invoices.vat.unverified', { codes: data.unverifiedCodes.join(', ') })}{' '}
            <Link to="/settings/tax-rates" className="link">
              {t('nav.taxRates')}
            </Link>
          </Callout>
        </div>
      )}

      {isPending || !data ? (
        <PageLoading />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Stat label={t('invoices.vat.output')}>{moneyIn(data.totals.salesVat, company.baseCurrency)}</Stat>
            <Stat label={t('invoices.vat.input')}>{moneyIn(data.totals.purchaseVat, company.baseCurrency)}</Stat>
            <Stat label={payable && payable.isNegative() ? t('invoices.vat.carryover') : t('invoices.vat.payable')}>
              {moneyIn(payable ? payable.abs().toFixed(2) : '0', company.baseCurrency)}
            </Stat>
          </div>

          {data.rows.length === 0 ? (
            <Card>
              <EmptyState icon={<Percent className="size-5" />} title={t('invoices.vat.empty')} />
            </Card>
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{t('invoices.vat.rate')}</Th>
                    <Th num>{t('invoices.vat.salesNet')}</Th>
                    <Th num>{t('invoices.vat.output')}</Th>
                    <Th num>{t('invoices.vat.purchaseNet')}</Th>
                    <Th num>{t('invoices.vat.input')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <Tr key={`${r.code}-${r.rate}`}>
                      <Td>
                        %{dec(r.rate).toFixed(0)}
                        {r.code && <span className="ml-2 font-mono text-xs text-muted">{r.code}</span>}
                      </Td>
                      <Td num>{money(r.salesNet)}</Td>
                      <Td num>{money(r.salesVat)}</Td>
                      <Td num>{money(r.purchaseNet)}</Td>
                      <Td num>{money(r.purchaseVat)}</Td>
                    </Tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-2">
                    <Td>{t('common.total')} ({currencySymbol(company.baseCurrency)})</Td>
                    <Td num>{money(data.totals.salesNet)}</Td>
                    <Td num>{money(data.totals.salesVat)}</Td>
                    <Td num>{money(data.totals.purchaseNet)}</Td>
                    <Td num>{money(data.totals.purchaseVat)}</Td>
                  </tr>
                </tfoot>
              </Table>
            </TableWrap>
          )}
          {data.reconciliation && (
            <div className="mt-4">
              {dec(data.reconciliation.outputDifference).isZero() && dec(data.reconciliation.inputDifference).isZero() ? (
                <p className="text-[13px] text-muted">
                  {t('invoices.vat.reconciled', { output: money(data.reconciliation.ledgerOutput), input: money(data.reconciliation.ledgerInput) })}
                </p>
              ) : (
                <Callout tone="warning">
                  {t('invoices.vat.unreconciled', {
                    output: money(data.reconciliation.ledgerOutput),
                    outputDiff: money(data.reconciliation.outputDifference),
                    input: money(data.reconciliation.ledgerInput),
                    inputDiff: money(data.reconciliation.inputDifference),
                  })}
                </Callout>
              )}
            </div>
          )}
          <p className="mt-3 text-xs text-muted">{t('invoices.vat.note')}</p>
        </>
      )}
    </>
  );
}
