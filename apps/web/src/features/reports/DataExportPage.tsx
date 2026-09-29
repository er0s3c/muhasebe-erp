import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, PageHeader } from '../../components/ui/Card';
import { Callout } from '../../components/ui/Feedback';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { Field, Input } from '../../components/ui/Field';

const SHEETS = ['parties', 'items', 'accounts', 'journal', 'invoices', 'invoiceLines', 'deliveries', 'treasuryAccounts', 'treasuryTransactions', 'stockMovements'] as const;

/** Tam veri dışa aktarma: şirketin tüm verisi tek Excel dosyasında (her tablo bir sayfa). */
export function DataExportPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const valid = !from || !to || from <= to;

  return (
    <div>
      <PageHeader
        title={t('reports.dataExport.title')}
        description={t('reports.dataExport.subtitle')}
        actions={<ExportMenu exportKey="full-data" params={{ from, to }} formats={['xlsx']} print={false} disabled={!valid} />}
      />
      <div className="flex flex-col gap-5">
        <Callout tone="warning" title={t('reports.dataExport.warnTitle')}>
          {t('reports.dataExport.warn')}
        </Callout>
        <Card>
          <CardHeader title={t('reports.dataExport.contentTitle')} description={t('reports.dataExport.contentDesc')} />
          <ul className="grid gap-x-8 gap-y-2 p-5 text-sm sm:grid-cols-2">
            {SHEETS.map((s) => (
              <li key={s} className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span>
                  <span>{t(`reports.dataExport.sheets.${s}`)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={t('reports.dataExport.filterTitle')} description={t('reports.dataExport.filterDesc')} />
          <div className="flex flex-wrap items-end gap-4 p-5">
            <Field label={t('common.from')}>{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />}</Field>
            <Field label={t('common.to')} error={valid ? undefined : t('reports.dataExport.badRange')}>
              {(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />}
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}
