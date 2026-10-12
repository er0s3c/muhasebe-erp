import { todayIso } from '@erp/shared';
import { Plus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, EmptyState, PageLoading, ErrorState } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { SegmentedTabs, TabPanel } from '../../components/ui/Tabs';
import { Table, TableWrap, Td, Th, Tr } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { PayrollCostReport, PayrollParamRow, PayrollRunDetail, PayrollRunRow } from '../../lib/types';
import { isMonth } from './attendance-common';
import { PAYROLL_INVALIDATE, PayrollStatusBadge, UnverifiedBadge } from './payroll-common';

type Tab = 'runs' | 'cost';

/** Bordro (Faz D3): aylık bordro çalıştırmaları ve proje bazında bordro maliyeti. İç belgedir; oranlar doğrulanmamış parametredir. */
export function PayrollPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('runs');
  return (
    <>
      <PageHeader title={t('payroll.title')} description={t('payroll.subtitle')} />
      <div className="mb-4 flex flex-col gap-3">
        <Callout tone="warning">{t('payroll.notice')}</Callout>
        <ParamsStatus />
      </div>
      <div className="mb-4">
        <SegmentedTabs id="hr-payrollpage-tabs" panelId={() => 'hr-payrollpage-tabs-panel'}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'runs', label: t('payroll.tabs.runs') },
            { key: 'cost', label: t('payroll.tabs.cost') },
          ]}
        />
      </div>
      <TabPanel id="hr-payrollpage-tabs-panel" labelledBy={`hr-payrollpage-tabs-${tab}`}>
      {tab === 'runs' ? <RunsTab canManage={can('hr.payroll_manage')} /> : <CostTab />}
      </TabPanel>
    </>
  );
}

/** Parametre durumu özeti: açık parametre yoksa motorun yalnızca yazılanı yaptığı açıkça söylenir. */
function ParamsStatus() {
  const { t } = useTranslation();
  const { data } = useCQuery<{ params: PayrollParamRow[] }>(['payroll', 'params'], '/api/payroll/params');
  if (!data) return null;
  const enabled = data.params.filter((p) => p.enabled);
  if (enabled.length === 0) return <Callout tone="info">{t('payroll.noParams')}</Callout>;
  const unverified = enabled.filter((p) => !p.verifiedAt).length;
  return unverified > 0 ? <Callout tone="warning">{t('payroll.someUnverified', { count: unverified, total: enabled.length })}</Callout> : null;
}

function RunsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ runs: PayrollRunRow[] }>(['payroll', 'runs'], '/api/payroll/runs');
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [error, setError] = useState<Error | null>(null);
  const create = useCMutation((_: void, call) => call<PayrollRunDetail>('/api/payroll/runs', { method: 'POST', body: { month } }), PAYROLL_INVALIDATE);
  const rows = data?.runs ?? [];
  const addButton = canManage && (
    <Button variant="primary" onClick={() => { setError(null); setOpen(true); }}>
      <Plus className="size-4" aria-hidden />
      {t('payroll.newRun')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end">{addButton}</div>
      {queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Wallet className="size-5" />} title={t('payroll.empty')} description={t('payroll.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('payroll.tabs.runs')}>
            <thead>
              <tr>
                <Th>{t('payroll.cols.number')}</Th>
                <Th>{t('payroll.cols.month')}</Th>
                <Th>{t('payroll.cols.status')}</Th>
                <Th num>{t('payroll.cols.employees')}</Th>
                <Th num>{t('payroll.cols.gross')}</Th>
                <Th num>{t('payroll.cols.net')}</Th>
                <Th num>{t('payroll.cols.employer')}</Th>
                <Th>{t('payroll.cols.rates')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} clickable onClick={() => navigate(`/hr/payroll/${r.id}`)}>
                  <Td className="font-mono text-[13px]">{r.number}</Td>
                  <Td>{r.month}</Td>
                  <Td>
                    <PayrollStatusBadge status={r.status} />
                  </Td>
                  <Td num>{r.employeeCount}</Td>
                  <Td num>{money(r.grossTotal)}</Td>
                  <Td num>{money(r.netTotal)}</Td>
                  <Td num>{money(r.employerTotal)}</Td>
                  <Td>{r.hasUnverifiedParams ? <UnverifiedBadge /> : r.paramsSnapshot.length === 0 ? <Badge>{t('payroll.noRates')}</Badge> : <Badge tone="success">{t('payroll.verifiedRates')}</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('payroll.newRun')}
        description={t('payroll.newRunDesc')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!isMonth(month)}
              onClick={() => create.mutate(undefined, { onSuccess: (r) => { setOpen(false); navigate(`/hr/payroll/${r.run.id}`); }, onError: setError })}
            >
              {t('payroll.createRun')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('payroll.month')} required>
            {(id) => <Input id={id} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}

function CostTab() {
  const { t } = useTranslation();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01`);
  const [to, setTo] = useState(todayIso().slice(0, 7));
  const valid = isMonth(from) && isMonth(to) && from <= to;
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<PayrollCostReport>(['payroll', 'cost', from, to], valid ? `/api/payroll/reports/cost?from=${from}&to=${to}` : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('payroll.cost.from')} className="w-44">
            {(id) => <Input id={id} type="month" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={t('payroll.cost.to')} className="w-44">
            {(id) => <Input id={id} type="month" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </div>
        <ExportMenu exportKey="payroll-cost" params={{ from, to }} print={false} disabled={!valid || !data || data.rows.length === 0} />
      </div>
      <p className="text-sm text-muted">{t('payroll.cost.hint')}</p>
      {data?.unverified && <Callout tone="warning">{t('payroll.cost.unverified')}</Callout>}
      {!valid ? (
        <Callout tone="warning">{t('payroll.cost.invalid')}</Callout>
      ) : queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending || !data ? (
        <PageLoading />
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Wallet className="size-5" />} title={t('payroll.cost.empty')} description={t('payroll.cost.emptyDesc')} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('payroll.tabs.cost')}>
            <thead>
              <tr>
                <Th>{t('payroll.cost.project')}</Th>
                <Th>{t('payroll.cost.wbs')}</Th>
                <Th>{t('payroll.cost.costCode')}</Th>
                <Th num>{t('payroll.cols.employees')}</Th>
                <Th num>{t('payroll.cost.hours')}</Th>
                <Th num>{t('payroll.cols.gross')}</Th>
                <Th num>{t('payroll.cols.employer')}</Th>
                <Th num>{t('payroll.cost.total')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.projectCode ? `${r.projectCode} — ${r.projectName}` : <span className="text-muted">{t('payroll.cost.untagged')}</span>}</Td>
                  <Td className="text-muted">{r.wbsCode ? `${r.wbsCode} — ${r.wbsName}` : '—'}</Td>
                  <Td className="text-muted">{r.costCode ? `${r.costCode} — ${r.costCodeName}` : '—'}</Td>
                  <Td num>{r.employees}</Td>
                  <Td num>{money(r.hours)}</Td>
                  <Td num>{money(r.gross)}</Td>
                  <Td num>{money(r.employer)}</Td>
                  <Td num>{money(r.total)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="[&>td]:border-t [&>td]:border-border [&>td]:bg-surface-2 [&>td]:px-4 [&>td]:py-2.5">
                <td colSpan={4}>{t('attendance.summary.total')}</td>
                <td className="num">{money(data.totals.hours)}</td>
                <td className="num">{money(data.totals.gross)}</td>
                <td className="num">{money(data.totals.employer)}</td>
                <td className="num">{money(data.totals.total)}</td>
              </tr>
            </tfoot>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
