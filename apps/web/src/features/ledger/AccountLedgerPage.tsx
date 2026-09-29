import { FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, isZero, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { Account, AccountLedgerData } from '../../lib/types';

function Balance({ value }: { value: string }) {
  const n = Number(value);
  if (n === 0) return <>{money('0')}</>;
  return (
    <>
      {money(String(Math.abs(n)))} <span className="text-xs text-muted">{n > 0 ? 'B' : 'A'}</span>
    </>
  );
}

export function AccountLedgerPage() {
  const { t } = useTranslation();
  const company = useCompany();
  const year = todayIso().slice(0, 4);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayIso());

  const { data: accountsData } = useCQuery<{ accounts: Account[] }>(['accounts'], '/api/accounts');
  const options = useMemo<ComboOption[]>(
    () => (accountsData?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}`, keywords: a.code, hint: a.isPostable ? undefined : t('ledger.accounts.group') })),
    [accountsData, t],
  );

  const { data, isPending, error } = useCQuery<AccountLedgerData>(
    ['account-ledger', accountId, from, to],
    accountId ? `/api/reports/account-ledger?${new URLSearchParams({ accountId, from, to })}` : null,
  );

  return (
    <>
      <PageHeader
        title={t('ledger.accountLedger.title')}
        description={t('ledger.accountLedger.subtitle')}
        actions={accountId ? <ExportMenu exportKey="account-ledger" params={{ accountId, from, to }} disabled={!data} /> : undefined}
      />
      <PrintHeader subtitle={`${from.split('-').reverse().join('.')} – ${to.split('-').reverse().join('.')}`} />

      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('ledger.accountLedger.pick')} className="w-full max-w-md">
          {(id) => <Combobox options={options} value={accountId} onChange={setAccountId} placeholder={t('ledger.accountLedger.pickPrompt')} aria-label={t('ledger.accountLedger.pick')} id={id} />}
        </Field>
        <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
        <Field label={t('common.to')}>{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}</Field>
      </div>

      {!accountId ? (
        <Card>
          <EmptyState icon={<FileText className="size-5" />} title={t('ledger.accountLedger.pickPrompt')} />
        </Card>
      ) : error ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : isPending || !data ? (
        <PageLoading />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th className="w-28">{t('common.date')}</Th>
                <Th className="w-40">{t('ledger.accountLedger.entryNo')}</Th>
                <Th>{t('common.description')}</Th>
                <Th num>{t('ledger.accountLedger.fx')}</Th>
                <Th num>{t('common.debit')}</Th>
                <Th num>{t('common.credit')}</Th>
                <Th num>
                  {t('common.balance')} ({company.baseCurrency})
                </Th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-surface-2/60">
                <Td colSpan={6}>
                  {t('ledger.accountLedger.opening')} — {data.account.code} {data.account.name}
                </Td>
                <Td num>
                  <Balance value={data.opening} />
                </Td>
              </tr>
              {data.lines.length === 0 && (
                <tr>
                  <Td colSpan={7} className="py-8 text-center text-muted">
                    {t('ledger.accountLedger.empty')}
                  </Td>
                </tr>
              )}
              {data.lines.map((l, i) => (
                <Tr key={`${l.entryId}-${i}`}>
                  <Td>{formatDateTR(l.entryDate)}</Td>
                  <Td className="font-mono text-[13px]">{l.entryNo}</Td>
                  <Td>
                    {l.accountCode !== data.account.code && <span className="mr-2 font-mono text-xs text-muted">{l.accountCode}</span>}
                    {l.description}
                  </Td>
                  <Td num className="text-muted">
                    {l.currencyCode !== company.baseCurrency ? `${money(Number(l.debit) > 0 ? l.debit : l.credit)} ${l.currencyCode}` : ''}
                  </Td>
                  <Td num>{isZero(l.debitBase) ? '' : money(l.debitBase)}</Td>
                  <Td num>{isZero(l.creditBase) ? '' : money(l.creditBase)}</Td>
                  <Td num>
                    <Balance value={l.balance} />
                  </Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-surface-2">
                <Td colSpan={4}>{t('ledger.accountLedger.totals')}</Td>
                <Td num>{money(data.totals.debitBase)}</Td>
                <Td num>{money(data.totals.creditBase)}</Td>
                <Td num>
                  <span className="sr-only">{t('ledger.accountLedger.closing')}: </span>
                  <Balance value={data.closing} />
                </Td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
