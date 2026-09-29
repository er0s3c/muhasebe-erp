import { CheckCircle2, RefreshCw, Scale, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Button } from '../../components/ui/Button';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { isZero, money, splitBalance } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { TrialBalanceData } from '../../lib/types';

const levelOf = (code: string) => (code.includes('.') ? 2 + code.split('.').length - 1 : code.length - 1);

/** Bakiye hücresi: "1.250,00 B" (borç) / "300,00 A" (alacak) */
function Net({ value }: { value: string }) {
  const { t } = useTranslation();
  if (isZero(value)) return <span className="text-muted">—</span>;
  const n = Number(value);
  const abs = String(Math.abs(n));
  return (
    <span title={n > 0 ? t('common.debit') : t('common.credit')}>
      {money(abs)} <span className="text-xs text-muted">{n > 0 ? 'B' : 'A'}</span>
    </span>
  );
}

export function TrialBalancePage() {
  const { t } = useTranslation();
  const toast = useToast();
  const company = useCompany();
  const canRates = useCan()('rates.manage');
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [currency, setCurrency] = useState<'base' | 'reporting'>('base');
  const [withGroups, setWithGroups] = useState(true);

  const { data, isPending, error } = useCQuery<TrialBalanceData>(
    ['trial-balance', from, to, currency],
    `/api/reports/trial-balance?${new URLSearchParams({ from, to, currency })}`,
    { enabled: Boolean(from && to) },
  );
  const backfill = useCMutation((_: void, call) => call<{ updated: number; stillMissing: number }>('/api/ledger/backfill-reporting', { method: 'POST' }), [['trial-balance']]);

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => withGroups || r.isPostable), [data, withGroups]);
  const balanced = data ? isZero(data.totals.difference) : false;

  return (
    <div className="print-wide">
      <PageHeader
        title={t('ledger.trialBalance.title')}
        description={t('ledger.trialBalance.subtitle')}
        actions={<ExportMenu exportKey="trial-balance" params={{ from, to, currency, view: withGroups ? 'groups' : 'accounts' }} disabled={!data || rows.length === 0} />}
      />
      <PrintHeader subtitle={`${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}`} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
        <Field label={t('ledger.trialBalance.basis')}>
          {(id) => (
            <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value as 'base' | 'reporting')} className="w-56">
              <option value="base">{t('ledger.trialBalance.base', { currency: company.baseCurrency })}</option>
              {company.reportingCurrency && <option value="reporting">{t('ledger.trialBalance.reporting', { currency: company.reportingCurrency })}</option>}
            </Select>
          )}
        </Field>
        <Field label={t('ledger.trialBalance.view')}>
          {(id) => (
            <Select id={id} value={withGroups ? 'groups' : 'accounts'} onChange={(e) => setWithGroups(e.target.value === 'groups')} className="w-44">
              <option value="groups">{t('ledger.trialBalance.withGroups')}</option>
              <option value="accounts">{t('ledger.trialBalance.accountsOnly')}</option>
            </Select>
          )}
        </Field>
      </div>

      {error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-5">
          {data.missingReportingLines > 0 && (
            <Callout
              tone="warning"
              title={t('ledger.trialBalance.missingTitle', { count: data.missingReportingLines })}
              action={
                canRates ? (
                  <Button
                    size="sm"
                    loading={backfill.isPending}
                    onClick={() =>
                      backfill.mutate(undefined, {
                        onSuccess: (r) => toast.success(t('settings.currencies.backfilled', { updated: r.updated, missing: r.stillMissing })),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    <RefreshCw className="size-3.5" aria-hidden />
                    {t('settings.currencies.backfill')}
                  </Button>
                ) : undefined
              }
            >
              {t('ledger.trialBalance.missingBody')}
            </Callout>
          )}

          {rows.length === 0 ? (
            <Card>
              <EmptyState icon={<Scale className="size-5" />} title={t('ledger.trialBalance.empty')} />
            </Card>
          ) : (
            <>
              <TableWrap className="max-h-[calc(100vh-24rem)] min-h-64">
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-36">{t('common.code')}</Th>
                      <Th>{t('ledger.trialBalance.accountName')}</Th>
                      <Th num>{t('ledger.trialBalance.opening')}</Th>
                      <Th num>{t('ledger.trialBalance.periodDebit')}</Th>
                      <Th num>{t('ledger.trialBalance.periodCredit')}</Th>
                      <Th num>{t('ledger.trialBalance.closingDebit')}</Th>
                      <Th num>{t('ledger.trialBalance.closingCredit')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const closing = splitBalance(r.closing);
                      return (
                        <Tr key={r.accountId} className={cn(!r.isPostable && 'bg-surface-2/50')}>
                          <Td className="font-mono text-[13px]" style={{ paddingLeft: `${1 + (withGroups ? levelOf(r.code) : 0) * 1.1}rem` }}>
                            {r.code}
                          </Td>
                          <Td className="min-w-56">{r.name}</Td>
                          <Td num>
                            <Net value={r.opening} />
                          </Td>
                          <Td num>{isZero(r.debit) ? <span className="text-muted">—</span> : money(r.debit)}</Td>
                          <Td num>{isZero(r.credit) ? <span className="text-muted">—</span> : money(r.credit)}</Td>
                          <Td num>{isZero(closing.debit) ? <span className="text-muted">—</span> : money(closing.debit)}</Td>
                          <Td num>{isZero(closing.credit) ? <span className="text-muted">—</span> : money(closing.credit)}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-2">
                      <Td colSpan={3}>
                        {t('ledger.trialBalance.grandTotal')} ({data.currency})
                      </Td>
                      <Td num>{money(data.totals.debit)}</Td>
                      <Td num>{money(data.totals.credit)}</Td>
                      <Td colSpan={2} />
                    </tr>
                  </tfoot>
                </Table>
              </TableWrap>
              <div className={cn('flex items-center gap-2 text-sm', balanced ? 'text-success' : 'text-danger')} role="status">
                {balanced ? <CheckCircle2 className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
                {balanced ? t('ledger.trialBalance.balanced') : t('ledger.trialBalance.unbalanced', { amount: money(String(Math.abs(Number(data.totals.difference)))) })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
