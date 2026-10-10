import { todayIso } from '@erp/shared';
import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
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
import type { PremiumSummaryReport, SocialDeclarationDetail, SocialDeclarationRow } from '../../lib/types';
import { isMonth } from './attendance-common';
import { SOCIAL_INVALIDATE, SocialStatusBadge, SocialUnverifiedBadge } from './social-common';

type Tab = 'declarations' | 'summary';

/** Sosyal güvenlik çıktıları (Faz D4): aylık bildirimler ve prim özeti. GENEL düzendir; resmî biçim değildir, doğrulanmadı. */
export function SocialSecurityPage() {
  const { t } = useTranslation();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('declarations');
  return (
    <>
      <PageHeader title={t('social.title')} description={t('social.subtitle')} />
      <div className="mb-4">
        <Callout tone="warning">{t('social.notice')}</Callout>
      </div>
      <div className="mb-4">
        <SegmentedTabs id="hr-socialsecuritypage-tabs" panelId={() => 'hr-socialsecuritypage-tabs-panel'}
          value={tab}
          onChange={setTab}
          items={[
            { key: 'declarations', label: t('social.tabs.declarations') },
            { key: 'summary', label: t('social.tabs.summary') },
          ]}
        />
      </div>
      <TabPanel id="hr-socialsecuritypage-tabs-panel" labelledBy={`hr-socialsecuritypage-tabs-${tab}`}>
      {tab === 'declarations' ? <DeclarationsTab canManage={can('hr.payroll_manage')} /> : <SummaryTab />}
      </TabPanel>
    </>
  );
}

function DeclarationsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<{ declarations: SocialDeclarationRow[] }>(['social', 'declarations'], '/api/social-security/declarations');
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [error, setError] = useState<Error | null>(null);
  const create = useCMutation((_: void, call) => call<SocialDeclarationDetail>('/api/social-security/declarations', { method: 'POST', body: { month } }), SOCIAL_INVALIDATE);
  const rows = data?.declarations ?? [];
  const addButton = canManage && (
    <Button variant="primary" onClick={() => { setError(null); setOpen(true); }}>
      <Plus className="size-4" aria-hidden />
      {t('social.newDeclaration')}
    </Button>
  );

  return (
    <>
      <div className="mb-3 flex justify-end">{addButton}</div>
      {queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="size-5" />} title={t('social.empty')} description={t('social.emptyDesc')} action={addButton || undefined} />
        </Card>
      ) : (
        <TableWrap>
          <Table aria-label={t('social.tabs.declarations')}>
            <thead>
              <tr>
                <Th>{t('social.cols.number')}</Th>
                <Th>{t('social.cols.month')}</Th>
                <Th>{t('social.cols.status')}</Th>
                <Th num>{t('social.cols.employees')}</Th>
                <Th num>{t('social.cols.employeePremium')}</Th>
                <Th num>{t('social.cols.employerPremium')}</Th>
                <Th num>{t('social.cols.supportEmployer')}</Th>
                <Th>{t('social.cols.run')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id} clickable onClick={() => navigate(`/hr/social-security/${r.id}`)}>
                  <Td className="font-mono text-[13px]">{r.number}</Td>
                  <Td>{r.month}</Td>
                  <Td>
                    <SocialStatusBadge status={r.status} />
                  </Td>
                  <Td num>{r.employeeCount}</Td>
                  <Td num>{money(r.employeePremiumTotal)}</Td>
                  <Td num>{money(r.employerPremiumTotal)}</Td>
                  <Td num>{money(r.supportEmployerTotal)}</Td>
                  <Td>
                    <span className="font-mono text-[13px] text-muted">{r.payrollRunNumber}</span> {r.hasUnverifiedParams && <SocialUnverifiedBadge className="ml-1" />}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('social.newDeclaration')}
        description={t('social.newDeclarationDesc')}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!isMonth(month)}
              onClick={() => create.mutate(undefined, { onSuccess: (r) => { setOpen(false); navigate(`/hr/social-security/${r.declaration.id}`); }, onError: setError })}
            >
              {t('social.createDeclaration')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('social.month')} required>
            {(id) => <Input id={id} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          </Field>
        </div>
      </Modal>
    </>
  );
}

