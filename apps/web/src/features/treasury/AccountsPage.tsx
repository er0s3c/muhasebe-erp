import { Landmark, Plus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { currencySymbol, formatDateTR, money, moneyIn } from '../../lib/format';
import { useCan, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { TreasurySummary } from '../../lib/types';
import { AccountFormSheet } from './AccountFormSheet';
import { useTreasuryAccounts } from './common';

export function AccountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const company = useCompany();
  const base = company.baseCurrency;
  const canManage = useCan()('treasury.manage');
  const { data, isPending } = useTreasuryAccounts();
  const { data: summary } = useCQuery<TreasurySummary>(['treasury', 'summary'], '/api/treasury/summary');
  const [adding, setAdding] = useState(false);

  const accounts = data?.accounts ?? [];
  const addButton = canManage && (
    <Button variant="primary" onClick={() => setAdding(true)}>
      <Plus className="size-4" aria-hidden />
      {t('treasury.accounts.add')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('treasury.accounts.title')} description={t('treasury.accounts.subtitle')} actions={addButton} />

      {isPending ? (
        <PageLoading />
      ) : accounts.length === 0 ? (
        <Card>
          <EmptyState icon={<Wallet className="size-5" />} title={t('treasury.accounts.empty')} description={t('treasury.accounts.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {summary && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Stat
                label={t('treasury.accounts.totalEquivalent')}
                sub={summary.approximate ? t('treasury.accounts.approx') : t('treasury.accounts.equivalentNote')}
              >
                {moneyIn(summary.equivalent, base)}
              </Stat>
              <Stat label={t('treasury.accounts.accountCount')}>{summary.accountCount}</Stat>
              <Stat label={t('treasury.accounts.byCurrency')}>
                <span className="block text-base leading-relaxed">
                  {summary.byCurrency.map((c) => (
                    <span key={c.currency} className="mr-4 inline-block whitespace-nowrap">
                      {moneyIn(c.balance, c.currency)}
                    </span>
                  ))}
                </span>
              </Stat>
            </div>
          )}

          {summary?.approximate && <Callout tone="warning">{t('treasury.accounts.approxDetail')}</Callout>}

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t('treasury.accounts.name')}</Th>
                  <Th className="w-28">{t('treasury.accounts.glCode')}</Th>
                  <Th num>{t('treasury.accounts.balance')}</Th>
                  <Th num>{t('treasury.accounts.equivalent', { currency: currencySymbol(base) })}</Th>
                  <Th className="w-32">{t('treasury.accounts.lastActivity')}</Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const Icon = a.kind === 'cash' ? Wallet : Landmark;
                  return (
                    <Tr
                      key={a.id}
                      clickable
                      tabIndex={0}
                      className={a.isActive ? undefined : 'opacity-60'}
                      onClick={() => navigate(`/treasury/accounts/${a.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') navigate(`/treasury/accounts/${a.id}`);
                      }}
                    >
                      <Td>
                        <div className="flex items-center gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
                            <Icon className="size-4" aria-hidden />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate">{a.name}</span>
                            <span className="block text-xs text-muted">
                              {t(`treasury.kinds.${a.kind}`)}
                              {a.bankName ? ` · ${a.bankName}` : ''}
                              {a.iban ? ` · ${a.iban}` : ''}
                            </span>
                          </span>
                          {!a.isActive && <Badge tone="danger">{t('common.inactive')}</Badge>}
                        </div>
                      </Td>
                      <Td className="font-mono text-[13px] text-muted">{a.accountCode}</Td>
                      <Td num>
                        {moneyIn(a.balance, a.currencyCode)}
                      </Td>
                      <Td num className="text-muted">
                        {a.currencyCode === base ? '' : a.equivalent === null ? t('treasury.accounts.noRate') : money(a.equivalent)}
                      </Td>
                      <Td className="text-muted">{a.lastActivity ? formatDateTR(a.lastActivity) : '—'}</Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      )}

      <AccountFormSheet open={adding} onOpenChange={setAdding} onSaved={(a) => navigate(`/treasury/accounts/${a.id}`)} />
    </>
  );
}
