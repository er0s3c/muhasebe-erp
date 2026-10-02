import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Select } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { errorMessage } from '../../lib/errors';
import { useCQuery } from '../../lib/queries';
import type { ExecutiveSummaryData } from '../../lib/types';
import { PeriodFields, periodText, useReportPeriod } from './common';
import { ExecutiveView } from './ExecutiveView';

/** Yönetici özet raporu (şirket): tek sayfa A4 çıktıya uygun; yalnızca kullanıcının görebildiği bölümler gelir. */
export function ExecutiveSummaryPage() {
  const { t } = useTranslation();
  const { from, to, setFrom, setTo, valid } = useReportPeriod();
  const [compare, setCompare] = useState<'none' | 'previous' | 'last_year'>('previous');
  const { data, isPending, error } = useCQuery<{ report: ExecutiveSummaryData }>(['reports', 'executive', from, to, compare], `/api/reports/executive-summary?${new URLSearchParams({ from, to, compare })}`, { enabled: valid });
  return (
    <div>
      <PageHeader title={t('executive.title')} description={t('executive.subtitle')} actions={<ExportMenu exportKey="executive-summary" params={{ from, to, compare }} disabled={!valid || !data} />} />
      <PrintHeader subtitle={periodText(from, to)} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <PeriodFields from={from} to={to} onFrom={setFrom} onTo={setTo} />
        <Field label={t('executive.compare')}>
          {(id) => (
            <Select id={id} value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className="w-56">
              <option value="none">{t('executive.compareNone')}</option>
              <option value="previous">{t('executive.comparePrevious')}</option>
              <option value="last_year">{t('executive.compareLastYear')}</option>
            </Select>
          )}
        </Field>
      </div>
      {error ? <Callout tone="danger">{errorMessage(error)}</Callout> : isPending || !data ? <PageLoading /> : <ExecutiveView data={data.report} />}
    </div>
  );
}