function SummaryTab() {
  const { t } = useTranslation();
  const year = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${year}-01`);
  const [to, setTo] = useState(todayIso().slice(0, 7));
  const valid = isMonth(from) && isMonth(to) && from <= to;
  const { data, isPending , error: queryError, refetch: retryQuery, isFetching: retryingQuery } = useCQuery<PremiumSummaryReport>(['social', 'premium', from, to], valid ? `/api/social-security/reports/premium?from=${from}&to=${to}` : null);
  const totalRow = (cols: number, label: string, tot: PremiumSummaryReport['totals']) => (
    <tfoot>
      <tr className="[&>td]:border-t [&>td]:border-border [&>td]:bg-surface-2 [&>td]:px-4 [&>td]:py-2.5">
        <td colSpan={cols}>{label}</td>
        <td className="num">{money(tot.employeePremium)}</td>
        <td className="num">{money(tot.employerPremium)}</td>
        <td className="num">{money(tot.supportEmployee)}</td>
        <td className="num">{money(tot.supportEmployer)}</td>
        <td className="num">{money(tot.employeeDue)}</td>
        <td className="num">{money(tot.employerDue)}</td>
      </tr>
    </tfoot>
  );
  const head = (
    <>
      <Th num>{t('social.cols.employeePremium')}</Th>
      <Th num>{t('social.cols.employerPremium')}</Th>
      <Th num>{t('social.cols.supportEmployee')}</Th>
      <Th num>{t('social.cols.supportEmployer')}</Th>
      <Th num>{t('social.cols.employeeDue')}</Th>
      <Th num>{t('social.cols.employerDue')}</Th>
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('social.summary.from')} className="w-44">
            {(id) => <Input id={id} type="month" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label={t('social.summary.to')} className="w-44">
            {(id) => <Input id={id} type="month" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </div>
        <ExportMenu exportKey="social-premium-summary" params={{ from, to }} disabled={!valid || !data || data.months.length === 0} />
      </div>
      <p className="text-sm text-muted">{t('social.summary.hint')}</p>
      {data?.unverified && <Callout tone="warning">{t('social.summary.unverified')}</Callout>}
      {!valid ? (
        <Callout tone="warning">{t('social.summary.invalid')}</Callout>
      ) : queryError ? (<ErrorState description={errorMessage(queryError)} onRetry={() => void retryQuery()} retrying={retryingQuery} />) : isPending || !data ? (
        <PageLoading />
      ) : data.months.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="size-5" />} title={t('social.summary.empty')} description={t('social.summary.emptyDesc')} />
        </Card>
      ) : (
        <>
          <h2 className="text-base font-medium">{t('social.summary.byMonth')}</h2>
          <TableWrap>
            <Table aria-label={t('social.summary.byMonth')}>
              <thead>
                <tr>
                  <Th>{t('social.cols.month')}</Th>
                  <Th>{t('social.cols.number')}</Th>
                  <Th>{t('social.cols.status')}</Th>
                  {head}
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.id}>
                    <Td>{m.month}</Td>
                    <Td className="font-mono text-[13px]">{m.number}</Td>
                    <Td>
                      <SocialStatusBadge status={m.status} />
                    </Td>
                    <Td num>{money(m.employeePremium)}</Td>
                    <Td num>{money(m.employerPremium)}</Td>
                    <Td num>{money(m.supportEmployee)}</Td>
                    <Td num>{money(m.supportEmployer)}</Td>
                    <Td num>{money(m.employeeDue)}</Td>
                    <Td num>{money(m.employerDue)}</Td>
                  </tr>
                ))}
              </tbody>
              {totalRow(3, t('social.summary.total'), data.totals)}
            </Table>
          </TableWrap>
          <h2 className="text-base font-medium">{t('social.summary.byProject')}</h2>
          <TableWrap>
            <Table aria-label={t('social.summary.byProject')}>
              <thead>
                <tr>
                  <Th>{t('social.summary.project')}</Th>
                  <Th num>{t('social.cols.employees')}</Th>
                  {head}
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p, i) => (
                  <tr key={i}>
                    <Td>{p.projectCode ? `${p.projectCode} — ${p.projectName}` : <span className="text-muted">{t('social.summary.untagged')}</span>}</Td>
                    <Td num>{p.employees}</Td>
                    <Td num>{money(p.employeePremium)}</Td>
                    <Td num>{money(p.employerPremium)}</Td>
                    <Td num>{money(p.supportEmployee)}</Td>
                    <Td num>{money(p.supportEmployer)}</Td>
                    <Td num>{money(p.employeeDue)}</Td>
                    <Td num>{money(p.employerDue)}</Td>
                  </tr>
                ))}
              </tbody>
              {totalRow(2, t('social.summary.total'), data.totals)}
            </Table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
