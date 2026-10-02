import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { todayIso } from '@erp/shared';
import { Card, PageHeader } from '../../components/ui/Card';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Callout, PageLoading } from '../../components/ui/Feedback';
import { Field, Input } from '../../components/ui/Field';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { errorMessage } from '../../lib/errors';
import { formatDateTR } from '../../lib/format';
import { useCQuery } from '../../lib/queries';
import type { CompanyFxPositionData } from '../../lib/types';
import { CompanyFxPositionView } from './FxPositionView';

/** Döviz pozisyon raporu (şirket): rapor yalnızdır, yevmiye yazmaz. */
export function FxPositionPage() {
  const { t } = useTranslation();
  const [asOf, setAsOf] = useState(todayIso());
  const [rateDate, setRateDate] = useState('');
  const [rates, setRates] = useState('');
  const qs = new URLSearchParams({ asOf, ...(rateDate ? { rateDate } : {}), ...(rates.trim() ? { rates: rates.trim() } : {}) });
  const { data, isPending, error } = useCQuery<{ report: CompanyFxPositionData }>(['reports', 'fx-position', qs.toString()], `/api/reports/fx-position?${qs}`, { enabled: Boolean(asOf) });
  return (
    <div className="print-wide">
      <PageHeader title={t('fxPosition.title')} description={t('fxPosition.subtitle')} actions={<ExportMenu exportKey="fx-position" params={{ asOf, rateDate, rates: rates.trim() }} disabled={!data} />} />
      <PrintHeader subtitle={`${formatDateTR(asOf)} ${t('fxPosition.asOfShort')}`} />
      <div className="mb-5 flex flex-wrap items-end gap-4 print:hidden">
        <Field label={t('fxPosition.asOf')}>{(id) => <Input id={id} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="w-44" />}</Field>
        <Field label={t('fxPosition.rateDate')} hint={t('fxPosition.rateDateHint')}>{(id) => <Input id={id} type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} className="w-44" />}</Field>
        <Field label={t('fxPosition.manualRates')} hint={t('fxPosition.manualRatesHint')}>{(id) => <Input id={id} value={rates} onChange={(e) => setRates(e.target.value)} placeholder="USD:35,EUR:38" className="w-56" />}</Field>
      </div>
      {error ? <Callout tone="danger">{errorMessage(error)}</Callout> : isPending || !data ? <PageLoading /> : <Card className="p-5"><CompanyFxPositionView data={data.report} /></Card>}
    </div>
  );
}
