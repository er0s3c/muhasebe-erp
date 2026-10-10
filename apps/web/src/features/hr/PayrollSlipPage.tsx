import { ArrowLeft, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { PrintNote, PrintSignatures } from '../../components/print/PrintBlocks';
import { Button } from '../../components/ui/Button';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Table, TableWrap, Td, Th } from '../../components/ui/Table';
import { errorMessage } from '../../lib/errors';
import { formatDateTR, money } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { PayrollLineItemRow, PayrollSlip } from '../../lib/types';
import { PayrollStatusBadge, UnverifiedBadge, useWarningText } from './payroll-common';

/**
 * Bordro pusulası (yazdırılabilir). TASLAK / İÇ BELGEDİR: resmî bordro değildir. Doğrulanmamış parametre kullanıldıysa
 * hem ekranda hem basılı çıktıda uyarı vardır. Ücret verisi okuması erişim günlüğüne yazılır (sunucu).
 */
export function PayrollSlipPage() {
  const { t } = useTranslation();
  const { id = '', employeeId = '' } = useParams();
  const { data, isPending, error } = useCQuery<PayrollSlip>(['payroll', 'slip', id, employeeId], `/api/payroll/runs/${id}/slips/${employeeId}`);
  const warningText = useWarningText();
  if (isPending) return <PageLoading />;
  if (!data) return <Callout tone="danger">{errorMessage(error)}</Callout>;
  const { run, line: l } = data;
  const label = (i: PayrollLineItemRow) => (i.source === 'country' ? i.label : i.source === 'param' && i.paramKey ? `${t(`payroll.params.keys.${i.paramKey}`)}${i.rate ? ` (${Number(i.rate).toLocaleString('tr-TR', { maximumFractionDigits: 6 })})` : ''}` : `${i.code} — ${i.label}`);
  const earnings = l.items.filter((i) => i.kind === 'earning');
  const deductions = l.items.filter((i) => i.kind === 'deduction');
  const employer = l.items.filter((i) => i.kind === 'employer');
  const row = (name: string, amount: string, strong = false, neg = false) => (
    <tr className={strong ? 'font-medium [&>td]:border-t [&>td]:border-border' : undefined}>
      <Td>{name}</Td>
      <Td num>{neg ? `-${money(amount)}` : money(amount)}</Td>
    </tr>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link to={`/hr/payroll/${run.id}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ArrowLeft className="size-4" aria-hidden />
          {run.number}
        </Link>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          {t('payroll.slip.print')}
        </Button>
      </div>

      <div>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl">
          {t('payroll.slip.title')}
          <PayrollStatusBadge status={run.status} />
          {run.hasUnverifiedParams && <UnverifiedBadge />}
        </h1>
        <p className="mt-1 text-sm font-medium text-warning">{t('payroll.slip.draftNote')}</p>
      </div>
      {run.hasUnverifiedParams && <Callout tone="warning">{t('payroll.slip.unverifiedWarn')}</Callout>}
      {!run.jurisdiction && !run.hasUnverifiedParams && run.paramsSnapshot.length === 0 && <Callout tone="info">{t('payroll.slip.noParams')}</Callout>}
      {l.legalCalculationSnapshot && <div className="rounded-md border border-border p-4"><p className="mb-3 text-sm font-medium">{run.jurisdiction === 'TR' ? 'Türkiye / standart 4/a' : 'KKTC'} — {l.legalCalculationSnapshot.rulePackVersion}</p><dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
        {[['Prim günü', String(l.legalCalculationSnapshot.socialDays)], ['Önceki kümülatif matrah', money(l.legalCalculationSnapshot.cumulativeTaxBaseBefore)], ['Yeni kümülatif matrah', money(l.legalCalculationSnapshot.cumulativeTaxBaseAfter)], ['Gelir vergisi istisna/indirimi', money(l.legalCalculationSnapshot.incomeTaxExemption)], ['Damga esası', money(l.legalCalculationSnapshot.stampBase)], ['Damga istisnası', money(l.legalCalculationSnapshot.stampTaxExemption)], ['Kişisel dönem indirimi', money(l.legalCalculationSnapshot.personalAllowance)], ['Özel indirim', money(l.legalCalculationSnapshot.specialAllowance)]].map(([name, value]) => <div key={name}><dt className="text-muted">{name}</dt><dd className="mt-1 tabular-nums">{value}</dd></div>)}
      </dl><p className="mt-3 text-xs text-muted">Bu bordroda kaydedilmiş ülke ve hesap kuralı kullanılır. Sonraki kural değişiklikleri bu tutarları değiştirmez.</p></div>}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.slip.employee')}</dt><dd>{l.employeeCode} — {l.employeeName}</dd></div>
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.slip.period')}</dt><dd>{run.month} ({run.number})</dd></div>
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.slip.department')}</dt><dd>{[l.department, l.jobTitle].filter(Boolean).join(' · ') || '—'}</dd></div>
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.slip.hireDate')}</dt><dd>{data.hireDate ? formatDateTR(data.hireDate) : '—'}</dd></div>
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.line.basis')}</dt><dd>{t(`payroll.basis.${l.payBasis}`)} · {money(l.rate)}</dd></div>
        <div className="flex gap-2"><dt className="w-32 text-muted">{t('payroll.slip.iban')}</dt><dd>{l.ibanMasked ?? '—'}</dd></div>
      </dl>

      <TableWrap>
        <Table aria-label={t('payroll.slip.attendance')}>
          <thead>
            <tr>
              <Th num>{t('attendance.normalHours')}</Th>
              <Th num>{t('attendance.overtimeHours')}</Th>
              <Th num>{t('payroll.slip.hourDays')}</Th>
              <Th num>{t('attendance.dayTypes.annual_leave')}</Th>
              <Th num>{t('attendance.dayTypes.sick_leave')}</Th>
              <Th num>{t('attendance.dayTypes.unpaid_leave')}</Th>
              <Th num>{t('attendance.dayTypes.absent')}</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td num>{money(l.normalHours)}</Td>
              <Td num>{money(l.overtimeHours)}</Td>
              <Td num>{l.hourDays}</Td>
              <Td num>{l.annualLeaveDays}</Td>
              <Td num>{l.sickLeaveDays}</Td>
              <Td num>{l.unpaidLeaveDays}</Td>
              <Td num>{l.absentDays}</Td>
            </tr>
          </tbody>
        </Table>
      </TableWrap>

      <TableWrap>
        <Table aria-label={t('payroll.slip.calc')}>
          <thead>
            <tr>
              <Th>{t('payroll.slip.item')}</Th>
              <Th num className="w-40">{t('payroll.slip.amount')}</Th>
            </tr>
          </thead>
          <tbody>
            {row(t('payroll.slip.scheduledPay'), l.scheduledPay)}
            {Number(l.absenceDeduction) > 0 && row(t('payroll.slip.absence'), l.absenceDeduction, false, true)}
            {Number(l.overtimePay) > 0 && row(t('payroll.slip.overtimePay'), l.overtimePay)}
            {earnings.map((i, k) => <tr key={`e${k}`}><Td>{label(i)}</Td><Td num>{money(i.amount)}</Td></tr>)}
            {row(t('payroll.cols.gross'), l.gross, true)}
            {deductions.map((i, k) => <tr key={`d${k}`}><Td>{label(i)}</Td><Td num>-{money(i.amount)}</Td></tr>)}
            {row(t('payroll.cols.deductions'), l.deductionsTotal, true, true)}
            {row(t('payroll.slip.net'), l.net, true)}
          </tbody>
        </Table>
      </TableWrap>

      {employer.length > 0 && (
        <TableWrap>
          <Table aria-label={t('payroll.slip.employerCosts')}>
            <thead>
              <tr>
                <Th>{t('payroll.slip.employerCosts')}</Th>
                <Th num className="w-40">{t('payroll.slip.amount')}</Th>
              </tr>
            </thead>
            <tbody>
              {employer.map((i, k) => <tr key={k}><Td>{label(i)}</Td><Td num>{money(i.amount)}</Td></tr>)}
              {row(t('payroll.cols.employer'), l.employerTotal, true)}
            </tbody>
          </Table>
        </TableWrap>
      )}

      {l.warnings.length > 0 && (
        <Callout tone="warning" title={t('payroll.line.warnings')}>
          <ul className="list-disc pl-5">
            {l.warnings.map((w, k) => <li key={k}>{warningText(w)}</li>)}
          </ul>
        </Callout>
      )}

      <PrintSignatures labels={[t('printDoc.prepared'), t('printDoc.approved'), t('payroll.slip.employeeSign')]} />
      <PrintNote>{t('payroll.slip.printNote')}</PrintNote>
    </div>
  );
}
