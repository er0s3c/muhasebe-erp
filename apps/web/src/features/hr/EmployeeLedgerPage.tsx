import { todayIso } from '@erp/shared';
import { HandCoins, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { Combobox, type ComboOption } from '../../components/ui/Combobox';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Select } from '../../components/ui/Field';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { SegmentedTabs } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import { useCompany } from '../../lib/session';
import type { AdvanceDetail, AdvanceRegister, AdvanceRegisterRow, EmployeeBalances, EmployeeRow, LedgerSettings, SalaryPaymentRow } from '../../lib/types';
import { useProjectOptions } from '../projects/common';
import { accountLabel, useTreasuryAccounts } from '../treasury/common';
import { AdvanceStatusBadge, LEDGER_INVALIDATE, LedgerUnverifiedBadge } from './employee-ledger-common';

type Tab = 'balances' | 'advances' | 'payments' | 'settings';

/**
 * Personel cari ve avans takibi (Faz X5): kim kime borçlu, avans sicili, maaş ödemeleri ve avans kesintisi üst sınırı.
 * Ücret ve avans bakiyesi hassas veridir: hr.payroll izniyle sınırlıdır ve okunması erişim günlüğüne yazılır; dışa aktarmalar IBAN içermez.
 */
export function EmployeeLedgerPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('balances');
  return (
    <>
      <PageHeader title={t('employeeLedger.title')} description={t('employeeLedger.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('employeeLedger.notice')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs
          value={tab}
          onChange={setTab}
          items={[
            { key: 'balances', label: t('employeeLedger.tabs.balances') },
            { key: 'advances', label: t('employeeLedger.tabs.advances') },
            { key: 'payments', label: t('employeeLedger.tabs.payments') },
            { key: 'settings', label: t('employeeLedger.tabs.settings') },
          ]}
        />
      </div>
      {tab === 'balances' && <BalancesTab />}
      {tab === 'advances' && <AdvancesTab canManage={can('hr.payroll_manage')} />}
      {tab === 'payments' && <PaymentsTab canManage={can('hr.payroll_manage')} />}
      {tab === 'settings' && <SettingsTab canManage={can('hr.payroll_manage')} />}
    </>
  );
}

// --- Bakiyeler ----------------------------------------------------------------------------------------------------------

function BalancesTab() {
  const { t } = useTranslation();
  const { data, isPending, error } = useCQuery<EmployeeBalances>(['employee-ledger', 'balances'], '/api/employee-ledger/balances');
  if (isPending) return <PageLoading />;
  if (!data) return <Callout tone="danger">{errorMessage(error)}</Callout>;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Stat label={t('employeeLedger.owedToEmployees')} sub={t('employeeLedger.owedToEmployeesHint')}>{money(data.totals.owedToEmployees)}</Stat>
        <Stat label={t('employeeLedger.owedByEmployees')} sub={t('employeeLedger.owedByEmployeesHint')}>{money(data.totals.owedByEmployees)}</Stat>
      </div>
      <div className="flex justify-end print:hidden">
        <ExportMenu exportKey="employee-balances" print={false} disabled={data.rows.length === 0} />
      </div>
      {data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<HandCoins className="size-5" />} title={t('employeeLedger.balances.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('employeeLedger.tabs.balances')}>
            <thead>
              <tr>
                <Th>{t('employeeLedger.cols.employee')}</Th>
                <Th num>{t('employeeLedger.cols.salaryNet')}</Th>
                <Th num>{t('employeeLedger.cols.salaryPaid')}</Th>
                <Th num>{t('employeeLedger.cols.advanceGiven')}</Th>
                <Th num>{t('employeeLedger.cols.settled')}</Th>
                <Th num>{t('employeeLedger.cols.openAdvance')}</Th>
                <Th num>{t('employeeLedger.cols.net')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const net = Number(r.net);
                return (
                  <Tr key={r.employeeId}>
                    <Td>
                      <Link to={`/hr/employee-ledger/${r.employeeId}`} className="underline-offset-2 hover:underline">
                        <span className="font-mono text-[12px] text-muted">{r.code}</span> {r.fullName}
                      </Link>
                    </Td>
                    <Td num>{money(r.salaryNet)}</Td>
                    <Td num>{money(r.salaryPaid)}</Td>
                    <Td num>{money(r.advanceGiven)}</Td>
                    <Td num>{money((Number(r.advanceDeducted) + Number(r.advanceRepaid)).toFixed(2))}</Td>
                    <Td num>{money(r.openAdvance)}</Td>
                    <Td num className={net < 0 ? 'text-danger' : undefined}>
                      {money(r.net)}
                      <span className="ml-2 text-xs text-muted">{net > 0 ? t('employeeLedger.weOwe') : net < 0 ? t('employeeLedger.theyOwe') : ''}</span>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}

// --- Avans sicili ------------------------------------------------------------------------------------------------------

type AdvDlg = { kind: 'give' } | { kind: 'detail' | 'repay' | 'cancel'; row: AdvanceRegisterRow } | null;

function AdvancesTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('outstanding');
  const { data, isPending, error } = useCQuery<AdvanceRegister>(['employee-ledger', 'advances', status], `/api/employee-ledger/advances?status=${status}`);
  const [dlg, setDlg] = useState<AdvDlg>(null);
  const buckets = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t('employeeLedger.advances.statusFilter')}>
          {(id) => (
            <Select id={id} className="w-56" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="outstanding">{t('employeeLedger.advances.outstanding')}</option>
              <option value="all">{t('employeeLedger.advances.all')}</option>
              {(['open', 'partial', 'settled', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>{t(`employeeLedger.status.${s}`)}</option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <ExportMenu exportKey="employee-advances" params={{ status: status === 'all' ? undefined : status }} print={false} disabled={!data?.rows.length} />
          {canManage && (
            <Button variant="primary" onClick={() => setDlg({ kind: 'give' })}>
              <Plus className="size-4" aria-hidden />
              {t('employeeLedger.advances.give')}
            </Button>
          )}
        </div>
      </div>
      {isPending ? (
        <PageLoading />
      ) : !data ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label={t('employeeLedger.advances.openTotal')} className="lg:col-span-1">{money(data.totals.open)}</Stat>
            {buckets.map((b) => (
              <Stat key={b} label={t(`employeeLedger.buckets.${b}`)}>{money(data.totals.buckets[b])}</Stat>
            ))}
          </div>
          {data.rows.length === 0 ? (
            <Card>
              <EmptyState icon={<HandCoins className="size-5" />} title={t('employeeLedger.advances.empty')} />
            </Card>
          ) : (
            <TableWrap>
              <Table aria-label={t('employeeLedger.tabs.advances')}>
                <thead>
                  <tr>
                    <Th>{t('employeeLedger.cols.number')}</Th>
                    <Th>{t('employeeLedger.cols.date')}</Th>
                    <Th>{t('employeeLedger.cols.employee')}</Th>
                    <Th>{t('employeeLedger.cols.purpose')}</Th>
                    <Th num>{t('employeeLedger.cols.amount')}</Th>
                    <Th num>{t('employeeLedger.cols.settled')}</Th>
                    <Th num>{t('employeeLedger.cols.open')}</Th>
                    <Th num>{t('employeeLedger.cols.age')}</Th>
                    <Th>{t('employeeLedger.cols.status')}</Th>
                    <Th className="w-52"><span className="sr-only">{t('common.actions')}</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <Tr key={r.id}>
                      <Td className="font-mono text-[13px]">{r.number}</Td>
                      <Td>{formatDateTR(r.advanceDate)}</Td>
                      <Td>{r.employeeName}</Td>
                      <Td className="max-w-56 truncate" title={r.purpose}>{r.purpose}{r.projectCode ? <span className="ml-2 text-muted">{r.projectCode}</span> : null}</Td>
                      <Td num>{money(r.amount)}</Td>
                      <Td num>{money(r.settled)}</Td>
                      <Td num>{money(r.open)}</Td>
                      <Td num>{r.ageDays}</Td>
                      <Td><AdvanceStatusBadge status={r.status} /></Td>
                      <Td>
                        <div className="flex justify-end gap-2 print:hidden">
                          <Button size="sm" onClick={() => setDlg({ kind: 'detail', row: r })}>{t('employeeLedger.advances.detail')}</Button>
                          {canManage && (r.status === 'open' || r.status === 'partial') && (
                            <Button size="sm" onClick={() => setDlg({ kind: 'repay', row: r })}>{t('employeeLedger.advances.repay')}</Button>
                          )}
                          {canManage && r.status === 'open' && (
                            <Button size="sm" variant="ghost" onClick={() => setDlg({ kind: 'cancel', row: r })}>{t('employeeLedger.advances.cancel')}</Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </>
      )}
      {dlg?.kind === 'give' && <GiveAdvanceModal onClose={() => setDlg(null)} />}
      {dlg && dlg.kind !== 'give' && dlg.kind === 'detail' && <AdvanceDetailModal row={dlg.row} onClose={() => setDlg(null)} />}
      {dlg && dlg.kind === 'repay' && <RepayModal row={dlg.row} onClose={() => setDlg(null)} />}
      {dlg && dlg.kind === 'cancel' && <CancelAdvanceModal row={dlg.row} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** Kasa/banka hesabı seçici: avans ve maaş ödemeleri defter para birimindeki hesaplardan yapılır. */
function useBaseAccounts() {
  const company = useCompany();
  const { data } = useTreasuryAccounts();
  return useMemo(() => (data?.accounts ?? []).filter((a) => a.isActive && a.currencyCode === company.baseCurrency), [data, company.baseCurrency]);
}

function useActiveEmployees() {
  const { data } = useCQuery<{ employees: EmployeeRow[] }>(['employee-ledger', 'employees'], '/api/employees?status=active');
  return useMemo<ComboOption[]>(() => (data?.employees ?? []).map((e) => ({ value: e.id, label: `${e.code} — ${e.fullName}`, keywords: `${e.code} ${e.fullName}` })), [data]);
}

function GiveAdvanceModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const accounts = useBaseAccounts();
  const employees = useActiveEmployees();
  const { allowed: projectsOn, projects } = useProjectOptions();
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [accountId, setAccountId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const give = useCMutation((_: void, call) => call('/api/employee-ledger/advances', { method: 'POST', body: { employeeId, date, amount, purpose: purpose.trim(), treasuryAccountId: accountId, ...(projectId ? { projectId } : {}) } }), LEDGER_INVALIDATE);
  const valid = !!employeeId && !!date && Number(amount) > 0 && purpose.trim().length >= 3 && !!accountId;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('employeeLedger.give.title')}
      description={t('employeeLedger.give.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={give.isPending} disabled={!valid} onClick={() => give.mutate(undefined, { onSuccess: () => { toast.success(t('employeeLedger.give.done')); onClose(); }, onError: setError })}>
            {t('employeeLedger.give.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('employeeLedger.cols.employee')} required>
          {(id) => <Combobox id={id} options={employees} value={employeeId || null} placeholder={t('employeeLedger.pickEmployee')} onChange={setEmployeeId} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employeeLedger.cols.date')} required>{(id) => <Input id={id} type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('employeeLedger.cols.amount')} required>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}</Field>
        </div>
        <Field label={t('employeeLedger.give.account')} required hint={t('employeeLedger.give.accountHint')}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t('employeeLedger.give.pickAccount')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a)}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('employeeLedger.cols.purpose')} required>{(id) => <Input id={id} maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}</Field>
        {projectsOn && (
          <Field label={t('employeeLedger.give.project')}>
            {(id) => (
              <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t('projects.picker.none')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </Modal>
  );
}

function AdvanceDetailModal({ row, onClose }: { row: AdvanceRegisterRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isPending } = useCQuery<AdvanceDetail>(['employee-ledger', 'advance', row.id], `/api/employee-ledger/advances/${row.id}`);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t('employeeLedger.detail.title', { no: row.number })} description={`${row.employeeName} — ${row.purpose}`} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {isPending || !data ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid grid-cols-3 gap-3">
            <Stat label={t('employeeLedger.cols.amount')}>{money(data.advance.amount)}</Stat>
            <Stat label={t('employeeLedger.cols.settled')}>{money(data.advance.settledAmount)}</Stat>
            <Stat label={t('employeeLedger.cols.open')}>{money(data.advance.openAmount)}</Stat>
          </div>
          <p className="text-muted">{t('employeeLedger.detail.payment', { txn: data.advance.txnNo })}</p>
          <div>
            <h3 className="mb-1.5 font-medium">{t('employeeLedger.detail.settlements')}</h3>
            {data.settlements.length === 0 ? (
              <p className="text-muted">{t('employeeLedger.detail.noSettlements')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.settlements.map((s) => (
                  <li key={s.id} className={`flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 ${s.reversedAt ? 'opacity-60' : ''}`}>
                    <span>
                      {formatDateTR(s.settledDate)} — {t(`employeeLedger.kinds.${s.kind === 'payroll' ? 'advance_deduction' : 'advance_repayment'}`)}
                      {s.runNumber ? ` (${s.runNumber})` : s.txnNo ? ` (${s.txnNo})` : ''}
                      {s.reversedAt && <Badge tone="danger" className="ml-2">{t('employeeLedger.detail.reversed')}</Badge>}
                    </span>
                    <span className="num">{money(s.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1.5 font-medium">{t('employeeLedger.detail.history')}</h3>
            <ul className="flex flex-col gap-1">
              {data.events.map((e, i) => (
                <li key={i} className="text-muted">
                  {new Date(e.at).toLocaleString('tr-TR')} — {e.fromStatus ? `${t(`employeeLedger.status.${e.fromStatus}`)} → ` : ''}{t(`employeeLedger.status.${e.toStatus}`)} ({money(e.settledAmount)}){e.by ? ` · ${e.by}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RepayModal({ row, onClose }: { row: AdvanceRegisterRow; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const accounts = useBaseAccounts();
  const [amount, setAmount] = useState(row.open);
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const repay = useCMutation((_: void, call) => call(`/api/employee-ledger/advances/${row.id}/repay`, { method: 'POST', body: { amount, date, treasuryAccountId: accountId, ...(note.trim() ? { note: note.trim() } : {}) } }), LEDGER_INVALIDATE);
  const valid = Number(amount) > 0 && Number(amount) <= Number(row.open) && !!date && !!accountId;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('employeeLedger.repay.title', { no: row.number })}
      description={t('employeeLedger.repay.desc', { open: money(row.open) })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={repay.isPending} disabled={!valid} onClick={() => repay.mutate(undefined, { onSuccess: () => { toast.success(t('employeeLedger.repay.done')); onClose(); }, onError: setError })}>
            {t('employeeLedger.repay.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employeeLedger.cols.date')} required>{(id) => <Input id={id} type="date" max={todayIso()} min={row.advanceDate} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('employeeLedger.cols.amount')} required>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}</Field>
        </div>
        <Field label={t('employeeLedger.repay.account')} required>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t('employeeLedger.give.pickAccount')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a)}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('employeeLedger.repay.note')}>{(id) => <Input id={id} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function CancelAdvanceModal({ row, onClose }: { row: AdvanceRegisterRow; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const cancel = useCMutation((_: void, call) => call(`/api/employee-ledger/advances/${row.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }), LEDGER_INVALIDATE);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('employeeLedger.cancel.title', { no: row.number })}
      description={t('employeeLedger.cancel.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 3} onClick={() => cancel.mutate(undefined, { onSuccess: () => { toast.success(t('employeeLedger.cancel.done')); onClose(); }, onError: setError })}>
            {t('employeeLedger.advances.cancel')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('employeeLedger.cancel.reason')} required>{(id) => <Input id={id} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

// --- Maaş ödemeleri ------------------------------------------------------------------------------------------------------

function PaymentsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const { data, isPending, error } = useCQuery<{ payments: SalaryPaymentRow[] }>(['employee-ledger', 'payments'], '/api/employee-ledger/salary-payments');
  const [paying, setPaying] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info">{t('employeeLedger.payments.note')}</Callout>
      {canManage && (
        <div className="flex justify-end print:hidden">
          <Button variant="primary" onClick={() => setPaying(true)}>
            <Plus className="size-4" aria-hidden />
            {t('employeeLedger.payments.pay')}
          </Button>
        </div>
      )}
      {isPending ? (
        <PageLoading />
      ) : !data ? (
        <Callout tone="danger">{errorMessage(error)}</Callout>
      ) : data.payments.length === 0 ? (
        <Card>
          <EmptyState icon={<HandCoins className="size-5" />} title={t('employeeLedger.payments.empty')} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('employeeLedger.tabs.payments')}>
            <thead>
              <tr>
                <Th>{t('employeeLedger.cols.date')}</Th>
                <Th>{t('employeeLedger.cols.employee')}</Th>
                <Th>{t('employeeLedger.payments.run')}</Th>
                <Th>{t('employeeLedger.payments.txn')}</Th>
                <Th num>{t('employeeLedger.cols.amount')}</Th>
                <Th>{t('employeeLedger.cols.status')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.payments.map((p) => (
                <Tr key={p.id} className={p.txnStatus === 'cancelled' ? 'opacity-60' : undefined}>
                  <Td>{formatDateTR(p.payDate)}</Td>
                  <Td>{p.employeeName}</Td>
                  <Td className="font-mono text-[13px]">{p.runNumber ?? '—'}</Td>
                  <Td className="font-mono text-[13px]">{p.txnNo}</Td>
                  <Td num>{money(p.amount)}</Td>
                  <Td>{p.txnStatus === 'cancelled' ? <Badge tone="danger">{t('employeeLedger.payments.cancelled')}</Badge> : <Badge tone="success">{t('employeeLedger.payments.posted')}</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      {paying && <PayModal onClose={() => setPaying(false)} />}
    </div>
  );
}

function PayModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const accounts = useBaseAccounts();
  const { data: balances } = useCQuery<EmployeeBalances>(['employee-ledger', 'balances'], '/api/employee-ledger/balances');
  const payable = useMemo(() => (balances?.rows ?? []).filter((r) => Number(r.unpaidSalary) > 0), [balances]);
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const pay = useCMutation((_: void, call) => call('/api/employee-ledger/salary-payments', { method: 'POST', body: { employeeId, date, amount, treasuryAccountId: accountId } }), LEDGER_INVALIDATE);
  const chosen = payable.find((r) => r.employeeId === employeeId);
  const valid = !!employeeId && !!accountId && Number(amount) > 0 && !!date;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('employeeLedger.payments.title')}
      description={t('employeeLedger.payments.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!valid} onClick={() => pay.mutate(undefined, { onSuccess: () => { toast.success(t('employeeLedger.payments.done')); onClose(); }, onError: setError })}>
            {t('employeeLedger.payments.pay')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <Field label={t('employeeLedger.cols.employee')} required>
          {(id) => (
            <Select id={id} value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); const r = payable.find((x) => x.employeeId === e.target.value); setAmount(r ? r.unpaidSalary : ''); }}>
              <option value="">{t('employeeLedger.pickEmployee')}</option>
              {payable.map((r) => (
                <option key={r.employeeId} value={r.employeeId}>{r.code} — {r.fullName} ({money(r.unpaidSalary)})</option>
              ))}
            </Select>
          )}
        </Field>
        {payable.length === 0 && <Callout tone="info">{t('employeeLedger.payments.nonePayable')}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('employeeLedger.cols.date')} required>{(id) => <Input id={id} type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label={t('employeeLedger.cols.amount')} required hint={chosen ? t('employeeLedger.payments.maxHint', { max: money(chosen.unpaidSalary) }) : undefined}>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}</Field>
        </div>
        <Field label={t('employeeLedger.give.account')} required>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t('employeeLedger.give.pickAccount')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{accountLabel(a)}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

// --- Ayarlar -------------------------------------------------------------------------------------------------------------

function SettingsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { data, isPending, error: loadError } = useCQuery<{ settings: LedgerSettings }>(['employee-ledger', 'settings'], '/api/employee-ledger/settings');
  const [cap, setCap] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const save = useCMutation((v: { deductionCapPct: string | null; sourceNote: string | null }, call) => call('/api/employee-ledger/settings', { method: 'PUT', body: v }), [['employee-ledger']]);
  const verify = useCMutation((_: void, call) => call('/api/employee-ledger/settings/verify', { method: 'POST', body: {} }), [['employee-ledger']]);
  if (isPending) return <PageLoading />;
  if (!data) return <Callout tone="danger">{errorMessage(loadError)}</Callout>;
  const s = data.settings;
  const capValue = cap ?? (s.deductionCapPct ? String(Number(s.deductionCapPct)) : '');
  const noteValue = note ?? s.sourceNote ?? '';
  return (
    <Card>
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-base font-medium">{t('employeeLedger.settings.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t('employeeLedger.settings.desc')}</p>
        </div>
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
        <div className="flex flex-wrap items-center gap-2">
          {s.deductionCapPct ? (s.verifiedAt ? <Badge tone="success">{t('employeeLedger.settings.verified', { by: s.verifiedBy ?? '' })}</Badge> : <LedgerUnverifiedBadge />) : <Badge>{t('employeeLedger.settings.noCap')}</Badge>}
        </div>
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutate({ deductionCapPct: capValue.trim() ? capValue.trim().replace(',', '.') : null, sourceNote: noteValue.trim() || null }, { onSuccess: () => { toast.success(t('employeeLedger.settings.saved')); setCap(null); setNote(null); }, onError: setError });
          }}
        >
          <Field label={t('employeeLedger.settings.cap')} hint={t('employeeLedger.settings.capHint')}>
            {(id) => <Input id={id} inputMode="decimal" disabled={!canManage} value={capValue} onChange={(e) => setCap(e.target.value)} />}
          </Field>
          <Field label={t('employeeLedger.settings.source')}>{(id) => <Input id={id} maxLength={300} disabled={!canManage} value={noteValue} onChange={(e) => setNote(e.target.value)} />}</Field>
          {canManage && (
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={save.isPending}>{t('common.save')}</Button>
              {s.deductionCapPct && !s.verifiedAt && (
                <Button loading={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: () => toast.success(t('employeeLedger.settings.verifiedToast')), onError: setError })}>
                  {t('employeeLedger.settings.verify')}
                </Button>
              )}
            </div>
          )}
        </form>
      </div>
    </Card>
  );
}
