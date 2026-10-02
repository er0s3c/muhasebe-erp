import { dec } from '@erp/shared';
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { Button } from '../../components/ui/Button';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Sheet';
import { Stat } from '../../components/ui/Stat';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCan, useCMutation, useCQuery } from '../../lib/queries';
import type { SocialDeclarationDetail } from '../../lib/types';
import { SOCIAL_INVALIDATE, SocialStatusBadge, SocialUnverifiedBadge, useSocialWarningText } from './social-common';

type Dlg = null | 'finalize' | 'reopen' | 'delete';

/**
 * Aylık sosyal güvenlik bildirimi (GENEL düzen; resmî bildirim biçimi değildir, doğrulanmadı). Taslakta yeniden üretilir/silinir,
 * kesinleşince kilitlenir (o ay için bordro iptali ve puantaj ayı açma engellenir). Numara maskelidir.
 */
export function SocialDeclarationPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const manage = useCan()('hr.payroll_manage');
  const { data, isPending, error: loadError } = useCQuery<SocialDeclarationDetail>(['social', 'declaration', id], `/api/social-security/declarations/${id}`);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const warningText = useSocialWarningText();

  const act = useCMutation((v: { path: string; body?: unknown }, call) => call<SocialDeclarationDetail>(`/api/social-security/declarations/${id}/${v.path}`, { method: 'POST', body: v.body ?? {} }), SOCIAL_INVALIDATE);
  const remove = useCMutation((_: void, call) => call(`/api/social-security/declarations/${id}`, { method: 'DELETE' }), SOCIAL_INVALIDATE);

  if (isPending) return <PageLoading />;
  if (!data) return <Callout tone="danger">{errorMessage(loadError)}</Callout>;
  const { declaration: d, lines, totals } = data;
  const draft = d.status === 'draft';
  const open = (x: Dlg) => {
    setError(null);
    setText('');
    setDlg(x);
  };
  const done = (msg: string) => ({ onSuccess: () => { toast.success(msg); setDlg(null); }, onError: setError });
  const warned = lines.filter((l) => l.warnings.length > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link to="/hr/social-security" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text print:hidden">
          <ArrowLeft className="size-4" aria-hidden />
          {t('social.detail.back')}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          <span className="print:hidden">{t('social.detail.title', { month: d.month })}</span>
          <span className="hidden print:inline">{t('social.detail.printTitle')} — {d.month}</span>
          <span className="font-mono text-[15px] text-muted">{d.number}</span>
          <SocialStatusBadge status={d.status} />
          {d.hasUnverifiedParams && <SocialUnverifiedBadge />}
        </h1>
        <p className="mt-1 text-sm font-medium text-warning">{t('social.detail.printNote')}</p>
      </div>

      <div className="print:hidden">
        <Callout tone="warning">{t('social.notice')}</Callout>
      </div>
      {error && !dlg && <Callout tone="danger">{errorMessage(error)}</Callout>}
      {d.hasUnverifiedParams && <Callout tone="warning">{t('social.detail.unverifiedWarn')}</Callout>}
      {draft ? <Callout tone="info">{t('social.detail.draftInfo')}</Callout> : <Callout tone="info">{t('social.detail.finalizedInfo')}</Callout>}
      {d.reopenCount > 0 && <Callout tone="info">{t('social.detail.reopenedInfo', { count: d.reopenCount, reason: d.reopenReason ?? '—' })}</Callout>}
      {d.supportSnapshot.length === 0 ? (
        <Callout tone="info">{t('social.detail.noSupport')}</Callout>
      ) : (
        <Callout tone="warning" title={t('social.detail.supportApplied')}>
          <ul className="list-disc pl-5">
            {d.supportSnapshot.map((s) => (
              <li key={s.code}>
                {s.code} — {s.name} ({t(`social.rules.targets.${s.target as 'employer' | 'employee'}`)}, {t(`social.rules.modes.${s.mode as 'percent_of_premium' | 'fixed_amount'}`)}: {s.value}) {s.verified ? '' : `· ${t('social.unverifiedBadge')}`}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {warned > 0 && <Callout tone="warning">{t('payroll.run.warned', { count: warned })}</Callout>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('social.cols.base')}>{money(totals.premiumBase)}</Stat>
        <Stat label={t('social.cols.employeePremium')}>{money(totals.employeePremium)}</Stat>
        <Stat label={t('social.cols.employerPremium')}>{money(totals.employerPremium)}</Stat>
        <Stat label={t('social.cols.employerDue')} sub={`${t('social.cols.supportEmployer')}: ${money(totals.supportEmployer)}`}>{money(totals.employerDue)}</Stat>
      </div>
      <p className="text-sm text-muted">
        {t('social.detail.sourceRun')}:{' '}
        <Link to={`/hr/payroll/${d.payrollRunId}`} className="font-mono underline">
          {d.payrollRunNumber}
        </Link>
        {d.finalizedAt ? ` · ${formatDateTR(d.finalizedAt.slice(0, 10))}` : ''}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
        <ExportMenu exportKey="social-declaration" params={{ id }} disabled={lines.length === 0} />
        {manage && draft && (
          <>
            <Button variant="danger" onClick={() => open('delete')}>{t('common.delete')}</Button>
            <Button loading={act.isPending} onClick={() => act.mutate({ path: 'rebuild' }, { onSuccess: () => toast.success(t('social.detail.rebuilt')), onError: setError })}>
              <RefreshCw className="size-4" aria-hidden />
              {t('social.detail.rebuild')}
            </Button>
            <Button variant="primary" disabled={lines.length === 0} onClick={() => open('finalize')}>
              <CheckCircle2 className="size-4" aria-hidden />
              {t('social.detail.finalize')}
            </Button>
          </>
        )}
        {manage && !draft && <Button onClick={() => open('reopen')}>{t('social.detail.reopen')}</Button>}
      </div>

      <TableWrap>
        <Table aria-label={t('social.detail.linesTitle')}>
          <thead>
            <tr>
              <Th>{t('social.line.employee')}</Th>
              <Th>{t('social.line.type')}</Th>
              <Th>{t('social.line.ssn')}</Th>
              <Th num>{t('social.line.days')}</Th>
              <Th num>{t('social.cols.base')}</Th>
              <Th num>{t('social.cols.employeePremium')}</Th>
              <Th num>{t('social.cols.employerPremium')}</Th>
              <Th num>{t('social.line.support')}</Th>
              <Th>{t('social.line.warnings')}</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td>
                  <span className="font-mono text-[12px] text-muted">{l.employeeCode}</span> {l.employeeName}
                </Td>
                <Td>{l.payrollTypeCode ?? t('social.line.noType')}</Td>
                <Td className="font-mono text-[13px]">{l.ssnMasked ?? '—'}</Td>
                <Td num title={`${t('social.line.leave')}: ${l.annualLeaveDays}/${l.sickLeaveDays}/${l.unpaidLeaveDays}/${l.absentDays}`}>{l.daysWorked}</Td>
                <Td num>{money(l.premiumBase)}</Td>
                <Td num>{money(l.employeePremium)}</Td>
                <Td num>{money(l.employerPremium)}</Td>
                <Td num>{dec(l.supportEmployee).plus(l.supportEmployer).gt(0) ? `${money(dec(l.supportEmployee).plus(l.supportEmployer).toFixed(4))} (${l.supportCodes})` : '—'}</Td>
                <Td className="text-[13px] text-warning">{l.warnings.map((w) => warningText(w)).join('; ')}</Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="[&>td]:border-t [&>td]:border-border [&>td]:bg-surface-2 [&>td]:px-4 [&>td]:py-2.5">
              <td colSpan={4}>{t('attendance.summary.total')}</td>
              <td className="num">{money(totals.premiumBase)}</td>
              <td className="num">{money(totals.employeePremium)}</td>
              <td className="num">{money(totals.employerPremium)}</td>
              <td className="num">{money(totals.supportTotal)}</td>
              <td />
            </tr>
          </tfoot>
        </Table>
      </TableWrap>

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved')]} />
      <PrintNote>{t('social.detail.printNote')}</PrintNote>

      <Modal
        open={dlg === 'finalize'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('social.detail.finalizeTitle')}
        description={t('social.detail.finalizeDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate({ path: 'finalize', body: text.trim() ? { note: text.trim() } : {} }, done(t('social.detail.finalized')))}>
              {t('social.detail.finalize')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          {d.hasUnverifiedParams && <Callout tone="warning">{t('social.detail.unverifiedWarn')}</Callout>}
          <Field label={t('social.detail.finalizeNote')}>{(fid) => <Input id={fid} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      </Modal>

      <Modal
        open={dlg === 'reopen'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('social.detail.reopenTitle')}
        description={t('social.detail.reopenDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={act.isPending} disabled={text.trim().length < 3} onClick={() => act.mutate({ path: 'reopen', body: { reason: text.trim() } }, done(t('social.detail.reopened')))}>
              {t('social.detail.reopen')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
          <Field label={t('social.detail.reason')} required>{(fid) => <Textarea id={fid} rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </div>
      </Modal>

      <Modal
        open={dlg === 'delete'}
        onOpenChange={(o) => !o && setDlg(null)}
        title={t('social.detail.deleteTitle')}
        description={t('social.detail.deleteDesc')}
        footer={
          <>
            <Button onClick={() => setDlg(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: () => { toast.success(t('social.detail.deleted')); navigate('/hr/social-security'); }, onError: setError })}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        {error && <Callout tone="danger">{errorMessage(error)}</Callout>}
      </Modal>
    </div>
  );
}
